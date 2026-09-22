#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required for auth integration tests}"

mapfile -t integration_tests < <(
  find apps packages -type f -name '*.integration.test.ts' -print | sort
)
if ((${#integration_tests[@]} == 0)); then
  echo "No integration test files were found." >&2
  exit 1
fi

exec bun test "${integration_tests[@]}"
