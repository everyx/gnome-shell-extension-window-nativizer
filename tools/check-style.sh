#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

node tools/gen-style.mjs --check
node tools/gen-shader.mjs --check
node tools/gen-mutter.mjs --check
node tools/gen-gtk.mjs --check
node tools/gen-inspector.mjs --check
node tools/gen-locale.mjs --check
node tools/gen-shell-api.mjs --check
node tools/check-shell-version.mjs --check
node tools/check-upstream-mirrors.mjs --check
node tools/check-platform-boundary.mjs --check

# One signal rule that is a grep: every signal the extension connects is torn down through
# src/lib/subscriptions.js, which holds the [object, id] pair that makes teardown possible. A
# hand-written disconnect is the shape that module replaced - connect-only sites (a widget's own
# children, a clone that dies with its handler) do not match, and do not need to be forced into it.
if grep -rn '\.disconnect(' src --include='*.js' \
        | grep -v 'src/lib/subscriptions.js' \
        | grep -vE '\.disconnect(All|Object)\('; then
    echo "[check-style] A signal is disconnected by hand: connect and tear down through lib/subscriptions.js." >&2
    exit 1
fi

# Two comment rules that are greps rather than lint rules:
# EGO's R-SLOP-01/02, because TypeScript-style JSDoc is unusual in a GNOME extension, and the rule
# that a comment describes what is beside it - a `docs/` pointer would put one fact in two places.
if grep -rnE '@(param|returns)[[:space:]]*\{' src --include='*.js' | grep -v '\.generated\.js'; then
    echo "[check-style] TypeScript-style JSDoc in src: write plain prose and let the code carry types." >&2
    exit 1
fi
if grep -rnE '^[[:space:]]*(//|\*|/\*)' src --include='*.js' \
        | grep -v '\.generated\.js' | grep -E 'docs/|\.md'; then
    echo "[check-style] A src comment points at documentation: a comment must stand on its own." >&2
    exit 1
fi
