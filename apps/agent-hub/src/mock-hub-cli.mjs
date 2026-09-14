#!/usr/bin/env node
import path from "node:path";
import { AgentHub } from "./hub.mjs";
import { loadJsonConfig, parseArgs, resolveFrom } from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.config) {
  console.error("Usage: node src/mock-hub-cli.mjs --config <hub.json>");
  process.exit(2);
}

const loaded = await loadJsonConfig(args.config);
const config = loaded.data;
if (config.logs?.file) config.logs.file = resolveFrom(loaded.dir, config.logs.file);
if (config.tls?.keyFile) config.tls.keyFile = resolveFrom(loaded.dir, config.tls.keyFile);
if (config.tls?.certFile) config.tls.certFile = resolveFrom(loaded.dir, config.tls.certFile);

const hub = await new AgentHub(config).start();
console.log(`Mock Hub listening at ${hub.url()} (worker endpoint: ${hub.url().replace(/^http/, "ws")}/worker)`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping Hub after ${signal}`);
  await hub.stop();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
