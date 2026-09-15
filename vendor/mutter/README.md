# vendor/mutter

Authoritative source for window management and shadow decorations, vendored from upstream mutter.

- Source: https://gitlab.gnome.org/GNOME/mutter
- COMMIT: See the COMMIT file in this directory (currently `cat COMMIT`)
- Purpose:
  - `tools/gen-mutter.mjs` parses `default_shadow_classes` parameters and algorithms from `meta-shadow-factory.c` and `MetaWindowType` from `window.h`, generating `src/lib/mutterRules.generated.js` (do not edit the generated file directly).
  - `tools/gen-clutter.mjs` parses `clutter/clutter/clutter-actor-box.c` --
    `_clutter_actor_box_enlarge_for_effects` -- generating
    `src/lib/clutterEffectPadding.generated.js` (the 3px offscreen padding literal and the
    derived 2px top/left origin; do not edit the generated file directly). The file lives
    under `clutter/` upstream but is vendored flat here, like the others.
  - `meta-window-actor-x11.c` preserves `has_shadow` decision logic as the basis for window decoration detection.
  - `window.h` provides authoritative `MetaWindowType` enum definition to prevent enum drift.
- `research/mutter` is an uncommitted clone kept only for reading; this directory is the
  committed source of truth, at the COMMIT above.
- Update instructions:
  1. Re-vendor upstream files and update COMMIT
  2. Run `node tools/gen-mutter.mjs` and `node tools/gen-clutter.mjs` (or `pnpm run gen-style`)
  3. Verify that the generated diff matches expectations
