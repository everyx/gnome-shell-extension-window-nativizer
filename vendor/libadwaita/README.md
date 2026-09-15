# vendor/libadwaita

Authoritative source of decoration styles (CSD window decorations), vendored from upstream libadwaita.

- Source: https://gitlab.gnome.org/GNOME/libadwaita
- COMMIT: See the COMMIT file in this directory (currently `cat COMMIT`)
- Purpose: `tools/gen-style.mjs` parses window.csd rounded corner, shadow, and backdrop
  transition parameters from here, generating `src/lib/adwaitaStyle.generated.js` (do not edit
  the generated file directly). `_common.scss`'s `$backdrop_transition` supplies
  `ADWAITA_STYLE.transition`; `ADWAITA_STYLE.shadowPad` is derived from every generated shadow
  layer.
- Update instructions:
  1. Re-vendor upstream files and update COMMIT
  2. Run `node tools/gen-style.mjs` (fails if assertion errors occur)
  3. Verify that the generated diff in `adwaitaStyle.generated.js` matches expectations
