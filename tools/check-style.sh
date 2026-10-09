#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

node tools/gen-clutter.mjs --check
node tools/gen-style.mjs --check
node tools/gen-shader.mjs --check
node tools/gen-mutter.mjs --check
node tools/gen-gtk.mjs --check
node tools/gen-inspector.mjs --check
node tools/gen-locale.mjs --check
node tools/gen-shell-api.mjs --check
node tools/check-shell-version.mjs --check
node tools/check-platform-boundary.mjs --check
