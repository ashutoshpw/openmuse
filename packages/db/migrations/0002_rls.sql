-- Tenant and actor boundary. API code must establish both settings inside a
-- transaction using withTenantContext(); a missing setting intentionally yields
-- no rows rather than a broad read.

CREATE OR REPLACE FUNCTION openmuse_workspace_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')
$$;

CREATE OR REPLACE FUNCTION openmuse_actor_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')
$$;

CREATE OR REPLACE FUNCTION openmuse_is_member(candidate_workspace_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM workspace_members wm
    WHERE wm.workspace_id = candidate_workspace_id
      AND wm.user_id = openmuse_actor_id()
      AND wm.status = 'active'
  )
$$;

CREATE OR REPLACE FUNCTION openmuse_user_in_workspace(
  candidate_user_id text,
  candidate_workspace_id text
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM workspace_members wm
    WHERE wm.user_id = candidate_user_id
      AND wm.workspace_id = candidate_workspace_id
      AND wm.status = 'active'
  )
$$;

CREATE OR REPLACE FUNCTION openmuse_can_admin(candidate_workspace_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM workspace_members wm
    WHERE wm.workspace_id = candidate_workspace_id
      AND wm.user_id = openmuse_actor_id()
      AND wm.status = 'active'
      AND wm.role IN ('owner', 'admin')
  )
$$;

CREATE OR REPLACE FUNCTION openmuse_is_bootstrap_owner(candidate_workspace_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM workspaces w
    WHERE w.id = candidate_workspace_id
      AND w.created_by = openmuse_actor_id()
      AND NOT EXISTS (
        SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id
      )
  )
$$;

CREATE OR REPLACE FUNCTION openmuse_can_read_snapshot(candidate_snapshot_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM shared_snapshots s
    WHERE s.id = candidate_snapshot_id
      AND (s.created_by = openmuse_actor_id() OR EXISTS (
        SELECT 1 FROM shared_snapshot_grants g
        WHERE g.snapshot_id = s.id
          AND g.user_id = openmuse_actor_id()
          AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > now())
      ))
  )
$$;

CREATE OR REPLACE FUNCTION openmuse_can_grant_snapshot(candidate_snapshot_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM shared_snapshots s
    WHERE s.id = candidate_snapshot_id AND s.created_by = openmuse_actor_id()
  )
$$;

CREATE OR REPLACE FUNCTION openmuse_can_read_conversation(candidate_conversation_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = candidate_conversation_id
      AND c.workspace_id = openmuse_workspace_id()
      AND (
        c.created_by = openmuse_actor_id()
        OR EXISTS (
          SELECT 1 FROM conversation_members cm
          WHERE cm.conversation_id = c.id
            AND cm.user_id = openmuse_actor_id()
            AND cm.permission = 'owner'
        )
      )
  )
$$;

-- Runs and their dependent rows inherit the visibility of the conversation
-- that produced them.  These SECURITY DEFINER helpers deliberately query the
-- base tables as the migration owner so that a policy on a child table does
-- not recurse through the parent's RLS policy.
CREATE OR REPLACE FUNCTION openmuse_can_read_run(candidate_run_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM runs r
    WHERE r.id = candidate_run_id
      AND r.workspace_id = openmuse_workspace_id()
      AND openmuse_is_member(r.workspace_id)
      AND openmuse_can_read_conversation(r.conversation_id)
  )
$$;

CREATE OR REPLACE FUNCTION openmuse_can_read_task(candidate_task_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM tasks t
    WHERE t.id = candidate_task_id
      AND t.workspace_id = openmuse_workspace_id()
      AND t.requested_by = openmuse_actor_id()
      AND openmuse_is_member(t.workspace_id)
      AND (t.run_id IS NULL OR openmuse_can_read_run(t.run_id))
  )
$$;

CREATE OR REPLACE FUNCTION openmuse_can_read_artifact(candidate_artifact_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM artifacts a
    WHERE a.id = candidate_artifact_id
      AND a.workspace_id = openmuse_workspace_id()
      AND openmuse_is_member(a.workspace_id)
      AND (
        (a.run_id IS NULL AND a.created_by = openmuse_actor_id())
        OR (a.run_id IS NOT NULL AND openmuse_can_read_run(a.run_id))
      )
  )
$$;

CREATE OR REPLACE FUNCTION openmuse_can_read_approval(candidate_approval_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM approvals a
    WHERE a.id = candidate_approval_id
      AND a.workspace_id = openmuse_workspace_id()
      AND openmuse_is_member(a.workspace_id)
      AND (
        (a.run_id IS NULL AND a.requested_by = openmuse_actor_id())
        OR (a.run_id IS NOT NULL AND openmuse_can_read_run(a.run_id))
      )
  )
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_snapshot_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
-- Better Auth uses a separate role, but keeping these tables behind RLS also
-- prevents an accidentally over-granted tenant role from reading session
-- tokens, password hashes, OAuth tokens, or verification values.
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification ENABLE ROW LEVEL SECURITY;

-- The user may see their own identity and identities in a workspace where they
-- are a member. This is enough for member pickers without exposing the user
-- table as a public directory.
CREATE POLICY users_scope ON users
  USING (
    id = openmuse_actor_id()
    OR openmuse_user_in_workspace(id, openmuse_workspace_id())
  )
  WITH CHECK (id = openmuse_actor_id());

CREATE POLICY workspaces_scope ON workspaces
  USING (id = openmuse_workspace_id() AND (openmuse_is_member(id) OR created_by = openmuse_actor_id()))
  WITH CHECK (id = openmuse_workspace_id() AND created_by = openmuse_actor_id());

CREATE POLICY workspace_members_scope ON workspace_members
  USING (
    workspace_id = openmuse_workspace_id()
    AND (user_id = openmuse_actor_id() OR openmuse_can_admin(workspace_id))
  )
  WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND (
      openmuse_can_admin(workspace_id)
      OR (user_id = openmuse_actor_id() AND openmuse_is_bootstrap_owner(workspace_id))
    )
  );

CREATE POLICY workspace_invites_scope ON workspace_invites
  USING (workspace_id = openmuse_workspace_id() AND openmuse_can_admin(workspace_id))
  WITH CHECK (workspace_id = openmuse_workspace_id() AND openmuse_can_admin(workspace_id));

-- Membership RLS is the first fence. Conversations remain private; the only
-- durable cross-user sharing path is an immutable shared snapshot below.
CREATE POLICY conversations_scope ON conversations
  USING (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id) AND openmuse_can_read_conversation(id))
  WITH CHECK (workspace_id = openmuse_workspace_id() AND created_by = openmuse_actor_id());
CREATE POLICY conversation_members_scope ON conversation_members
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_members.conversation_id
        AND c.workspace_id = openmuse_workspace_id()
        AND openmuse_is_member(c.workspace_id)
    )
    AND (user_id = openmuse_actor_id() OR openmuse_can_admin(openmuse_workspace_id()))
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_members.conversation_id
        AND c.workspace_id = openmuse_workspace_id()
        AND c.created_by = openmuse_actor_id()
    )
    AND user_id = openmuse_actor_id()
    AND permission = 'owner'
  );

-- Shared snapshot payloads are immutable. Grants can be revoked by their
-- creator/admin, but a new payload requires a new snapshot ID.
CREATE POLICY shared_snapshots_scope ON shared_snapshots
  USING (
    workspace_id = openmuse_workspace_id()
    AND openmuse_is_member(workspace_id)
    AND openmuse_can_read_snapshot(id)
  )
  WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND created_by = openmuse_actor_id()
    AND openmuse_is_member(workspace_id)
  );
CREATE POLICY shared_snapshot_grants_scope ON shared_snapshot_grants
  USING (
    workspace_id = openmuse_workspace_id()
    AND openmuse_is_member(workspace_id)
    AND (
      openmuse_can_grant_snapshot(snapshot_id)
      OR (user_id = openmuse_actor_id() AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))
      OR openmuse_can_admin(workspace_id)
    )
  )
  WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND granted_by = openmuse_actor_id()
    AND openmuse_is_member(workspace_id)
    AND openmuse_can_grant_snapshot(snapshot_id)
  );
CREATE POLICY shared_snapshot_grants_revoke ON shared_snapshot_grants
  FOR UPDATE
  USING (openmuse_can_grant_snapshot(snapshot_id) OR openmuse_can_admin(workspace_id))
  WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND (openmuse_can_grant_snapshot(snapshot_id) OR openmuse_can_admin(workspace_id))
  );

-- Every remaining row has a direct tenant column. Keeping these policies
-- explicit makes accidental cross-tenant queries fail closed even if a caller
-- forgets the application-level workspace predicate.
CREATE POLICY messages_scope ON messages
  USING (
    workspace_id = openmuse_workspace_id()
    AND openmuse_can_read_conversation(conversation_id)
  )
  WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND openmuse_can_read_conversation(conversation_id)
  );
CREATE POLICY runs_scope ON runs
  USING (
    workspace_id = openmuse_workspace_id()
    AND openmuse_can_read_conversation(conversation_id)
  )
  WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND openmuse_can_read_conversation(conversation_id)
  );
CREATE POLICY run_events_scope ON run_events
  USING (
    workspace_id = openmuse_workspace_id()
    AND openmuse_can_read_run(run_id)
  )
  WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND openmuse_can_read_run(run_id)
  );
CREATE POLICY tasks_scope ON tasks
  USING (openmuse_can_read_task(id))
  WITH CHECK (openmuse_can_read_task(id));
CREATE POLICY task_leases_scope ON task_leases
  USING (openmuse_can_read_task(task_id))
  WITH CHECK (openmuse_can_read_task(task_id));
CREATE POLICY artifacts_scope ON artifacts
  USING (openmuse_can_read_artifact(id))
  WITH CHECK (openmuse_can_read_artifact(id));
CREATE POLICY approvals_scope ON approvals
  USING (openmuse_can_read_approval(id))
  WITH CHECK (openmuse_can_read_approval(id));
CREATE POLICY goals_scope ON goals USING (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id)) WITH CHECK (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id));
CREATE POLICY schedules_scope ON schedules USING (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id)) WITH CHECK (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id));
CREATE POLICY memories_scope ON memories USING (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id)) WITH CHECK (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id));
CREATE POLICY connections_scope ON connections USING (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id) AND (user_id = openmuse_actor_id() OR openmuse_can_admin(workspace_id))) WITH CHECK (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id) AND (user_id = openmuse_actor_id() OR openmuse_can_admin(workspace_id)));
CREATE POLICY provider_credentials_scope ON provider_credentials USING (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id) AND (user_id IS NULL OR user_id = openmuse_actor_id() OR openmuse_can_admin(workspace_id))) WITH CHECK (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id) AND (user_id IS NULL OR user_id = openmuse_actor_id() OR openmuse_can_admin(workspace_id)));
CREATE POLICY audit_events_scope ON audit_events USING (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id)) WITH CHECK (workspace_id = openmuse_workspace_id() AND openmuse_is_member(workspace_id));
CREATE POLICY idempotency_scope ON idempotency_records USING (workspace_id = openmuse_workspace_id() AND actor_id = openmuse_actor_id()) WITH CHECK (workspace_id = openmuse_workspace_id() AND actor_id = openmuse_actor_id());
