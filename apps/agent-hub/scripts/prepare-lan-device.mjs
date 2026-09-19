#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "../src/common.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const hubRoot = path.resolve(path.dirname(scriptFile), "..");
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

export function buildWorkerConfig({ provider, command, mode, hubIp, deviceId, fullAccess, root = hubRoot }) {
  const agentId = `${deviceId}-${provider}-01`;
  const workspace = path.join(root, "workspaces", "lan", deviceId, provider);
  const stateFile = path.join(root, "var", "lan", "state", `${agentId}.json`);
  const cacheFile = path.join(root, "var", "lan", "provider-cache", `${deviceId}-${provider}.json`);
  const probeScript = path.join(root, "scripts", "provider-probe.mjs");
  const providerName = provider === "codex" ? "openai" : "google";
  const roles = mode === "coordinator" ? ["planner", "executor", "reviewer"] : ["executor", "reviewer"];
  const probeBase = [probeScript, "--provider", provider, "--command", command, "--cache-file", cacheFile, "--max-age-ms", "30000", "--timeout-ms", "20000"];
  const policy = fullAccess ? {
    requireTaskSpec: false,
    defaultDenyUnknownPermissions: true,
    allowedPermissions: ["project_workspace", "terminal", "browser", "system_settings"],
    deniedPermissions: [],
  } : {
    requireTaskSpec: false,
    defaultDenyUnknownPermissions: true,
    allowedPermissions: ["project_workspace", "terminal"],
    deniedPermissions: ["browser", "system_settings"],
  };
  const adapter = provider === "codex" ? {
    type: "codex",
    command,
    globalArgs: [],
    execArgs: [],
    sandbox: fullAccess ? "danger-full-access" : "workspace-write",
    approvalPolicy: "never",
    maxOutputChars: 200000,
  } : {
    type: "antigravity",
    command,
    // Never generate Antigravity's permission-bypass flag. LAN full access grants
    // the known permission set in A446 while the official client stays in its
    // highest non-bypass automation mode.
    args: ["--mode", "accept-edits"],
    stripProxyEnv: false,
    resumeOnStart: true,
    shutdownTimeoutMs: 5000,
  };
  return {
    agentId,
    deviceId,
    account: {
      id: `${deviceId}-${provider}-current`,
      provider: providerName,
      plan: "unknown",
      label: `${provider === "codex" ? "Codex" : "Antigravity"} 当前账号`,
      maxConcurrency: 1,
    },
    roles,
    models: [],
    hubUrl: `ws://${hubIp}:8787/worker`,
    authTokenEnv: "HUB_TOKEN",
    authRequired: true,
    heartbeatMs: 5000,
    stateFile,
    workspace,
    capabilities: ["task.execute", "planning", "coding", "review", "document_editing", "pause", "resume", "cancel"],
    policy,
    checkpoints: { includeOutput: true, maxOutputChars: 200000 },
    artifacts: { centralStore: true, apiUrl: `http://${hubIp}:8787`, maxFileBytes: 104857600 },
    capabilityProbe: {
      intervalMs: 300000,
      timeoutMs: 20000,
      tools: [
        { name: "git", command: "git", args: ["--version"], capabilities: ["git"] },
      ],
      device: {
        python: { command: "python", args: ["--version"], capabilities: ["python"] },
        gpu: { command: "nvidia-smi", args: ["--query-gpu=name,driver_version", "--format=csv,noheader"], capabilities: ["gpu"] },
      },
    },
    accountProbe: { command: process.execPath, args: [...probeBase, "--kind", "account"], source: `${provider}-official-client`, timeoutMs: 25000 },
    modelProbe: { command: process.execPath, args: [...probeBase, "--kind", "models"], source: `${provider}-official-client`, timeoutMs: 25000 },
    quotaProbe: { command: process.execPath, args: [...probeBase, "--kind", "quota"], source: `${provider}-official-client`, timeoutMs: 25000, intervalMs: 300000 },
    reconnect: { baseMs: 1000, maxMs: 30000 },
    tls: { rejectUnauthorized: true },
    adapter,
  };
}

export function buildHubConfig({ hubIp }) {
  return {
    host: hubIp,
    port: 8787,
    heartbeatMs: 5000,
    auth: { required: true, tokenEnv: "HUB_TOKEN" },
    tls: { enabled: false },
    allowPlaintextRemote: true,
    storage: { driver: "json-file", file: "../hub-state.json" },
    artifacts: { rootDirectory: "../artifacts", maxFileBytes: 104857600 },
    leases: { enabled: true, ttlMs: 30000, scanIntervalMs: 5000, maxRecoveryAttempts: 3 },
    delivery: { ackTimeoutMs: 3000, maxAttemptsPerConnection: 5 },
    messages: { maxInMemory: 10000 },
    logs: { file: "../logs/hub-events.jsonl", includePayloads: false },
  };
}

export function detectProviders(environment = process.env) {
  const detected = [];
  const codex = commandStatus("codex", ["login", "status"], environment);
  if (codex.ok) detected.push({ provider: "codex", command: codex.command, detail: codex.detail });
  const agyCommand = resolveAgyCommand("agy", environment);
  const antigravity = commandStatus(agyCommand, ["models"], environment, 20000);
  if (antigravity.ok) detected.push({ provider: "antigravity", command: agyCommand, detail: antigravity.detail });
  return detected;
}

async function prepare(args) {
  const mode = String(args.mode ?? "worker").toLowerCase();
  if (!['coordinator', 'worker', 'preflight'].includes(mode)) throw new Error("--mode must be coordinator, worker, or preflight");
  const hubIp = String(args["hub-ip"] ?? "");
  if (!net.isIPv4(hubIp)) throw new Error("--hub-ip must be an IPv4 address");
  const deviceId = sanitizeDeviceId(args["device-id"] ?? os.hostname());
  const fullAccess = String(args.access ?? "safe").toLowerCase() === "full";
  const detected = detectProviders();
  const configRoot = path.join(hubRoot, "var", "lan", "config");
  await mkdir(configRoot, { recursive: true });
  const workers = [];
  for (const provider of detected) {
    const config = buildWorkerConfig({ ...provider, mode: mode === "preflight" ? "worker" : mode, hubIp, deviceId, fullAccess });
    const file = path.join(configRoot, `worker.${config.agentId}.json`);
    await writeJsonAtomic(file, config);
    workers.push({ provider: provider.provider, agentId: config.agentId, roles: config.roles, configFile: file, command: provider.command, detail: provider.detail });
  }
  let hubConfigFile = null;
  if (mode === "coordinator") {
    hubConfigFile = path.join(configRoot, "hub.lan.json");
    await writeJsonAtomic(hubConfigFile, buildHubConfig({ hubIp }));
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    hubIp,
    deviceId,
    fullAccess,
    hubConfigFile,
    workers,
    consoleUrl: `http://${hubIp}:5173`,
    workerUrl: `ws://${hubIp}:8787/worker`,
  };
  const manifestFile = path.join(hubRoot, "var", "lan", `device-${deviceId}.json`);
  await writeJsonAtomic(manifestFile, manifest);
  return { ...manifest, manifestFile };
}

function commandStatus(command, args, environment, timeout = 10000) {
  const outcome = spawnSync(command, args, { encoding: "utf8", windowsHide: true, shell: false, timeout, env: environment });
  const detail = String(outcome.stdout || outcome.stderr || "").trim().split(/\r?\n/)[0] || null;
  return { ok: !outcome.error && outcome.status === 0, command, detail, error: outcome.error?.message ?? null };
}

function resolveAgyCommand(command, environment) {
  if (process.platform !== "win32" || command.toLowerCase() !== "agy") return command;
  const candidate = environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, "agy", "bin", "agy.exe") : null;
  return candidate && existsSync(candidate) ? candidate : command;
}

function sanitizeDeviceId(value) {
  const normalized = String(value ?? "device").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("device ID is empty after normalization");
  return normalized.slice(0, 64);
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}

if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(await prepare(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  }
}
