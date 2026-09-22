-- Better Auth runs on a dedicated least-privilege database role. Do not use a
-- transaction-local GUC for this exception: a tenant role could set that GUC
-- before querying users. Instead, provision a NOLOGIN group role and grant it
-- to the configured AUTH_DATABASE_URL login role, for example:
--
--   create role openmuse_auth_service nologin;
--   create role openmuse_auth login password '...';
--   grant openmuse_auth_service to openmuse_auth;
--
-- The login role may have any name. Membership in the non-login group is the
-- database-enforced marker, so a request cannot self-enable this exception by
-- setting a custom GUC. Grant the login role only users/session/account/
-- verification plus the invite function; it must not receive tenant tables.
-- The API must use AUTH_DATABASE_URL for this role and DATABASE_URL for the
-- tenant-scoped runtime role.
CREATE OR REPLACE FUNCTION openmuse_is_auth_service()
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    pg_has_role(current_user, to_regrole('openmuse_auth_service'), 'member'),
    false
  )
$$;

DROP POLICY IF EXISTS users_auth_service ON users;
CREATE POLICY users_auth_service ON users
  USING (openmuse_is_auth_service())
  WITH CHECK (openmuse_is_auth_service());

DROP POLICY IF EXISTS session_auth_service ON session;
CREATE POLICY session_auth_service ON session
  USING (openmuse_is_auth_service())
  WITH CHECK (openmuse_is_auth_service());

DROP POLICY IF EXISTS account_auth_service ON account;
CREATE POLICY account_auth_service ON account
  USING (openmuse_is_auth_service())
  WITH CHECK (openmuse_is_auth_service());

DROP POLICY IF EXISTS verification_auth_service ON verification;
CREATE POLICY verification_auth_service ON verification
  USING (openmuse_is_auth_service())
  WITH CHECK (openmuse_is_auth_service());
