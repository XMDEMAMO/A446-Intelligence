ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS root_task_id uuid REFERENCES tasks(task_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS expected_path text,
  ADD COLUMN IF NOT EXISTS original_name text,
  ADD COLUMN IF NOT EXISTS byte_size bigint,
  ADD COLUMN IF NOT EXISTS sha256 text,
  ADD COLUMN IF NOT EXISTS storage_key text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_attempt_path_idx
  ON artifacts (attempt_id, expected_path)
  WHERE attempt_id IS NOT NULL AND expected_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS artifacts_root_task_idx ON artifacts (root_task_id, created_at);
CREATE INDEX IF NOT EXISTS artifacts_status_idx ON artifacts (status);

CREATE TABLE IF NOT EXISTS worker_credentials (
  credential_id uuid PRIMARY KEY,
  agent_id text NOT NULL,
  device_id text NOT NULL,
  secret_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK (status IN ('active', 'revoked'))
);

CREATE INDEX IF NOT EXISTS worker_credentials_agent_idx
  ON worker_credentials (agent_id, status);

CREATE TABLE IF NOT EXISTS web_users (
  user_id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  password_parameters jsonb NOT NULL,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (role IN ('admin', 'operator')),
  CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS web_sessions (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES web_users(user_id) ON DELETE CASCADE,
  secret_hash text NOT NULL,
  csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS web_sessions_expiry_idx ON web_sessions (expires_at);
