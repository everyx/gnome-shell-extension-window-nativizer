#!/usr/bin/env bash
# verify-line.sh - runs the verification tiers for one audited GNOME line, inside that line's container.
#
# Usage: tools/verify-line.sh <gnome-line> [tier]
#
# Tiers, cheapest first (docs/shell-compatibility.md says what each is for):
#   shapes    the members we call are callable, with the shape the code assumes - no session needed
#   session   tools/test-e2e.sh, the whole behaviour suite, on a private bus and a headless shell
#   all       both
#
# The container is described in tools/lines.json and built from tools/Containerfile on first use. The
# shell it reports is checked against what that line expects before anything is measured, so a
# repointed tag fails loudly instead of verifying the wrong line. The working tree is mounted read-only
# and the container copies the directories it reads into its own filesystem, so a run cannot write to
# the tree it is testing.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LINES="$ROOT/tools/lines.json"

LINE="${1:-}"
TIER="${2:-shapes}"

if [ -z "$LINE" ]; then
    echo "usage: tools/verify-line.sh <gnome-line> [shapes|session|all]" >&2
    echo "  lines: $(python3 -c "import json; print(' '.join(json.load(open('$LINES'))['lines']))")" >&2
    exit 2
fi

case "$TIER" in
    shapes|session|all) ;;
    *)
        echo "!! [verify-line] unknown tier '$TIER' (shapes, session, all)" >&2
        exit 2
        ;;
esac

entry() { python3 -c "
import json, sys
entry = json.load(open('$LINES'))['lines'].get('$LINE')
sys.exit('line $LINE is not in tools/lines.json') if entry is None else print(entry['$1'])
"; }

BASE="$(entry base)"
IMAGE="$(entry image)"
EXPECTS="$(entry expects)"

echo "================================================================"
echo " Verifying GNOME $LINE - tier: $TIER"
echo " Image: $IMAGE (from $BASE, must report $EXPECTS)"
echo "================================================================"

# Build every time rather than only when the image is missing: the layer cache makes an unchanged
# Containerfile nearly free, and a guard on existence alone silently runs a stale image - which is how
# a run once tested a container that did not have the packages the recipe had just added.
echo ">> [verify-line] building $IMAGE (cached unless tools/Containerfile changed)"
podman build -q -f "$ROOT/tools/Containerfile" --build-arg BASE="$BASE" -t "$IMAGE" "$ROOT" >/dev/null

# Runs in every tier: confirm the image carries the line it claims to, then find the typelib
# directories the same way test-e2e.sh does on a real machine - they are named for the Mutter API
# version, with gnome-shell's own beside them.
PREAMBLE="$(cat <<'INNER'
set -euo pipefail

# Mutter's headless backend starts Xwayland, which needs the X socket directory to exist and be
# writable. A container's /tmp does not have one, and the failure is a libmutter abort rather than
# anything the suite reports as a test failure.
install -d -m 1777 /tmp/.X11-unix

# Mutter's headless backend still puts its Wayland socket under XDG_RUNTIME_DIR, which a container
# does not set; without it the failure is another libmutter abort.
export XDG_RUNTIME_DIR=/run/wn-runtime
install -d -m 0700 "$XDG_RUNTIME_DIR"

# GNOME Shell's background manager asks logind, on the system bus. A container has neither: with no
# system bus the shell's init throws outright, and with one but no login1 the proxy that resolves it
# takes the shell down the same way. dbusmock's logind template is the stand-in GNOME's own container
# testing uses, and all the shell reads from it are capability properties and an Inhibit.
[ -s /etc/machine-id ] || dbus-uuidgen --ensure=/etc/machine-id
install -d -m 0755 /run/dbus
dbus-daemon --system --fork --nopidfile
python3 -m dbusmock --system --template logind >/dev/null 2>&1 &
for _ in $(seq 1 40); do
    gdbus call --system --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.NameHasOwner org.freedesktop.login1 2>/dev/null | grep -q true && break
    sleep 0.5
done

VERSION="$(gnome-shell --version)"
echo ">> [verify-line] shell: $VERSION"
case "$VERSION" in
    "$EXPECTS"*) ;;
    *) echo "!! [verify-line] expected $EXPECTS, got '$VERSION' - this image is not that line" >&2; exit 1 ;;
esac

DIRS="$( { ls -d /usr/lib64/mutter-[0-9]* /usr/lib/mutter-[0-9]* /usr/lib64/gnome-shell /usr/lib/gnome-shell 2>/dev/null || true; } | tr '\n' ':' | sed 's/:$//')"
export GI_TYPELIB_PATH="$DIRS"
export LD_LIBRARY_PATH="$DIRS"
INNER
)"

TIER_SCRIPT=""
case "$TIER" in
    shapes) TIER_SCRIPT='gjs -m tools/gjs-surface.js' ;;
    session) TIER_SCRIPT='bash tools/test-e2e.sh' ;;
    all) TIER_SCRIPT='gjs -m tools/gjs-surface.js && bash tools/test-e2e.sh' ;;
esac

# The tree is mounted read-only, so the suite runs from a copy: nothing it does can reach the working
# tree, and no writable bind mount has to be trusted. HOME is the container's own, which is where
# deploy-ext.sh installs the extension.
CONTAINER_SCRIPT="$(cat <<INNER
$PREAMBLE

export HOME="\${HOME:-/root}"
mkdir -p /work
cp -a /repo/src /repo/tools /repo/package.json /work/
cd /work

# shell-version is the claim this whole exercise exists to earn, and a shell refuses to load an
# extension that does not claim its line (State: OUT OF DATE). Widen the copy under test so the code
# can be exercised on this line at all; the tree is mounted read-only and the manifest we ship is
# untouched, so nothing here can widen the real claim.
python3 -c "import json, os; p='src/metadata.json'; d=json.load(open(p)); v=sorted(set(d['shell-version']) | {os.environ['VERIFY_LINE']}, key=int); d['shell-version']=v; json.dump(d, open(p,'w'), indent=4); open(p,'a').write(chr(10)); print('>> [verify-line] manifest claims, for this run only:', v)"

# gnome-extensions is a GTK client and wants a display even for enable and info. On a developer's
# machine it inherits their session's; a container has none, so point it at the nested shell's own
# Wayland socket - whose name is read from the script that creates it, not copied.
export WAYLAND_DISPLAY="\$(sed -n 's/^WL_DISPLAY="\(.*\)"/\1/p' tools/dev.sh | head -1)"

$TIER_SCRIPT
INNER
)"

podman run --rm -e EXPECTS="$EXPECTS" -e VERIFY_LINE="$LINE" -v "$ROOT:/repo:ro" -w /repo "$IMAGE" bash -lc "$CONTAINER_SCRIPT"

echo ">> [verify-line] GNOME $LINE: $TIER passed"
