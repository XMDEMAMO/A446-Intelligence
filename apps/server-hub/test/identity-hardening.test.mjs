import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { IdentityService } from "../src/identity-service.mjs";
import { PostgresHubStore } from "../src/postgres-hub-store.mjs";

const { Pool } = pg;
const connectionString = process.env.A446_TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

test("identity hardening rate-limits login and enforces user and Worker lifecycle", { timeout: 30000 }, async () => {
  assert.ok(connectionString, "A446_TEST_DATABASE_URL is required");
  const adminPool = new Pool({ connectionString, max: 2 });
  const store = new PostgresHubStore({ connectionString, migrationsDirectory });
  let nowMs = Date.now();
  try {
    await store.init();
    await resetDatabase(adminPool);
    const identities = new IdentityService({
      pool: store.pool,
      secureCookies: true,
      now: () => nowMs,
      loginProtection: {
        username: { maxFailures: 2, baseDelayMs: 100, maxDelayMs: 500 },
        ip: { maxFailures: 3, baseDelayMs: 100, maxDelayMs: 500 },
      },
    });
    await identities.init();

    const admin = await identities.createUser({ username: "security-admin", password: "correct horse battery staple", role: "admin" });
    const operator = await identities.createOperator({ username: "security-operator", password: "operator horse battery staple" });
    assert.equal(operator.role, "operator");
    await assert.rejects(
      identities.createOperator({ username: "another-admin", password: "another correct horse password", role: "admin" }),
      (error) => error.statusCode === 403 && error.code === "ADMIN_HTTP_CREATION_FORBIDDEN",
    );

    await assert.rejects(
      identities.login("security-operator", "wrong password", { clientIp: "192.0.2.10" }),
      (error) => error.statusCode === 401 && error.code === "AUTH_INVALID_CREDENTIALS",
    );
    await assert.rejects(
      identities.login("security-operator", "operator horse battery staple", { clientIp: "192.0.2.10" }),
      (error) => error.statusCode === 429 && error.code === "AUTH_RATE_LIMITED" && error.retryAfterMs > 0,
    );
    nowMs += 101;
    const session = await identities.login("security-operator", "operator horse battery staple", { clientIp: "192.0.2.10" });
    assert.match(session.cookie, /HttpOnly/);

    const users = await identities.listUsers();
    assert.equal(users.length, 2);
    assert.equal(users.find((user) => user.userId === operator.userId)?.activeSessionCount, 1);
    assert.ok(users.find((user) => user.userId === operator.userId)?.lastLoginAt);
    await assert.rejects(
      identities.setUserStatus(admin.userId, "disabled"),
      (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
    );
    const disabled = await identities.setUserStatus(operator.userId, "disabled");
    assert.equal(disabled.status, "disabled");
    assert.equal(await identities.authenticateWeb(requestForCookie(session.cookie)), null);
    await identities.setUserStatus(operator.userId, "active");
    nowMs += 1;
    const secondSession = await identities.login("security-operator", "operator horse battery staple", { clientIp: "192.0.2.10" });
    const revoked = await identities.revokeUserSessions(operator.userId);
    assert.equal(revoked.revokedSessions, 1);
    assert.equal(await identities.authenticateWeb(requestForCookie(secondSession.cookie)), null);

    await assert.rejects(
      identities.createWorkerCredential({ agentId: "bad\nagent", deviceId: "device-a" }),
      (error) => error.statusCode === 400 && error.code === "VALIDATION_ERROR",
    );
    const firstWorker = await identities.createWorkerCredential({ agentId: "worker-a", deviceId: "device-a" });
    await assert.rejects(
      identities.createWorkerCredential({ agentId: "worker-a", deviceId: "device-b" }),
      (error) => error.statusCode === 409 && error.code === "ACTIVE_CREDENTIAL_EXISTS",
    );
    const rotatedWorker = await identities.rotateWorkerCredential(firstWorker.credentialId);
    assert.equal(await identities.authenticateWorker(`Bearer ${firstWorker.token}`), null);
    assert.equal((await identities.authenticateWorker(`Bearer ${rotatedWorker.token}`))?.agentId, "worker-a");
    const activeWorkers = (await identities.listWorkerCredentials()).filter((credential) => credential.agentId === "worker-a" && credential.status === "active");
    assert.equal(activeWorkers.length, 1);

    const audit = await adminPool.query("SELECT user_id, username_hash, ip_hash, outcome FROM web_auth_events");
    const outcomeCounts = Object.fromEntries(["invalid_credentials", "rate_limited", "success"].map((outcome) => [
      outcome,
      audit.rows.filter((row) => row.outcome === outcome).length,
    ]));
    assert.deepEqual(outcomeCounts, { invalid_credentials: 1, rate_limited: 1, success: 2 });
    assert.ok(audit.rows.every((row) => row.username_hash !== "security-operator" && row.ip_hash !== "192.0.2.10"));
    assert.equal(audit.rows.find((row) => row.outcome === "invalid_credentials")?.user_id, null);
    const throttleScopes = await adminPool.query("SELECT scope_type, scope_hash FROM web_login_throttles");
    assert.deepEqual(throttleScopes.rows.map((row) => row.scope_type), ["ip"]);
    assert.notEqual(throttleScopes.rows[0].scope_hash, "192.0.2.10");
  } finally {
    await resetDatabase(adminPool).catch(() => {});
    await store.close().catch(() => {});
    await adminPool.end();
  }
});

function requestForCookie(serializedCookie) {
  return {
    headers: { cookie: serializedCookie.split(";", 1)[0] },
    socket: { encrypted: true },
  };
}

async function resetDatabase(pool) {
  await pool.query(`
    TRUNCATE TABLE
      web_auth_events,
      web_login_throttles,
      web_sessions,
      web_users,
      worker_credentials,
      human_interventions,
      artifacts,
      task_attempts,
      outbound_deliveries,
      inbound_messages,
      task_messages,
      tasks,
      worker_registrations,
      audit_events,
      hub_metadata
    RESTART IDENTITY CASCADE
  `);
}
