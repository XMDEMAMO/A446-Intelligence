ALTER TABLE human_interventions
  ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES tasks(task_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS requester_role text,
  ADD COLUMN IF NOT EXISTS requester_stage text,
  ADD COLUMN IF NOT EXISTS session_scope_id text,
  ADD COLUMN IF NOT EXISTS decision text,
  ADD COLUMN IF NOT EXISTS resolved_by text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

UPDATE human_interventions
SET status = 'pending',
    document = jsonb_set(document, '{status}', '"pending"'::jsonb, true)
WHERE status = 'required';

CREATE INDEX IF NOT EXISTS human_interventions_root_status_idx
  ON human_interventions (root_task_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS human_interventions_task_idx
  ON human_interventions (task_id, created_at DESC)
  WHERE task_id IS NOT NULL;
