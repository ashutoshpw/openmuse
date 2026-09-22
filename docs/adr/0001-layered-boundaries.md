# ADR 0001: Keep product layers behind typed boundaries

## Status

Accepted for the current implementation.

## Decision

The web and native clients call `@openmuse/client` and shared contracts. The
API owns authentication and application orchestration. Database repositories
own tenant context and RLS-aware persistence. Provider packages implement
provider contracts and do not import application or database internals.

The repository check in `scripts/check-boundaries.ts` enforces the highest-risk
dependency directions. It is a guardrail, not a substitute for authorization
tests.

## Consequences

Contracts can be tested without a database or provider credential, and native
clients cannot accidentally ship server-only packages. New cross-layer needs
must be expressed as an explicit interface or API route and reviewed with its
tenant/auth implications.
