#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { AgentHub } from "../../agent-hub/src/hub.mjs";
import { loadJsonConfig, parseArgs, resolveFrom } from "../../agent-hub/src/common.mjs";
import { PostgresHubStore } from "./postgres-hub-store.mjs";
import { IdentityService } from "./identity-service.mjs";
import { LocalArtifactStore } from "./local-artifact-store.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.config) {
  console.error("Usage: node src/server-hub-cli.mjs --config <server-hub.json>");
  process.exit(2);
}

const loaded = await loadJsonConfig(args.config);
const config = loaded.data;
if (config.storage?.driver !== "postgres") throw new Error("Server Hub requires storage.driver=postgres");
if (config.logs?.file) config.logs.file = resolveFrom(loaded.dir, config.logs.file);
if (config.tls?.keyFile) config.tls.keyFile = resolveFrom(loaded.dir, config.tls.keyFile);
if (config.tls?.certFile) config.tls.certFile = resolveFrom(loaded.dir, config.tls.certFile);

const connectionStringEnv = config.storage.connectionStringEnv ?? "A446_DATABASE_URL";
const connectionString = process.env[connectionStringEnv];
if (!connectionString) throw new Error(`Server Hub database connection is missing from ${connectionStringEnv}`);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new PostgresHubStore({
  connectionString,
  maxConnections: config.storage.maxConnections,
  ssl: config.storage.ssl,
  migrationsDirectory: path.join(packageRoot, "migrations"),
});
if (config.auth?.mode !== "identity") throw new Error("Server Hub requires auth.mode=identity");
const artifactRootEnv = config.artifacts?.rootDirectoryEnv ?? "A446_ARTIFACT_ROOT";
const artifactRoot = process.env[artifactRootEnv];
if (!artifactRoot) throw new Error(`Server Hub artifact root is missing from ${artifactRootEnv}`);
const authService = new IdentityService({
  pool: store.pool,
  sessionTtlMs: config.auth.sessionTtlMs,
  cookieName: config.auth.cookieName,
  secureCookies: config.auth.secureCookies !== false,
  allowedOrigins: config.auth.allowedOrigins,
});
const artifactStore = new LocalArtifactStore({
  rootDirectory: path.resolve(artifactRoot),
  repositoryRoot: path.resolve(packageRoot, "..", ".."),
  maxFileBytes: config.artifacts?.maxFileBytes,
});
const hub = await new AgentHub(config, {
  store,
  authService,
  artifactStore,
  webSocketModule: { WebSocket, WebSocketServer },
}).start();
console.log(`Server Hub listening at ${hub.url()} (worker endpoint: ${hub.url().replace(/^http/, "ws")}/worker)`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping Server Hub after ${signal}`);
  await hub.stop();
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
