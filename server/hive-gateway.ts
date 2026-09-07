/** Narrow, server-side bridge to the heLLM hives API.
 *
 * The model receives only these fixed operations.  The base URL and service
 * credential stay in the harness process; neither is placed in an MCP tool
 * schema or sent to a provider.
 */

export type HiveSourceType = "linear_issue" | "missive_assignment";

export interface HiveAdmission {
  sourceType: HiveSourceType;
  sourceId: string;
  ownerRole: string;
  ownerBotId: string;
  harness: string;
}

type GatewayResult = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string };

const SOURCE_TYPES = new Set<HiveSourceType>(["linear_issue", "missive_assignment"]);
const HARNESSES = new Set(["codex", "claude", "grok", "devin"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function baseUrl(): URL | null {
  const raw = process.env.OMB_HIVES_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const value = new URL(raw);
    const local = value.hostname === "localhost" || value.hostname === "127.0.0.1" || value.hostname === "::1";
    if (value.protocol !== "https:" && !(value.protocol === "http:" && local)) return null;
    if (value.search || value.hash || !value.host) return null;
    return value;
  } catch {
    return null;
  }
}

function unavailable(): GatewayResult {
  return { ok: false, status: 503, error: "hive gateway unavailable: OMB_HIVES_BASE_URL and OMB_HIVES_SERVICE_TOKEN are required" };
}

function validAdmission(value: unknown): value is HiveAdmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.sourceType === "string" && SOURCE_TYPES.has(item.sourceType as HiveSourceType) &&
    typeof item.sourceId === "string" && UUID.test(item.sourceId) &&
    typeof item.ownerBotId === "string" && UUID.test(item.ownerBotId) &&
    typeof item.ownerRole === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(item.ownerRole) &&
    typeof item.harness === "string" && HARNESSES.has(item.harness);
}

async function request(path: string, init: RequestInit): Promise<GatewayResult> {
  const base = baseUrl();
  const token = process.env.OMB_HIVES_SERVICE_TOKEN?.trim();
  if (!base || !token) return unavailable();
  try {
    const response = await fetch(new URL(path, base), {
      ...init,
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
    });
    const body: unknown = await response.json().catch(() => ({}));
    const error = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).error === "string"
      ? (body as Record<string, unknown>).error as string
      : `hive API returned HTTP ${response.status}`;
    if (!response.ok) return { ok: false, status: response.status, error };
    return { ok: true, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 502, error: `hive API request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function submitHiveAdmission(admission: HiveAdmission): Promise<GatewayResult> {
  if (!validAdmission(admission)) return { ok: false, status: 400, error: "invalid hive admission" };
  return request("/api/hives/admissions", { method: "POST", body: JSON.stringify(admission) });
}

export async function getHiveStatus(sourceType: string, sourceId: string): Promise<GatewayResult> {
  if (!SOURCE_TYPES.has(sourceType as HiveSourceType) || !UUID.test(sourceId)) {
    return { ok: false, status: 400, error: "sourceType and sourceId are invalid" };
  }
  const query = new URLSearchParams({ sourceType, sourceId });
  return request(`/api/hives?${query.toString()}`, { method: "GET" });
}

export type HiveAcceptance = { queueId: string; ownerBotId: string; generation: number; runId: string;
  workerFence: string; sourceRevision: string; receiptDigest: string; accepted: boolean; summary: string };
export async function submitHiveAcceptance(value: HiveAcceptance): Promise<GatewayResult> {
  if (!UUID.test(value.queueId) || !UUID.test(value.ownerBotId) || !UUID.test(value.runId) || !Number.isSafeInteger(value.generation)
    || value.generation < 1 || !/^\d+$/.test(value.workerFence) || !value.sourceRevision?.trim()
    || !/^[0-9a-f]{64}$/.test(value.receiptDigest) || typeof value.accepted !== "boolean" || !value.summary?.trim()) {
    return { ok: false, status: 400, error: "invalid hive acceptance binding" };
  }
  return request(`/api/hives/${value.queueId}/acceptance`, { method: "POST", body: JSON.stringify(value) });
}
