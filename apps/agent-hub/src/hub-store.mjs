import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function emptyState() {
  return {
    tasks: [],
    messages: [],
    agents: [],
    attempts: [],
    artifacts: [],
    interventions: [],
    deliveries: [],
    inboundMessages: [],
    auditEvents: [],
    metadata: {
      messageSeq: 0,
      usageTotals: null,
    },
  };
}

export class MemoryHubStore {
  constructor(seed = {}) {
    this.state = normalizeState(seed);
  }

  async init() {}

  async load() {
    return structuredClone(this.state);
  }

  async commit(changes = {}) {
    for (const task of changes.tasks ?? []) assertTaskGuard(this.state.tasks, task, changes.taskGuards?.[task.taskId]);
    for (const intervention of changes.interventions ?? []) {
      assertInterventionGuard(this.state.interventions, intervention, changes.interventionGuards?.[intervention.interventionId]);
    }
    for (const task of changes.tasks ?? []) {
      upsert(this.state.tasks, task, (item) => item.taskId);
    }
    for (const message of changes.messages ?? []) upsert(this.state.messages, message, (item) => item.messageId);
    for (const agent of changes.agents ?? []) upsert(this.state.agents, agent, (item) => item.agentId);
    for (const attempt of changes.attempts ?? []) upsert(this.state.attempts, attempt, (item) => item.attemptId);
    for (const artifact of changes.artifacts ?? []) upsert(this.state.artifacts, artifact, (item) => item.artifactId);
    for (const intervention of changes.interventions ?? []) upsert(this.state.interventions, intervention, (item) => item.interventionId);
    for (const delivery of changes.deliveries ?? []) {
      upsert(this.state.deliveries, delivery, deliveryKey);
    }
    for (const delivery of changes.deletedDeliveries ?? []) {
      remove(this.state.deliveries, `${delivery.agentId}:${delivery.messageId}`, deliveryKey);
    }
    for (const message of changes.inboundMessages ?? []) {
      upsert(this.state.inboundMessages, message, (item) => item.messageId);
    }
    for (const event of changes.auditEvents ?? []) upsert(this.state.auditEvents, event, (item) => item.seq);
    if (changes.metadata) this.state.metadata = { ...this.state.metadata, ...structuredClone(changes.metadata) };
  }

  async close() {}

  snapshot() {
    return structuredClone(this.state);
  }
}

export class JsonFileHubStore extends MemoryHubStore {
  constructor(file) {
    if (!file) throw new Error("JsonFileHubStore requires a state file");
    super();
    this.file = path.resolve(file);
    this.backupFile = `${this.file}.bak`;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(path.dirname(this.file), { recursive: true });
    let loaded = null;
    try {
      loaded = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && error.name !== "SyntaxError") throw error;
      if (error.name === "SyntaxError") {
        try {
          loaded = JSON.parse(await readFile(this.backupFile, "utf8"));
        } catch (backupError) {
          throw Object.assign(new Error(`Hub state is invalid and no valid backup is available: ${error.message}`), { cause: backupError });
        }
      }
    }
    this.state = normalizeState(loaded ?? {});
    if (!loaded) await this.persist();
  }

  async commit(changes = {}) {
    await super.commit(changes);
    await this.persist();
  }

  async close() {
    await this.writeChain;
  }

  async persist() {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        await copyFile(this.file, this.backupFile);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await rename(temp, this.file);
    });
    return this.writeChain;
  }
}

export function createEmptyHubState() {
  return emptyState();
}

function normalizeState(seed) {
  const state = emptyState();
  for (const key of ["tasks", "messages", "agents", "attempts", "artifacts", "interventions", "deliveries", "inboundMessages", "auditEvents"]) {
    state[key] = Array.isArray(seed[key]) ? structuredClone(seed[key]) : [];
  }
  state.metadata = {
    ...state.metadata,
    ...(seed.metadata && typeof seed.metadata === "object" ? structuredClone(seed.metadata) : {}),
  };
  return state;
}

function upsert(collection, value, keyOf) {
  const cloned = structuredClone(value);
  const key = keyOf(cloned);
  const index = collection.findIndex((item) => keyOf(item) === key);
  if (index === -1) collection.push(cloned);
  else collection[index] = cloned;
}

function remove(collection, key, keyOf) {
  const index = collection.findIndex((item) => keyOf(item) === key);
  if (index !== -1) collection.splice(index, 1);
}

function deliveryKey(delivery) {
  return `${delivery.agentId}:${delivery.envelope.id}`;
}

function assertTaskGuard(tasks, task, guard) {
  if (!guard) return;
  const current = tasks.find((item) => item.taskId === task.taskId);
  const statusAllowed = guard.allowedStatuses?.includes(current?.status);
  if (!current || current.currentAttemptId !== guard.currentAttemptId || !statusAllowed) {
    throw Object.assign(new Error(`Stale task transition rejected for ${task.taskId}`), { code: "STALE_TASK_TRANSITION" });
  }
}

function assertInterventionGuard(interventions, intervention, guard) {
  if (!guard) return;
  const current = interventions.find((item) => item.interventionId === intervention.interventionId);
  if (!current || !guard.allowedStatuses?.includes(current.status)) {
    throw Object.assign(new Error(`Intervention ${intervention.interventionId} is no longer pending`), {
      code: "INTERVENTION_CONFLICT",
      statusCode: 409,
    });
  }
}
