// The drivers spawn their CLI detached so that stopping a turn also stops
// whatever the CLI started (its MCP servers). That guarantee is the whole
// contract of killCliTree, so it is what gets tested: a grandchild must not
// survive the kill on either platform.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { killCliTree, spawnCli, trackCliTreeNow } from "./procs.ts";

const IDLE = "setInterval(() => {}, 1000)";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("killCliTree", () => {
  it("owns stdin pipe errors before a CLI can be force-stopped", async () => {
    const child = spawnCli(process.execPath, ["-e", IDLE], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      await expect(killCliTree(child)).resolves.toBe(true);
    }
  });

  it("reaps a grandchild, not just the process it was handed", async () => {
    // a stand-in CLI: spawns one helper, reports its pid, then idles
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { stdio: "ignore" });` +
          `console.log(c.pid); ${IDLE}`,
      ],
      { stdio: ["ignore", "pipe", "ignore"], detached: true },
    );
    let grandchild = 0;
    try {
      grandchild = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("helper did not report its pid")), 5_000);
        parent.stdout!.once("data", (chunk) => {
          clearTimeout(timer);
          resolve(Number(String(chunk).trim()));
        });
      });
      expect(grandchild).toBeGreaterThan(0);
      expect(alive(grandchild)).toBe(true);

      await expect(killCliTree(parent)).resolves.toBe(true);

      // Read the parent's death off the child object: a POSIX parent stays a
      // live pid as a zombie until Node reaps it. The grandchild has no Child
      // object here, so wait until its pid disappears as the observable proof.
      const exited = () => parent.exitCode !== null || parent.signalCode !== null;
      const deadline = Date.now() + 10_000;
      while ((alive(grandchild) || !exited()) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(alive(grandchild)).toBe(false);
      expect(exited()).toBe(true);
    } finally {
      await killCliTree(parent);
      if (grandchild && alive(grandchild)) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 20_000);

  it("reaps a separately grouped descendant after its model parent exits", async () => {
    if (process.platform !== "linux") return;
    const unrelated = spawn(process.execPath, ["-e", IDLE], { stdio: "ignore", detached: true });
    const parent = spawnCli(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");` +
          `const c = spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { stdio: "ignore", detached: true });` +
          `console.log(c.pid); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let descendant = 0;
    try {
      descendant = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("descendant did not report its pid")), 5_000);
        parent.stdout.once("data", (chunk) => {
          clearTimeout(timer);
          trackCliTreeNow(parent);
          resolve(Number(String(chunk).trim()));
        });
      });
      expect(descendant).toBeGreaterThan(0);
      expect(alive(descendant)).toBe(true);
      expect(alive(unrelated.pid!)).toBe(true);

      const closed = new Promise<void>((resolve) => parent.once("close", () => resolve()));
      parent.stdin.end();
      await closed;

      const deadline = Date.now() + 5_000;
      while (alive(descendant) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(alive(descendant)).toBe(false);
      expect(alive(unrelated.pid!)).toBe(true);
    } finally {
      await killCliTree(parent);
      if (descendant && alive(descendant)) process.kill(descendant, "SIGTERM");
      if (unrelated.pid && alive(unrelated.pid)) process.kill(-unrelated.pid, "SIGTERM");
    }
  }, 15_000);
});
