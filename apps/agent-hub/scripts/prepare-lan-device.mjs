#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
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

export function detectProviderInventory(environment = process.env, dependencies = {}) {
  const detected = [];
  const runner = dependencies.commandStatus ?? commandStatus;
  const codexCandidates = dependencies.codexCandidates ?? resolveCodexCandidates(environment);
  const codex = selectReadyCommand(codexCandidates, ["login", "status"], environment, runner);
  if (codex.selected) detected.push({ provider: "codex", command: codex.selected.command, detail: codex.selected.detail });

  const agyCommand = dependencies.agyCommand ?? resolveAgyCommand("agy", environment);
  const antigravity = selectReadyCommand([agyCommand], ["models"], environment, runner, 20000);
  if (antigravity.selected) detected.push({ provider: "antigravity", command: antigravity.selected.command, detail: antigravity.selected.detail });

  return {
    providers: detected,
    diagnostics: [
      providerDiagnostic("codex", codex, "No discovered Codex executable reported an active login."),
      providerDiagnostic("antigravity", antigravity, "Antigravity CLI is unavailable or not ready."),
    ],
  };
}

export function detectProviders(environment = process.env, dependencies = {}) {
  return detectProviderInventory(environment, dependencies).providers;
}

export function selectReadyCommand(candidates, args, environment, runner = commandStatus, timeout = 10000) {
  const attempts = [];
  for (const command of uniqueCommands(candidates)) {
    const outcome = runner(command, args, environment, timeout);
    attempts.push(outcome);
    if (outcome.ok) return { selected: outcome, attempts };
  }
  return { selected: null, attempts };
}

async function prepare(args) {
  const mode = String(args.mode ?? "worker").toLowerCase();
  if (!['coordinator', 'worker', 'preflight'].includes(mode)) throw new Error("--mode must be coordinator, worker, or preflight");
  const hubIp = String(args["hub-ip"] ?? "");
  if (!net.isIPv4(hubIp)) throw new Error("--hub-ip must be an IPv4 address");
  const deviceId = sanitizeDeviceId(args["device-id"] ?? os.hostname());
  const fullAccess = String(args.access ?? "safe").toLowerCase() === "full";
  const inventory = detectProviderInventory();
  const detected = inventory.providers;
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
    providerDiagnostics: inventory.diagnostics,
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
  return { ok: !outcome.error && outcome.status === 0, command, detail, error: outcome.error?.message ?? null, exitCode: outcome.status };
}

export function resolveCodexCandidates(environment = process.env) {
  const candidates = [];
  if (environment.A446_CODEX_EXE) candidates.push(String(environment.A446_CODEX_EXE));
  if (process.platform !== "win32") return uniqueCommands([...candidates, "codex"]);

  if (environment.LOCALAPPDATA) {
    candidates.push(...findExecutables(path.join(environment.LOCALAPPDATA, "OpenAI", "Codex", "bin"), "codex.exe"));
  }
  const located = spawnSync("where.exe", ["codex.exe"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 5000,
    env: environment,
  });
  if (!located.error && located.status === 0) {
    candidates.push(...String(located.stdout ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
  }
  // Deliberately avoid codex.cmd here. Worker processes require a directly
  // spawnable executable so probes and task execution use the same login.
  return uniqueCommands([...candidates, "codex.exe"]);
}

function resolveAgyCommand(command, environment) {
  if (process.platform !== "win32" || command.toLowerCase() !== "agy") return command;
  const candidate = environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, "agy", "bin", "agy.exe") : null;
  return candidate && existsSync(candidate) ? candidate : command;
}

function findExecutables(root, fileName, maxDepth = 4) {
  if (!root || !existsSync(root)) return [];
  const found = [];
  const visit = (directory, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) found.push(candidate);
    }
  };
  visit(root, 0);
  return found.sort((left, right) => fileModifiedAt(right) - fileModifiedAt(left));
}

function fileModifiedAt(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

function uniqueCommands(values) {
  const seen = new Set();
  return values.filter(Boolean).filter((value) => {
    const key = process.platform === "win32" ? String(value).toLowerCase() : String(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function providerDiagnostic(provider, result, fallback) {
  return {
    provider,
    ready: Boolean(result.selected),
    selectedCommand: result.selected?.command ?? null,
    attempts: result.attempts,
    errorSummary: result.selected ? null : result.attempts.length ? fallback : `No ${provider} command candidate was found.`,
  };
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
