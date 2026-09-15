#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresHubStore } from "./postgres-hub-store.mjs";

const connectionString = process.env.A446_DATABASE_URL;
if (!connectionString) throw new Error("A446_DATABASE_URL is required");
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new PostgresHubStore({ connectionString, migrationsDirectory: path.join(packageRoot, "migrations") });
try {
  await store.init();
  console.log("Server Hub database migrations are up to date.");
} finally {
  await store.close();
}
