import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PROXY = join(SERVER_DIR, "drivers", "agents-proxy.ts");
const PORT = 20_000 + Math.floor(Math.random() * 8_000);
const WEBHOOK_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const CAPABILITY_KEY = "hive-integration-test-capability";
const SERVICE_TOKEN = "hive-integration-service-token";
const UUID = "11111111-1111-4111-8111-111111111111";

type CapturedRequest = { method: string; path: string; body: Record<string, unknown> };

let home = "";
let staticDir = "";
let child: ChildProcess | undefined;
let hives: Server | undefined;
let hivesPort = 0;
let captured: CapturedRequest[] = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function mintCapability(botId: string, threadId: string): Promise<string> {
  const response = await api("POST", "/api/testing/internal-capability", { botId, threadId }, {
    "x-openmausbot-test-capability": CAPABILITY_KEY,
  });
  expect(response.status).toBe(201);
  return String(response.body.token);
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`OMB fixture exited before health: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // startup in progress
    }
    if (Date.now() >= deadline) throw new Error("OMB fixture did not become healthy");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stop(childProcess: ChildProcess | undefined): Promise<void> {
  if (!childProcess || childProcess.exitCode !== null) return;
  childProcess.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    childProcess.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function toolsList(enabled: boolean): Promise<Array<{ name: string }>> {
  return new Promise((resolve, reject) => {
    const proxy = spawn(process.execPath, [PROXY], {
      cwd: ROOT,
      env: {
        ...process.env,
        OMB_HARNESS_URL: "http://127.0.0.1:1",
        OMB_BOT_ID: UUID,
        OMB_THREAD_ID: "thread-hive",
        OMB_COMMS_TOKEN: "unused-for-tools-list",
        OMB_HIVE_TOOLS_ENABLED: enabled ? "1" : "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    const timer = setTimeout(() => {
      proxy.kill("SIGTERM");
      reject(new Error("agents proxy tools/list timed out"));
    }, 5_000);
    proxy.stdout!.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } };
          if (message.id !== 1) continue;
          clearTimeout(timer);
          proxy.kill("SIGTERM");
          resolve(message.result?.tools ?? []);
          return;
        } catch (error) {
          clearTimeout(timer);
          proxy.kill("SIGTERM");
          reject(error);
          return;
        }
      }
    });
    proxy.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-hive-integration-"));
  staticDir = join(home, "static");
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>OMB fixture</title>");

  hives = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    captured.push({
      method: request.method ?? "",
      path: request.url ?? "",
      body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
    });
    response.writeHead(request.url?.includes("/acceptance") ? 200 : 201, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true, receipt: "fixture-receipt" }));
  });
  hivesPort = await listen(hives);

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OMB_DATA_DIR: join(home, "data"),
      OMB_STATIC_DIR: staticDir,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
      OMB_TEST_INTERNAL_CAPABILITY_KEY: CAPABILITY_KEY,
      OMB_HIVES_BASE_URL: `http://127.0.0.1:${hivesPort}`,
      OMB_HIVES_SERVICE_TOKEN: SERVICE_TOKEN,
      // Do not let the fixture discover or invoke a configured provider.
      OMB_EXTRA_PATH: join(home, "empty-bin"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await waitForServer();
  captured = [];
});

afterAll(async () => {
  await stop(child);
  await new Promise<void>((resolve) => hives?.close(() => resolve()) ?? resolve());
  rmSync(home, { recursive: true, force: true });
});

describe("hive internal integration", () => {
  it("injects the authenticated sender owner and rejects spoofed identity", async () => {
    const created = await api("POST", "/api/bots", { name: "Hive coordination fixture" });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { orgRole: "domain-lead" })).status).toBe(200);
    const token = await mintCapability(bot.id, bot.threadId);
    const auth = { authorization: `Bearer ${token}` };

    const submit = await api("POST", "/api/internal/hive-submit", {
      sourceType: "linear_issue",
      sourceId: UUID,
      ownerRole: "worker",
      harness: "codex",
    }, auth);
    expect(submit.status).toBe(200);
    expect(captured.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/hives/admissions",
      body: { ownerBotId: bot.id, ownerRole: "domain-lead", sourceId: UUID },
    });

    const beforeSpoof = captured.length;
    const spoofedSender = await api("POST", "/api/internal/hive-submit", {
      fromBotId: "22222222-2222-4222-8222-222222222222",
      sourceType: "linear_issue",
      sourceId: UUID,
      ownerRole: "domain-lead",
      harness: "codex",
    }, auth);
    expect(spoofedSender.status).toBe(403);
    expect(captured).toHaveLength(beforeSpoof);

    const acceptance = await api("POST", "/api/internal/hive-acceptance", {
      ownerBotId: "22222222-2222-4222-8222-222222222222",
      queueId: UUID,
      generation: 1,
      runId: "33333333-3333-4333-8333-333333333333",
      workerFence: "4",
      sourceRevision: "2026-09-07T03:00:00.000Z",
      receiptDigest: "a".repeat(64),
      accepted: true,
      summary: "verified fixture receipt",
    }, auth);
    expect(acceptance.status).toBe(403);
    expect(captured).toHaveLength(beforeSpoof);

    const allowedAcceptance = await api("POST", "/api/internal/hive-acceptance", {
      queueId: UUID,
      generation: 1,
      runId: "33333333-3333-4333-8333-333333333333",
      workerFence: "4",
      sourceRevision: "2026-09-07T03:00:00.000Z",
      receiptDigest: "a".repeat(64),
      accepted: true,
      summary: "verified fixture receipt",
    }, auth);
    expect(allowedAcceptance.status).toBe(200);
    expect(captured.at(-1)).toMatchObject({
      path: `/api/hives/${UUID}/acceptance`,
      body: { ownerBotId: bot.id, queueId: UUID, generation: 1 },
    });
  });

  it("refuses hive dispatch from a non-coordination role", async () => {
    const created = await api("POST", "/api/bots", { name: "Hive worker fixture" });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { orgRole: "worker" })).status).toBe(200);
    const token = await mintCapability(bot.id, bot.threadId);
    const before = captured.length;
    const result = await api("POST", "/api/internal/hive-submit", {
      sourceType: "linear_issue", sourceId: UUID, ownerRole: "worker", harness: "codex",
    }, { authorization: `Bearer ${token}` });
    expect(result.status).toBe(403);
    expect(captured).toHaveLength(before);
  });

  it("exposes hive tools only when coordination capability is enabled", async () => {
    const ordinary = await toolsList(false);
    expect(ordinary.some((tool) => tool.name.startsWith("hive_"))).toBe(false);
    const coordination = await toolsList(true);
    expect(coordination.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "hive_submit", "hive_status", "hive_acceptance",
    ]));
  });
});
