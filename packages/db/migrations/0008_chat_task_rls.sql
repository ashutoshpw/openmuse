-- The task visibility helper queries the tasks table itself. Using that helper
-- in a policy for INSERT ... RETURNING makes a newly inserted task invisible
-- while its policy is being evaluated, so task submission is rejected by RLS.
-- Keep actor/workspace visibility direct, and validate a task's already-created
-- parent run without looking the task itself up.
CREATE OR REPLACE FUNCTION openmuse_can_enqueue_task(
  candidate_workspace_id text,
  candidate_actor_id text,
  candidate_run_id text
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT candidate_workspace_id = openmuse_workspace_id()
    AND candidate_actor_id = openmuse_actor_id()
    AND EXISTS (
      SELECT 1
      FROM runs r
      WHERE r.id = candidate_run_id
        AND r.workspace_id = candidate_workspace_id
        AND r.requested_by = candidate_actor_id
        AND openmuse_is_member(r.workspace_id)
        AND openmuse_can_read_conversation(r.conversation_id)
    )
$$;

DROP POLICY IF EXISTS tasks_scope ON tasks;
CREATE POLICY tasks_scope ON tasks
  USING (
    workspace_id = openmuse_workspace_id()
    AND requested_by = openmuse_actor_id()
    AND openmuse_is_member(workspace_id)
  )
  WITH CHECK (
    workspace_id = openmuse_workspace_id()
    AND requested_by = openmuse_actor_id()
    AND openmuse_is_member(workspace_id)
    AND (run_id IS NULL OR openmuse_can_enqueue_task(workspace_id, requested_by, run_id))
  );
