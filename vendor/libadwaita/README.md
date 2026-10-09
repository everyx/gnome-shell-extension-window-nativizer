# vendor/libadwaita

Authoritative source of decoration styles (CSD window decorations), vendored from upstream libadwaita.

- Source: https://gitlab.gnome.org/GNOME/libadwaita
- COMMIT: See the COMMIT file in this directory (currently `cat COMMIT`)
- Purpose: `tools/gen-style.mjs` parses window.csd rounded corner, shadow, and backdrop
  transition parameters from `_window.scss`, `_colors.scss`, and `_common.scss`, generating
  `src/lib/adwaitaStyle.generated.js` (do not edit the generated file directly). `_common.scss`'s
  `$backdrop_transition` supplies `ADWAITA_STYLE.transition`; `ADWAITA_STYLE.shadowPad` is derived
  from every generated shadow layer.
- Update instructions:
  1. Re-vendor upstream files and update COMMIT
  2. Run `pnpm run gen:code` (or `node tools/gen-style.mjs` after `gen-clutter`)
  3. Verify that the generated diff in `adwaitaStyle.generated.js` matches expectations
