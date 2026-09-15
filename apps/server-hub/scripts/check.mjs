import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "src/server-hub-cli.mjs",
  "src/migrate-cli.mjs",
  "src/postgres-hub-store.mjs",
  "migrations/001_persistent_scheduling.sql",
  "config/server.example.json",
];
for (const relative of required) await access(path.join(root, relative));
const config = JSON.parse(await readFile(path.join(root, "config/server.example.json"), "utf8"));
if (config.storage?.driver !== "postgres") throw new Error("server.example.json must use PostgreSQL");
if (config.leases?.enabled !== true) throw new Error("server.example.json must enable leases");
if (config.auth?.required !== true) throw new Error("server.example.json must require authentication");
await import("../src/postgres-hub-store.mjs");
await import("ws");
console.log("Server Hub package structure and example configuration are valid.");
