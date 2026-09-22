# OpenMuse implementation checklist

This is a source and local-validation checklist. A passing local command does
not prove that a hosted deployment, release, provider, or mobile store build is
live.

## Verified foundation

- [x] Establish Bun 1.4.2 workspace metadata, catalogs, strict TypeScript, and
      the Turbo task graph.
- [x] Keep root Vitest, native Jest, and web Playwright test selection
      independent.
- [x] Add Oxlint/Oxfmt configuration, repository boundary checks, secret and
      license checks, Knip dependency checks, and a no-bypass pre-commit hook.
- [x] Add pinned-permission CI jobs for quality, native Jest/Expo iOS Hermes
      export, PostgreSQL migration/RLS smoke, web Playwright, and a stable
      aggregate result.
- [x] Add the web session/cache hardening, provider setup/share forms, and
      deterministic mocked Playwright coverage. Local evidence: 7 web tests,
      web typecheck/build, and visual desktop/mobile screenshots pass.
- [x] Native Jest wrapper runs the current suite (5 tests pass locally).

## Outstanding implementation and proof

- [ ] Complete API authentication, workspace/resource endpoints, provider
      CRUD, sharing resolution, artifact/media storage, and durable worker
      integration; source contracts alone are not runtime proof.
- [ ] Complete native lint and any remaining native runtime/accessibility work.
- [ ] Finish the isolated PostgreSQL integration fixture and verify runtime,
      migration, worker, and auth roles against it.
- [ ] Run the full root lint/format/typecheck/build matrix after all agents'
      changes are integrated; current concurrent files may still be
      unformatted or fail native lint.
- [ ] Run React Doctor against an actual selected source scope; the previous
      changed-file invocation returned no score.
- [ ] Prove a frozen install from a clean committed checkout and record the
      exact SHA. No deployment or store-release claim is made here.
