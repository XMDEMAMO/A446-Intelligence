import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function probeLocalCapabilities(config) {
  const checkedAt = new Date().toISOString();
  const tools = [];
  const configured = Array.isArray(config.capabilityProbe?.tools) ? config.capabilityProbe.tools : [];
  for (const tool of configured) tools.push(probeTool(tool, config.capabilityProbe));

  const adapterTool = adapterProbe(config.adapter);
  const adapter = adapterTool ? probeAdapter(adapterTool, config.capabilityProbe) : {
    name: config.adapter?.type ?? "mock",
    command: null,
    available: true,
    ready: true,
    version: "built-in",
  };

  return {
    schemaVersion: 1,
    checkedAt,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    adapter,
    tools,
  };
}

export function initialExecutorStatus(adapterType, observed) {
  return {
    type: adapterType,
    health: observed.adapter.available && observed.adapter.ready !== false ? "Healthy" : "Unhealthy",
    quota: "Unknown",
    checkedAt: observed.checkedAt,
    lastError: observed.adapter.available && observed.adapter.ready !== false
      ? null
      : { name: "CapabilityProbeError", message: observed.adapter.readiness?.error ?? observed.adapter.error ?? "adapter is not ready" },
  };
}

export function statusAfterSuccess(current) {
  return {
    ...current,
    health: "Healthy",
    quota: "Healthy",
    checkedAt: new Date().toISOString(),
    lastError: null,
  };
}

export function statusAfterError(current, error) {
  const message = String(error?.message ?? error);
  const normalized = message.toLowerCase();
  let quota = current.quota ?? "Unknown";
  let health = "Degraded";
  if (/quota[_\s-]*exhaust|resource[_\s-]*exhaust|usage limit|credits? exhausted|insufficient quota/.test(normalized)) {
    quota = "Exhausted";
    health = "Unhealthy";
  } else if (/rate[_\s-]*limit|too many requests|\b429\b/.test(normalized)) {
    quota = "Low";
  } else if (/not logged in|unauthorized|forbidden|authentication|login required|location is not supported/.test(normalized)) {
    health = "Unhealthy";
  }
  return {
    ...current,
    health,
    quota,
    checkedAt: new Date().toISOString(),
    lastError: { name: error?.name ?? "Error", message: message.slice(0, 500) },
  };
}

function probeTool(tool, probeConfig = {}) {
  const name = String(tool.name ?? tool.command ?? "tool");
  const command = resolveKnownCommand(String(tool.command ?? name));
  const args = Array.isArray(tool.args) ? tool.args : ["--version"];
  if (looksLikePath(command) && !existsSync(command)) {
    return { name, command, available: false, version: null, error: "file not found" };
  }
  const outcome = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: Number(probeConfig.timeoutMs ?? 5000),
    env: cleanedEnvironment(Boolean(probeConfig.stripProxyEnv)),
  });
  const firstLine = String(outcome.stdout || outcome.stderr || "").trim().split(/\r?\n/)[0] || null;
  return {
    name,
    command,
    available: !outcome.error && outcome.status === 0,
    version: !outcome.error && outcome.status === 0 ? firstLine : null,
    ...(!outcome.error && outcome.status === 0 ? {} : { error: outcome.error?.message ?? firstLine ?? `exit ${outcome.status}` }),
  };
}

function probeAdapter(spec, probeConfig = {}) {
  const binary = probeTool(spec, probeConfig);
  if (!binary.available || probeConfig.readiness === false || !spec.readinessArgs) {
    return { ...binary, ready: binary.available };
  }
  const readiness = probeTool({
    name: `${spec.name}-readiness`,
    command: spec.command,
    args: spec.readinessArgs,
  }, probeConfig);
  return {
    ...binary,
    ready: readiness.available,
    readiness: {
      checked: true,
      detail: readiness.version,
      ...(!readiness.available ? { error: readiness.error } : {}),
    },
  };
}

function adapterProbe(adapter = {}) {
  if (adapter.type === "codex") {
    return { name: "codex", command: adapter.command ?? "codex", args: ["--version"], readinessArgs: ["login", "status"] };
  }
  if (adapter.type === "antigravity") {
    return { name: "antigravity", command: adapter.command ?? "agy", args: ["--version"], readinessArgs: ["models"] };
  }
  if (adapter.type === "stdio-json" && adapter.command) return { name: "stdio-json", command: adapter.command, args: adapter.probeArgs ?? ["--version"] };
  return null;
}

function resolveKnownCommand(command) {
  if (process.platform !== "win32" || command.toLowerCase() !== "agy") return command;
  const base = process.env.LOCALAPPDATA;
  if (!base) return command;
  const candidate = path.join(base, "agy", "bin", "agy.exe");
  return existsSync(candidate) ? candidate : command;
}

function looksLikePath(command) {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function cleanedEnvironment(stripProxyEnv) {
  const env = { ...process.env };
  if (stripProxyEnv) {
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[name];
  }
  return env;
}

\n