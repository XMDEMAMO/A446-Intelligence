import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonFileHubStore } from "../src/hub-store.mjs";

test("JSON file Hub store survives restart and recovers from its last backup", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "a446-json-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "hub-state.json");
  const firstTask = { taskId: "task-1", status: "queued", currentAttemptId: null };
  const secondTask = { taskId: "task-2", status: "completed", currentAttemptId: null };

  const store = new JsonFileHubStore(file);
  await store.init();
  await store.commit({ tasks: [firstTask] });
  await store.commit({ tasks: [secondTask] });
  await store.close();

  const restarted = new JsonFileHubStore(file);
  await restarted.init();
  assert.deepEqual((await restarted.load()).tasks, [firstTask, secondTask]);
  await restarted.close();

  await writeFile(file, "{broken", "utf8");
  const recovered = new JsonFileHubStore(file);
  await recovered.init();
  assert.deepEqual((await recovered.load()).tasks, [firstTask]);
  assert.match(await readFile(`${file}.bak`, "utf8"), /task-1/);
  await recovered.close();
});
