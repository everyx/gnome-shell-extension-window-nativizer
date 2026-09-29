# vendor/gnome-shell

Authoritative source for the metrics the window inspector borrows from the Shell's own pickers,
vendored from upstream gnome-shell.

- Source: https://gitlab.gnome.org/GNOME/gnome-shell
- COMMIT: See the COMMIT file in this directory (currently `cat COMMIT`)
- Purpose:
  - `tools/gen-inspector.mjs` parses `const width = 2` from `lookingGlass.js` -- the border the
    Looking Glass picker draws around the actor under the pointer, which is the closest thing
    upstream has to this extension's picker, since both are hover-and-pick tools -- and
    `st-transparentize(-st-accent-color, 0.8)` from `_screenshot.scss` -- the fill the screenshot
    window selector gives the window it highlights -- generating `src/lib/inspectorStyle.generated.js`
    (do not edit the generated file directly). The files live under `js/ui/` and
    `data/theme/gnome-shell-sass/widgets/` upstream but are vendored flat here, like the others.
- The screenshot selector states `border: 6px transparent` for its own highlight. This extension
  draws 2px instead, and the reason is the interaction rather than the look: a thumbnail grid can
  afford a 6px band, a hover-and-pick tool cannot, and Looking Glass -- the picker it does resemble
  -- uses 2. The choice is recorded here rather than silently extracted, so that a future reader can
  see it was made on purpose.
- `research/gnome-shell` is an uncommitted clone kept only for reading; this directory is the
  committed source of truth, at the COMMIT above.
- Update instructions:
  1. Re-vendor upstream files and update COMMIT
  2. Run `node tools/gen-inspector.mjs`
  3. Verify that the generated diff matches expectations
