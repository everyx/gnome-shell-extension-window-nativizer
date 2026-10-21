#!/bin/sh
#
# Runs the EGO analyzer and hands its JSON report to the checker that owns the verdict.
#
# shexli exits 0 whether or not it finds anything, so its exit code cannot be the gate; the
# verdict is tools/check-package.mjs. Keep the two halves together: a future change to the
# analyzer's report shape should fail here, not quietly pass.
#
# Usage: tools/lint-zip.sh [package.zip]

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ZIP=${1:-"$ROOT/dist/window-nativizer@everyx.github.io.shell-extension.zip"}

if [ ! -f "$ZIP" ]; then
    echo "[lint:zip] no package at $ZIP - run 'pnpm run build' first" >&2
    exit 2
fi

REPORT=$(mktemp)
trap 'rm -f "$REPORT"' EXIT

if command -v uvx >/dev/null 2>&1; then
    if uvx --with 'tree-sitter<0.26.0' shexli --format json "$ZIP" > "$REPORT" 2>/dev/null; then
        node "$ROOT/tools/check-package.mjs" "$REPORT"
        exit $?
    fi
fi

if ! command -v pipx >/dev/null 2>&1; then
    echo '[lint:zip] neither uvx nor pipx can run shexli' >&2
    exit 2
fi

pipx install --force shexli >/dev/null
pipx runpip shexli install 'tree-sitter<0.26.0' >/dev/null
shexli --format json "$ZIP" > "$REPORT"
node "$ROOT/tools/check-package.mjs" "$REPORT"
exit $?
