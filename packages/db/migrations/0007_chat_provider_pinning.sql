-- Provider instances are tenant/user configuration records. System providers
-- remain deployment-owned catalogue entries; this table stores only workspace
-- and personal instances.
ALTER TABLE provider_credentials
  ADD COLUMN IF NOT EXISTS provider_instance_id text REFERENCES provider_instances(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS created_by text REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS secret_revision integer NOT NULL DEFAULT 1;

UPDATE provider_credentials pc
SET created_by = COALESCE(pc.created_by, pc.user_id, w.created_by)
FROM workspaces w
WHERE w.id = pc.workspace_id AND pc.created_by IS NULL;

DROP INDEX IF EXISTS provider_credentials_scope_idx;
CREATE UNIQUE INDEX IF NOT EXISTS provider_credentials_instance_kind_idx
  ON provider_credentials (provider_instance_id, credential_kind, user_id)
  WHERE provider_instance_id IS NOT NULL AND status <> 'revoked';
CREATE INDEX IF NOT EXISTS provider_credentials_instance_idx
  ON provider_credentials (workspace_id, provider_instance_id, status);

CREATE TABLE IF NOT EXISTS provider_instance_defaults (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  module text NOT NULL,
  provider_instance_id text NOT NULL REFERENCES provider_instances(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_instance_defaults_scope_idx
  ON provider_instance_defaults (workspace_id, module, user_id);
CREATE INDEX IF NOT EXISTS provider_instance_defaults_instance_idx
  ON provider_instance_defaults (provider_instance_id);
CREATE UNIQUE INDEX IF NOT EXISTS provider_instance_defaults_workspace_unique_idx
  ON provider_instance_defaults (workspace_id, module)
  WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS provider_instance_defaults_user_unique_idx
  ON provider_instance_defaults (workspace_id, user_id, module)
  WHERE user_id IS NOT NULL;

ALTER TABLE provider_instance_defaults ENABLE ROW LEVEL SECURITY;
CREATE POLICY provider_instance_defaults_read ON provider_instance_defaults
  FOR SELECT USING (
    workspace_id = openmuse_workspace_id()
    AND openmuse_is_member(workspace_id)
    AND (user_id IS NULL OR user_id = openmuse_actor_id())
  );
CREATE POLICY provider_instance_defaults_insert ON provider_instance_defaults
  FOR INSERT WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND created_by = openmuse_actor_id()
    AND (
      (user_id = openmuse_actor_id())
      OR (user_id IS NULL AND openmuse_can_admin(workspace_id))
    )
  );
CREATE POLICY provider_instance_defaults_update ON provider_instance_defaults
  FOR UPDATE USING (
    workspace_id = openmuse_workspace_id()
    AND (
      (user_id = openmuse_actor_id())
      OR (user_id IS NULL AND openmuse_can_admin(workspace_id))
    )
  ) WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND created_by = openmuse_actor_id()
    AND (
      (user_id = openmuse_actor_id())
      OR (user_id IS NULL AND openmuse_can_admin(workspace_id))
    )
  );
CREATE POLICY provider_instance_defaults_delete ON provider_instance_defaults
  FOR DELETE USING (
    workspace_id = openmuse_workspace_id()
    AND (
      (user_id = openmuse_actor_id())
      OR (user_id IS NULL AND openmuse_can_admin(workspace_id))
    )
  );

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS provider_instance_id text,
  ADD COLUMN IF NOT EXISTS provider_id text,
  ADD COLUMN IF NOT EXISTS provider_module text,
  ADD COLUMN IF NOT EXISTS provider_version text,
  ADD COLUMN IF NOT EXISTS provider_build_digest text,
  ADD COLUMN IF NOT EXISTS provider_config_version text,
  ADD COLUMN IF NOT EXISTS provider_config jsonb,
  ADD COLUMN IF NOT EXISTS provider_credential_bindings jsonb,
  ADD COLUMN IF NOT EXISTS config_digest text,
  ADD COLUMN IF NOT EXISTS current_event_sequence integer NOT NULL DEFAULT 0;

UPDATE runs r
SET current_event_sequence = COALESCE((
  SELECT max(re.sequence) FROM run_events re WHERE re.run_id = r.id
), 0)
WHERE r.current_event_sequence = 0;

CREATE INDEX IF NOT EXISTS runs_provider_instance_idx
  ON runs (workspace_id, provider_instance_id, created_at);

DROP TRIGGER IF EXISTS provider_instance_defaults_updated_at ON provider_instance_defaults;
CREATE TRIGGER provider_instance_defaults_updated_at
  BEFORE UPDATE ON provider_instance_defaults
  FOR EACH ROW EXECUTE FUNCTION openmuse_touch_updated_at();
