#!/usr/bin/env node
import { AgentWorker } from "./worker.mjs";
import { loadJsonConfig, parseArgs, resolveFrom } from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.config) {
  console.error("Usage: node src/worker-cli.mjs --config <worker.json>");
  process.exit(2);
}
const loaded = await loadJsonConfig(args.config);
const config = loaded.data;
config.stateFile = resolveFrom(loaded.dir, config.stateFile ?? `../var/${config.agentId}-state.json`);
config.workspace = resolveFrom(loaded.dir, config.workspace ?? "../workspaces/default");
if (config.tls?.caFile) config.tls.caFile = resolveFrom(loaded.dir, config.tls.caFile);
if (Array.isArray(config.policy?.allowedRoots)) {
  config.policy.allowedRoots = config.policy.allowedRoots.map((item) => resolveFrom(loaded.dir, item));
}
if (config.checkpoints?.directory) config.checkpoints.directory = resolveFrom(loaded.dir, config.checkpoints.directory);

const worker = await new AgentWorker(config).start();
console.log(`[${config.agentId}] worker started with ${worker.adapter.type}; Hub: ${config.hubUrl}`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[${config.agentId}] stopping after ${signal}`);
  await worker.stop();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

\n