#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadJsonConfig, parseArgs, resolveFrom } from "../src/common.mjs";
import { probeLocalCapabilities } from "../src/capability-probe.mjs";

const args = parseArgs(process.argv.slice(2));
const results = [];
const major = Number(process.versions.node.split(".")[0]);
results.push({ check: "Node.js >= 20", ok: major >= 20, detail: process.version });
results.push({ check: "Platform", ok: true, detail: `${process.platform}/${process.arch}` });

if (args.config) {
  const loaded = await loadJsonConfig(args.config);
  const config = loaded.data;
  results.push({ check: "agentId", ok: Boolean(config.agentId), detail: config.agentId ?? "missing" });
  results.push({ check: "hubUrl", ok: /^wss?:\/\//.test(config.hubUrl ?? ""), detail: config.hubUrl ?? "missing" });
  config.workspace = resolveFrom(loaded.dir, config.workspace ?? "../workspaces/default");
  if (config.stateFile) {
    results.push({ check: "state path", ok: true, detail: resolveFrom(loaded.dir, config.stateFile) });
  }
  results.push({ check: "workspace", ok: true, detail: config.workspace });
  results.push({
    check: "local policy",
    ok: true,
    detail: `taskSpec=${config.policy?.requireTaskSpec ? "required" : "compatible"}; default-deny=${config.policy?.defaultDenyUnknownPermissions !== false}`,
  });
  const observed = probeLocalCapabilities(config);
  results.push({
    check: `adapter ${observed.adapter.name}`,
    ok: observed.adapter.available && observed.adapter.ready !== false,
    detail: [
      observed.adapter.version ?? observed.adapter.error ?? "unknown",
      observed.adapter.readiness?.detail ?? observed.adapter.readiness?.error,
    ].filter(Boolean).join("; "),
  });
  for (const tool of observed.tools) {
    results.push({ check: `capability ${tool.name}`, ok: tool.available, detail: tool.version ?? tool.error ?? "unknown" });
  }
  results.push({
    check: "quota telemetry",
    ok: true,
    detail: "Unknown before execution; runtime reports Healthy/Low/Exhausted from trusted outcomes",
  });
}

if (args.codex) {
  checkCommand("codex", ["--version"]);
  const auth = spawnSync("codex", ["login", "status"], { encoding: "utf8", windowsHide: true });
  results.push({ check: "Codex login", ok: auth.status === 0, detail: (auth.stdout || auth.stderr).trim() });
}

for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.check}: ${result.detail}`);
}
process.exitCode = results.some((result) => !result.ok) ? 1 : 0;

function checkCommand(command, commandArgs) {
  if (!command) {
    results.push({ check: "adapter command", ok: false, detail: "missing" });
    return;
  }
  if ((command.includes("/") || command.includes("\\")) && !existsSync(path.resolve(command))) {
    results.push({ check: `command ${command}`, ok: false, detail: "file not found" });
    return;
  }
  const outcome = spawnSync(command, commandArgs, { encoding: "utf8", windowsHide: true, timeout: 5000 });
  results.push({
    check: `command ${command}`,
    ok: !outcome.error && outcome.status === 0,
    detail: outcome.error?.message ?? (outcome.stdout || outcome.stderr).trim().split(/\r?\n/)[0] ?? "",
  });
}

\n