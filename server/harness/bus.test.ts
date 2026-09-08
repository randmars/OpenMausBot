// The bus is the seam every client depends on: events must arrive
// stamped with their instanceId, cross-driver leaks must be dropped, and
// neither logging nor a broken listener may take down the stream.
import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EVENTS_DIR, ensureDirs } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { EventBus } from "./bus.ts";

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

const testEvent = (over: Partial<RuntimeEvent> = {}): RuntimeEvent =>
  ({
    eventId: "ev-1",
    provider: "fake",
    threadId: "thread-1",
    createdAt: new Date().toISOString(),
    type: "turn.started",
    ...over,
  }) as RuntimeEvent;

function errorWithCode(code: string, message = code) {
  return Object.assign(new Error(message), { code });
}

async function liveInstance() {
  const fake = makeFakeDriver();
  await fake.driver.create({
    instanceId: "inst-1",
    displayName: undefined,
    environment: {},
    enabled: true,
    config: {},
  });
  return fake.created.get("inst-1")!;
}

describe("EventBus", () => {
  beforeEach(() => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    ensureDirs();
  });

  it("stamps events from an attached adapter with the instanceId", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent());
    expect(seen).toHaveLength(1);
    expect(seen[0].providerInstanceId).toBe("inst-1");
  });

  it("drops events claiming a different driver kind (cross-driver invariant)", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent({ provider: "impostor" }));
    expect(seen).toHaveLength(0);
  });

  it("tees every published event to the per-thread NDJSON log", () => {
    const bus = new EventBus();
    bus.publish(testEvent({ threadId: "log-me" }));

    const logged = readFileSync(join(EVENTS_DIR, "log-me.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logged).toHaveLength(1);
    expect(logged[0].type).toBe("turn.started");
  });

  it("redacts credential-shaped content before writing the NDJSON log", () => {
    const bus = new EventBus();
    bus.publish(testEvent({
      threadId: "redacted-log",
      type: "runtime.error",
      message: `provider returned ${SECRET}`,
    }));

    const logged = readFileSync(join(EVENTS_DIR, "redacted-log.ndjson"), "utf8");
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain("«redacted");
  });

  it("recreates a missing EVENTS_DIR once and writes the redacted event without a warning", () => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const event = testEvent({
      threadId: "recovered-log",
      type: "runtime.error",
      message: `provider returned ${SECRET}`,
    });
    bus.publish(event);

    expect(existsSync(EVENTS_DIR)).toBe(true);
    expect(statSync(EVENTS_DIR).mode & 0o777).toBe(0o700);
    const file = join(EVENTS_DIR, "recovered-log.ndjson");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const logged = readFileSync(file, "utf8");
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain("«redacted");
    const parsed = logged.trim().split("\n").map((line) => JSON.parse(line));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].eventId).toBe("ev-1");
    expect(seen).toEqual([event]);
  });

  it("retries an ENOENT append once with the exact same path, payload, and options", () => {
    const append = vi.fn<typeof appendFileSync>();
    append.mockImplementationOnce(() => {
      throw errorWithCode("ENOENT");
    });
    const mkdirEventsDir = vi.fn();
    const bus = new EventBus(append, mkdirEventsDir);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const event = testEvent({ message: `provider returned ${SECRET}` });
    bus.publish(event);

    expect(mkdirEventsDir).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]).toEqual(append.mock.calls[0]);
    const payload = String(append.mock.calls[0][1]);
    expect(payload).not.toContain(SECRET);
    expect(payload).toContain("«redacted");
    expect(seen).toEqual([event]);
  });

  it("does not retry a non-ENOENT append and never creates the directory", () => {
    const append = vi.fn<typeof appendFileSync>(() => {
      throw errorWithCode("ENOSPC", "disk full");
    });
    const mkdirEventsDir = vi.fn();
    const bus = new EventBus(append, mkdirEventsDir);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const first = testEvent();
    const second = testEvent({ eventId: "ev-2", type: "turn.completed", ok: true });
    bus.publish(first);
    bus.publish(second);

    expect(mkdirEventsDir).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({
      type: "runtime.error",
      threadId: "thread-1",
      message: expect.stringContaining("event history is incomplete"),
    });
    expect(seen.slice(1).map((event) => event.eventId)).toEqual(["ev-1", "ev-2"]);
  });

  it("warns once when mkdir fails after ENOENT and still delivers each live event once", () => {
    const append = vi.fn<typeof appendFileSync>(() => {
      throw errorWithCode("ENOENT");
    });
    const mkdirEventsDir = vi.fn(() => {
      throw errorWithCode("EACCES", "cannot mkdir");
    });
    const bus = new EventBus(append, mkdirEventsDir);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const first = testEvent();
    const second = testEvent({ eventId: "ev-2" });
    bus.publish(first);
    bus.publish(second);

    expect(mkdirEventsDir).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({
      type: "runtime.error",
      message: expect.stringContaining("event history is incomplete"),
    });
    expect(seen.slice(1).map((event) => event.eventId)).toEqual(["ev-1", "ev-2"]);
  });

  it("warns once when the ENOENT retry append fails and does not retry again", () => {
    const append = vi.fn<typeof appendFileSync>();
    append.mockImplementationOnce(() => {
      throw errorWithCode("ENOENT");
    });
    append.mockImplementationOnce(() => {
      throw errorWithCode("EACCES", "cannot write");
    });
    const mkdirEventsDir = vi.fn();
    const bus = new EventBus(append, mkdirEventsDir);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const event = testEvent();
    bus.publish(event);

    expect(mkdirEventsDir).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]).toEqual(append.mock.calls[0]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      type: "runtime.error",
      message: expect.stringContaining("event history is incomplete"),
    });
    expect(seen[1]).toBe(event);
  });

  it("writes the incomplete marker before the first event after logging recovers", () => {
    let failing = true;
    const writes: string[] = [];
    const append: typeof appendFileSync = vi.fn((...args: Parameters<typeof appendFileSync>) => {
      if (failing) throw errorWithCode("ENOSPC", "disk full");
      writes.push(String(args[1]));
    });
    const mkdirEventsDir = vi.fn();
    const bus = new EventBus(append, mkdirEventsDir);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    const first = testEvent({ message: `provider returned ${SECRET}` });
    const recovered = testEvent({ eventId: "ev-2", type: "turn.completed", ok: true });
    const later = testEvent({ eventId: "ev-3", message: `still ${SECRET}` });
    bus.publish(first);
    failing = false;
    bus.publish(recovered);
    bus.publish(later);

    expect(mkdirEventsDir).not.toHaveBeenCalled();
    const persisted = writes[0].trim().split("\n").map((line) => JSON.parse(line));
    expect(persisted.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    expect(persisted[0].message).toContain("event history is incomplete");
    expect(persisted[1].eventId).toBe("ev-2");
    expect(writes[1]).not.toContain(SECRET);
    expect(writes[1]).toContain("«redacted");
    expect(writes[1].trim()).toContain('"eventId":"ev-3"');
    expect(seen.filter((event) => event.type === "runtime.error")).toHaveLength(1);
    expect(seen.map((event) => event.eventId).filter((id) => id === "ev-1" || id === "ev-2" || id === "ev-3")).toEqual([
      "ev-1",
      "ev-2",
      "ev-3",
    ]);
  });

  it("keeps live delivery when an event cannot be serialized", () => {
    const append = vi.fn<typeof appendFileSync>();
    const mkdirEventsDir = vi.fn();
    const bus = new EventBus(append, mkdirEventsDir);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    const event = testEvent({ raw: { source: "test", payload: 1n } });

    expect(() => bus.publish(event)).not.toThrow();
    expect(append).not.toHaveBeenCalled();
    expect(mkdirEventsDir).not.toHaveBeenCalled();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ type: "runtime.error" });
    expect(seen[1]).toBe(event);
  });

  it("a throwing listener does not starve the others", () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    expect(seen).toHaveLength(1);
  });

  it("unsubscribe and detachAll stop delivery", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));

    emit(testEvent());
    unsub();
    emit(testEvent());
    expect(seen).toHaveLength(1);

    const seenAfterDetach: RuntimeEvent[] = [];
    bus.subscribe((e) => seenAfterDetach.push(e));
    bus.detachAll();
    emit(testEvent());
    expect(seenAfterDetach).toHaveLength(0);
  });
});
