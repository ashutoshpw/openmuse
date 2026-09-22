# OpenMuse

OpenMuse is a workspace for a provider-backed creative application, shared
contracts, server packages, and native clients.

## Development

The repository uses Bun 1.4.2 and Turborepo:

```sh
bun install
cp .env.example .env.local
bun run hooks:install
bun run check
```

The root Vitest suite and the mobile Jest suite are separate; native validation
is run from the mobile workspace when it is present.

Workspaces live under `apps/*`, `packages/*`, and
`packages/providers/*`. Keep provider integrations behind the shared provider
contracts and keep credentials in local environment files only.

Verification commands and their proof boundaries are recorded in
[`docs/verification.md`](docs/verification.md). Self-hosting configuration is
in [`docs/self-hosting.md`](docs/self-hosting.md), and provider/share behavior
is in [`docs/providers.md`](docs/providers.md). No local check is a claim that
the application is deployed or serving production traffic.
