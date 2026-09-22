-- A conversation INSERT ... RETURNING is evaluated against the new row. The
-- previous policy delegated USING to openmuse_can_read_conversation(), which
-- queried conversations again and could not see the row while its INSERT was
-- being checked. Keep the row fields as function arguments so this policy does
-- not recurse through conversations while retaining the private owner-member
-- boundary for existing rows.
CREATE OR REPLACE FUNCTION openmuse_can_read_conversation_row(
  candidate_conversation_id text,
  candidate_workspace_id text,
  candidate_created_by text
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT candidate_workspace_id = openmuse_workspace_id()
    AND openmuse_is_member(candidate_workspace_id)
    AND (
      candidate_created_by = openmuse_actor_id()
      OR EXISTS (
        SELECT 1
        FROM conversation_members cm
        WHERE cm.conversation_id = candidate_conversation_id
          AND cm.user_id = openmuse_actor_id()
          AND cm.permission = 'owner'
      )
    )
$$;

DROP POLICY IF EXISTS conversations_scope ON conversations;
CREATE POLICY conversations_scope ON conversations
  USING (openmuse_can_read_conversation_row(id, workspace_id, created_by))
  WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND openmuse_is_member(workspace_id)
    AND created_by = openmuse_actor_id()
  );
