-- Workers may discover only the tenant/actor pairs that have work ready. The
-- function intentionally returns no payload, message, credential, or task
-- data. Keep EXECUTE revoked from PUBLIC; deployment must grant it only to a
-- dedicated worker database role (never the API role).
CREATE OR REPLACE FUNCTION openmuse_discover_pending_task_scopes(
  scope_limit integer DEFAULT 100
)
RETURNS TABLE(workspace_id text, actor_id text)
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT DISTINCT t.workspace_id, t.requested_by AS actor_id
  FROM tasks t
  INNER JOIN workspace_members wm
    ON wm.workspace_id = t.workspace_id
   AND wm.user_id = t.requested_by
   AND wm.status = 'active'
  WHERE (
    (t.status = 'queued' AND t.available_at <= now())
    OR (t.status = 'running' AND t.lease_expires_at < now())
  )
  ORDER BY t.workspace_id, actor_id
  LIMIT GREATEST(1, LEAST(COALESCE(scope_limit, 100), 1000))
$$;

REVOKE ALL ON FUNCTION openmuse_discover_pending_task_scopes(integer) FROM PUBLIC;
