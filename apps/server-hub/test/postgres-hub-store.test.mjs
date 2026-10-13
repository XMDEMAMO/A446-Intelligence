import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import pg from "pg";
import { WebSocket, WebSocketServer } from "ws";
import { AgentHub } from "../../agent-hub/src/hub.mjs";
import { AgentWorker } from "../../agent-hub/src/worker.mjs";
import { delay } from "../../agent-hub/src/common.mjs";
import { PostgresHubStore } from "../src/postgres-hub-store.mjs";
import { LocalArtifactStore } from "../src/local-artifact-store.mjs";

const { Pool } = pg;
const webSocketModule = { WebSocket, WebSocketServer };
const connectionString = process.env.A446_TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

test("PostgreSQL restores an active task across Hub restart and preserves terminal and approval state", { timeout: 30000 }, async () => {
  assert.ok(connectionString, "A446_TEST_DATABASE_URL is required");
  const admin = new Pool({ connectionString, max: 2 });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "a446-postgres-hub-test-"));
  let hub;
  let worker;
  try {
    const bootstrap = new PostgresHubStore({ connectionString, migrationsDirectory });
    await bootstrap.init();
    await bootstrap.close();
    await resetDatabase(admin);

    const firstStore = new PostgresHubStore({ connectionString, migrationsDirectory });
    hub = new AgentHub(testHubConfig(), { store: firstStore, webSocketModule });
    await hub.start();
    worker = new AgentWorker({
      agentId: "postgres-worker",
      hubUrl: `ws://127.0.0.1:${hub.port}/worker`,
      stateFile: path.join(tempRoot, "worker-state.json"),
      workspace: path.join(tempRoot, "workspace"),
      heartbeatMs: 100,
      reconnect: { baseMs: 100, maxMs: 300 },
      adapter: { type: "mock", delayMs: 1500 },
    });
    await worker.start();
    await waitUntil(() => hub.agents.get("postgres-worker")?.status === "online");

    const completedResponse = await post(hub, "/v1/tasks", {
      targetAgentId: "postgres-worker",
      input: "persist this result",
      taskSpec: { execution_policy: { side_effects: "none", on_lease_expiry: "retry" } },
    });
    const completedTaskId = completedResponse.task.taskId;
    await waitUntil(() => hub.tasks.get(completedTaskId)?.status === "running");
    const completedAttemptId = hub.tasks.get(completedTaskId).currentAttemptId;
    const restartPort = hub.port;

    await hub.stop();
    hub = null;

    const recoveryStore = new PostgresHubStore({ connectionString, migrationsDirectory });
    hub = new AgentHub(testHubConfig(restartPort), { store: recoveryStore, webSocketModule });
    await hub.start();
    await waitUntil(() => hub.agents.get("postgres-worker")?.status === "online");
    await waitUntil(() => hub.tasks.get(completedTaskId)?.status === "completed", 15000);

    const approvalResponse = await post(hub, "/v1/tasks", {
      targetAgentId: "postgres-worker",
      input: "wait for approval",
      requiresApproval: true,
    });
    const approvalTaskId = approvalResponse.task.taskId;
    const approvalInterventionId = [...hub.interventions.values()].find((item) => item.taskId === approvalTaskId)?.interventionId;
    assert.ok(approvalInterventionId);

    const cancelledResponse = await post(hub, "/v1/tasks", {
      targetAgentId: "postgres-worker",
      input: "cancelled terminal state",
      requiresApproval: true,
    });
    const cancelledTaskId = cancelledResponse.task.taskId;
    await post(hub, "/v1/commands", { type: "task.cancel", taskId: cancelledTaskId });

    const pendingAgent = testAgent("unconnected-worker");
    hub.agents.set(pendingAgent.agentId, pendingAgent);
    hub.markAgent(pendingAgent);
    const pendingTask = hub.createTask({
      targetAgentId: pendingAgent.agentId,
      input: "preserve the original assignment envelope",
      taskSpec: { execution_policy: { side_effects: "none", on_lease_expiry: "retry" } },
    });
    await hub.queueOrDispatch(pendingTask);
    await hub.commitAndDispatch();
    const pendingEnvelopeId = [...hub.pendingDeliveries.values()]
      .find((delivery) => delivery.envelope.taskId === pendingTask.taskId)?.envelope.id;
    assert.ok(pendingEnvelopeId);

    await worker.stop();
    worker = null;
    await hub.stop();
    hub = null;

    const secondStore = new PostgresHubStore({ connectionString, migrationsDirectory });
    hub = new AgentHub(testHubConfig(), { store: secondStore, webSocketModule });
    await hub.start();
    assert.equal(hub.tasks.get(completedTaskId)?.status, "completed");
    assert.match(hub.tasks.get(completedTaskId)?.output ?? "", /postgres-worker/);
    assert.equal(hub.tasks.get(approvalTaskId)?.status, "awaiting_approval");
    assert.equal(hub.interventions.get(approvalInterventionId)?.status, "pending");
    assert.equal(hub.tasks.get(cancelledTaskId)?.status, "cancelled");
    assert.equal(hub.attempts.get(completedAttemptId)?.status, "completed");
    assert.equal(hub.agents.get("postgres-worker")?.status, "offline");
    assert.ok(hub.messages.some((message) => message.taskId === completedTaskId));
    assert.ok(hub.log.recent(1000).some((event) => event.type === "task.result"));
    assert.ok(hub.processedInbound.size > 0);
    assert.ok([...hub.pendingDeliveries.values()].some((delivery) => delivery.envelope.id === pendingEnvelopeId));

    const decisions = await Promise.all([
      postStatus(hub, `/v1/interventions/${approvalInterventionId}/resolve`, { decision: "approve" }),
      postStatus(hub, `/v1/interventions/${approvalInterventionId}/resolve`, { decision: "approve" }),
    ]);
    assert.deepEqual(decisions.sort(), [200, 409]);
    assert.equal(hub.interventions.get(approvalInterventionId)?.status, "resolved");
    assert.equal(hub.tasks.get(approvalTaskId)?.status, "queued");
  } finally {
    if (worker) await worker.stop();
    if (hub) await hub.stop();
    await resetDatabase(admin).catch(() => {});
    await admin.end();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function testAgent(agentId) {
  return {
    agentId,
    status: "online",
    paused: false,
    busy: false,
    activeTaskCount: 0,
    maxConcurrency: 1,
    roles: [],
    capabilities: [],
    models: [],
    protocolFeatures: ["attempt-lease-v1"],
  };
}

function testHubConfig(port = 0) {
  return {
    host: "127.0.0.1",
    port,
    heartbeatMs: 100,
    delivery: { ackTimeoutMs: 100, maxAttemptsPerConnection: 5 },
    leases: { enabled: true, ttlMs: 5000, scanIntervalMs: 100 },
    logs: { includePayloads: false },
  };
}

test("PostgreSQL preserves archive and update state and purges a conversation without deleting shared artifacts", async () => {
  assert.ok(connectionString, "A446_TEST_DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 2 });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "a446-postgres-lifecycle-"));
  const artifactStore = new LocalArtifactStore({ rootDirectory: path.join(tempRoot, "artifacts") });
  await artifactStore.init();
  let hub;
  try {
    const store = new PostgresHubStore({ connectionString, migrationsDirectory });
    await store.init();
    await resetDatabase(pool);
    hub = new AgentHub(testHubConfig(), { store, artifactStore, webSocketModule });
    await hub.start();
    const root = hub.createTask({ input: "completed conversation" });
    root.status = "completed";
    hub.markTask(root);
    const retained = hub.createTask({ input: "other conversation" });
    retained.status = "completed";
    const artifacts = [];
    for (const filename of ["exclusive.txt", "shared.txt"]) {
      const contents = Buffer.from(filename);
      const artifact = {
        artifactId: randomUUID(), taskId: root.taskId, rootTaskId: root.taskId,
        status: "ready", path: filename, originalName: filename, size: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
        storageKey: artifactStore.createStorageKey(), createdAt: new Date().toISOString(),
      };
      await artifactStore.receive(Readable.from([contents]), artifact);
      hub.artifacts.set(artifact.artifactId, artifact);
      hub.markArtifact(artifact);
      artifacts.push(artifact);
    }
    retained.contextBundle = { artifactReferences: [artifacts[1]] };
    hub.markTask(retained);
    const job = { jobId: "persisted-update-job", deviceId: "test-device", status: "completed", reports: [] };
    hub.markUpdateJob(job);
    const actor = { kind: "web", id: "test-admin", role: "admin" };
    await hub.lifecycle.archive(root.taskId, actor);
    const persistedMessageIds = await store.collectMessageIdsByRoot(root.taskId);
    assert.ok(persistedMessageIds.length > 0);
    await hub.stop();

    const recoveryStore = new PostgresHubStore({ connectionString, migrationsDirectory });
    hub = new AgentHub(testHubConfig(), { store: recoveryStore, artifactStore, webSocketModule });
    await hub.start();
    assert.equal(hub.lifecycle.stateOf(root.taskId), "archived");
    assert.equal(hub.updates.listJobs().find((item) => item.jobId === job.jobId)?.status, "completed");
    await hub.lifecycle.trash(root.taskId, actor);
    hub.messages = []; // Purge must collect all persisted messages, even outside the memory window.
    await hub.lifecycle.purge(root.taskId, actor);
    await assert.rejects(() => artifactStore.open(artifacts[0]), { code: "ENOENT" });
    const sharedFile = await artifactStore.open(artifacts[1]);
    sharedFile.stream.destroy();
    await assert.rejects(() => artifactStore.remove({ storageKey: "../outside" }), /Invalid server storage key/);
    const state = await recoveryStore.load();
    assert.equal(state.tasks.some((item) => item.taskId === root.taskId), false);
    assert.equal(state.messages.some((item) => item.rootTaskId === root.taskId), false);
    assert.equal(state.artifacts.some((item) => item.artifactId === artifacts[0].artifactId), false);
    assert.equal(state.artifacts.some((item) => item.artifactId === artifacts[1].artifactId), true);
    assert.equal(state.lifecycles.some((item) => item.rootTaskId === root.taskId), false);
    assert.equal(state.tombstones.some((item) => item.rootTaskId === root.taskId), true);
    assert.equal(state.tasks.some((item) => item.taskId === retained.taskId), true);
    await hub.stop();
    hub = new AgentHub(testHubConfig(), {
      store: new PostgresHubStore({ connectionString, migrationsDirectory }), artifactStore, webSocketModule,
    });
    await hub.start();
    assert.equal(hub.lifecycle.stateOf(root.taskId), "purged");
    assert.equal(hub.tasks.has(root.taskId), false);
    assert.equal(hub.artifacts.has(artifacts[1].artifactId), true);
  } finally {
    if (hub) await hub.stop();
    await resetDatabase(pool);
    await pool.end();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function resetDatabase(pool) {
  await pool.query(`
    TRUNCATE TABLE
      device_update_jobs, conversation_lifecycles, conversation_tombstones,
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

async function post(hub, pathname, body) {
  const response = await fetch(`${hub.url()}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text);
}

async function postStatus(hub, pathname, body) {
  const response = await fetch(`${hub.url()}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await response.text();
  return response.status;
}

async function waitUntil(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error("Timed out waiting for condition");
}
