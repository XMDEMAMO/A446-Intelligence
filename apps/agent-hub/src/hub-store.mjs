function emptyState() {
  return {
    tasks: [],
    messages: [],
    agents: [],
    attempts: [],
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
    for (const task of changes.tasks ?? []) {
      assertTaskGuard(this.state.tasks, task, changes.taskGuards?.[task.taskId]);
      upsert(this.state.tasks, task, (item) => item.taskId);
    }
    for (const message of changes.messages ?? []) upsert(this.state.messages, message, (item) => item.messageId);
    for (const agent of changes.agents ?? []) upsert(this.state.agents, agent, (item) => item.agentId);
    for (const attempt of changes.attempts ?? []) upsert(this.state.attempts, attempt, (item) => item.attemptId);
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

export function createEmptyHubState() {
  return emptyState();
}

function normalizeState(seed) {
  const state = emptyState();
  for (const key of ["tasks", "messages", "agents", "attempts", "deliveries", "inboundMessages", "auditEvents"]) {
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
