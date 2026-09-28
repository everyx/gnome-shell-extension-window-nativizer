#!/usr/bin/env bash
# Installs src/ into the user's extension directory and compiles its GSettings
# schema. Sourced by tools/dev.sh and tools/devkit.sh so the two never drift on
# what "install the extension" means.
#
# Expects ROOT to be the repository root. Sets SRC_DIR, UUID, EXT_DIR and defines
# deploy_ext().

SRC_DIR="${SRC_DIR:-$ROOT/src}"
UUID="$(python3 -c "import json; print(json.load(open('$SRC_DIR/metadata.json'))['uuid'])")"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

deploy_ext() {
    # Refuse to touch the install directory unless the uuid is known: the rm -rf below on an empty
    # uuid would take every other extension with it.
    if [[ -z "$UUID" ]]; then
        echo "!! deploy: could not read the uuid from $SRC_DIR/metadata.json" >&2
        return 1
    fi
    # Replace, do not merge. A renamed or deleted source file would otherwise survive here, and a
    # stale schemas/*.xml is not inert: glib-compile-schemas compiles every xml in the directory,
    # so the shell would register a schema the sources no longer have.
    rm -rf "$EXT_DIR"
    mkdir -p "$EXT_DIR"
    cp "$SRC_DIR/metadata.json" "$SRC_DIR/extension.js" "$EXT_DIR/"
    [[ -f "$SRC_DIR/prefs.js" ]] && cp "$SRC_DIR/prefs.js" "$EXT_DIR/"
    [[ -f "$SRC_DIR/stylesheet.css" ]] && cp "$SRC_DIR/stylesheet.css" "$EXT_DIR/"
    [[ -d "$SRC_DIR/lib" ]] && cp -r "$SRC_DIR/lib" "$EXT_DIR/"
    [[ -d "$SRC_DIR/compat" ]] && cp -r "$SRC_DIR/compat" "$EXT_DIR/"
    [[ -d "$SRC_DIR/effects" ]] && cp -r "$SRC_DIR/effects" "$EXT_DIR/"
    [[ -d "$SRC_DIR/icons" ]] && cp -r "$SRC_DIR/icons" "$EXT_DIR/"
    [[ -d "$SRC_DIR/locale" ]] && cp -r "$SRC_DIR/locale" "$EXT_DIR/"
    if [[ -d "$SRC_DIR/schemas" ]]; then
        mkdir -p "$EXT_DIR/schemas"
        cp "$SRC_DIR/schemas/"*.xml "$EXT_DIR/schemas/"
        glib-compile-schemas "$EXT_DIR/schemas"
    fi
}
