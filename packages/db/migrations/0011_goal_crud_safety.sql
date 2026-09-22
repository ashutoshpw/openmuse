-- Goal CRUD is owner-isolated. Scheduling metadata is persisted and validated
-- at the application boundary, but occurrence materialization/execution is not
-- part of this migration.

ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS revision integer,
  ADD COLUMN IF NOT EXISTS config jsonb,
  ADD COLUMN IF NOT EXISTS next_run_at timestamptz;

UPDATE goals
SET revision = CASE
  WHEN jsonb_typeof(progress -> 'revision') = 'number'
    AND (progress ->> 'revision') ~ '^[1-9][0-9]{0,8}$'
    THEN (progress ->> 'revision')::integer
  ELSE 1
END,
config = jsonb_build_object(
  'schedule', CASE
    WHEN jsonb_typeof(progress -> 'schedule') = 'object'
      AND progress ->> 'kind' IN ('once', 'interval', 'cron')
      THEN progress -> 'schedule'
    ELSE 'null'::jsonb
  END,
  'connectionIds', CASE
    WHEN jsonb_typeof(progress -> 'connectionIds') = 'array'
      THEN progress -> 'connectionIds'
    ELSE '[]'::jsonb
  END,
  'memoryIds', CASE
    WHEN jsonb_typeof(progress -> 'memoryIds') = 'array'
      THEN progress -> 'memoryIds'
    ELSE '[]'::jsonb
  END,
  'approvalPolicyVersion', CASE
    WHEN jsonb_typeof(progress -> 'approvalPolicyVersion') = 'string'
      THEN progress -> 'approvalPolicyVersion'
    ELSE '"1"'::jsonb
  END
)
WHERE revision IS NULL OR config IS NULL;

ALTER TABLE goals
  ALTER COLUMN revision SET DEFAULT 1,
  ALTER COLUMN revision SET NOT NULL,
  ALTER COLUMN config SET DEFAULT '{"schedule":null,"connectionIds":[],"memoryIds":[],"approvalPolicyVersion":"1"}'::jsonb,
  ALTER COLUMN config SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'goals_revision_positive_check'
      AND conrelid = 'goals'::regclass
  ) THEN
    ALTER TABLE goals
      ADD CONSTRAINT goals_revision_positive_check CHECK (revision > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'goals_status_check'
      AND conrelid = 'goals'::regclass
  ) THEN
    ALTER TABLE goals
      ADD CONSTRAINT goals_status_check
      CHECK (status IN ('draft', 'active', 'paused', 'completed', 'blocked'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS goals_owner_updated_idx
  ON goals (workspace_id, created_by, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS goals_due_owner_idx
  ON goals (workspace_id, created_by, status, next_run_at);

DROP POLICY IF EXISTS goals_scope ON goals;
CREATE POLICY goals_scope ON goals
  USING (
    workspace_id = openmuse_workspace_id()
    AND created_by = openmuse_actor_id()
    AND openmuse_is_member(workspace_id)
  )
  WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND created_by = openmuse_actor_id()
    AND openmuse_is_member(workspace_id)
  );

-- Resource routes must not resolve a goal's workspace for another workspace
-- member. Keep the function SECURITY DEFINER and return only the workspace ID.
CREATE OR REPLACE FUNCTION openmuse_resolve_resource_workspace(
  candidate_resource_type text,
  candidate_resource_id text,
  candidate_actor_id text
)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT source.workspace_id
  FROM (
    SELECT 'conversation'::text AS resource_type, c.id AS resource_id, c.workspace_id
    FROM conversations c
    WHERE (c.created_by = candidate_actor_id OR EXISTS (
      SELECT 1 FROM conversation_members cm
      WHERE cm.conversation_id = c.id
        AND cm.user_id = candidate_actor_id
        AND cm.permission = 'owner'
    ))
    UNION ALL
    SELECT 'run', r.id, r.workspace_id
    FROM runs r
    WHERE r.requested_by = candidate_actor_id
    UNION ALL
    SELECT 'goal', g.id, g.workspace_id
    FROM goals g
    WHERE g.created_by = candidate_actor_id
      AND EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = g.workspace_id
          AND wm.user_id = candidate_actor_id
          AND wm.status = 'active'
      )
    UNION ALL
    SELECT 'memory', m.id, m.workspace_id
    FROM memories m
    WHERE m.created_by = candidate_actor_id
      OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = m.workspace_id AND wm.user_id = candidate_actor_id AND wm.status = 'active')
    UNION ALL
    SELECT 'artifact', a.id, a.workspace_id
    FROM artifacts a
    WHERE EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = a.workspace_id AND wm.user_id = candidate_actor_id AND wm.status = 'active')
    UNION ALL
    SELECT 'approval', a.id, a.workspace_id
    FROM approvals a
    WHERE EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = a.workspace_id AND wm.user_id = candidate_actor_id AND wm.status = 'active')
    UNION ALL
    SELECT 'provider_instance', p.id, p.workspace_id
    FROM provider_instances p
    WHERE EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = p.workspace_id AND wm.user_id = candidate_actor_id AND wm.status = 'active')
    UNION ALL
    SELECT 'share', s.snapshot_id, s.workspace_id
    FROM shared_snapshot_grants s
    WHERE EXISTS (SELECT 1 FROM shared_snapshots ss WHERE ss.id = s.snapshot_id AND ss.created_by = candidate_actor_id)
  ) AS source
  WHERE source.resource_type = candidate_resource_type
    AND source.resource_id = candidate_resource_id
  LIMIT 1
$$;
