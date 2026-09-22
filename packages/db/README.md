# `@openmuse/db`

The database package owns the tenant-scoped schema, migrations, RLS context,
and compare-and-swap repositories used by the API and durable worker.

## Runtime boundary

`DATABASE_URL` must use a dedicated runtime role that is not the migration role,
table owner, a superuser, or a role with `BYPASSRLS`. Grant that role the
required table and sequence privileges after applying migrations. The migration
role owns the tables and functions, then the runtime role is granted access.
This is necessary because PostgreSQL table owners and bypass roles can ignore
RLS, which would make an isolation test meaningless.

The worker role additionally needs `EXECUTE` on
`openmuse_discover_pending_task_scopes(integer)`. Migration `0004_worker.sql`
revokes that function from `PUBLIC`; grant it only to the dedicated worker
role. The function returns ready workspace/actor pairs, never task payloads or
credentials. The worker rechecks membership in each tenant-scoped transaction
before claiming or executing work.

Every request uses `withTenantContext`/`ScopedDatabase`. Both
`app.workspace_id` and `app.actor_id` are transaction-local settings, so a
pooled connection cannot retain one request's identity for the next request.
Missing settings yield no rows. The worker must claim a task using the same
workspace and actor scope that enqueued it; lease heartbeats and completion are
fenced by worker ID plus fence token.

The migration deliberately has no embedded password, role creation, or broad
`BYPASSRLS` grant. Self-hosted deployment scripts should create their own
least-privilege roles and run a non-superuser RLS smoke test.

## Better Auth role

Better Auth must use `AUTH_DATABASE_URL` with a separate login role. The
tenant `DATABASE_URL` role must not be given the auth exception. After
migrations, provision the non-login marker role, the login role, and grant
only the auth tables/functions it needs:

```sql
create role openmuse_auth_service nologin;
create role openmuse_auth login password '...';
grant openmuse_auth_service to openmuse_auth;
grant usage on schema public to openmuse_auth;
grant select, insert, update, delete on users, session, account, verification to openmuse_auth;
grant execute on function openmuse_accept_invite(text, text, text) to openmuse_auth;
```

Migration `0006_auth_role.sql` identifies the exception by membership in the
non-login marker role, not by a request-settable PostgreSQL setting. The login
role name is therefore configurable without weakening the boundary, and
`AUTH_DATABASE_URL` is a real connection boundary, not just a second name for
the tenant pool.
