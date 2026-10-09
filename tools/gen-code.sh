#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

node tools/gen-clutter.mjs "$@"
node tools/gen-style.mjs "$@"
node tools/gen-shader.mjs "$@"
node tools/gen-mutter.mjs "$@"
node tools/gen-gtk.mjs "$@"
node tools/gen-inspector.mjs "$@"
node tools/gen-shell-api.mjs "$@"
