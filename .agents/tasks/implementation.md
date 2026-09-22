# OpenMuse implementation checklist

## Phase 1: root scaffold

- [x] Establish Bun 1.4.2 workspace metadata and exact workspace globs.
- [x] Add named dependency catalogs for backend, frontend, Expo SDK 57,
      testing, and tooling.
- [x] Add the strict TypeScript baseline and modern Turbo task graph.
- [x] Add Vitest discovery that excludes native Jest/mobile test trees.
- [x] Add Oxlint/Oxfmt configuration and root quality commands.
- [x] Add environment, licensing, third-party notice, and contributor guidance.

## Follow-up implementation

- [ ] Add application entrypoints under `apps/*`.
- [ ] Add provider implementations under `packages/providers/*`.
- [ ] Add deployment, migration, and native release validation once those
      workspaces exist.
