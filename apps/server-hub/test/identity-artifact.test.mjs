import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { WebSocket, WebSocketServer } from "ws";
import { ArtifactClient } from "../../agent-hub/src/artifact-client.mjs";
import { delay, makeEnvelope } from "../../agent-hub/src/common.mjs";
import { AgentHub } from "../../agent-hub/src/hub.mjs";
import { normalizePolicy } from "../../agent-hub/src/local-policy.mjs";
import { IdentityService } from "../src/identity-service.mjs";
import { LocalArtifactStore } from "../src/local-artifact-store.mjs";
import { PostgresHubStore } from "../src/postgres-hub-store.mjs";

const { Pool } = pg;
const connectionString = process.env.A446_TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const webSocketModule = { WebSocket, WebSocketServer };

test("identity boundaries protect a restart-safe streamed Artifact Store", { timeout: 30000 }, async () => {
  assert.ok(connectionString, "A446_TEST_DATABASE_URL is required");
  const adminPool = new Pool({ connectionString, max: 2 });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "a446-identity-artifact-test-"));
  const artifactRoot = path.join(tempRoot, "artifact-store");
  let hub;
  let workerSocket;
  try {
    const store = new PostgresHubStore({ connectionString, migrationsDirectory });
    await store.init();
    await resetDatabase(adminPool);
    const identities = new IdentityService({ pool: store.pool, secureCookies: true });
    const admin = await identities.createUser({ username: "batch2-admin", password: "correct horse battery staple", role: "admin" });
    assert.equal(admin.role, "admin");
    await identities.createUser({ username: "batch2-operator", password: "operator horse battery staple", role: "operator" });
    const workerA = await identities.createWorkerCredential({ agentId: "worker-a", deviceId: "device-a" });
    const workerB = await identities.createWorkerCredential({ agentId: "worker-b", deviceId: "device-b" });

    hub = await createHub(store, identities, artifactRoot);
    const unauthenticated = await fetch(`${hub.url()}/v1/tasks`);
    assert.equal(unauthenticated.status, 401);

    const adminSession = await login(hub, "batch2-admin", "correct horse battery staple");
    const operatorSession = await login(hub, "batch2-operator", "operator horse battery staple");
    const forbidden = await webRequest(hub, operatorSession, "/v1/admin/workers", { method: "POST", body: { agentId: "forbidden" } });
    assert.equal(forbidden.response.status, 403);

    const impostor = new WebSocket(`ws://127.0.0.1:${hub.port}/worker`, {
      headers: { authorization: `Bearer ${workerA.token}` },
    });
    await once(impostor, "open");
    impostor.send(JSON.stringify(makeEnvelope("worker.hello", {
      agentId: "worker-b",
      payload: { deviceId: "device-b", protocolFeatures: ["attempt-lease-v1", "artifact-transfer-v1"] },
    })));
    const [impostorCloseCode] = await once(impostor, "close");
    assert.equal(impostorCloseCode, 1008);
    assert.notEqual(hub.agents.get("worker-b")?.status, "online");

    workerSocket = new WebSocket(`ws://127.0.0.1:${hub.port}/worker`, {
      headers: { authorization: `Bearer ${workerA.token}` },
    });
    const messages = [];
    workerSocket.on("message", (raw) => messages.push(JSON.parse(raw.toString("utf8"))));
    await once(workerSocket, "open");
    workerSocket.send(JSON.stringify(makeEnvelope("worker.hello", {
      agentId: "worker-a",
      payload: { deviceId: "device-a", protocolFeatures: ["attempt-lease-v1", "artifact-transfer-v1"] },
    })));
    await waitUntil(() => hub.agents.get("worker-a")?.status === "online");

    const created = await webRequest(hub, adminSession, "/v1/tasks", {
      method: "POST",
      body: {
        targetAgentId: "worker-a",
        input: "produce the declared file",
        taskSpec: {
          expected_outputs: ["result.txt"],
          execution_policy: { side_effects: "none", on_lease_expiry: "retry" },
        },
      },
    });
    assert.equal(created.response.status, 202, created.text);
    const task = created.body.task;
    const assignment = await waitForMessage(messages, (message) => message.type === "task.assign" && message.taskId === task.taskId);
    workerSocket.send(JSON.stringify(makeEnvelope("ack", { agentId: "worker-a", replyTo: assignment.id })));
    workerSocket.send(JSON.stringify(makeEnvelope("task.started", {
      agentId: "worker-a",
      taskId: task.taskId,
      payload: { attemptId: assignment.payload.attemptId },
    })));
    await waitUntil(() => hub.tasks.get(task.taskId)?.status === "running");

    const oversized = await workerJson(hub, workerA.token, "/v1/artifacts", {
      method: "POST",
      body: { taskId: task.taskId, attemptId: assignment.payload.attemptId, path: "result.txt", size: 1025, sha256: "a".repeat(64) },
    });
    assert.equal(oversized.response.status, 413);
    const undeclared = await workerJson(hub, workerA.token, "/v1/artifacts", {
      method: "POST",
      body: { taskId: task.taskId, attemptId: assignment.payload.attemptId, path: "other.txt", size: 1, sha256: "a".repeat(64) },
    });
    assert.equal(undeclared.response.status, 403);
    const escaped = await workerJson(hub, workerA.token, "/v1/artifacts", {
      method: "POST",
      body: { taskId: task.taskId, attemptId: assignment.payload.attemptId, path: "../result.txt", size: 1, sha256: "a".repeat(64) },
    });
    assert.equal(escaped.response.status, 400);

    const bytes = Buffer.from("server-ready artifact\n", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const registered = await workerJson(hub, workerA.token, "/v1/artifacts", {
      method: "POST",
      body: { taskId: task.taskId, attemptId: assignment.payload.attemptId, path: "result.txt", size: bytes.length, sha256 },
    });
    assert.equal(registered.response.status, 201, registered.text);
    const artifactId = registered.body.artifact.artifactId;
    const wrongBytes = Buffer.from(bytes);
    wrongBytes[0] ^= 1;
    const badUpload = await fetch(`${hub.url()}/v1/artifacts/${artifactId}/content`, {
      method: "PUT",
      headers: { authorization: `Bearer ${workerA.token}`, "content-type": "application/octet-stream" },
      body: wrongBytes,
    });
    assert.equal(badUpload.status, 422);
    await badUpload.text();
    const retried = await workerJson(hub, workerA.token, "/v1/artifacts", {
      method: "POST",
      body: { taskId: task.taskId, attemptId: assignment.payload.attemptId, path: "result.txt", size: bytes.length, sha256 },
    });
    assert.equal(retried.body.artifact.artifactId, artifactId);
    const upload = await fetch(`${hub.url()}/v1/artifacts/${artifactId}/content`, {
      method: "PUT",
      headers: { authorization: `Bearer ${workerA.token}`, "content-type": "application/octet-stream" },
      body: bytes,
    });
    assert.equal(upload.status, 200);

    workerSocket.send(JSON.stringify(makeEnvelope("task.result", {
      agentId: "worker-a",
      taskId: task.taskId,
      payload: {
        attemptId: assignment.payload.attemptId,
        output: "done",
        artifacts: { algorithm: "sha256", files: [{ artifactId, path: "result.txt", size: bytes.length, sha256, status: "ready", downloadUrl: `/v1/artifacts/${artifactId}/content` }], missing: [] },
      },
    })));
    await waitUntil(() => hub.tasks.get(task.taskId)?.status === "completed");

    const review = hub.createTask({
      targetAgentId: "worker-b",
      input: "review artifact",
      rootTaskId: task.rootTaskId,
      parentTaskId: task.taskId,
      contextBundle: { artifactReferences: [{ artifactId, path: "received/result.txt", size: bytes.length, sha256, status: "ready" }] },
    });
    await hub.flushState();
    const workerBRoot = path.join(tempRoot, "worker-b");
    await mkdir(workerBRoot, { recursive: true });
    process.env.A446_TEST_WORKER_B_TOKEN = workerB.token;
    const artifactClient = new ArtifactClient({
      hubUrl: `ws://127.0.0.1:${hub.port}/worker`,
      authTokenEnv: "A446_TEST_WORKER_B_TOKEN",
      workspace: workerBRoot,
      artifacts: { centralStore: true, apiUrl: hub.url(), maxFileBytes: 1024 },
    }, normalizePolicy({ allowedRoots: [workerBRoot] }, workerBRoot));
    await artifactClient.downloadReferences(review);
    assert.deepEqual(await readFile(path.join(workerBRoot, "received", "result.txt")), bytes);

    const revoke = await webRequest(hub, adminSession, `/v1/admin/workers/${workerA.credentialId}`, { method: "DELETE" });
    assert.equal(revoke.response.status, 200, revoke.text);
    assert.equal(await identities.authenticateWorker(`Bearer ${workerA.token}`), null);
    assert.equal((await identities.authenticateWorker(`Bearer ${workerB.token}`))?.agentId, "worker-b");
    await waitUntil(() => hub.agents.get("worker-a")?.status === "offline");

    const restartPort = hub.port;
    workerSocket.close();
    workerSocket = null;
    await hub.stop();
    hub = null;
    const restoredStore = new PostgresHubStore({ connectionString, migrationsDirectory });
    const restoredIdentities = new IdentityService({ pool: restoredStore.pool, secureCookies: true });
    hub = await createHub(restoredStore, restoredIdentities, artifactRoot, restartPort);
    const restored = await fetch(`${hub.url()}/v1/artifacts/${artifactId}/content`, { headers: { cookie: adminSession.cookie } });
    assert.equal(restored.status, 200);
    assert.deepEqual(Buffer.from(await restored.arrayBuffer()), bytes);
    assert.equal(hub.artifacts.get(artifactId)?.status, "ready");
  } finally {
    delete process.env.A446_TEST_WORKER_B_TOKEN;
    if (workerSocket) workerSocket.close();
    if (hub) await hub.stop();
    await resetDatabase(adminPool).catch(() => {});
    await adminPool.end();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function createHub(store, identities, artifactRoot, port = 0) {
  return new AgentHub({
    host: "127.0.0.1",
    port,
    auth: { mode: "identity", required: true },
    leases: { enabled: true, ttlMs: 5000, scanIntervalMs: 100 },
    delivery: { ackTimeoutMs: 100, maxAttemptsPerConnection: 5 },
    logs: { includePayloads: false },
  }, {
    store,
    authService: identities,
    artifactStore: new LocalArtifactStore({ rootDirectory: artifactRoot, maxFileBytes: 1024 }),
    webSocketModule,
  }).start();
}

async function login(hub, username, password) {
  const response = await fetch(`${hub.url()}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  return { cookie: setCookie.split(";", 1)[0], csrf: body.csrfToken };
}

async function webRequest(hub, session, pathname, options = {}) {
  const response = await fetch(`${hub.url()}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      cookie: session.cookie,
      origin: hub.url(),
      "x-csrf-token": session.csrf,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return { response, text, body: text ? JSON.parse(text) : null };
}

async function workerJson(hub, token, pathname, options) {
  const response = await fetch(`${hub.url()}${pathname}`, {
    method: options.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, text, body: text ? JSON.parse(text) : null };
}

async function waitForMessage(messages, predicate, timeoutMs = 5000) {
  await waitUntil(() => messages.some(predicate), timeoutMs);
  return messages.find(predicate);
}

async function waitUntil(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for condition");
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
