CREATE TABLE IF NOT EXISTS hub_metadata (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id uuid PRIMARY KEY,
  root_task_id uuid NOT NULL,
  parent_task_id uuid,
  status text NOT NULL,
  current_attempt_id uuid,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_root_task_id_idx ON tasks (root_task_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status);

CREATE TABLE IF NOT EXISTS task_messages (
  message_id uuid PRIMARY KEY,
  root_task_id uuid NOT NULL,
  task_id uuid NOT NULL,
  sequence bigint NOT NULL UNIQUE,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS task_messages_root_sequence_idx ON task_messages (root_task_id, sequence);

CREATE TABLE IF NOT EXISTS worker_registrations (
  agent_id text PRIMARY KEY,
  status text NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  message_id uuid PRIMARY KEY,
  agent_id text NOT NULL,
  message_type text NOT NULL,
  task_id uuid,
  document jsonb NOT NULL,
  received_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_deliveries (
  agent_id text NOT NULL,
  message_id uuid NOT NULL,
  message_type text NOT NULL,
  task_id uuid,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, message_id)
);

CREATE INDEX IF NOT EXISTS outbound_deliveries_task_id_idx ON outbound_deliveries (task_id);

CREATE TABLE IF NOT EXISTS task_attempts (
  attempt_id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  worker_id text NOT NULL,
  status text NOT NULL,
  assignment_message_id uuid,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS task_attempts_task_id_idx ON task_attempts (task_id);
CREATE INDEX IF NOT EXISTS task_attempts_active_lease_idx ON task_attempts (lease_expires_at)
  WHERE status IN ('assigned', 'running');

CREATE TABLE IF NOT EXISTS audit_events (
  sequence bigint PRIMARY KEY,
  event_type text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id text PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  attempt_id uuid REFERENCES task_attempts(attempt_id) ON DELETE SET NULL,
  status text NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS human_interventions (
  intervention_id text PRIMARY KEY,
  root_task_id uuid NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  status text NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
