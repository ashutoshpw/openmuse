#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required for auth integration tests}"
exec bun test apps/api/test/auth.integration.test.ts
