#!/usr/bin/env bash
# verify-line.sh - runs the verification tiers for one audited GNOME line, inside that line's container.
#
# Usage: tools/verify-line.sh <gnome-line> [tier]
#
# Tiers, cheapest first (see docs/shell-compatibility.md for what each one is for):
#   shapes    the members we call are callable, with the shape the code assumes - no session needed
#
# The container is described in tools/lines.json and the shell it reports is checked against what that
# entry expects before anything is measured, so a repointed tag fails loudly instead of verifying the
# wrong line. Everything else runs from the repository, mounted read-only.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LINES="$ROOT/tools/lines.json"

LINE="${1:-}"
TIER="${2:-shapes}"

if [ -z "$LINE" ]; then
    echo "usage: tools/verify-line.sh <gnome-line> [tier]" >&2
    echo "  lines: $(python3 -c "import json; print(' '.join(json.load(open('$LINES'))['lines']))")" >&2
    exit 2
fi

case "$TIER" in
    shapes) ;;
    *)
        echo "!! [verify-line] tier '$TIER' is not implemented yet (implemented: shapes)" >&2
        exit 2
        ;;
esac

IMAGE="$(python3 -c "
import json, sys
entry = json.load(open('$LINES'))['lines'].get('$LINE')
sys.exit('line $LINE is not in tools/lines.json') if entry is None else print(entry['image'])
")"
EXPECTS="$(python3 -c "import json; print(json.load(open('$LINES'))['lines']['$LINE']['expects'])")"

echo "================================================================"
echo " Verifying GNOME $LINE - tier: $TIER"
echo " Image: $IMAGE (must report $EXPECTS)"
echo "================================================================"

# Runs inside the container. EXPECTS arrives as an environment variable so this stays a quoted
# heredoc: the shell that expands it is the container's, not this one's.
CONTAINER_SCRIPT="$(cat <<'INNER'
set -euo pipefail

install_shell() {
    if dnf -y -q install --setopt=install_weak_deps=False gnome-shell gjs >/dev/null 2>&1; then
        return 0
    fi
    # A release that has passed end of life has its repositories moved off the live mirrors, and the
    # image's repo files still point there. Retry against the archive rather than guessing which
    # releases have moved: the first attempt failing is the signal.
    echo ">> [verify-line] the live repositories did not answer; retrying against the release archive"
    sed -i -e 's|^metalink=|#metalink=|g' \
           -e 's|^#baseurl=http://download.example/pub/fedora/linux|baseurl=https://dl.fedoraproject.org/pub/archive/fedora/linux|g' \
           /etc/yum.repos.d/fedora*.repo
    dnf -y -q install --setopt=install_weak_deps=False gnome-shell gjs >/dev/null 2>&1
}

install_shell

VERSION="$(gnome-shell --version)"
echo ">> [verify-line] shell: $VERSION"
case "$VERSION" in
    "$EXPECTS"*) ;;
    *) echo "!! [verify-line] expected $EXPECTS, got '$VERSION' - this image is not that line" >&2; exit 1 ;;
esac

# Same discovery test-e2e.sh does on a real machine: the typelib directories are named for the
# Mutter API version, and gnome-shell keeps its own next to them.
DIRS="$( { ls -d /usr/lib64/mutter-[0-9]* /usr/lib/mutter-[0-9]* /usr/lib64/gnome-shell /usr/lib/gnome-shell 2>/dev/null || true; } | tr '\n' ':' | sed 's/:$//')"
echo ">> [verify-line] typelibs: $DIRS"

GI_TYPELIB_PATH="$DIRS" LD_LIBRARY_PATH="$DIRS" gjs -m tools/gjs-surface.js
INNER
)"

podman run --rm -e EXPECTS="$EXPECTS" -v "$ROOT:/repo:ro" -w /repo "$IMAGE" bash -lc "$CONTAINER_SCRIPT"

echo ">> [verify-line] GNOME $LINE: $TIER passed"
