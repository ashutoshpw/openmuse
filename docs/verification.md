# Verification boundaries

OpenMuse reports local source and test evidence explicitly. A green command is
not proof that a hosted API, provider, database, mobile store build, or worker
is deployed and serving traffic.

## Reproducible local checks

From a clean checkout with Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun run check:quality
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
bun run test:native
bun run build:native
bun run test:web
```

`test:native` runs the mobile Jest suite through `scripts/test-native.sh`.
`build:native` exports an iOS Hermes JavaScript bundle; it does not build or
sign an iOS/Android binary. `test:web` uses deterministic route fixtures and
does not authenticate against a live service.

## PostgreSQL integration

`bun run test:pg` requires `DATABASE_URL` for a non-owner runtime role and
`WORKER_DATABASE_URL` for the worker role. Apply migrations through
`MIGRATION_DATABASE_URL`, run `bun scripts/grant-runtime.ts`, then run the
smoke test. The smoke test checks that tenant tables have RLS, a missing tenant
context returns no rows, and the worker discovery function is callable. It is
not a production load or backup/restore test.

## CI evidence

`.github/workflows/ci.yml` keeps quality, native, PostgreSQL, and web jobs
separate and fails through one aggregate job. Action references are pinned to
commits (the actionlint container is pinned by digest), and the workflow has
read-only repository permissions. Hosted CI results must be recorded with the
commit SHA; this repository does not claim a hosted run until one exists.

React Doctor is an advisory source audit. Record its command and output; do not
invent a score when the selected scope produces no score.
