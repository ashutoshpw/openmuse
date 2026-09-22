-- Better Auth runs before a workspace/actor context exists. Deployments should
-- give its dedicated runtime role `ALTER ROLE <auth-role> SET
-- app.auth_service='true'`; this policy lets that role manage identity rows
-- while the normal API role remains tenant-scoped. The role must still not be
-- a table owner, superuser, or BYPASSRLS role.
CREATE POLICY users_auth_service ON users
  USING (current_setting('app.auth_service', true) = 'true')
  WITH CHECK (current_setting('app.auth_service', true) = 'true');

CREATE OR REPLACE FUNCTION openmuse_accept_invite(
  invite_token_hash text,
  target_user_id text,
  target_email text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  invite workspace_invites%ROWTYPE;
BEGIN
  SELECT * INTO invite
  FROM workspace_invites
  WHERE token_hash = invite_token_hash
    AND accepted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND OR invite.expires_at <= now()
     OR lower(invite.email) <> lower(target_email) THEN
    RAISE EXCEPTION 'invite_invalid' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO workspace_members (workspace_id, user_id, role, status, invited_by)
  VALUES (invite.workspace_id, target_user_id, invite.role, 'active', invite.invited_by)
  ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'active', role = EXCLUDED.role, updated_at = now();

  UPDATE workspace_invites SET accepted_at = now() WHERE id = invite.id;
  RETURN invite.workspace_id;
END;
$$;

-- Resolve a conversation's tenant only after checking the authenticated actor.
-- This supports client routes whose public shape contains only a conversation
-- ID while keeping the API from doing an unscoped cross-tenant lookup.
CREATE OR REPLACE FUNCTION openmuse_resolve_conversation_workspace(
  candidate_conversation_id text,
  candidate_actor_id text
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT c.workspace_id
  FROM conversations c
  WHERE c.id = candidate_conversation_id
    AND (
      c.created_by = candidate_actor_id
      OR EXISTS (
        SELECT 1 FROM conversation_members cm
        WHERE cm.conversation_id = c.id
          AND cm.user_id = candidate_actor_id
          AND cm.permission = 'owner'
      )
    )
  LIMIT 1
$$;
