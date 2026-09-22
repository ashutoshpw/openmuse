-- Workspace administrators may mutate shared provider instances through the
-- scoped API. The API keeps created_by immutable; this policy only aligns the
-- row-level write check with the repository's owner/admin authorization.
DROP POLICY IF EXISTS provider_instances_scope ON provider_instances;
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
    AND (created_by = openmuse_actor_id() OR openmuse_can_admin(workspace_id))
  );
