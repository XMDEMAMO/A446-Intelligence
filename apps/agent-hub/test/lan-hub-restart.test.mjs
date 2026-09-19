import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentHub } from "../src/hub.mjs";
import { JsonFileHubStore } from "../src/hub-store.mjs";

test("private-LAN Hub restores a task conversation and pending intervention from JSON", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "a446-lan-restart-"));
  const stateFile = path.join(directory, "hub-state.json");
  const config = {
    host: "127.0.0.1",
    port: 0,
    logs: { includePayloads: false },
    messages: { maxInMemory: 1000 },
  };
  let hub;
  t.after(async () => {
    if (hub) await hub.stop();
    await rm(directory, { recursive: true, force: true });
  });

  hub = await new AgentHub(config, { store: new JsonFileHubStore(stateFile) }).start();
  const task = hub.createTask({
    input: "wait for a human decision",
    role: "planner",
    requiresApproval: true,
    taskSpec: { title: "LAN restart check", acceptance: ["decision survives restart"] },
  });
  await hub.flushState();
  await hub.stop();
  hub = null;

  hub = await new AgentHub(config, { store: new JsonFileHubStore(stateFile) }).start();
  assert.equal(hub.tasks.get(task.taskId)?.status, "awaiting_approval");
  assert.equal(hub.conversations().length, 1);
  assert.equal(hub.messages.filter((message) => message.rootTaskId === task.taskId).length >= 1, true);
  const intervention = [...hub.interventions.values()].find((item) => item.rootTaskId === task.taskId);
  assert.equal(intervention?.status, "pending");
  assert.deepEqual(intervention?.allowedActions, ["approve", "reject"]);
});
