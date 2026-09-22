-- Persisted provider configuration is metadata only. Secret material remains
-- in provider_credentials and is never copied into this table or returned by
-- the API.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE TABLE IF NOT EXISTS provider_instances (
  id text PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  module text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'available',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
  version text NOT NULL DEFAULT '1',
  config_version text NOT NULL DEFAULT '1',
  config_digest text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_instances_scope_check CHECK (
    workspace_id IS NOT NULL
    AND (user_id IS NULL OR user_id = created_by)
  ),
  CONSTRAINT provider_instances_status_check CHECK (status IN ('available', 'unavailable', 'disabled'))
);
CREATE INDEX IF NOT EXISTS provider_instances_workspace_idx
  ON provider_instances (workspace_id, module, provider_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS provider_instances_workspace_name_idx
  ON provider_instances (workspace_id, display_name, user_id);

ALTER TABLE provider_instances ENABLE ROW LEVEL SECURITY;
CREATE POLICY provider_instances_scope ON provider_instances
  USING (
    workspace_id = openmuse_workspace_id()
    AND openmuse_is_member(workspace_id)
    AND (user_id IS NULL OR user_id = openmuse_actor_id() OR openmuse_can_admin(workspace_id))
  )
  WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND openmuse_is_member(workspace_id)
    AND (user_id IS NULL OR user_id = openmuse_actor_id() OR openmuse_can_admin(workspace_id))
    AND created_by = openmuse_actor_id()
  );

DROP TRIGGER IF EXISTS provider_instances_updated_at ON provider_instances;
CREATE TRIGGER provider_instances_updated_at
  BEFORE UPDATE ON provider_instances
  FOR EACH ROW EXECUTE FUNCTION openmuse_touch_updated_at();

-- Workspace and resource routes resolve a tenant only from an authenticated
-- actor. These functions return no payload and keep route code from inventing
-- an unscoped lookup before a ScopedDatabase transaction is established.
CREATE OR REPLACE FUNCTION openmuse_list_actor_workspaces(candidate_actor_id text)
RETURNS TABLE(
  id text,
  name text,
  slug text,
  created_by text,
  created_at timestamptz,
  updated_at timestamptz,
  role text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT w.id, w.name, w.slug, w.created_by, w.created_at, w.updated_at, wm.role
  FROM workspaces w
  INNER JOIN workspace_members wm
    ON wm.workspace_id = w.id
   AND wm.user_id = candidate_actor_id
   AND wm.status = 'active'
  ORDER BY w.updated_at DESC, w.id
$$;

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
      OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = g.workspace_id AND wm.user_id = candidate_actor_id AND wm.status = 'active')
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
