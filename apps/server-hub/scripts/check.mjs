import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "src/server-hub-cli.mjs",
  "src/migrate-cli.mjs",
  "src/postgres-hub-store.mjs",
  "src/identity-service.mjs",
  "src/local-artifact-store.mjs",
  "src/identity-cli.mjs",
  "migrations/001_persistent_scheduling.sql",
  "migrations/002_artifacts_and_identity.sql",
  "migrations/003_resource_and_interventions.sql",
  "config/server.example.json",
  "config/worker.example.json",
  ".env.example",
  "OPERATIONS.md",
];
for (const relative of required) await access(path.join(root, relative));
const config = JSON.parse(await readFile(path.join(root, "config/server.example.json"), "utf8"));
const environmentTemplate = await readFile(path.join(root, ".env.example"), "utf8");
if (config.storage?.driver !== "postgres") throw new Error("server.example.json must use PostgreSQL");
if (config.leases?.enabled !== true) throw new Error("server.example.json must enable leases");
if (config.auth?.required !== true || config.auth?.mode !== "identity") throw new Error("server.example.json must require identity authentication");
if (!config.artifacts?.rootDirectoryEnv) throw new Error("server.example.json must configure an external Artifact Store root");
for (const name of ["A446_DATABASE_URL", "A446_ARTIFACT_ROOT", "A446_TEST_DATABASE_URL"]) {
  if (!environmentTemplate.match(new RegExp(`^${name}=`, "m"))) throw new Error(`.env.example must document ${name}`);
}
await import("../src/postgres-hub-store.mjs");
await import("../src/identity-service.mjs");
await import("../src/local-artifact-store.mjs");
await import("ws");
console.log("Server Hub package structure and example configuration are valid.");
