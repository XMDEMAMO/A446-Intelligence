#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "../src/common.mjs";

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

export async function probeCodex(options = {}) {
  const checkedAt = new Date().toISOString();
  const client = new StdioRpcClient(String(options.command ?? "codex"), ["app-server", "--listen", "stdio://"], Number(options.timeoutMs ?? 15_000));
  await client.start();
  try {
    await client.request("initialize", {
      clientInfo: { name: "a446_lan_probe", title: "A446 LAN Provider Probe", version: "0.5.0" },
    });
    client.notify("initialized", {});
    const [accountResult, modelResult, rateLimitResult, usageResult] = await Promise.allSettled([
      client.request("account/read", { refreshToken: false }),
      client.request("model/list", { limit: 100, includeHidden: false }),
      client.request("account/rateLimits/read", {}),
      client.request("account/usage/read", {}),
    ]);
    const errors = {
      account: rejectionMessage(accountResult),
      models: rejectionMessage(modelResult),
      quota: rejectionMessage(rateLimitResult),
      usage: rejectionMessage(usageResult),
    };
    const all = {
      provider: "openai",
      source: "codex-app-server",
      checkedAt,
      account: accountResult.status === "fulfilled" ? normalizeCodexAccount(accountResult.value) : null,
      models: modelResult.status === "fulfilled" ? normalizeCodexModels(modelResult.value) : [],
      quota: rateLimitResult.status === "fulfilled" ? normalizeCodexRateLimits(rateLimitResult.value, checkedAt) : null,
      usage: usageResult.status === "fulfilled" ? usageResult.value : null,
      errors: Object.fromEntries(Object.entries(errors).filter(([, value]) => value)),
    };
    return selectKind(all, options.kind ?? "all");
  } finally {
    await client.stop();
  }
}

export async function probeAntigravity(options = {}) {
  const checkedAt = new Date().toISOString();
  const command = resolveAgyCommand(String(options.command ?? "agy"));
  const timeoutMs = Number(options.timeoutMs ?? 15_000);
  const output = await runCommand(command, ["models"], timeoutMs);
  const models = parseAntigravityModels(output.stdout);
  if (!models.length) throw new Error("Antigravity returned no model list");
  let quota = null;
  let quotaError = null;
  let clientVersion = null;
  try {
    const versionOutput = await runCommand(command, ["--version"], Math.min(timeoutMs, 10_000));
    clientVersion = parseSemanticVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (!clientVersion || !semanticVersionAtLeast(clientVersion, [1, 1, 12])) {
      quotaError = "Antigravity 1.1.12 or newer is required for a read-only machine-readable quota snapshot";
    } else {
      const usageOutput = await runCommand(command, ["-p", "/usage", "--output-format", "json"], Math.max(timeoutMs, 30_000));
      quota = normalizeAntigravityUsage(parseJsonOutput(usageOutput.stdout), checkedAt);
    }
  } catch (error) {
    quotaError = String(error?.message ?? error).slice(0, 500);
  }
  const device = String(process.env.A446_DEVICE_ID ?? process.env.COMPUTERNAME ?? "device").toLowerCase();
  const all = {
    provider: "google",
    source: "antigravity-cli",
    checkedAt,
    clientVersion,
    account: {
      id: String(process.env.A446_ANTIGRAVITY_ACCOUNT_ID ?? `${device}:antigravity-default`),
      provider: "google",
      plan: String(process.env.A446_ANTIGRAVITY_PLAN ?? "unknown"),
      label: String(process.env.A446_ANTIGRAVITY_ACCOUNT_LABEL ?? "Antigravity 当前账号（身份待人工标注）"),
      authMode: "client-session",
      identityVerified: false,
    },
    models,
    quota: quota ?? {
      state: "Unknown",
      checkedAt,
      source: "antigravity-cli-usage-unavailable",
      windows: [],
      errorSummary: quotaError ?? "Antigravity quota snapshot is unavailable",
    },
    usage: null,
    errors: {},
  };
  return selectKind(all, options.kind ?? "all");
}

export function normalizeCodexAccount(result) {
  const account = result?.account;
  if (!account || typeof account !== "object") return null;
  const email = typeof account.email === "string" && account.email ? account.email : null;
  const type = String(account.type ?? "unknown");
  const plan = account.planType ? String(account.planType) : "unknown";
  const identity = email ?? `${type}:${plan}`;
  return {
    id: `openai-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
    provider: "openai",
    plan,
    label: email ?? `Codex ${type} account`,
    authMode: type,
    identityVerified: Boolean(email),
  };
}

export function normalizeCodexModels(result) {
  const items = Array.isArray(result?.data) ? result.data : [];
  return items.filter((item) => item && item.hidden !== true && (item.id || item.model)).map((item) => ({
    id: String(item.id ?? item.model),
    label: item.displayName ? String(item.displayName) : String(item.id ?? item.model),
    family: "codex",
    quotaGroup: "Codex",
    enabled: true,
    capabilities: [],
    reasoningEfforts: Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.map((entry) => String(entry?.reasoningEffort ?? entry)).filter(Boolean)
      : [],
    defaultReasoningEffort: item.defaultReasoningEffort ? String(item.defaultReasoningEffort) : null,
    inputModalities: Array.isArray(item.inputModalities) ? item.inputModalities.map(String) : [],
    isDefault: Boolean(item.isDefault),
  }));
}

export function normalizeCodexRateLimits(result, checkedAt = new Date().toISOString()) {
  const buckets = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === "object"
    ? Object.values(result.rateLimitsByLimitId)
    : result?.rateLimits ? [result.rateLimits] : [];
  const windows = [];
  let reached = false;
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    if (bucket.rateLimitReachedType) reached = true;
    for (const slot of ["primary", "secondary"]) {
      const value = bucket[slot];
      if (!value || typeof value !== "object") continue;
      const usedPercent = finitePercent(value.usedPercent);
      const quotaGroup = normalizeCodexQuotaGroup(bucket.limitName ?? bucket.limitId);
      const durationMinutes = quotaDurationMinutes(
        value.windowDurationMins ?? value.windowDurationMinutes ?? value.window_minutes,
        slot,
      );
      const windowType = quotaWindowType(value.window ?? value.name ?? value.id, durationMinutes, slot);
      windows.push({
        id: `${String(bucket.limitId ?? quotaGroup)}:${slot}`,
        name: `${quotaGroup} ${windowType}`,
        quotaGroup,
        windowType,
        durationMinutes,
        usedPercent,
        remainingPercent: usedPercent == null ? null : Math.max(0, 100 - usedPercent),
        resetsAt: toIsoTimestamp(value.resetsAt),
      });
    }
  }
  const remaining = windows.map((window) => window.remainingPercent).filter((value) => value != null);
  const state = reached || remaining.some((value) => value <= 0)
    ? "Exhausted"
    : remaining.some((value) => value <= 10)
      ? "Low"
      : windows.length ? "Healthy" : "Unknown";
  return { state, checkedAt, source: "codex-app-server", windows };
}

export function parseAntigravityModels(output) {
  return String(output ?? "").split(/\r?\n/).map((line) => line.trim()).map((line) => {
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match || !/^(?:gemini|claude|gpt)-/i.test(match[1])) return null;
    const effort = modelEffort(match[1], match[2]);
    const family = modelFamily(match[1]);
    return {
      id: match[1],
      label: match[2].trim(),
      family,
      quotaGroup: antigravityQuotaGroup(family),
      enabled: true,
      capabilities: [],
      reasoningEfforts: effort ? [effort] : [],
    };
  }).filter(Boolean);
}

export function normalizeAntigravityUsage(result, checkedAt = new Date().toISOString()) {
  const groups = locateQuotaGroups(result);
  const windows = [];
  for (const group of groups) {
    const rawGroupName = String(group?.name ?? group?.label ?? group?.title ?? group?.id ?? "Antigravity");
    const quotaGroup = antigravityQuotaGroup(rawGroupName);
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const remainingPercent = quotaRemainingPercent(bucket);
      const rawWindow = bucket?.window ?? bucket?.name ?? bucket?.id ?? "quota";
      const windowType = quotaWindowType(rawWindow);
      const durationMinutes = quotaDurationMinutes(null, windowType);
      windows.push({
        name: `${quotaGroup} ${String(bucket?.name ?? rawWindow)}`,
        quotaGroup,
        windowType,
        durationMinutes,
        remainingPercent,
        usedPercent: remainingPercent == null ? null : Math.max(0, 100 - remainingPercent),
        resetsAt: normalizeIsoTime(bucket?.reset_time ?? bucket?.resetTime ?? bucket?.resetsAt),
        ...(bucket?.id ? { id: String(bucket.id) } : {}),
      });
    }
  }
  const remaining = windows.map((window) => window.remainingPercent).filter((value) => value != null);
  const state = remaining.some((value) => value <= 0)
    ? "Exhausted"
    : remaining.some((value) => value <= 10)
      ? "Low"
      : remaining.length ? "Healthy" : "Unknown";
  return {
    state,
    checkedAt,
    source: "antigravity-cli-usage",
    windows,
    ...(remaining.length ? {} : { errorSummary: "Antigravity returned no enabled numeric quota windows" }),
  };
}

function selectKind(all, kind) {
  if (kind === "all") return all;
  if (kind === "account") {
    if (!all.account) throw new Error(all.errors?.account ?? "No active account was reported by the official client");
    return { source: all.source, checkedAt: all.checkedAt, account: all.account };
  }
  if (kind === "models") {
    if (!all.models?.length) throw new Error(all.errors?.models ?? "No models were reported by the official client");
    return { source: all.source, checkedAt: all.checkedAt, models: all.models };
  }
  if (kind === "quota") {
    if (!all.quota) throw new Error(all.errors?.quota ?? "No quota snapshot was reported by the official client");
    return all.quota;
  }
  if (kind === "usage") {
    if (!all.usage) throw new Error(all.errors?.usage ?? "No usage snapshot was reported by the official client");
    return { source: all.source, checkedAt: all.checkedAt, ...all.usage };
  }
  throw new Error("--kind must be all, account, models, quota, or usage");
}

class StdioRpcClient {
  constructor(command, args, timeoutMs) {
    this.command = command;
    this.args = args;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
  }

  async start() {
    this.child = spawn(this.command, this.args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000); });
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    this.child.once("exit", (code, signal) => {
      const detail = this.stderr.trim() || `code=${code}, signal=${signal ?? "none"}`;
      for (const pending of this.pending.values()) pending.reject(new Error(`Codex app-server exited: ${detail}`));
      this.pending.clear();
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.write({ method, id, params });
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server stdin is unavailable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id == null || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`${message.error.code ?? "RPC_ERROR"}: ${message.error.message ?? "request failed"}`));
    else pending.resolve(message.result);
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    if (child.stdin.writable) child.stdin.end();
    if (child.exitCode == null) child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-200_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}: ${stderr.trim() || "no stderr"}`));
    });
  });
}

function resolveAgyCommand(command) {
  if (process.platform !== "win32" || command.toLowerCase() !== "agy") return command;
  const candidate = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe") : null;
  return candidate && existsSync(candidate) ? candidate : command;
}

function rejectionMessage(result) {
  return result.status === "rejected" ? String(result.reason?.message ?? result.reason) : null;
}

function parseSemanticVersion(output) {
  const match = String(output ?? "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function semanticVersionAtLeast(actual, minimum) {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function parseJsonOutput(output) {
  const text = String(output ?? "").trim();
  try { return JSON.parse(text); } catch {}
  for (const line of text.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  throw new Error("Antigravity usage command did not return JSON");
}

function locateQuotaGroups(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value.groups)) return value.groups;
  for (const child of Object.values(value)) {
    const found = locateQuotaGroups(child, seen);
    if (found.length) return found;
  }
  return [];
}

function quotaRemainingPercent(bucket) {
  for (const key of ["remainingPercent", "remaining_percent", "remainingPercentage", "remaining_percentage"]) {
    const value = Number(bucket?.[key]);
    if (Number.isFinite(value)) return roundPercent(value);
  }
  for (const key of ["remaining_fraction", "remainingFraction"]) {
    const value = Number(bucket?.[key]);
    if (Number.isFinite(value)) return roundPercent(value * 100);
  }
  return null;
}

function roundPercent(value) {
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
}

function normalizeIsoTime(value) {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000).toISOString();
}

function modelEffort(id, label) {
  const fromId = String(id).match(/-(low|medium|high)$/i)?.[1];
  const fromLabel = String(label).match(/\((low|medium|high)\)\s*$/i)?.[1];
  return String(fromId ?? fromLabel ?? "").toLowerCase() || null;
}

function modelFamily(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.startsWith("gemini-")) return "gemini";
  if (normalized.startsWith("claude-")) return "claude";
  if (normalized.startsWith("gpt-")) return "gpt";
  return "unknown";
}

function antigravityQuotaGroup(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("gemini")) return "Gemini Models";
  if (normalized.includes("claude") || normalized.includes("gpt") || normalized === "3p") return "Claude and GPT models";
  return String(value ?? "Antigravity");
}

function normalizeCodexQuotaGroup(value) {
  const label = String(value ?? "Codex").trim();
  return /^codex$/i.test(label) ? "Codex" : label;
}

function quotaWindowType(value, durationMinutes = null, fallback = null) {
  if (durationMinutes === 300) return "5h";
  if (durationMinutes === 10_080) return "7d";
  const normalized = String(value ?? fallback ?? "").toLowerCase();
  if (/(?:^|[^a-z0-9])5\s*(?:h|hour)|five[ -]?hour/.test(normalized)) return "5h";
  if (/weekly|week|(?:^|[^a-z0-9])7\s*d/.test(normalized)) return "7d";
  return normalized || String(fallback ?? "quota");
}

function quotaDurationMinutes(value, fallback = null) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const type = quotaWindowType(fallback);
  if (type === "5h" || type === "primary") return 300;
  if (type === "7d" || type === "secondary") return 10_080;
  return null;
}

function finitePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function toIsoTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const provider = String(args.provider ?? "").toLowerCase();
    const kind = String(args.kind ?? "all").toLowerCase();
    const timeoutMs = Math.max(1000, Number(args["timeout-ms"] ?? 15_000));
    const cacheFile = args["cache-file"] ? path.resolve(String(args["cache-file"])) : null;
    const maxAgeMs = Math.max(0, Number(args["max-age-ms"] ?? 30_000));
    let all = cacheFile ? await readFreshCache(cacheFile, provider, maxAgeMs) : null;
    if (!all) {
      all = provider === "codex"
        ? await probeCodex({ command: args.command ?? "codex", kind: "all", timeoutMs })
        : provider === "antigravity"
          ? await probeAntigravity({ command: args.command ?? "agy", kind: "all", timeoutMs })
          : (() => { throw new Error("--provider must be codex or antigravity"); })();
      if (cacheFile) await writeCache(cacheFile, all);
    }
    const result = selectKind(all, kind);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  }
}

async function readFreshCache(file, provider, maxAgeMs) {
  try {
    const cached = JSON.parse(await readFile(file, "utf8"));
    const age = Date.now() - Date.parse(cached.checkedAt);
    return cached.provider === (provider === "codex" ? "openai" : "google") && Number.isFinite(age) && age >= 0 && age <= maxAgeMs ? cached : null;
  } catch (error) {
    if (error.code === "ENOENT" || error.name === "SyntaxError") return null;
    throw error;
  }
}

async function writeCache(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}
