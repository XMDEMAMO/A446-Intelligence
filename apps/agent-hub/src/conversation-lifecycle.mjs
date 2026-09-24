import { createHash, randomUUID } from "node:crypto";

/**
 * Conversation lifecycle domain module (C branch).
 *
 * Independent of the business `task.status`: a collaboration task (a whole
 * conversation, keyed by its root task id) moves through
 *
 *   active -> archived -> trashed -> purged
 *              ^           |
 *              +-- restore-+
 *
 * - `archived`: hidden from the default list, all data and artifacts kept.
 * - `trashed`: kept for a retention window (default 7 days), restorable.
 * - `purged`: the hub deletes the task bodies, messages, attempts,
 *   interventions, deliveries and the artifacts EXCLUSIVE to that root; only
 *   a minimal audit tombstone survives.
 *
 * The hub keeps the maps (this.lifecycles / this.tombstones) and persists
 * them with the regular state flush; this module owns the transition rules,
 * permission checks, idempotency and audit events.
 */

export const LIFECYCLE_STATES = ["active", "archived", "trashed"];
// Workflow conversation statuses that may be archived/trashed. `active` and
// `needs_human` are live workflows; `stalled` is not running anything but
// never reached a terminal pillar - it is treated as dead and archivable.
const ARCHIVABLE_CONVERSATION_STATUSES = new Set(["completed", "failed", "cancelled", "stalled"]);
const DEFAULT_TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOMBSTONE_COUNT = 1000;

export function lifecycleError(statusCode, message, code, details) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}), ...(details ? { details } : {}) });
}

function titleDigest(title) {
  return createHash("sha256").update(String(title ?? "")).digest("hex").slice(0, 16);
}

export class ConversationLifecycleManager {
  constructor(hub, options = {}) {
    this.hub = hub;
    this.retentionMs = Number(options.trashRetentionMs ?? DEFAULT_TRASH_RETENTION_MS);
    this.lifecycles = new Map();
    this.tombstones = new Map();
  }

  /** Rebuilds the registry from persisted state after a hub restart. */
  loadState(lifecycles, tombstones) {
    for (const record of Array.isArray(lifecycles) ? lifecycles : []) {
      if (record && typeof record.rootTaskId === "string") {
        this.lifecycles.set(record.rootTaskId, { ...record });
      }
    }
    for (const stone of Array.isArray(tombstones) ? tombstones : []) {
      if (stone && typeof stone.rootTaskId === "string") {
        this.tombstones.set(stone.rootTaskId, { ...stone });
      }
    }
  }

  markLifecycle(record) {
    if (record?.rootTaskId && typeof this.hub.markLifecycle === "function") this.hub.markLifecycle(record);
  }

  /** Current lifecycle state of a root conversation; `active` when unknown. */
  stateOf(rootTaskId) {
    if (this.tombstones.has(rootTaskId)) return "purged";
    return this.lifecycles.get(rootTaskId)?.state ?? "active";
  }

  recordOf(rootTaskId) {
    return this.lifecycles.get(rootTaskId) ?? null;
  }

  requireRecord(rootTaskId) {
    let record = this.lifecycles.get(rootTaskId);
    if (!record) {
      record = {
        rootTaskId,
        state: "active",
        archivedAt: null,
        archivedBy: null,
        trashedAt: null,
        trashedBy: null,
        purgeAfter: null,
        updatedAt: new Date().toISOString(),
        version: 1,
      };
      this.lifecycles.set(rootTaskId, record);
      this.markLifecycle(record);
    }
    return record;
  }

  /**
   * The workflow behind the conversation must be terminal before it can be
   * archived or trashed: completed, failed (or rejected), cancelled - or
   * stalled (nothing running, never finalized). Live workflows (active,
   * needs_human) are rejected with 409 WORKFLOW_NOT_TERMINAL.
   */
  assertWorkflowTerminal(rootTaskId) {
    const root = this.hub.tasks.get(rootTaskId);
    if (!root || root.rootTaskId !== root.taskId) {
      throw lifecycleError(409, `Task '${rootTaskId}' is not a conversation root; single subtasks cannot be deleted`, "NOT_A_ROOT_CONVERSATION");
    }
    const conversation = this.hub.conversations({ lifecycle: "all" }).find((item) => item.rootTaskId === rootTaskId);
    const status = conversation?.status ?? null;
    if (!status || !ARCHIVABLE_CONVERSATION_STATUSES.has(status)) {
      throw lifecycleError(409, `The workflow of conversation '${rootTaskId}' is not terminal (status ${status ?? "unknown"})`, "WORKFLOW_NOT_TERMINAL", { conversationStatus: status });
    }
    return status;
  }

  requireWebActor(actor, { admin = false } = {}) {
    if (actor?.kind !== "web") throw lifecycleError(403, "Web user session required", "FORBIDDEN");
    if (admin && actor.role !== "admin") {
      throw lifecycleError(403, "Administrator role required for permanent purge", "FORBIDDEN");
    }
    if (!admin && actor.role !== "admin" && actor.role !== "operator") {
      throw lifecycleError(403, "Operator role required", "FORBIDDEN");
    }
  }

  requireKnownRoot(rootTaskId) {
    const root = this.hub.tasks.get(rootTaskId);
    if (!root || root.rootTaskId !== root.taskId) {
      throw lifecycleError(404, `Unknown conversation '${rootTaskId}'`, "UNKNOWN_CONVERSATION");
    }
  }

  async audit(type, details) {
    await this.hub.recordEvent(type, details);
  }

  /**
   * Applies one transition synchronously (check + mutate without any await)
   * so two racing requests can never both win. Returns
   * { record, transitioned } - transitioned=false means idempotent replay.
   */
  transition(rootTaskId, { from, to, actor, terminalCheck = false }) {
    const record = this.requireRecord(rootTaskId);
    if (record.state === to) return { record, transitioned: false };
    if (from && !from.includes(record.state)) {
      throw lifecycleError(409, `Cannot move conversation '${rootTaskId}' from ${record.state} to ${to}`, "INVALID_LIFECYCLE_TRANSITION", { from: record.state, to });
    }
    if (terminalCheck) this.assertWorkflowTerminal(rootTaskId);
    const now = new Date().toISOString();
    record.version += 1;
    record.state = to;
    record.updatedAt = now;
    if (to === "archived") {
      record.archivedAt = now;
      record.archivedBy = actor?.id ?? "unknown";
    }
    if (to === "trashed") {
      record.trashedAt = now;
      record.trashedBy = actor?.id ?? "unknown";
      record.purgeAfter = new Date(Date.now() + this.retentionMs).toISOString();
    }
    if (to === "active") {
      record.archivedAt = null;
      record.archivedBy = null;
    }
    this.markLifecycle(record);
    return { record, transitioned: true };
  }

  async archive(rootTaskId, actor) {
    this.requireWebActor(actor);
    this.requireKnownRoot(rootTaskId);
    let outcome;
    try {
      outcome = this.transition(rootTaskId, { from: ["active"], to: "archived", actor, terminalCheck: true });
    } catch (error) {
      await this.audit("conversation.lifecycle.rejected", {
        actor: actor?.id ?? "unknown", rootTaskId, action: "archive", reason: error.code ?? "ERROR",
        ...(error.details ?? {}),
      });
      throw error;
    }
    if (outcome.transitioned) {
      await this.audit("conversation.archived", { actor: actor.id, rootTaskId, from: "active", to: "archived" });
      await this.hub.flushState();
    }
    return { lifecycle: this.publicRecord(outcome.record), transitioned: outcome.transitioned };
  }

  async restore(rootTaskId, actor) {
    this.requireWebActor(actor);
    this.requireKnownRoot(rootTaskId);
    let outcome;
    try {
      outcome = this.transition(rootTaskId, { from: ["archived"], to: "active", actor });
    } catch (error) {
      if (error.code === "INVALID_LIFECYCLE_TRANSITION") {
        // Restoring an active conversation is a no-op, not an error.
        const record = this.requireRecord(rootTaskId);
        return { lifecycle: this.publicRecord(record), transitioned: false };
      }
      await this.audit("conversation.lifecycle.rejected", {
        actor: actor?.id ?? "unknown", rootTaskId, action: "restore", reason: error.code ?? "ERROR",
        ...(error.details ?? {}),
      });
      throw error;
    }
    if (outcome.transitioned) {
      await this.audit("conversation.restored", { actor: actor.id, rootTaskId, from: "archived", to: "active" });
      await this.hub.flushState();
    }
    return { lifecycle: this.publicRecord(outcome.record), transitioned: outcome.transitioned };
  }

  async trash(rootTaskId, actor) {
    this.requireWebActor(actor);
    this.requireKnownRoot(rootTaskId);
    let outcome;
    try {
      outcome = this.transition(rootTaskId, { from: ["active", "archived"], to: "trashed", actor, terminalCheck: true });
    } catch (error) {
      await this.audit("conversation.lifecycle.rejected", {
        actor: actor?.id ?? "unknown", rootTaskId, action: "trash", reason: error.code ?? "ERROR",
        ...(error.details ?? {}),
      });
      throw error;
    }
    if (outcome.transitioned) {
      await this.audit("conversation.trashed", {
        actor: actor.id, rootTaskId, from: outcome.record.archivedAt ? "archived" : "active", to: "trashed",
        purgeAfter: outcome.record.purgeAfter,
      });
      await this.hub.flushState();
    }
    return { lifecycle: this.publicRecord(outcome.record), transitioned: outcome.transitioned };
  }

  async restoreFromTrash(rootTaskId, actor) {
    this.requireWebActor(actor);
    this.requireKnownRoot(rootTaskId);
    let outcome;
    try {
      outcome = this.transition(rootTaskId, { from: ["trashed"], to: "archived", actor });
    } catch (error) {
      await this.audit("conversation.lifecycle.rejected", {
        actor: actor?.id ?? "unknown", rootTaskId, action: "trash_restore", reason: error.code ?? "ERROR",
        ...(error.details ?? {}),
      });
      throw error;
    }
    if (outcome.transitioned) {
      // Restored conversations come back as archived, not active: the user
      // explicitly re-opens them with restore() if desired (contract 6.5).
      await this.audit("conversation.trash_restored", { actor: actor.id, rootTaskId, from: "trashed", to: "archived" });
      await this.hub.flushState();
    }
    return { lifecycle: this.publicRecord(outcome.record), transitioned: outcome.transitioned };
  }

  /**
   * Permanent purge (Administrator only). File deletions happen FIRST; only
   * when every exclusive artifact was removed from disk does the metadata
   * disappear, so a failure never leaves "purged in the database but the
   * body still on disk". Retry is safe (file removal is idempotent).
   */
  async purge(rootTaskId, actor) {
    this.requireWebActor(actor, { admin: true });
    const tombstone = this.tombstones.get(rootTaskId);
    if (tombstone) {
      // Purging twice returns the tombstone, not an error.
      return { purged: true, alreadyPurged: true, tombstone: this.publicTombstone(tombstone) };
    }
    this.requireKnownRoot(rootTaskId);
    const record = this.requireRecord(rootTaskId);
    if (record.state !== "trashed") {
      const error = lifecycleError(409, `Conversation '${rootTaskId}' must be in the trash before purge (state ${record.state})`, "INVALID_LIFECYCLE_TRANSITION", { from: record.state, to: "purged" });
      await this.audit("conversation.lifecycle.rejected", {
        actor: actor?.id ?? "unknown", rootTaskId, action: "purge", reason: error.code, ...(error.details ?? {}),
      });
      throw error;
    }

    const root = this.hub.tasks.get(rootTaskId);
    const rootTaskIds = new Set([rootTaskId]);
    const taskIds = new Set();
    for (const task of this.hub.tasks.values()) {
      if (task.rootTaskId === rootTaskId || this.hub.getCanonicalRootTask(task)?.taskId === rootTaskId) {
        taskIds.add(task.taskId);
        rootTaskIds.add(task.rootTaskId);
      }
    }

    // 1. Collect the artifacts exclusive to this conversation. An artifact is
    //    shared when ANY task OUTSIDE this root still references it.
    const exclusiveArtifacts = [];
    const sharedArtifacts = [];
    for (const artifact of this.hub.artifacts.values()) {
      if (artifact.rootTaskId !== rootTaskId && !taskIds.has(artifact.taskId)) continue;
      if (this.artifactSharedWithOtherRoots(artifact, rootTaskId, taskIds)) {
        sharedArtifacts.push(artifact.artifactId);
      } else {
        exclusiveArtifacts.push(artifact);
      }
    }

    // 2. Delete the exclusive artifact files from disk BEFORE touching any
    //    metadata. A failure aborts the purge with nothing else removed.
    for (const artifact of exclusiveArtifacts) {
      if (artifact.storageKey && this.hub.artifactStore?.remove) {
        try {
          await this.hub.artifactStore.remove(artifact);
        } catch (error) {
          await this.audit("conversation.lifecycle.rejected", {
            actor: actor?.id ?? "unknown", rootTaskId, action: "purge",
            reason: "ARTIFACT_DELETE_FAILED", artifactId: artifact.artifactId, error: String(error.message ?? error).slice(0, 300),
          });
          throw lifecycleError(500, `Purge aborted: artifact ${artifact.artifactId} could not be deleted from the store`, "ARTIFACT_DELETE_FAILED", { artifactId: artifact.artifactId });
        }
      }
    }

    // 3. Delete metadata: tasks, messages, attempts, interventions, deliveries, artifacts.
    const counts = {
      tasks: taskIds.size,
      messages: 0,
      attempts: 0,
      interventions: 0,
      artifacts: exclusiveArtifacts.length,
    };
    const messageIds = this.hub.store.collectMessageIdsByRoot
      ? this.hub.store.collectMessageIdsByRoot(rootTaskId)
      : this.hub.messages.filter((message) => message.rootTaskId === rootTaskId).map((message) => message.messageId);
    counts.messages = messageIds.length;
    const attemptIds = [...this.hub.attempts.values()].filter((attempt) => taskIds.has(attempt.taskId)).map((attempt) => attempt.attemptId);
    counts.attempts = attemptIds.length;
    const interventionIds = [...this.hub.interventions.values()].filter((intervention) => intervention.rootTaskId === rootTaskId).map((intervention) => intervention.interventionId);
    counts.interventions = interventionIds.length;
    const deliveryKeys = [...this.hub.pendingDeliveries.values()]
      .filter((delivery) => {
        const taskId = delivery.envelope?.taskId ?? delivery.envelope?.payload?.taskId;
        return taskId != null && taskIds.has(taskId);
      })
      .map((delivery) => `${delivery.agentId}:${delivery.envelope.id}`);
    counts.deliveries = deliveryKeys.length;

    this.hub.markPurgeRemovals({
      taskIds: [...taskIds],
      messageIds,
      attemptIds,
      interventionIds,
      artifactIds: exclusiveArtifacts.map((artifact) => artifact.artifactId),
      deliveryKeys,
    });
    for (const artifact of exclusiveArtifacts) this.hub.artifacts.delete(artifact.artifactId);
    for (const attemptId of attemptIds) this.hub.attempts.delete(attemptId);
    for (const interventionId of interventionIds) this.hub.interventions.delete(interventionId);
    for (const deliveryKey of deliveryKeys) this.hub.pendingDeliveries.delete(deliveryKey);
    for (const taskId of taskIds) this.hub.tasks.delete(taskId);
    this.hub.messages = this.hub.messages.filter((message) => !messageIds.includes(message.messageId));
    this.lifecycles.delete(rootTaskId);
    this.hub.markLifecycleRemoved(rootTaskId);

    const stone = {
      tombstoneId: randomUUID(),
      rootTaskId,
      titleDigest: titleDigest(root?.taskSpec?.title ?? root?.input ?? rootTaskId),
      purgedBy: actor.id,
      purgedAt: new Date().toISOString(),
      counts,
      sharedArtifactIds: sharedArtifacts,
    };
    this.tombstones.set(rootTaskId, stone);
    if (typeof this.hub.markTombstone === "function") this.hub.markTombstone(stone);
    this.pruneTombstones();
    await this.audit("conversation.purged", {
      actor: actor.id, rootTaskId, ...counts,
      sharedArtifactsKept: sharedArtifacts.length,
      titleDigest: stone.titleDigest,
    });
    await this.hub.flushState();
    return { purged: true, alreadyPurged: false, tombstone: this.publicTombstone(stone) };
  }

  /** True when a task outside the purged root still references the artifact. */
  artifactSharedWithOtherRoots(artifact, rootTaskId, purgedTaskIds) {
    for (const task of this.hub.tasks.values()) {
      if (purgedTaskIds.has(task.taskId)) continue;
      const references = [
        ...(task.contextBundle?.artifactReferences ?? []),
        ...(task.artifacts?.files ?? []),
        ...(task.taskSpec?.artifacts ?? []),
      ];
      if (references.some((item) => item?.artifactId === artifact.artifactId)) return true;
    }
    return false;
  }

  /** Auto-purge everything whose retention window elapsed (hub sweep timer). */
  async purgeDue(now = Date.now(), actor = { kind: "web", id: "system:sweeper", role: "admin" }) {
    const due = [...this.lifecycles.values()].filter(
      (record) => record.state === "trashed" && record.purgeAfter && Date.parse(record.purgeAfter) <= now,
    );
    const purged = [];
    for (const record of due) {
      try {
        const outcome = await this.purge(record.rootTaskId, actor);
        purged.push({ rootTaskId: record.rootTaskId, tombstone: outcome.tombstone });
      } catch {
        // Keep the item in the trash; the next sweep retries.
      }
    }
    return purged;
  }

  tombstoneOf(rootTaskId) {
    const stone = this.tombstones.get(rootTaskId);
    return stone ? this.publicTombstone(stone) : null;
  }

  pruneTombstones() {
    if (this.tombstones.size <= MAX_TOMBSTONE_COUNT) return;
    const ordered = [...this.tombstones.values()].sort((a, b) => Date.parse(a.purgedAt) - Date.parse(b.purgedAt));
    for (const stone of ordered.slice(0, this.tombstones.size - MAX_TOMBSTONE_COUNT)) {
      this.tombstones.delete(stone.rootTaskId);
    }
  }

  publicRecord(record) {
    return {
      rootTaskId: record.rootTaskId,
      state: record.state,
      archivedAt: record.archivedAt,
      archivedBy: record.archivedBy,
      trashedAt: record.trashedAt,
      trashedBy: record.trashedBy,
      purgeAfter: record.purgeAfter,
      updatedAt: record.updatedAt,
      version: record.version,
    };
  }

  publicTombstone(stone) {
    return {
      tombstoneId: stone.tombstoneId,
      rootTaskId: stone.rootTaskId,
      titleDigest: stone.titleDigest,
      purgedBy: stone.purgedBy,
      purgedAt: stone.purgedAt,
      counts: { ...stone.counts },
    };
  }

  listRecords() {
    return [...this.lifecycles.values()].map((record) => this.publicRecord(record));
  }
}
