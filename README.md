# OpenMuse

OpenMuse is a workspace for a provider-backed creative application, shared
contracts, server packages, and native clients.

## Development

The repository uses Bun 1.4.2 and Turborepo:

```sh
bun install
cp .env.example .env.local
bun run check
```

The root Vitest suite and the mobile Jest suite are separate; native validation
is run from the mobile workspace when it is present.

Workspaces live under `apps/*`, `packages/*`, and
`packages/providers/*`. Keep provider integrations behind the shared provider
contracts and keep credentials in local environment files only.
