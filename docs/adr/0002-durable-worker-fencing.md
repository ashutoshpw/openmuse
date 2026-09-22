# ADR 0002: Durable work is leased and fenced

## Status

Accepted for the current implementation.

## Decision

Asynchronous work is claimed by the durable worker with a worker ID and unique
fence token. Heartbeats, checkpoints, cancellation, and completion are checked
against that fence inside the tenant scope. A provider error with an uncertain
side effect becomes `outcome_unknown`; it is not replayed automatically.

Worker scope discovery returns only workspace/actor pairs with ready work. The
worker rechecks active membership before claiming and executing a task. The
worker role receives only the database privileges needed for this path.

## Consequences

A task can require operator reconciliation after an uncertain external result,
but duplicate side effects are less likely. Capacity and deployment health
still require separate integration and operational evidence.
