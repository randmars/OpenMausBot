// Cross-platform process spawning for the agent CLIs. Four Windows
// differences are exposed to drivers through this module:
//   1. CreateProcess can't exec npm .cmd/.bat shims or node-shebang scripts
//      directly. env-path resolves those to their real .exe / `node script`
//      entry without a shell, so quoting-sensitive JSON argv stays intact.
//   2. No process-group kill (kill(-pid) is POSIX) — taskkill /T reaps the
//      whole tree, CLI + its spawned MCP proxies alike.
//   3. Console apps spawned from the GUI shell flash a console window
//      unless windowsHide is set.
//   4. CreateProcess has a 32,767-character command-line limit. Keep prompt
//      bodies on stdin or in private files and fail clearly if a future
//      driver accidentally puts one back in argv.
import {
  spawn,
  execFile,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { resolveCliSpawn, type ResolvedSpawn } from "./env-path.ts";

export interface LinuxProcessIdentity {
  pid: number;
  ppid: number;
  processGroup: number;
  startTime: string;
}

interface TrackedLinuxProcess extends LinuxProcessIdentity {
  depth: number;
}

interface LinuxCliTree {
  leader: LinuxProcessIdentity;
  descendants: Map<number, TrackedLinuxProcess>;
  tracker?: NodeJS.Timeout;
  cleanedAfterExit: boolean;
  lastIoRefreshAt: number;
}

const linuxCliTrees = new WeakMap<ChildProcess, LinuxCliTree>();
const LINUX_TREE_TRACK_MS = 100;
const MAX_TRACKED_DESCENDANTS = 256;
const MAX_TRACKED_DEPTH = 32;

/** Parse the fields after /proc's parenthesized comm, which may contain spaces. */
function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | null {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = line.lastIndexOf(") ");
    if (close < 0) return null;
    const fields = line.slice(close + 2).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    const processGroup = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(processGroup) || !startTime) return null;
    return { pid, ppid, processGroup, startTime };
  } catch {
    return null;
  }
}

function sameLinuxProcess(expected: LinuxProcessIdentity, current: LinuxProcessIdentity | null): boolean {
  return Boolean(current && current.pid === expected.pid && current.startTime === expected.startTime);
}

function linuxChildren(pid: number): number[] {
  try {
    const children = new Set<number>();
    // Children may be spawned by any thread, not only the thread-group
    // leader. The kernel exposes a separate children list for each task.
    for (const task of readdirSync(`/proc/${pid}/task`, { withFileTypes: true })) {
      if (!task.isDirectory() || !/^\d+$/.test(task.name)) continue;
      const values = readFileSync(`/proc/${pid}/task/${task.name}/children`, "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter(Number.isSafeInteger);
      for (const child of values) children.add(child);
    }
    return [...children];
  } catch {
    return [];
  }
}

function refreshLinuxCliTree(tree: LinuxCliTree): void {
  if (!sameLinuxProcess(tree.leader, readLinuxProcessIdentity(tree.leader.pid))) return;
  for (const [pid, identity] of tree.descendants) {
    if (!sameLinuxProcess(identity, readLinuxProcessIdentity(pid))) tree.descendants.delete(pid);
  }
  const queue: Array<{ identity: LinuxProcessIdentity; depth: number }> = [{ identity: tree.leader, depth: 0 }];
  const seen = new Set<number>([tree.leader.pid]);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    if (tree.descendants.size >= MAX_TRACKED_DESCENDANTS) break;
    if (parent.depth >= MAX_TRACKED_DEPTH) continue;
    for (const pid of linuxChildren(parent.identity.pid)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const identity = readLinuxProcessIdentity(pid);
      if (!identity || identity.ppid !== parent.identity.pid) continue;
      const tracked = { ...identity, depth: parent.depth + 1 };
      tree.descendants.set(pid, tracked);
      queue.push({ identity, depth: tracked.depth });
      if (tree.descendants.size >= MAX_TRACKED_DESCENDANTS) break;
    }
  }
}

function registerLinuxCliTree(child: ChildProcess): void {
  if (process.platform !== "linux" || !child.pid) return;
  const leader = readLinuxProcessIdentity(child.pid);
  if (!leader) return;
  const tree: LinuxCliTree = {
    leader,
    descendants: new Map(),
    cleanedAfterExit: false,
    lastIoRefreshAt: 0,
  };
  refreshLinuxCliTree(tree);
  tree.tracker = setInterval(() => refreshLinuxCliTree(tree), LINUX_TREE_TRACK_MS);
  tree.tracker.unref?.();
  linuxCliTrees.set(child, tree);
  child.once("exit", () => cleanupExitedCliTree(child));
}

/** Refresh at a driver's existing I/O boundary, while the model is still live. */
export function trackCliTreeNow(child: ChildProcess): void {
  const tree = linuxCliTrees.get(child);
  if (!tree) return;
  const now = Date.now();
  // Stream chunks can arrive much faster than the event loop can afford
  // synchronous /proc traversal. Preserve the first I/O observation, then
  // cap this path at 10 Hz per CLI; the independent tracker is also 10 Hz.
  if (tree.lastIoRefreshAt !== 0 && now - tree.lastIoRefreshAt < LINUX_TREE_TRACK_MS) return;
  tree.lastIoRefreshAt = now;
  refreshLinuxCliTree(tree);
}

/** Signal a PID only while it still has the start identity captured as our descendant. */
export function terminateTrackedLinuxProcess(
  expected: LinuxProcessIdentity,
  readIdentity: (pid: number) => LinuxProcessIdentity | null = readLinuxProcessIdentity,
  signal: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM"),
): boolean {
  if (!sameLinuxProcess(expected, readIdentity(expected.pid))) return false;
  try {
    signal(expected.pid);
    return true;
  } catch {
    return false;
  }
}

function signalTrackedDescendants(tree: LinuxCliTree): void {
  const deepestFirst = [...tree.descendants.values()].sort((a, b) => b.depth - a.depth);
  for (const identity of deepestFirst) terminateTrackedLinuxProcess(identity);
}

/** Finish exact descendants after the model/group leader has already exited. */
export function cleanupExitedCliTree(child: ChildProcess): void {
  const tree = linuxCliTrees.get(child);
  if (!tree || tree.cleanedAfterExit) return;
  tree.cleanedAfterExit = true;
  if (tree.tracker) clearInterval(tree.tracker);
  // Never signal the numeric process group after its leader is gone: that
  // identity can be reused. Only signal descendant PIDs whose start time is
  // still the one captured while they belonged to this live CLI tree.
  signalTrackedDescendants(tree);
}

export function resolveCli(cli: string, args: string[] = []): ResolvedSpawn {
  return resolveCliSpawn(cli, args);
}

/** Leave headroom below CreateProcess' 32,767 UTF-16 code-unit limit for
 * libuv's quoting and environment-specific executable expansion. */
export const WINDOWS_SAFE_COMMAND_LINE_CHARS = 30_000;

/** Conservative size of the command line libuv will give CreateProcess.
 * JSON string quoting escapes every slash/quote case Windows quoting needs,
 * so this can over-count but cannot hide a dangerous launch. */
export function estimatedWindowsCommandLineChars(resolved: ResolvedSpawn): number {
  return [resolved.command, ...resolved.args].reduce(
    (total, value) => total + JSON.stringify(value).length + 1,
    0,
  );
}

export function assertSafeCliArgv(
  resolved: ResolvedSpawn,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  if (estimatedWindowsCommandLineChars(resolved) <= WINDOWS_SAFE_COMMAND_LINE_CHARS) return;
  const error = new Error(
    "agent CLI launch arguments exceed Windows' safe command-line limit; pass large prompts through stdin or a file",
  ) as NodeJS.ErrnoException;
  error.code = "ENAMETOOLONG";
  throw error;
}

export function spawnCli(
  cli: string,
  args: string[],
  opts: SpawnOptions,
): ChildProcessByStdio<Writable, Readable, Readable> {
  const resolved = resolveCli(cli, args);
  assertSafeCliArgv(resolved);
  const child = spawn(resolved.command, resolved.args, {
    ...opts,
    // posix: own process group so kill(-pid) reaps child MCP servers;
    // win32: taskkill /T does the reaping instead (see killCliTree)
    ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
  }) as ChildProcessByStdio<Writable, Readable, Readable>; // callers always pipe all three
  registerLinuxCliTree(child);

  // A write to a dying child's stdin fails differently per platform, and one
  // of the ways is fatal. On POSIX the kill is synchronous, the stream is
  // already destroyed by the time anything writes, and the write throws into
  // the caller's try/catch. On Windows killCliTree goes through taskkill — a
  // subprocess — so there is a window where the child is dead but its pipe is
  // not, and a write during it errors *asynchronously* on the stream. No
  // driver listens for that, an unlistened stream error is an uncaught
  // exception, and the whole harness exits over one dead CLI. The error
  // carries no information the drivers don't already get from `close`, which
  // is where every one of them settles the turn — so it is swallowed, not
  // logged.
  child.stdin?.on("error", () => {});
  return child;
}

export function execCli(
  cli: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr?: string) => void,
): void {
  const resolved = resolveCli(cli, args);
  try {
    assertSafeCliArgv(resolved);
  } catch (error) {
    queueMicrotask(() => cb(error instanceof Error ? error : new Error(String(error)), "", ""));
    return;
  }
  execFile(resolved.command, resolved.args, { ...opts, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) =>
    cb(err, stdout, stderr),
  );
}

/** Human wording for a failed CLI spawn.
 *
 * Node reports these as bare errno strings — "spawn grok ENOENT" — which
 * reads as a crash. On a CLI spawn the common codes mean exactly one thing
 * each, and both are setup problems the user can fix, so say which. The
 * `setup` flag lets the UI offer "Install" instead of a "Retry" that is
 * guaranteed to fail the same way. */
type SpawnFailure = { message: string; setup: boolean };

export function describeSpawnFailure(err: NodeJS.ErrnoException, cli: string): SpawnFailure {
  if (err.code === "ENOENT")
    return { message: `\`${cli}\` isn't installed, or isn't on this app's PATH`, setup: true };
  if (err.code === "EACCES" || err.code === "EPERM")
    return { message: `\`${cli}\` isn't executable — check its file permissions`, setup: true };
  if (err.code === "ENAMETOOLONG")
    return {
      message: `\`${cli}\` received too much launch data for Windows; update this provider or pass its prompt through stdin/a file`,
      setup: false,
    };
  return { message: `spawn failed: ${err.message}`, setup: false };
}

/** Stop a CLI and every process it spawned (MCP proxies included). */
export function killCliTree(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return Promise.resolve(true);
  if (child.exitCode !== null || child.signalCode !== null) {
    cleanupExitedCliTree(child);
    return Promise.resolve(true);
  }

  const linuxTree = linuxCliTrees.get(child);
  if (linuxTree) {
    refreshLinuxCliTree(linuxTree);
    // Codex MCP launchers create their own process groups. Signal every exact
    // descendant identity before stopping the model's group.
    signalTrackedDescendants(linuxTree);
  }

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const done = (stopped: boolean) => {
      clearTimeout(timer);
      child.off("close", closed);
      resolve(stopped);
    };
    const closed = () => done(true);
    child.once("close", closed);
    timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();

    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
        if (!err) return;
        try {
          // taskkill is unavailable or the tree lookup failed. At least stop
          // the process we own instead of leaving the entire turn running.
          child.kill();
        } catch {
          /* already gone */
        }
      });
      return;
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  });
}

/** Per-turn broker channel: unix socket on POSIX, named pipe on Windows
 * (Node can't listen on a filesystem socket path there — EACCES). */
export function brokerSocketPath(dataDir: string, tag: string): string {
  return process.platform === "win32"
    // Named pipes share a global namespace; DATA_DIR cannot isolate two
    // concurrent app instances the way a POSIX socket directory does.
    ? `\\\\.\\pipe\\openmausbot-perm-${process.pid}-${tag}`
    : join(dataDir, `perm-${tag}.sock`);
}
