#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/apps/mobile"
# Web export is intentionally not used here: this app does not declare the
# optional react-dom/react-native-web pair. Separate output directories keep
# the iOS and Android Hermes bundles independent and make both native graphs
# part of the canonical local and CI build.
bunx expo export --platform ios --output-dir dist/ios
bunx expo export --platform android --output-dir dist/android
