# Self-hosting OpenMuse

The repository contains the API, worker, web, native, database, and provider
source packages. Deployment is intentionally separate from local validation:
the commands below prepare a database and configuration but do not deploy a
public service.

## Configuration agreement

Copy `.env.example` to a local environment file and set the same API origin in
`AUTH_URL`, `WEB_ORIGIN`, `API_BASE_URL`, and the native
`EXPO_PUBLIC_OPENMUSE_API_URL` value. `AUTH_SECRET` must be at least 32
characters. Do not put provider credentials in the web or native bundles.

Use separate PostgreSQL roles:

- migration role: owns schema objects and is used only by `bun run db:migrate`;
- runtime role: used by the API and never a table owner, superuser, or
  `BYPASSRLS` role;
- worker role: used only by the durable worker and granted
  `EXECUTE` on `openmuse_discover_pending_task_scopes(integer)`.

The migration SQL deliberately does not create roles or embed passwords. Create
roles in the deployment environment, apply migrations with
`MIGRATION_DATABASE_URL`, and grant privileges with
`bun scripts/grant-runtime.ts`. Run `bun run test:pg` as the runtime/worker
roles before accepting the environment.

## Storage and network boundaries

Artifacts are represented by tenant-scoped storage keys. An S3-compatible
endpoint may be supplied through deployment configuration, but storage API
integration must be verified against the concrete adapter before calling it
production-ready. Keep the API and worker on private network paths to the
database and object store; expose only the API/web origins required by the
deployment.

Better Auth owns sessions. The API accepts cookie sessions for the web and the
Better Auth bearer plugin for native clients. A personal provider API key is
not an OAuth implementation and must not be described as one.
