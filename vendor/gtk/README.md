# vendor/gtk

Authoritative source for GTK4 behaviour (shadow rendering, resize-handle geometry), vendored
from upstream GTK.

- Source: https://gitlab.gnome.org/GNOME/gtk
- COMMIT: See the COMMIT file in this directory (currently `cat COMMIT`)
- Purpose:
  - `gskgpuboxshadow.glsl` (gsk/gpu/shaders) is the GSK GPU renderer's 2D analytical Gaussian
    box-shadow algorithm (erf, erf_range, gauss, ellipse_x, blur_rect, blur_corner,
    blur_rounded_rect). `tools/gen-shader.mjs` extracts it, generating shader code
    (do not edit the generated file directly).
  - `gtkwindow.c` (gtk/) defines `RESIZE_HANDLE_SIZE` and `RESIZE_HANDLE_CORNER_SIZE`, the CSD
    input-region geometry. `tools/gen-gtk.mjs` extracts them into
    `src/lib/gtkRules.generated.js`.
- `research/gtk` is an uncommitted clone kept only for reading; this directory is the committed
  source of truth, at the COMMIT above.
- Update instructions:
  1. Re-vendor upstream files and update COMMIT
  2. Run `pnpm run gen-style` (or `node tools/gen-shader.mjs` / `node tools/gen-gtk.mjs`)
  3. Verify that the generated diff matches expectations
