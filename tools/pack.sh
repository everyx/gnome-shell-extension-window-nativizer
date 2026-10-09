#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# 1. Compile gettext binary catalogues (.mo)
node tools/gen-locale.mjs

# 2. Ensure dist directory exists
mkdir -p dist

# 3. Temporarily mirror LICENSE into src/ so gnome-extensions can bundle it
cp LICENSE src/LICENSE
trap 'rm -f "${ROOT_DIR}/src/LICENSE"' EXIT INT TERM

# 4. Pack extension into dist/
gnome-extensions pack src \
  --force \
  --extra-source=platform \
  --extra-source=lib \
  --extra-source=prefs \
  --extra-source=effects \
  --extra-source=icons \
  --extra-source=stylesheet.css \
  --extra-source=locale \
  --extra-source=LICENSE \
  --out-dir=dist
