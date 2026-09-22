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
- [x] Native Jest wrapper runs the current candidate suite (20 tests across 6
      suites pass in the exact `98ce61d` archive; this is not device or store
      evidence).
- [x] Auth/RLS integration runner fails closed without `TEST_DATABASE_URL` and
      provisions disposable non-owner runtime and auth roles when configured.
- [x] Provider setup now uses one compare-and-swap request for configuration
      and write-only BYOK secrets; the web/mobile helpers trim and omit blank
      values and never use the credential list/create/rotate flow.
- [x] Provider atomic-setup safety coverage is accepted in `e58bfa9`: seven
      focused integration tests and 74 assertions cover ownership, digest
      fencing, secret redaction, and atomic credential/config persistence.
- [x] Media provider review is accepted for the current Meta endpoint,
      bounded provider responses, nested secret redaction, and explicit
      provider-contract behavior. Remote provider capacity is not proven.
- [x] Goal CRUD persists validated schedules and `nextRunAt` through the
      typed API/client boundary. This is metadata/CRUD evidence only; durable
      scheduler execution remains outstanding below.

## Launch scope still outstanding

### Product and server behavior

- [ ] Prove deployed Better Auth cookie and bearer sessions, trusted origins,
      bootstrap behavior, revocation, and error redaction against the real API.
- [ ] Complete and exercise workspace/resource CRUD, sharing resolution,
      artifact/media storage, and all remaining tenant authorization predicates
      through the HTTP boundary.
- [x] Provider CRUD, encrypted write-only credential rotation, atomic BYOK
      setup, config-digest concurrency, and provider ownership boundaries are
      covered by the accepted local integration/review evidence. This does not
      prove real-provider capacity or hosted deployment behavior.
- [ ] Integrate the durable worker with lease fencing, retries, idempotency,
      provider execution, approval pauses, and observable failure recovery.
- [x] Goal CRUD and validated schedule metadata are delivered as described
      above.
- [ ] Define and wire durable scheduler ownership, occurrence materialization,
      recurrence/time-zone semantics, pause/resume, cancellation, retries, and
      delivery proof; a non-null schedule is not yet background execution.
- [ ] Complete approval/tool continuation state across worker restarts,
      including durable leases, actor-bound decisions, expiration, and resume
      audit evidence.
- [ ] Complete AppConnect connection lifecycle: link, callback ownership,
      token exchange/refresh, revoke, expiry recovery, and per-user tool scope.
- [ ] Add memory policy and storage boundaries: user/workspace/conversation
      scope, retention/deletion, retrieval authorization, and prompt injection
      defenses with adversarial tests.
- [ ] Add immutable artifact/share records and recipient authorization in the
      application layer; provider adapters must remain owner/workspace scoped.
- [ ] Complete interruptible voice/realtime sessions with bounded audio,
      cancellation, reconnect fencing, transcript ownership, and cleanup.
- [ ] Complete invitation and membership lifecycle: issuance, expiry,
      acceptance, revocation, role changes, and cross-tenant rejection.
- [ ] Complete browser automation policy and runtime: default-deny network
      boundary, navigation/download limits, cancellation, ownership, and
      container-local egress proof.
- [ ] Complete product onboarding and account/workspace handoff, including
      first-run empty states, invitations, membership transitions, and
      cross-tenant rejection at every client entry point.
- [ ] Complete self-host launch operations: deployment topology, scoped secret
      provisioning, health/readiness checks, upgrades, backup/restore,
      rollback, observability, and capacity/runbook evidence.

### Security, data, and providers

- [x] Run the PostgreSQL migration, smoke, and auth/RLS integration lanes in
      the exact `98ce61d` archive against a disposable database with explicit
      non-owner runtime/worker roles: 27 RLS tables, 40 integration tests, and
      293 assertions passed. The local sidecar evidence is corroborated by the
      hosted CI lane recorded below.
- [x] Verify provider ownership, encrypted write-only secrets, config-digest
      concurrency, sandbox cancellation/deadlines, provider-level storage and
      media bounds, and connector/model/search capability boundaries with
      explicitly documented fakes and focused local tests. Artifact API
      integration and real-provider capacity remain open.
- [ ] Re-run and retain the PostgreSQL smoke/auth lanes in CI's disposable
      environment and record the hosted result against the final SHA.
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
- [x] S3-compatible storage provider local checkpoint: opaque workspace/actor
      and provider-instance keys, bounded put/get/head streams, SHA-256
      metadata verification, content-type policy, exact trusted endpoint
      allowlisting, short attachment download URLs, abort/uncertain-outcome
      handling, and cleanup-safe MinIO lifecycle smoke are covered by the
      current 21 storage-policy tests and 27 independent-review checks. The
      namespace-isolated SDK smoke passes, while host loopback publishing is
      blocked by this environment. This is injected/local evidence only; no
      remote bucket, artifact API integration, sharing authorization, or
      hosted CI proof is established.
      On this host, Docker bridge publishing was separately diagnosed as a
      loopback TCP connection that accepts but never receives MinIO health
      bytes (docker0 172.17.0.0/16, published 127.0.0.1 port, DOCKER-USER
      forwarding policy); the smoke keeps loopback-only publishing for CI and
      does not fall back to host networking.
- [ ] Integrate peer changes without unrelated dirty files, then pass frozen
      install, quality, format, lint, typecheck, unit, native Jest/export,
      PostgreSQL smoke plus auth integration, web Playwright, and aggregate
      gates from one exact committed SHA.
- [x] Fresh candidate archive `98ce61d` passed frozen install, quality,
      format, lint, 30-package typecheck, 135 unit tests (3 skipped), native
      Jest (20 tests across 6 suites), iOS/Android exports, build, 7 web
      Playwright tests, PostgreSQL migration/smoke, and 40 auth/RLS
      integration tests (293 assertions), including the seven provider-safety
      tests from `e58bfa9`. The required local Docker/MinIO lane passed Docker
      smoke but hit this host's known published-loopback MinIO timeout; the
      namespace-isolated MinIO SDK smoke passed. This is a local release-review
      milestone, not hosted CI, deployment, provider-capacity, or store proof.
- [x] Hosted CI run `35750751590` passed every gate, including the aggregate,
      for source SHA `98ce61d`. This proves the repository's hosted validation
      lane, not deployment, provider capacity, or mobile store release.
- [x] React Doctor 0.9.14 full `apps/web` scan is 91/100 with no changed-scope
      findings; two maintainability complexity warnings remain for follow-up.
- [x] Prove the final frozen install from the clean exact-SHA `98ce61d` archive;
      no deployment or store-release claim is implied by local checks.
