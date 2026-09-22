# OpenMuse implementation checklist

This is a source and local-validation checklist. A passing local command does
not prove that a hosted deployment, release, provider, or mobile store build is
live.

## Verified foundation

- [x] Establish Bun 1.4.2 workspace metadata, catalogs, strict TypeScript, and
      the Turbo task graph.
- [x] Keep root Vitest, Bun auth integration, native Jest, and web Playwright
      test selection independent; unit Vitest excludes `*.integration.test.*`.
- [x] Add Oxlint/Oxfmt configuration, repository boundary checks, secret and
      license checks, Knip dependency checks, and a no-bypass pre-commit hook.
- [x] Add pinned-permission CI jobs for quality, native Jest/Expo iOS Hermes
      export, PostgreSQL migration/RLS smoke, web Playwright, and a stable
      aggregate result.
- [x] Add the web session/cache hardening, provider setup/share forms, and
      deterministic mocked Playwright coverage. Local evidence: 7 web tests,
      web typecheck/build, and visual desktop/mobile screenshots pass.
- [x] Native Jest wrapper runs the current suite (5 tests pass locally).
- [x] Auth/RLS integration runner fails closed without `TEST_DATABASE_URL` and
      provisions disposable non-owner runtime and auth roles when configured.

## Launch scope still outstanding

### Product and server behavior

- [ ] Prove deployed Better Auth cookie and bearer sessions, trusted origins,
      bootstrap behavior, revocation, and error redaction against the real API.
- [ ] Complete and exercise workspace/resource CRUD, sharing resolution,
      provider CRUD and credential rotation, artifact/media storage, and all
      tenant authorization predicates through the HTTP boundary.
- [ ] Integrate the durable worker with lease fencing, retries, idempotency,
      provider execution, approval pauses, and observable failure recovery.

### Security, data, and providers

- [ ] Run the PostgreSQL smoke and auth/RLS integration lanes against CI's
      disposable database and retain evidence for migration, runtime, worker,
      and non-owner auth roles.
- [ ] Verify provider ownership, encrypted write-only secrets, config-digest
      concurrency, sandbox cancellation/deadlines, artifact limits, and
      connector/model/search capability boundaries with real providers or
      explicitly documented fakes.
- [ ] Exercise migration rollback/forward compatibility, backup/restore, data
      retention, and tenant-isolation failure paths before production use.

### Client and operations

- [ ] Complete native lint, device-level accessibility/runtime checks, deep-link
      and offline behavior, release metadata, signing, and store build proof.
- [ ] Deploy API, worker, web, and provider runtime with scoped secrets,
      health/readiness checks, structured logs/metrics, rate limits, capacity
      evidence, rollback, and an authenticated production smoke test.

## CI-green milestone

- [x] Sandbox service/driver local review checkpoint: scoped authentication,
      bounded file/exec behavior, cleanup uncertainty, request/inspection
      deadlines, and real Docker lifecycle smoke passed locally (10 focused
      tests and 2 Docker smoke tests). This is local-only evidence; it does
      not establish hosted deployment, provider capacity, or production proof.
- [ ] Integrate peer changes without unrelated dirty files, then pass frozen
      install, quality, format, lint, typecheck, unit, native Jest/export,
      PostgreSQL smoke plus auth integration, web Playwright, and aggregate
      gates from one exact committed SHA.
- [x] Candidate clean archive from CI checkpoint commit (`923568b`, parent of
      this documentation update) passed
      frozen install, quality, unit, native Jest/export, build, and 7 web
      Playwright tests; PostgreSQL was unavailable locally.
- [ ] Record the first hosted green `main` run. Remote run `35712766820` at
      `4a006da` failed before tests because `bun install --frozen-lockfile`
      detected a lockfile mismatch; it was not rerun or mutated.
- [x] React Doctor 0.9.14 full `apps/web` scan is 91/100 with no changed-scope
      findings; two maintainability complexity warnings remain for follow-up.
- [ ] Prove the final frozen install from a clean checkout after the CI-green
      commit; no deployment or store-release claim is implied by local checks.
