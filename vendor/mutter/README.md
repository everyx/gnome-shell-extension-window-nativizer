# vendor/mutter

Authoritative source for window management and shadow decorations, vendored from upstream mutter.

- Source: https://gitlab.gnome.org/GNOME/mutter
- COMMIT: See the COMMIT file in this directory (currently `cat COMMIT`)
- Purpose:
  - `tools/gen-mutter.mjs` validates the `default_shadow_classes` tuple shape in `meta-shadow-factory.c` (nothing is emitted from it) and generates `MetaWindowType`/`MetaWindowClientType` from `window.h` into `src/lib/mutterRules.generated.js` (do not edit the generated file directly).
  - `clutter/clutter/clutter-actor-box.c` -- `_clutter_actor_box_enlarge_for_effects` -- is what
    `src/lib/offscreenBox.js` mirrors at runtime: the offscreen box a shader effect gets has to be
    derived per paint, because `clutter-offscreen-effect.c` scales it by a resource scale and rounds
    each edge onto the device grid. Two callers exist: the unpatched upstream one multiplies by
    `ceilf (resource_scale)`, while upstream MR !5179, which is unmerged and only carried by the
    optional `mutter-everyx` package, uses the real resource scale. The checkout this snapshot is
    taken from (`research/mutter`, HEAD `8fe247a2` / 50.4) still has the `ceilf` caller and no
    `!5179` commit, so `src/lib/offscreenBox.js` resolves which caller produced a given FBO from the
    FBO's own extent rather than assuming one. `tools/check-upstream-mirrors.mjs` asserts the two
    literals of that rule - the `0.75f` margin before the `ceilf` and the `- 3` total - scoped to the
    function, so a bump that changes either one fails instead of leaving `ENLARGE_ROUNDING_PAD` and
    `ENLARGE_TOTAL_PAD` (src/lib/offscreenBox.js) as stale copies of an extinct rule.
  - `meta-window-actor-x11.c` preserves `has_shadow` decision logic as the basis for window decoration detection.
  - `meta-shaped-texture.c` preserves the one condition the overview mask depends on: the opaque
    fast path is taken only while `use_opaque_region` holds, and that is false whenever the actor's
    opacity is not exactly 255 (`do_paint_content`). `src/lib/overviewDecoration.js` relies on it by
    setting 254, so `tools/check-upstream-mirrors.mjs` asserts the expression: a bump that widens it
    would silently keep the mask from ever being applied.
  - `meta-window-actor-wayland.c` (src/compositor) preserves `surface_container_apply_transform`, the
    Wayland subpixel phase, as the basis for `getWindowSubpixelOffset` in `src/platform/window.js`.
    `tools/check-upstream-mirrors.mjs` asserts that arithmetic rather than generating from it.
  - `window.h` provides authoritative `MetaWindowType` enum definition to prevent enum drift.
- `research/mutter` is an uncommitted clone kept only for reading; this directory is the
  committed source of truth, at the COMMIT above.
- Update instructions:
  1. Re-vendor upstream files and update COMMIT
  2. Run `node tools/gen-mutter.mjs` (or `pnpm run gen:code`)
  3. Verify that the generated diff matches expectations
