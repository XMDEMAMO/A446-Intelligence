import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

export class PostgresHubStore {
  constructor(options = {}) {
    if (!options.connectionString && !options.pool) throw new Error("PostgresHubStore requires a connection string or Pool");
    this.migrationsDirectory = options.migrationsDirectory;
    this.ownsPool = !options.pool;
    this.pool = options.pool ?? new Pool({
      connectionString: options.connectionString,
      max: Math.max(1, Number(options.maxConnections ?? 10)),
      application_name: options.applicationName ?? "a446-server-hub",
      ...(options.ssl ? { ssl: options.ssl === true ? { rejectUnauthorized: true } : options.ssl } : {}),
    });
  }

  async init() {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT 1");
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await this.applyMigrations(client);
    } finally {
      client.release();
    }
  }

  async applyMigrations(client) {
    if (!this.migrationsDirectory) throw new Error("PostgresHubStore requires migrationsDirectory");
    const files = (await readdir(this.migrationsDirectory))
      .filter((file) => /^\d+.*\.sql$/i.test(file))
      .sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [file]);
      if (applied.rowCount > 0) continue;
      const sql = await readFile(path.join(this.migrationsDirectory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  }

  async load() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const tasks = await client.query("SELECT document FROM tasks ORDER BY created_at, task_id");
      const messages = await client.query("SELECT document FROM task_messages ORDER BY sequence");
      const agents = await client.query("SELECT document FROM worker_registrations ORDER BY agent_id");
      const attempts = await client.query("SELECT document FROM task_attempts ORDER BY created_at, attempt_id");
      const deliveries = await client.query("SELECT document FROM outbound_deliveries ORDER BY created_at, message_id");
      const inbound = await client.query("SELECT document FROM inbound_messages ORDER BY received_at, message_id");
      const events = await client.query("SELECT document FROM audit_events ORDER BY sequence");
      const metadataRows = await client.query("SELECT key, value FROM hub_metadata");
      await client.query("COMMIT");
      return {
        tasks: tasks.rows.map((row) => row.document),
        messages: messages.rows.map((row) => row.document),
        agents: agents.rows.map((row) => row.document),
        attempts: attempts.rows.map((row) => row.document),
        deliveries: deliveries.rows.map((row) => row.document),
        inboundMessages: inbound.rows.map((row) => row.document),
        auditEvents: events.rows.map((row) => row.document),
        metadata: Object.fromEntries(metadataRows.rows.map((row) => [row.key, row.value])),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async commit(changes = {}) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const task of changes.tasks ?? []) await upsertTask(client, task, changes.taskGuards?.[task.taskId]);
      for (const message of changes.messages ?? []) await upsertMessage(client, message);
      for (const agent of changes.agents ?? []) await upsertAgent(client, agent);
      for (const attempt of changes.attempts ?? []) await upsertAttempt(client, attempt);
      for (const delivery of changes.deliveries ?? []) await upsertDelivery(client, delivery);
      for (const delivery of changes.deletedDeliveries ?? []) {
        await client.query("DELETE FROM outbound_deliveries WHERE agent_id = $1 AND message_id = $2", [delivery.agentId, delivery.messageId]);
      }
      for (const message of changes.inboundMessages ?? []) await upsertInboundMessage(client, message);
      for (const event of changes.auditEvents ?? []) await upsertAuditEvent(client, event);
      for (const [key, value] of Object.entries(changes.metadata ?? {})) {
        await client.query(`
          INSERT INTO hub_metadata (key, value, updated_at)
          VALUES ($1, $2::jsonb, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `, [key, JSON.stringify(value)]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

async function upsertTask(client, task, guard) {
  if (guard) {
    const result = await client.query(`
      UPDATE tasks SET
        root_task_id = $2,
        parent_task_id = $3,
        status = $4,
        current_attempt_id = $5,
        document = $6::jsonb,
        updated_at = now()
      WHERE task_id = $1
        AND current_attempt_id = $7
        AND status = ANY($8::text[])
    `, [
      task.taskId,
      task.rootTaskId,
      task.parentTaskId ?? null,
      task.status,
      task.currentAttemptId ?? null,
      JSON.stringify(task),
      guard.currentAttemptId,
      guard.allowedStatuses ?? [],
    ]);
    if (result.rowCount !== 1) {
      throw Object.assign(new Error(`Stale task transition rejected for ${task.taskId}`), { code: "STALE_TASK_TRANSITION" });
    }
  } else {
    await client.query(`
      INSERT INTO tasks (task_id, root_task_id, parent_task_id, status, current_attempt_id, document, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
      ON CONFLICT (task_id) DO UPDATE SET
        root_task_id = EXCLUDED.root_task_id,
        parent_task_id = EXCLUDED.parent_task_id,
        status = EXCLUDED.status,
        current_attempt_id = EXCLUDED.current_attempt_id,
        document = EXCLUDED.document,
        updated_at = now()
    `, [
      task.taskId,
      task.rootTaskId,
      task.parentTaskId ?? null,
      task.status,
      task.currentAttemptId ?? null,
      JSON.stringify(task),
      task.createdAt,
    ]);
  }

  if (task.humanIntervention) {
    await client.query(`
      INSERT INTO human_interventions (intervention_id, root_task_id, status, document, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, now())
      ON CONFLICT (intervention_id) DO UPDATE SET status = EXCLUDED.status, document = EXCLUDED.document, updated_at = now()
    `, [`${task.rootTaskId}:current`, task.rootTaskId, task.humanIntervention.status ?? "unknown", JSON.stringify(task.humanIntervention)]);
  }
}

async function upsertMessage(client, message) {
  await client.query(`
    INSERT INTO task_messages (message_id, root_task_id, task_id, sequence, document, created_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    ON CONFLICT (message_id) DO UPDATE SET document = EXCLUDED.document
  `, [message.messageId, message.rootTaskId, message.taskId, message.seq, JSON.stringify(message), message.createdAt]);
}

async function upsertAgent(client, agent) {
  await client.query(`
    INSERT INTO worker_registrations (agent_id, status, document, updated_at)
    VALUES ($1, $2, $3::jsonb, now())
    ON CONFLICT (agent_id) DO UPDATE SET status = EXCLUDED.status, document = EXCLUDED.document, updated_at = now()
  `, [agent.agentId, agent.status ?? "offline", JSON.stringify(agent)]);
}

async function upsertAttempt(client, attempt) {
  await client.query(`
    INSERT INTO task_attempts (
      attempt_id, task_id, attempt_number, worker_id, status, assignment_message_id,
      lease_expires_at, last_heartbeat_at, started_at, completed_at, document, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, now())
    ON CONFLICT (attempt_id) DO UPDATE SET
      status = EXCLUDED.status,
      assignment_message_id = EXCLUDED.assignment_message_id,
      lease_expires_at = EXCLUDED.lease_expires_at,
      last_heartbeat_at = EXCLUDED.last_heartbeat_at,
      started_at = EXCLUDED.started_at,
      completed_at = EXCLUDED.completed_at,
      document = EXCLUDED.document,
      updated_at = now()
  `, [
    attempt.attemptId,
    attempt.taskId,
    attempt.attemptNumber,
    attempt.workerId,
    attempt.status,
    attempt.assignmentMessageId ?? null,
    attempt.leaseExpiresAt ?? null,
    attempt.lastHeartbeatAt ?? null,
    attempt.startedAt ?? null,
    attempt.completedAt ?? attempt.expiredAt ?? null,
    JSON.stringify(attempt),
    attempt.createdAt,
  ]);
}

async function upsertDelivery(client, delivery) {
  await client.query(`
    INSERT INTO outbound_deliveries (agent_id, message_id, message_type, task_id, document, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
    ON CONFLICT (agent_id, message_id) DO UPDATE SET document = EXCLUDED.document, updated_at = now()
  `, [
    delivery.agentId,
    delivery.envelope.id,
    delivery.envelope.type,
    delivery.envelope.taskId ?? null,
    JSON.stringify(delivery),
    delivery.createdAt ?? delivery.envelope.ts,
  ]);
}

async function upsertInboundMessage(client, message) {
  await client.query(`
    INSERT INTO inbound_messages (message_id, agent_id, message_type, task_id, document, received_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    ON CONFLICT (message_id) DO NOTHING
  `, [message.messageId, message.agentId, message.type, message.taskId ?? null, JSON.stringify(message), message.receivedAt]);
}

async function upsertAuditEvent(client, event) {
  await client.query(`
    INSERT INTO audit_events (sequence, event_type, document, created_at)
    VALUES ($1, $2, $3::jsonb, $4)
    ON CONFLICT (sequence) DO UPDATE SET event_type = EXCLUDED.event_type, document = EXCLUDED.document, created_at = EXCLUDED.created_at
  `, [event.seq, event.type, JSON.stringify(event), event.ts]);
}
