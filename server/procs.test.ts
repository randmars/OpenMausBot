import { describe, expect, it } from "vitest";

import {
  assertSafeCliArgv,
  describeSpawnFailure,
  estimatedWindowsCommandLineChars,
  terminateTrackedLinuxProcess,
  WINDOWS_SAFE_COMMAND_LINE_CHARS,
} from "./procs.ts";

describe("Linux descendant identity", () => {
  const captured = { pid: 42, ppid: 10, processGroup: 42, startTime: "1000" };

  it("signals the same captured PID identity", () => {
    const signalled: number[] = [];
    expect(terminateTrackedLinuxProcess(captured, () => captured, (pid) => signalled.push(pid))).toBe(true);
    expect(signalled).toEqual([42]);
  });

  it("does not signal a PID whose start time was reused", () => {
    const signalled: number[] = [];
    const reused = { ...captured, startTime: "2000" };
    expect(terminateTrackedLinuxProcess(captured, () => reused, (pid) => signalled.push(pid))).toBe(false);
    expect(signalled).toEqual([]);
  });
});

describe("Windows CLI argument safety", () => {
  it("accepts ordinary launches", () => {
    const resolved = { command: "agy.exe", args: ["--model", "gemini-3.1-pro-high"] };
    expect(estimatedWindowsCommandLineChars(resolved)).toBeLessThan(WINDOWS_SAFE_COMMAND_LINE_CHARS);
    expect(() => assertSafeCliArgv(resolved, "win32")).not.toThrow();
  });

  it("rejects a prompt-sized argv before CreateProcess can fail opaquely", () => {
    const resolved = { command: "agy.exe", args: ["--print", "x".repeat(40_000)] };
    expect(() => assertSafeCliArgv(resolved, "win32")).toThrow(
      /pass large prompts through stdin or a file/,
    );
    try {
      assertSafeCliArgv(resolved, "win32");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENAMETOOLONG");
    }
  });

  it("does not impose the Windows limit on other platforms", () => {
    const resolved = { command: "agy", args: ["--print", "x".repeat(40_000)] };
    expect(() => assertSafeCliArgv(resolved, "linux")).not.toThrow();
  });

  it("turns ENAMETOOLONG into an actionable message without echoing argv", () => {
    const error = Object.assign(new Error("private prompt contents"), { code: "ENAMETOOLONG" });
    const failure = describeSpawnFailure(error, "agy");
    expect(failure).toEqual({
      message: "`agy` received too much launch data for Windows; update this provider or pass its prompt through stdin/a file",
      setup: false,
    });
    expect(failure.message).not.toContain("private prompt contents");
  });
});
