#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const manifestPath = resolve(value("--manifest", "docs/org-cutover/dev-3388-org-v1.json"));
const base = value("--base-url", "http://127.0.0.1:8799").replace(/\/$/, "");
const apply = has("--apply");
const rollbackPath = value("--rollback", "");
const stem = basename(manifestPath, ".json");
const snapshotPath = resolve(value("--snapshot", resolve(dirname(manifestPath), `${stem}.live-snapshot.json`)));
const receiptPath = resolve(value("--receipt", resolve(dirname(manifestPath), `${stem}.receipt.json`)));

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${body.error ?? ""}`.trim());
  return body;
}

function publicInstance(instance) {
  return {
    instanceId: instance.instanceId,
    driverKind: instance.driverKind,
    displayName: instance.displayName,
    snapshot: instance.snapshot ? { state: instance.snapshot.state, version: instance.snapshot.version, authenticated: instance.snapshot.authenticated } : null,
    defaultModel: instance.models?.default ?? null,
    modelIds: Array.isArray(instance.models?.options) ? instance.models.options.map((model) => model.id).filter(Boolean) : [],
    capabilities: instance.capabilities ?? null,
  };
}

function publicRoutine(routine) {
  return { id: routine.id, name: routine.name, botId: routine.botId ?? null, target: routine.target ?? null, enabled: routine.enabled === true, schedule: routine.schedule ?? null, nextRunAt: routine.nextRunAt ?? null, sourceThreadId: routine.sourceThreadId ?? null };
}

function botRestore(bot) {
  return { section: bot.section ?? null, orgRole: bot.orgRole ?? null, crossSectionPeers: bot.crossSectionPeers ?? null };
}

async function readLive() {
  const [roster, routines, instances] = await Promise.all([request("/api/bots?messages=0"), request("/api/routines"), request("/api/instances")]);
  return {
    capturedAt: new Date().toISOString(),
    baseUrl: base,
    bots: (roster.bots ?? []).map((bot) => ({ id: bot.id, name: bot.name, busy: bot.busy === true, modelSelection: bot.modelSelection ?? null, approvalMode: bot.approvalMode ?? null, autoApprove: bot.autoApprove ?? null, alwaysAllow: bot.alwaysAllow ?? null, composio: bot.composio ?? null, browser: bot.browser ?? null, restore: botRestore(bot) })),
    routines: (routines.routines ?? []).map(publicRoutine),
    instances: (instances.instances ?? []).map(publicInstance),
  };
}

function expectedNameMatches(entry, bot) {
  return entry.name === bot.name || (Array.isArray(entry.aliases) && entry.aliases.includes(bot.name));
}

function modelChecks(raw, live) {
  const byId = new Map(live.bots.map((bot) => [bot.id, bot]));
  return (raw.modelRequirements ?? []).map((requirement) => {
    const bot = byId.get(requirement.botId);
    const actual = bot?.modelSelection ?? null;
    const matches = Boolean(bot && actual?.instanceId === requirement.instanceId && actual?.model === requirement.model);
    return { botId: requirement.botId, name: requirement.name ?? bot?.name ?? null, expected: { instanceId: requirement.instanceId, model: requirement.model }, actual, status: matches ? "matches" : "requires-authorized-smoke-proof", smokeProof: requirement.smokeProof ?? "No provider/model invocation is performed by this tool." };
  });
}

async function saveJson(path, data) { await writeFile(path, `${JSON.stringify(data, null, 2)}\n`); }

const raw = JSON.parse(await readFile(rollbackPath || manifestPath, "utf8"));
const live = await readLive();

if (rollbackPath) {
  if (raw.version !== 2 || !Array.isArray(raw.botSnapshots)) throw new Error("rollback file must be a v2 live snapshot");
  const liveById = new Map(live.bots.map((bot) => [bot.id, bot]));
  const busy = raw.botSnapshots.filter((snapshot) => liveById.get(snapshot.id)?.busy);
  const receipt = { version: 1, operation: "rollback", manifest: raw.manifest ?? null, baseUrl: base, dryRun: !apply, capturedAt: live.capturedAt, busy: busy.map((bot) => bot.id), patches: raw.botSnapshots.length };
  if (busy.length) receipt.status = "blocked-busy";
  else if (!apply) receipt.status = "dry-run";
  else {
    receipt.status = "applying";
    for (const snapshot of raw.botSnapshots) {
      const result = await request(`/api/bots/${encodeURIComponent(snapshot.id)}`, { method: "PATCH", body: JSON.stringify(snapshot.restore) });
      const bot = result.bot ?? result;
      if (snapshot.restore.orgRole !== undefined && bot.orgRole !== snapshot.restore.orgRole) throw new Error(`rollback response did not persist orgRole for ${snapshot.id}`);
    }
    receipt.status = "applied";
  }
  await saveJson(receiptPath, receipt);
  console.log(`${receipt.status}: ${raw.botSnapshots.length} bot restores; receipt=${receiptPath}`);
  if (busy.length) process.exitCode = 2;
  process.exit(0);
}

if (raw.version !== 1 || !Array.isArray(raw.bots)) throw new Error("unsupported org manifest");
const byId = new Map(live.bots.map((bot) => [bot.id, bot]));
const missing = raw.bots.filter((entry) => !byId.has(entry.id));
if (missing.length) throw new Error(`manifest IDs missing from live roster: ${missing.map((entry) => `${entry.name}=${entry.id}`).join(", ")}`);

const warnings = [];
const blocked = [];
const botSnapshots = [];
const plans = [];
for (const entry of raw.bots) {
  const bot = byId.get(entry.id);
  if (!expectedNameMatches(entry, bot)) warnings.push(`${entry.id}: manifest name ${entry.name} does not match live ${bot.name}; no rename will occur`);
  if (bot.busy) blocked.push({ id: bot.id, name: bot.name, reason: "busy" });
  const patch = Object.fromEntries(["section", "orgRole", "crossSectionPeers"].filter((field) => entry[field] !== undefined).map((field) => [field, entry[field]]));
  if (entry.crossSectionPeers !== undefined) patch.acknowledgePeerScope = true;
  botSnapshots.push({ id: bot.id, name: bot.name, restore: botRestore(bot), modelSelection: bot.modelSelection ?? null });
  plans.push({ id: bot.id, name: bot.name, patch });
}

const checks = modelChecks(raw, live);
const snapshot = { version: 2, manifest: manifestPath, capturedAt: live.capturedAt, baseUrl: base, botSnapshots, routines: live.routines, instances: live.instances, modelChecks: checks, warnings, blocked, retiredRoutinesPreserved: true };
if (has("--snapshot")) await saveJson(snapshotPath, snapshot);

const receipt = { version: 1, operation: "org-cutover", manifest: manifestPath, baseUrl: base, dryRun: !apply, capturedAt: live.capturedAt, planCount: plans.length, blocked, warnings, modelChecks: checks, snapshotPath: has("--snapshot") ? snapshotPath : null, retiredRoutinesPreserved: true, restart: { requiredAfterApply: true, command: "systemctl --user restart openmausbot.service", verify: "systemctl --user show openmausbot.service --property=ActiveState,SubState,MainPID --no-pager && curl -fsS http://127.0.0.1:8799/api/health", status: "not-run" } };

for (const plan of plans) console.log(`${apply ? "PLAN" : "DRY-RUN"} ${plan.name} (${plan.id}): ${JSON.stringify(plan.patch)}`);
for (const warning of warnings) console.log(`WARNING ${warning}`);
for (const item of blocked) console.log(`BLOCKED ${item.name} (${item.id}): ${item.reason}`);

if (apply && blocked.length) {
  receipt.status = "blocked-busy";
  await saveJson(receiptPath, receipt);
  console.log(`blocked before apply; receipt=${receiptPath}`);
  process.exitCode = 2;
} else if (!apply) {
  receipt.status = "dry-run";
  await saveJson(receiptPath, receipt);
  console.log(`dry-run only: ${plans.length} bot patches; receipt=${receiptPath}${has("--snapshot") ? `; snapshot=${snapshotPath}` : ""}`);
} else {
  await saveJson(snapshotPath, snapshot);
  receipt.snapshotPath = snapshotPath;
  receipt.status = "applying";
  await saveJson(receiptPath, receipt);
  for (const plan of plans) {
    const result = await request(`/api/bots/${encodeURIComponent(plan.id)}`, { method: "PATCH", body: JSON.stringify(plan.patch) });
    const bot = result.bot ?? result;
    for (const [field, expected] of Object.entries(plan.patch)) {
      if (field === "acknowledgePeerScope") continue;
      if (JSON.stringify(bot[field] ?? null) !== JSON.stringify(expected ?? null)) throw new Error(`apply response did not persist ${field} for ${plan.id}; rollback snapshot=${snapshotPath}`);
    }
  }
  receipt.status = "applied-awaiting-restart";
  await saveJson(receiptPath, receipt);
  console.log(`applied ${plans.length} bot patches; restart receipt required; snapshot=${snapshotPath}; receipt=${receiptPath}`);
}
