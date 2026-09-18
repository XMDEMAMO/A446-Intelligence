DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM worker_credentials
    WHERE status = 'active'
    GROUP BY agent_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'worker_credentials contains more than one active credential for an agent_id; revoke duplicates before applying migration 004';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS worker_credentials_one_active_agent_idx
  ON worker_credentials (agent_id)
  WHERE status = 'active';

ALTER TABLE web_users
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

CREATE TABLE IF NOT EXISTS web_login_throttles (
  scope_type text NOT NULL,
  scope_hash text NOT NULL,
  failure_count integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL,
  last_failed_at timestamptz,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_hash),
  CHECK (scope_type IN ('ip', 'username')),
  CHECK (failure_count >= 0),
  CHECK (length(scope_hash) = 64)
);

CREATE INDEX IF NOT EXISTS web_login_throttles_blocked_idx
  ON web_login_throttles (blocked_until)
  WHERE blocked_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS web_auth_events (
  event_id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL,
  user_id uuid REFERENCES web_users(user_id) ON DELETE SET NULL,
  username_hash text NOT NULL,
  ip_hash text,
  retry_after_ms integer,
  CHECK (outcome IN ('success', 'invalid_credentials', 'rate_limited')),
  CHECK (length(username_hash) = 64),
  CHECK (ip_hash IS NULL OR length(ip_hash) = 64),
  CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0)
);

CREATE INDEX IF NOT EXISTS web_auth_events_occurred_idx
  ON web_auth_events (occurred_at);
CREATE INDEX IF NOT EXISTS web_auth_events_user_idx
  ON web_auth_events (user_id, occurred_at);
