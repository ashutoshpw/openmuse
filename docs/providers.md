# Provider setup and sharing

Provider modules implement the contracts in `@openmuse/provider-contracts`.
The web settings panel sends non-secret instance configuration to the server
and sends a required secret only when the operator enters one. Secret inputs
are write-only, cleared after the request settles, and are never rendered from
the API response. The server is responsible for encryption, key rotation, and
redaction in logs.

The current client contract exposes provider instance and credential CRUD. A
deployment is not provider-ready until the corresponding authenticated API
handlers, database persistence, encryption key, and provider operation tests
are present and verified together.

Sharing is resolved by the server from a selected conversation and recipient
email. Browser code must not accept a raw user ID as the recipient or display
technical resource/user IDs as the sharing UX. Shared payloads are immutable
snapshots with revocable grants; they are not live conversation access.

Provider checks should cover:

1. capability discovery and unavailable-provider behavior;
2. schema validation at the provider boundary;
3. timeout, retry, cancellation, and uncertain-outcome behavior;
4. secret redaction and write-only credential responses;
5. tenant authorization and audit events; and
6. deterministic provider-testkit fixtures without real credentials.
