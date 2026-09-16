import { spawnSync } from "node:child_process";

if (!process.env.A446_TEST_DATABASE_URL) {
  console.error("A446_TEST_DATABASE_URL is required for PostgreSQL integration tests.");
  process.exit(2);
}
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "test/postgres-hub-store.test.mjs", "test/identity-artifact.test.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: process.env,
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
