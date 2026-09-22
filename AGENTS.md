# OpenMuse development guide

OpenMuse is a Bun-managed Turborepo. Use Bun 1.4.2 and keep package ownership
inside the workspace that owns the code.

## Common commands

- `bun install` installs the workspace.
- `bun run check` runs linting, formatting, typechecking, tests, and builds.
- `bun run typecheck` runs package typechecks through Turbo.
- `bun run test` runs the root Vitest suite. Native Jest and mobile test trees
  are intentionally outside that suite.
- Native Jest validation runs separately once the mobile workspace is present.

## Change boundaries

- Preserve unrelated worktree changes.
- Keep shared contracts and provider contracts independent of app runtimes.
- Do not commit credentials; update `.env.example` when configuration changes.
- Keep background work in the project's declared job boundary and document
  provider-specific behavior in the owning package.

Before handing off a change, run the narrowest relevant check and then
`bun run check` when dependencies are available.
