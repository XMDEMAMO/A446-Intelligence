import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AgentHub } from "../src/hub.mjs";
import { LocalArtifactStore } from "../src/local-artifact-store.mjs";

test("local artifact store verifies and reopens a LAN artifact", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "a446-artifacts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalArtifactStore({ rootDirectory: directory, maxFileBytes: 1024 });
  await store.init();
  const content = Buffer.from("reviewed result\n", "utf8");
  const artifact = {
    artifactId: randomUUID(),
    storageKey: store.createStorageKey(),
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };

  assert.deepEqual(await store.receive(Readable.from(content), artifact), { size: content.length, sha256: artifact.sha256 });
  const opened = await store.open(artifact);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString("utf8"), content.toString("utf8"));
});

test("local artifact store dynamically calculates size and sha256 when streaming", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "a446-artifacts-dyn-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalArtifactStore({ rootDirectory: directory, maxFileBytes: 1024 });
  await store.init();
  const content = Buffer.from("dynamic upload content\n", "utf8");
  const expectedHash = createHash("sha256").update(content).digest("hex");
  const artifact = {
    artifactId: randomUUID(),
    storageKey: store.createStorageKey(),
  };

  const result = await store.receive(Readable.from(content), artifact);
  assert.equal(result.size, content.length);
  assert.equal(result.sha256, expectedHash);
  assert.equal(artifact.size, content.length);
  assert.equal(artifact.sha256, expectedHash);

  const opened = await store.open(artifact);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString("utf8"), content.toString("utf8"));
});

test("local artifact store rejects escaped storage keys", async () => {
  const store = new LocalArtifactStore({ rootDirectory: path.resolve(os.tmpdir(), "a446-artifact-root") });
  assert.throws(() => store.resolveStorageKey("../outside"), /Invalid local storage key/);
});

test("legacy private-LAN token binds artifact upload to the declared Agent", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "a446-lan-artifact-"));
  const tokenName = `A446_TEST_ARTIFACT_TOKEN_${process.pid}`;
  const previousToken = process.env[tokenName];
  let hub;
  process.env[tokenName] = "test-private-lan-token";
  t.after(async () => {
    if (hub) await hub.stop();
    if (previousToken === undefined) delete process.env[tokenName];
    else process.env[tokenName] = previousToken;
    await rm(directory, { recursive: true, force: true });
  });
  const store = new LocalArtifactStore({ rootDirectory: path.join(directory, "objects"), maxFileBytes: 1024 });
  hub = await new AgentHub({
    host: "127.0.0.1",
    port: 0,
    auth: { required: true, tokenEnv: tokenName },
    logs: { includePayloads: false },
  }, { artifactStore: store }).start();
  const agentId = "device-a-codex-01";
  const task = hub.createTask({
    targetAgentId: agentId,
    input: "produce result",
    taskSpec: { expected_outputs: ["result.txt"] },
  });
  const attemptId = randomUUID();
  task.currentAttemptId = attemptId;
  task.status = "running";
  hub.attempts.set(attemptId, { attemptId, taskId: task.taskId, workerId: agentId, status: "running" });
  const content = Buffer.from("LAN reviewed artifact\n", "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const baseHeaders = { authorization: "Bearer test-private-lan-token", "content-type": "application/json" };

  const impersonated = await fetch(`${hub.url()}/v1/artifacts`, {
    method: "POST",
    headers: { ...baseHeaders, "x-a446-agent-id": "other-agent" },
    body: JSON.stringify({ taskId: task.taskId, attemptId, path: "result.txt", size: content.length, sha256 }),
  });
  assert.equal(impersonated.status, 403);

  const registration = await fetch(`${hub.url()}/v1/artifacts`, {
    method: "POST",
    headers: { ...baseHeaders, "x-a446-agent-id": agentId },
    body: JSON.stringify({ taskId: task.taskId, attemptId, path: "result.txt", size: content.length, sha256 }),
  });
  assert.equal(registration.status, 201);
  const artifact = (await registration.json()).artifact;
  const upload = await fetch(`${hub.url()}/v1/artifacts/${artifact.artifactId}/content`, {
    method: "PUT",
    headers: { authorization: "Bearer test-private-lan-token", "x-a446-agent-id": agentId },
    body: content,
  });
  assert.equal(upload.status, 200);

  const download = await fetch(`${hub.url()}/v1/artifacts/${artifact.artifactId}/content`, {
    headers: { authorization: "Bearer test-private-lan-token" },
  });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), content.toString("utf8"));

  const attachmentContent = Buffer.from("user attached document\n", "utf8");
  const attachmentUpload = await fetch(`${hub.url()}/v1/attachments?filename=requirements.md`, {
    method: "POST",
    headers: { authorization: "Bearer test-private-lan-token", "content-type": "text/markdown" },
    body: attachmentContent,
  });
  const attachmentText = await attachmentUpload.text();
  assert.equal(attachmentUpload.status, 201, attachmentText);
  const attachmentArtifact = JSON.parse(attachmentText).artifact;
  assert.equal(attachmentArtifact.path, "requirements.md");
  assert.equal(attachmentArtifact.size, attachmentContent.length);
  assert.equal(attachmentArtifact.status, "ready");

  const attachmentDownload = await fetch(`${hub.url()}/v1/artifacts/${attachmentArtifact.artifactId}/content`, {
    headers: { authorization: "Bearer test-private-lan-token" },
  });
  assert.equal(attachmentDownload.status, 200);
  assert.equal(await attachmentDownload.text(), attachmentContent.toString("utf8"));
});

