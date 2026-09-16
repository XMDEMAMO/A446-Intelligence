import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeModels } from "./collaboration.mjs";
import { probeJson } from "./quota-probe.mjs";

export function probeLocalCapabilities(config, previous = null) {
  const checkedAt = new Date().toISOString();
  const probeConfig = config.capabilityProbe ?? {};
  const configured = Array.isArray(probeConfig.tools) ? probeConfig.tools : [];
  const previousTools = new Map((previous?.tools ?? []).map((tool) => [tool.name, tool]));
  const tools = configured.map((tool) => stabilizeProbe(
    probeTool(tool, probeConfig),
    previousTools.get(String(tool.name ?? tool.command ?? "tool")),
    checkedAt,
    tool.source ?? "configured-tool",
  ));

  const adapterTool = adapterProbe(config.adapter);
  const rawAdapter = adapterTool ? probeAdapter(adapterTool, probeConfig) : {
    name: config.adapter?.type ?? "mock",
    command: null,
    available: true,
    ready: true,
    version: "built-in",
  };
  const adapter = stabilizeProbe(rawAdapter, previous?.adapter, checkedAt, "adapter-client", (value) => value.available && value.ready !== false);
  const device = probeDeviceCapabilities(probeConfig.device ?? {}, previous?.device, checkedAt, probeConfig);
  const services = probeConfiguredCollection(probeConfig.services, previous?.services, checkedAt, probeConfig, "configured-service");
  const resources = [adapter, ...tools, ...services, ...deviceResources(device)];
  const stale = resources.some((item) => item?.stale);
  const unavailable = resources.some((item) => item?.state === "unavailable");

  return {
    schemaVersion: 2,
    state: stale ? "stale" : unavailable ? "unavailable" : "available",
    source: "local-resource-probe",
    checkedAt,
    lastSuccessAt: stale || unavailable ? previous?.lastSuccessAt ?? null : checkedAt,
    stale,
    errorSummary: summarizeErrors(resources),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    adapter,
    tools,
    services,
    device,
  };
}

export async function probeConfiguredModels(config, previous = null, context = {}) {
  const checkedAt = new Date().toISOString();
  const spec = config.modelProbe ?? config.capabilityProbe?.models;
  const configured = normalizeModels(config.models, config.adapter).map((model) => ({
    ...model,
    availability: "unknown",
    source: "config",
    checkedAt,
    stale: false,
    errorSummary: null,
  }));
  if (!spec?.command) {
    return {
      state: "unknown",
      source: configured.length ? "config" : "unavailable",
      checkedAt,
      lastSuccessAt: null,
      stale: false,
      errorSummary: null,
      items: configured,
    };
  }

  try {
    const payload = await probeJson(spec, context);
    const source = String(payload?.source ?? spec.source ?? "official-client");
    const rawModels = Array.isArray(payload) ? payload : payload?.models;
    if (!Array.isArray(rawModels)) throw new Error("model probe output must contain a models array");
    const configuredById = new Map(configured.map((model) => [model.id, model]));
    const discovered = normalizeModels(rawModels).map((model) => {
      const fallback = configuredById.get(model.id);
      return {
        ...fallback,
        ...model,
        label: model.label ?? fallback?.label,
        capabilities: model.capabilities?.length ? model.capabilities : fallback?.capabilities ?? [],
        reasoningEfforts: model.reasoningEfforts?.length ? model.reasoningEfforts : fallback?.reasoningEfforts ?? [],
        availability: model.enabled === false ? "unavailable" : "available",
        source,
        checkedAt,
        lastSuccessAt: checkedAt,
        stale: false,
        errorSummary: null,
      };
    });
    return {
      state: "available",
      source,
      checkedAt,
      lastSuccessAt: checkedAt,
      stale: false,
      errorSummary: null,
      items: discovered,
    };
  } catch (error) {
    const errorSummary = safeMessage(error);
    if (previous?.lastSuccessAt && Array.isArray(previous.items)) {
      return {
        ...previous,
        state: "stale",
        checkedAt,
        stale: true,
        errorSummary,
        items: previous.items.map((model) => ({ ...model, availability: "stale", checkedAt, stale: true, errorSummary })),
      };
    }
    return {
      state: configured.length ? "unknown" : "unavailable",
      source: configured.length ? "config" : String(spec.source ?? "official-client"),
      checkedAt,
      lastSuccessAt: null,
      stale: false,
      errorSummary,
      items: configured.map((model) => ({ ...model, errorSummary })),
    };
  }
}

export function schedulingCapabilities(config, observed) {
  const capabilities = new Set((config.capabilities ?? ["task.execute", "pause", "resume", "cancel"]).map(String));
  const resources = [
    ...(observed?.tools ?? []),
    ...(observed?.services ?? []),
    ...deviceResources(observed?.device),
  ];
  for (const resource of resources) {
    if (!resource || !["available", "stale"].includes(resource.state)) continue;
    for (const capability of resource.capabilities ?? []) capabilities.add(String(capability));
  }
  return [...capabilities];
}

export function initialExecutorStatus(adapterType, observed) {
  return {
    type: adapterType,
    health: observed.adapter.state === "available" || observed.adapter.state === "stale" ? "Healthy" : "Unhealthy",
    quota: "Unknown",
    checkedAt: observed.checkedAt,
    lastError: ["available", "stale"].includes(observed.adapter.state)
      ? null
      : { name: "CapabilityProbeError", message: observed.adapter.errorSummary ?? "adapter is not ready" },
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

function probeDeviceCapabilities(deviceConfig, previous, checkedAt, probeConfig) {
  const cpus = os.cpus();
  const system = {
    state: "available",
    source: "node:os",
    checkedAt,
    lastSuccessAt: checkedAt,
    stale: false,
    errorSummary: null,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
  };
  const cpu = {
    state: cpus.length ? "available" : "unknown",
    source: "node:os",
    checkedAt,
    lastSuccessAt: cpus.length ? checkedAt : null,
    stale: false,
    errorSummary: null,
    model: cpus[0]?.model?.trim() || null,
    logicalCores: cpus.length,
  };
  const memory = {
    state: "available",
    source: "node:os",
    checkedAt,
    lastSuccessAt: checkedAt,
    stale: false,
    errorSummary: null,
    totalBytes: os.totalmem(),
    freeBytes: os.freemem(),
  };
  return {
    system,
    cpu,
    memory,
    node: {
      state: "available",
      source: "node:process",
      checkedAt,
      lastSuccessAt: checkedAt,
      stale: false,
      errorSummary: null,
      version: process.version,
    },
    python: probeOptionalResource("python", deviceConfig.python, previous?.python, checkedAt, probeConfig),
    gpu: probeOptionalResource("gpu", deviceConfig.gpu, previous?.gpu, checkedAt, probeConfig),
    browsers: probeConfiguredCollection(deviceConfig.browsers, previous?.browsers, checkedAt, probeConfig, "configured-browser"),
  };
}

function probeOptionalResource(name, spec, previous, checkedAt, probeConfig) {
  if (!spec) return unknownResource(name, checkedAt);
  if (!spec.command) {
    if (typeof spec.available !== "boolean") return { ...unknownResource(name, checkedAt), description: safeDescription(spec.description), capabilities: stringList(spec.capabilities ?? spec.capability) };
    return stabilizeProbe({
      name: String(spec.name ?? name),
      available: spec.available,
      version: spec.version ? String(spec.version) : null,
      description: safeDescription(spec.description),
      capabilities: stringList(spec.capabilities ?? spec.capability),
      ...(!spec.available ? { error: "configured as unavailable" } : {}),
    }, previous, checkedAt, spec.source ?? "config");
  }
  return stabilizeProbe(probeTool({ name, ...spec }, probeConfig), previous, checkedAt, spec.source ?? "configured-device-probe");
}

function probeConfiguredCollection(value, previousValue, checkedAt, probeConfig, defaultSource) {
  const specs = Array.isArray(value) ? value : [];
  const previous = new Map((previousValue ?? []).map((item) => [item.name, item]));
  return specs.map((spec) => {
    const name = String(spec.name ?? spec.command ?? "resource");
    const withSource = { ...spec, source: spec.source ?? defaultSource };
    return probeOptionalResource(name, withSource, previous.get(name), checkedAt, probeConfig);
  });
}

function stabilizeProbe(current, previous, checkedAt, source, success = (value) => value.available) {
  const base = {
    ...current,
    source: String(source ?? "local-probe"),
    checkedAt,
    capabilities: stringList(current.capabilities),
  };
  if (success(current)) {
    return {
      ...base,
      state: "available",
      lastSuccessAt: checkedAt,
      stale: false,
      errorSummary: null,
    };
  }
  const errorSummary = safeMessage(current.error ?? current.readiness?.error ?? "probe unavailable");
  if (previous?.lastSuccessAt && ["available", "stale"].includes(previous.state)) {
    return {
      ...previous,
      name: base.name ?? previous.name,
      command: base.command ?? previous.command,
      checkedAt,
      state: "stale",
      stale: true,
      errorSummary,
    };
  }
  return {
    ...base,
    state: "unavailable",
    lastSuccessAt: null,
    stale: false,
    errorSummary,
  };
}

function unknownResource(name, checkedAt) {
  return {
    name,
    state: "unknown",
    source: "unconfigured",
    checkedAt,
    lastSuccessAt: null,
    stale: false,
    errorSummary: null,
    available: null,
    version: null,
    capabilities: [],
  };
}

function probeTool(tool, probeConfig = {}) {
  const name = String(tool.name ?? tool.command ?? "tool");
  const command = resolveKnownCommand(String(tool.command ?? name));
  const args = Array.isArray(tool.args) ? tool.args : ["--version"];
  const details = {
    name,
    command,
    description: safeDescription(tool.description),
    capabilities: stringList(tool.capabilities ?? tool.capability),
  };
  if (looksLikePath(command) && !existsSync(command)) {
    return { ...details, available: false, version: null, error: "file not found" };
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
    ...details,
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

function deviceResources(device) {
  return device ? [device.system, device.cpu, device.memory, device.node, device.python, device.gpu, ...(device.browsers ?? [])] : [];
}

function summarizeErrors(resources) {
  const errors = resources.filter(Boolean).map((item) => item.errorSummary).filter(Boolean);
  return errors.length ? [...new Set(errors)].join("; ").slice(0, 500) : null;
}

function stringList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(String).filter(Boolean))];
}

function safeDescription(value) {
  return value ? String(value).slice(0, 500) : undefined;
}

function safeMessage(value) {
  return String(value?.message ?? value ?? "probe failed").slice(0, 500);
}
