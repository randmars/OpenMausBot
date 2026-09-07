import { afterEach, describe, expect, it, vi } from "vitest";

import { getHiveStatus, submitHiveAdmission, submitHiveAcceptance } from "./hive-gateway.ts";

describe("hive gateway", () => {
  afterEach(() => {
    delete process.env.OMB_HIVES_BASE_URL;
    delete process.env.OMB_HIVES_SERVICE_TOKEN;
    vi.unstubAllGlobals();
  });

  it("fails explicitly when the server-side gateway is not configured", async () => {
    await expect(submitHiveAdmission({
      sourceType: "linear_issue",
      sourceId: "11111111-1111-4111-8111-111111111111",
      ownerBotId: "22222222-2222-4222-8222-222222222222",
      ownerRole: "leader",
      harness: "codex",
    })).resolves.toMatchObject({ ok: false, status: 503 });
  });

  it("uses only the fixed authenticated hive routes", async () => {
    process.env.OMB_HIVES_BASE_URL = "http://127.0.0.1:3201";
    process.env.OMB_HIVES_SERVICE_TOKEN = "server-only";
    const fetchMock = vi.fn(async (input: URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:3201/api/hives/admissions");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer server-only");
      return new Response(JSON.stringify({ accepted: true }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitHiveAdmission({
      sourceType: "missive_assignment",
      sourceId: "11111111-1111-4111-8111-111111111111",
      ownerBotId: "22222222-2222-4222-8222-222222222222",
      ownerRole: "domain-lead",
      harness: "claude",
    })).resolves.toMatchObject({ ok: true, status: 201 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards the server-bound owner identity and acceptance binding unchanged", async () => {
    process.env.OMB_HIVES_BASE_URL = "http://127.0.0.1:3201";
    process.env.OMB_HIVES_SERVICE_TOKEN = "server-only";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }));

    await expect(submitHiveAdmission({
      sourceType: "linear_issue",
      sourceId: "11111111-1111-4111-8111-111111111111",
      ownerBotId: "22222222-2222-4222-8222-222222222222",
      ownerRole: "domain-lead",
      harness: "codex",
    })).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(submitHiveAcceptance({
      queueId: "33333333-3333-4333-8333-333333333333",
      ownerBotId: "22222222-2222-4222-8222-222222222222",
      generation: 2,
      runId: "44444444-4444-4444-8444-444444444444",
      workerFence: "7",
      sourceRevision: "2026-09-07T03:00:00.000Z",
      receiptDigest: "a".repeat(64),
      accepted: true,
      summary: "verified",
    })).resolves.toMatchObject({ ok: true, status: 200 });

    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      sourceType: "linear_issue",
      ownerBotId: "22222222-2222-4222-8222-222222222222",
    });
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      queueId: "33333333-3333-4333-8333-333333333333",
      ownerBotId: "22222222-2222-4222-8222-222222222222",
      generation: 2,
      workerFence: "7",
      receiptDigest: "a".repeat(64),
    });
  });

  it("rejects malformed acceptance before contacting the backend", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(submitHiveAcceptance({ queueId: "bad", ownerBotId: "bad", generation: 1, runId: "bad", workerFence: "1", sourceRevision: "rev", receiptDigest: "bad", accepted: true, summary: "test" })).resolves.toMatchObject({ ok: false, status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects arbitrary source values before making a request", async () => {
    process.env.OMB_HIVES_BASE_URL = "http://127.0.0.1:3201";
    process.env.OMB_HIVES_SERVICE_TOKEN = "server-only";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getHiveStatus("linear_issue", "DEV-3388?url=evil")).resolves.toMatchObject({ ok: false, status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
