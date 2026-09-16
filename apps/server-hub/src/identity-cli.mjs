#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsonConfig, parseArgs } from "../../agent-hub/src/common.mjs";
import { IdentityService } from "./identity-service.mjs";
import { PostgresHubStore } from "./postgres-hub-store.mjs";

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (!args.config || !command) {
  console.error("Usage: node src/identity-cli.mjs <create-user|create-worker|list-workers|rotate-worker|revoke-worker> --config <server.json> [options]");
  process.exit(2);
}

const loaded = await loadJsonConfig(args.config);
const config = loaded.data;
const connectionStringEnv = config.storage?.connectionStringEnv ?? "A446_DATABASE_URL";
const connectionString = process.env[connectionStringEnv];
if (!connectionString) throw new Error(`Database connection is missing from ${connectionStringEnv}`);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new PostgresHubStore({
  connectionString,
  migrationsDirectory: path.join(packageRoot, "migrations"),
  maxConnections: 2,
  ssl: config.storage?.ssl,
});

try {
  await store.init();
  const identities = new IdentityService({ pool: store.pool });
  let result;
  if (command === "create-user") {
    const passwordEnv = args["password-env"];
    const password = passwordEnv ? process.env[passwordEnv] : null;
    if (!password) throw new Error("create-user requires --password-env naming a populated environment variable");
    result = await identities.createUser({ username: args.username, password, role: args.role ?? "operator" });
  } else if (command === "create-worker") {
    result = await identities.createWorkerCredential({ agentId: args["agent-id"], deviceId: args["device-id"] });
  } else if (command === "list-workers") {
    result = await identities.listWorkerCredentials();
  } else if (command === "rotate-worker") {
    result = await identities.rotateWorkerCredential(args["credential-id"]);
  } else if (command === "revoke-worker") {
    result = await identities.revokeWorkerCredential(args["credential-id"]);
  } else {
    throw new Error(`Unsupported identity command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await store.close();
}
