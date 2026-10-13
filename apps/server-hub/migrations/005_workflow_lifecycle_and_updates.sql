CREATE TABLE IF NOT EXISTS device_update_jobs (
  job_id text PRIMARY KEY,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_lifecycles (
  root_task_id uuid PRIMARY KEY,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_tombstones (
  root_task_id uuid PRIMARY KEY,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A surviving workflow can reference an artifact produced by a purged one.
-- Preserve that shared artifact while removing its original task ownership.
ALTER TABLE artifacts ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_task_id_fkey;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_task_id_fkey
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE SET NULL;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_root_task_id_fkey;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_root_task_id_fkey
  FOREIGN KEY (root_task_id) REFERENCES tasks(task_id) ON DELETE SET NULL;
