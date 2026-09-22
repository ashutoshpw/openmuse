#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/apps/mobile"
# Web export is intentionally not used here: this app does not declare the
# optional react-dom/react-native-web pair. An iOS Hermes bundle exercises the
# native Metro graph without requiring an Apple runner.
exec bunx expo export --platform ios
