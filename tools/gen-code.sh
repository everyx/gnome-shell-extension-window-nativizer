#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# The one list of generated artifacts. `--check` regenerates and compares instead of writing, which
# is what check:style needs; a second copy of this list there had already drifted.
for generator in style shader mutter gtk inspector locale shell-api; do
    node "tools/gen-${generator}.mjs" "$@"
done
