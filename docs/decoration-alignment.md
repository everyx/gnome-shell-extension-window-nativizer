# Aligning the decoration with libadwaita

The decoration is meant to be indistinguishable from libadwaita's client-side decoration.
This is what that means numerically, how it was measured, what is known, and what is still
open. It exists because the knowledge below cost a great deal to acquire and is not visible
anywhere in the code.

## What is being aligned

libadwaita draws `window.csd` as a rounded rectangle with `box-shadow` and a 1px outline; the
values come from libadwaita's `_window.scss`. Mutter's own X11 window shadows
are **not** the model (they are cached per focus state and swapped with no transition); they
are recorded in `decoration-model.md` as a contrast.

Two things are drawn, and they have different mechanisms:

| Part | Where it lives | Notes |
| --- | --- | --- |
| Rounded clip + inner outline | a rounded clip effect on the window actor (surface actor on XWayland) | skipped entirely under some settings, see below |
| Shadow | our shadow actor, a **sibling** of the window actor | one baked 145x145 texture per style, 8-slice (why eight describe the shape: `decoration-model.md`); only where we paint it — bare XWayland keeps Mutter's, while SSD takes over the frames-client square shadow with our 15px rounded shadow |

Because our shadow is a sibling and the clip is an effect, a window-scoped screenshot
can never contain the shadow. Only a full-desktop screenshot shows both. The clip, on the
other hand, is always in the shot: it paints the actor's effect chain, so the four corners
come out with no alpha where the client drew its own square ones.

That is the correct encoding of the screen, not a cost of the clip. On screen those corner
pixels are the desktop - the clip is what puts the desktop there - so a capture saying "the
window contributes nothing here" says exactly what the screen says, and a self-rounding CSD
window's own capture carries alpha at its corners the same way. The test is whether the shot
composites back: over the desktop it was taken on, the corners take that desktop back and the
screen is reconstructed pixel for pixel; over anything else they take that instead, which is
what an alpha channel means. Measured on a GTK3 window over a white backdrop: 5383 pixels
below full alpha with the extension enabled against 680 with it disabled, the top-left pixel
reading `(0,0,0,0)` against `(250,250,251,255)`.

That is how to read a capture faithfully, not the standard a behaviour is judged by: a behaviour is
judged on the user's screen, and a capture-level difference is not a reason to withhold a
user-visible behaviour (see `decoration-model.md` § Retaining rounded corners through the
shaped-texture mask).

## The measurement that works

A window with a **known body colour** over a **white backdrop**, profiled pixel by pixel
outward from the window edge, all three channels. Red body + white background + black shadow
separate three things in one profile: body, outline, shadow.

`tools/probe-window.js` takes `WINDOW_NATIVIZER_BODY=#ff0000` for exactly this; with
`WINDOW_NATIVIZER_BACKDROP=1` it is the white surface. `WINDOW_NATIVIZER_MODE=native` renders the same
window through libadwaita as the reference.

Profiles must step **outward** on all four sides (top and left step negative) and must be
read in **physical** pixels: a screenshot is `logical x ceil-less resource scale` — on a
1.3333 display a 1280x800 monitor yields a 1707x1067 image.

### A native window's edge looks like this

Red body, bottom edge, offsets from the last pixel inside the window:

```
offset   -3   -2   -1    0    1    2    3    4    5
R       255  255  255  248  200  215  219  223  227
G         0    0   12   37  200  215  219  223  227
```

`G=12` at -1 is libadwaita's inner 1px highlight (white over red, about 5%; the generated
style says 7%). `0` is the anti-aliased body edge. `+1` and beyond is the shadow: the first
shadow pixel is a 1px border ring (`0 0 0 1px rgba(0,0,0,0.05)`, a zero-blur 1px spread at
5% alpha).

## The band you can grab is narrower than the shadow you can see

A native GNOME window is grabbable only in a band hugging the window itself; the rest of its
shadow is click-through:

| | Visible shadow | Grabbable band |
|---|---|---|
| GTK4 / libadwaita | 25px | **12px** |
| GTK3 + adw-gtk3 | 24/21/24/27px | **10px** |

The GTK3 row is one theme's numbers, quoted because that is what this machine runs; the rule behind it
is GTK3's own, and the theme supplies every number in it.

- GTK4 floors the handle at `RESIZE_HANDLE_SIZE 12` (`gtkwindow.c:191`) and builds the input
  region as the border box plus 12px (`update_realized_window_properties`, `:4229-4232`), so
  the outer 13px of the shadow belongs to nobody. The declared margin says the same thing from
  the other side: `MAX(css shadow, 12)` (`get_shadow_width`, `:4196-4201`).
- GTK3 + adw-gtk3 takes the band from the decoration node's margin + border + padding
  (`gtk-3-24 gtkwindow.c:7063,7088-7095`), and the theme names it outright -
  `decoration { box-shadow: 0 3px 8px 1px; margin: 10px }`, with the comment *"this is used for
  the resize cursor area"*.

"It looks like the whole shadow can be grabbed and only a strip of it can" is therefore
**native behaviour**, not something the drawing introduced: we draw the same shadow (average
deviation under 5/255, worst case 8/255 on the first two pixels), and the band we add is 12px
from the body - GTK4's width, and the width a GTK4
client's own input region already has. A GTK4 client that declares at least 12px on every side
therefore keeps its own handle and gets no band from us; any window we decorate whose own handle is
narrower gets ours, which brings it up to that width where its own is the theme's (10px with the
theme here), and GTK4's 24px corner reach where its toolkit reaches 20. That band is the one place the extension participates in hit testing at all
(`decoration-model.md` § The resize band); the shadow itself is still painted and never picked.

What was rejected is turning the **whole visible shadow** into an input region. That means
claiming a band the toolkit leaves click-through on purpose - 13px per side on GTK4 - and every
click in it would be swallowed: a strip above the window is not a surface actor, so Mutter's
stage filter neither takes the press nor passes it on. Mutter moved the other way for exactly
this reason (issues #2788, !3031, #2706). The measured gain is zero on GTK4, whose floor is
already 12px, and 2px on GTK3, so the band keeps to 12px and leaves the outer 13px alone.

### Who owns the cursor

Outside the window picker, the band is the only place the extension sets a cursor, and it has
to. (The picker sets a `CROSSHAIR` on `global.stage` for the duration of a pick.) Where the band covers
the ring, the pointer focus is cleared - `repick_for_event` reaches
`meta_wayland_pointer_set_current(window, NULL)` - so our reactive child becomes the only actor
the pointer is over and whoever else might have owned that cursor no longer does. Leaving the
cursor unset is therefore not neutral: the whole ring would just be the default arrow.

Mutter does not fill the gap for an ungrabbed window. It maps the 8-way resize cursor only
inside a grab (`meta_cursor_for_grab_op`), and it starts a resize only from inside the
window's own input region, never from the shadow band outside it. So the cursor in the outer
band can only come from us; there is no underlying owner whose value we would be duplicating.

The corollary is the residual defect in `decoration-model.md` § What the band cannot fix: we
own the cursor from the frame outward, the client owns it inside the frame, and where the
client uses a different cursor family at its own edge the pattern changes at that boundary.

Not verified with a real pointer: these figures come from the toolkit sources and from the
declared margins measured in the nested session. To see it by hand, hover a native libadwaita
window's shadow 8px and 20px from the window; only the inner one shows a resize cursor. The
resize band's own feel - hover cursor and drag - has not been tried with a real pointer either.

## The setting that silently disables half of this

`prefer-crisp-text` (default false) plus a fractional-scale monitor means
**no corner-clipping pass is attached**: square corners,
no inner outline, and the shadow is baked against a square outline instead. The effect is still
attached at radius 0 where a client ring has to be cleared. On the machine
this was developed on the setting is `true` and the monitor is at 1.3333, so every early
measurement compared a square decoration against a rounded one and produced a phantom "1
pixel edge offset" that was chased for a long time.

Before measuring corners or the outline:

```bash
gsettings set org.gnome.shell.extensions.window-nativizer prefer-crisp-text false   # and restore it
```

This is a real trade-off, not a bug: clipping is an offscreen per window, and the option
exists to avoid text blur and resampling on fractional-scale displays.

## The overview, which is not the shell showing it

- **It is never raised by the shell on its own.** Two runs of 29s and 17s with no input and
  no interaction left `OverviewActive` false throughout.
- **It is sometimes already up when a devkit session becomes usable**, and around startup a
  hide does not always stick; later, one hide sticks.
- **Exiting it is one D-Bus write**, which the shell maps onto its own `Main.overview.hide()`
  (`shellDBus.js`):

```bash
gdbus call --dest org.gnome.Shell --object-path /org/gnome/Shell \
  --method org.freedesktop.DBus.Properties.Set org.gnome.Shell OverviewActive '<false>'
```

- **Judges that lied**, both measured: the overview actor stays `mapped=true` while the
  overview is hidden, and `Main.overview.visible` was true while a screenshot showed a plain
  desktop. The D-Bus property is the one that agreed with the pixels.
- **A screenshot must be a transaction**: hide, check, shoot, check again, discard and retry
  if the state changed, refuse if it never holds. That is what finally made a measurement
  trustworthy: with it, a shot taken right after a session start still measured a clean
  desktop (mean 97, against 37 with the overview up).

## Facts that cost the most

- `pkill -f 'gnome-shell --devkit'` matches **the command line that runs it**. Use the
  `gnome-shel[l]` bracket trick, or a script file.
- `Eval` answers `(false, '')` in some sessions while the shell is perfectly usable. Read
  state from D-Bus properties instead of requiring Eval.
- The shell's own startup notification banner landed inside a measurement region and produced
  a 171 grey-level difference that had nothing to do with the decoration.
- A `ClutterOffscreenEffect`'s offscreen is not the actor's box: Clutter enlarges it to a
  stable size, `_clutter_actor_box_enlarge_for_effects` (`clutter-actor-box.c:505`) gives
  three pixels per axis split around the actor — two on the left/top and one on the
  right/bottom for an integer position — and then scales that box by the **real** resource
  scale and rounds each edge onto the device grid (`clutter-offscreen-effect.c`; the
  `mutter-everyx` patchset carries upstream MR !5179, which is what makes it the real scale —
  before it the box was multiplied by `ceilf (resource_scale)`, i.e. **2** on a 1.3333 monitor).
  Measured with `Clutter.OffscreenEffect.get_target_size()` for a 441x281 body: 444x284 device px
  at 1.0, 556x356 at 1.25 and 593x379 at 4/3. One shader unit is therefore one logical pixel
  only when the quad is derived per paint from that box (`lib/offscreenBox.js`); a constant
  cannot express it, and the constants that stood in for it read 1.2522 device px per unit at 1.25.
- `clutter_offscreen_effect_paint_texture` applies `1/resource_scale` and the `fbo_offset`
  in one matrix. Read the order in Graphene rather than assuming it.
- Measured live values for a 440x280 window at 4/3: `uFrame=[2.25,2.25,436.5,276.75]`,
  `uQuadSize=[444.75,284.25]`, `uFboOffset=[2.25,2.25]`, `target=[true, 593, 379]`. A Mutter built
  without MR !5179 would report `(440+3)x(280+3)` at `ceilf (4/3) = 2`, i.e. `886x566`, for the same
  window - not measured here, but that is the rule the old constants encoded.
- `move_resize_frame` to the work area, never `maximize()`: a maximize animation in a nested
  session never finishes.
- ES modules are not hot-reloaded: every change needs a fresh shell.
- Sessions must be torn down by display ownership (anything whose `WAYLAND_DISPLAY` is not
  `wayland-0`), or the devkit window outlives the shell it was showing.

## Where the alignment stands

With clipping enabled and a 440x280 window, profiles outward from the window edge were
compared against native libadwaita. Two apparent discrepancies were analyzed and resolved:

### 1. Right-edge highlight asymmetry (G=133)

- **The cause**: On a 1.3333 fractional scale display, a 440px wide window maps to
  `440 × 1.333333 = 586.6667` physical pixels. The right boundary lands on a fractional
  phase (`0.67`), so the rasterizer samples across the boundary between the window body
  and background/shadow, producing an anti-aliasing blend (`G=133`). On the left edge,
  `x=0` is integer-aligned (`G=0`).
- **Confirmation**: The underlying shader's distance field is mathematically centered and
  four-way symmetric. In native libadwaita, decorations are rendered entirely within the
  client's own Wayland surface via GTK4/GSK; in Window Nativizer, the window content and shadow
  live on separate Mutter Clutter actors, subject to Mutter's offscreen clipping and
  fractional blitting.
- **Trade-off & Grid Snapping**: When `prefer-crisp-text` is enabled, the rounded clip is deliberately omitted
  under fractional scaling to avoid resampling blur on client window content. When the clip runs, its boundary
  snaps to the physical device pixel grid with the same rounding rule the shadow cutlines use, so the body
  is not expanded outward and adjacent 8-slice shadow quads keep their cutlines on identical physical coordinates
  to eliminate subpixel seams.

### 2. First shadow pixel darkness (185 vs native 198-200)

Originally, Window Nativizer's first shadow pixel measured 185 (about 13-14 grey levels darker
than native's ~199). Two factors contributed to this:

1. **Layer 3 outline mask**: CSS defines the 1px ring as an outset border
   (`0 0 0 1px rgba(0,0,0,0.05)`). The shader used to evaluate a zero-blur ring as a solid
   disc. Because the shadow mesh is deliberately extended a little inward under the window
   to prevent subpixel floating-point seams between the window actor and the shadow actor,
   that solid disc contributed alpha even under
   the window edge and at the first boundary pixel.
2. **Layer compositing**: Multiple shadow layers were previously combined with linear
   arithmetic addition. Native GSK render nodes composite overlapping
   layers via **Alpha-Over** instead, preventing
   artificial saturation where blur tails overlap.

### Resolution: Symmetric Device Grid Phase Locking & Pure Gaussian Shadow

Fractional scaling under window drag revealed a critical limitation: as actor coordinates
shift across subpixel boundaries (e.g. 1.33x or 1.25x scale), two phenomena emerged:
1. Bilinear texture filtering across any high-frequency 1px border line baked into the 8-slice
   texture alternated between landing on a single physical pixel and splitting across two pixels,
   producing 1px/2px jumping and flickering.
2. The clip effect's outward growth rule expanded the clip rect outward by up
   to 0.5 logical pixels. On non-native windows declaring client shadow insets (such as Meld / GTK3
   CSD), this outward expansion inadvertently captured the obsolete 1px dark border drawn by the
   client in the outer decoration ring (`box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.23)`), while
   the shadow slices were snapped to the physical grid, causing a 1-physical-pixel phase conflict
   and asymmetric dark borders.

To solve this at the root:

1. **Straight Edge AA Decoupling in Clip Shader**:
   Applying an SDF anti-aliasing ramp indiscriminately to straight edges generates a 1px semi-transparent
   slope in the offscreen FBO. When moving windows across subpixel boundaries under fractional scaling
   (e.g. 1.33x or 1.25x scale), Mutter's stage texture filtering convolves this semi-transparent slope a
   second time, broadening the edge into a 2px blurry fringe. The AA ramp is therefore strictly
   restricted to the corner arcs, while straight edges preserve 100% clean content alpha. Single-pass
   GPU screen-space rasterization keeps
   the straight edge sharp and jitter-free at all subpixel positions. This is the one home of that
   decision; `architecture.md` and `decoration-model.md` only point here.
2. **Symmetric Device Grid Phase Locking**:
   The clip frame snaps to the same physical grid phase as the shadow cutlines, which also snap to
   the physical grid. `resolveClipTarget` (`lib/clipTarget.js`) picks the Wayland surface container
   when it can identify it (`getSurfaceContainer`: exactly one non-foreign child, else the unique
   buffer-compatible one, else fall back to the window actor) and its geometry matches the buffer;
   the buffer's subpixel phase is that container's own transform, so
   an offscreen effect on the container paints its local content and the hard straight-edge cut is
   computed in the same coordinates as the buffer. Clipping the window actor instead leaves the
   phase in a child transform, which the offscreen FBO's box rounding cannot keep; at 1.25x the cut
   then fell a full physical pixel inside the frame and the backdrop showed through as a bright
   hairline between the clip's cut and the shadow's cutout. `clipFrameFor` in `lib/snap.js` is the
   one derivation of both local edges, and the shadow actor carries the phase as its own
   translation. On this container path, this guarantees:
   - Zero phase drift between the clip mask and the 8-slice shadow cutout across all monitor DPI scales;
   - The clip's cut and the shadow's cutout land on one physical pixel, with no hairline between them;
   - Obsolete client-drawn border rings outside the client frame are strictly excluded
     from the clipped body without fractional outward expansion;
   - Concentric, subpixel-exact, 100% four-way symmetric corners under both static display and dynamic drag.

   The resolver also has a real fallback: an ambiguous actor tree, a container whose geometry does
   not match the buffer, an unreadable buffer or allocation, a container whose local box is not
   integer-aligned, or, on X11, the first non-foreign child when no unique container can be
   identified. There the phase
   is not in the target's own transform, so the clip folds `getWindowSubpixelOffset` into its
   geometry again - the behaviour before the container path - while the shadow keeps the same offset
   as a translation. Both cuts still share `clipFrameFor` and still meet on one physical line, but
   the offscreen FBO's integer-grid box rounding can still part them by the hairline that clipping
   the window actor left at 1.25x. We nevertheless keep the phase correction on the fallback,
   because it is what keeps the cut aligned with the client content: without it the cut sits a
   fraction of a pixel off the buffer everywhere, which is worse than a boundary that can still
   part at the one phase where the FBO rounds across it. The straight-edge claim in `README.md`
   therefore describes the container path.

   The box check is a precondition, not a fix. `lib/offscreenBox.js` derives the offscreen box - the
   FBO extent and the actor origin inside it - per paint from the actor size and the real resource
   scale, so a fractional box is expressible; the guard remains because Clutter enlarges the box
   from the container's place in its parent while `offscreenQuad` derives it from an actor-local
   `[0, length]`, and the two only agree on the boxes it admits. What the constants could not
   express was the *scale*: they scaled the box by an integer, so at 1.25x one shader unit was
   1.2522 device px, the corner arc drifted up to half a physical pixel off the pixel-snapped
   straight edge, and at 4/3 a float32 fencepost cut the bottom edge a device pixel short.
3. **Alpha-Over Compositing**: Multi-layer shadows are composited with alpha-over in the shadow bake.
4. **Physical Grid Snapping**: The small inward bleed of the shadow mesh is retained to prevent
   subpixel seams, and slice boxes
   are snapped to the physical grid using GTK 4.24's `gsk_rect_snap_to_grid` rules. FLOOR and
   CEIL mirror `gsk_rect_snap_direction` exactly; ROUND is a deliberate adaptation. GSK's branch
   evaluates `roundf (value + GSK_SNAP_EPSILON)` on the raw value, so `-1.5` becomes
   `roundf(-1.499) = -1` - biasing negative coordinates toward zero and breaking sign symmetry.
   We round the magnitude and reapply the sign instead, because the two edges of a body must snap
   alike (`f(-x) = -f(x)`); `tests/snap.test.js` pins both the deviation and the symmetry.
   - **Decision (A vs B)**: option A was to adopt GSK's raw-value epsilon exactly. Rejected - it
     changes desktop rendering on negative coordinates with no bug behind it, and gives up the
     origin-odd symmetry. Option B (documented deviation) is in force. Reopen A only if a visible
     1-physical-pixel artifact appears at negative coordinates.
5. **Symmetric Physical Margin Snapping**:
   GTK3 CSD windows (e.g. Meld) render a 1px border stroke (`box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.23)`).
   Because Cairo strokes 1px lines using half-pixel centering (0.5px outside, 0.5px inside), independent
   absolute coordinate rounding under fractional scaling suffered from parity drift (35px vs 34px), leaving
   stroke residue on one side. `snapActorBodyFrame` symmetrically snaps declared margins per-side to the
   device grid (`round(margin * scale)`). Equal declared margins guarantee identical physical margin cuts
   on all sides across all fractional scales, cleanly excising stroke residue while keeping the clip body
   and shadow body strictly unified on the true frame.
6. **Ring layer as a hollow band**: The zero-blur ring layer is a hollow outset band
   rather than the filled disc the
   old shader evaluated, so it no longer floods alpha under the window edge and the first boundary
   pixel.
7. **Inward Normal Texture Sampling Offset under Fractional Scaling**:
   When clearing client-drawn decoration rings (`uClearStroke > 0.5`), GTK3 windows often carry
   semi-transparent Cairo border strokes (`0.5px` outside, `0.5px` inside the frame). Under fractional
   scaling (e.g. 1.25x, 1.33x), hardware bilinear texture filtering samples texels across the border edge,
   pulling exterior dark pixels into the boundary. To eliminate this without shrinking the window's
   physical geometry, `clipEffect.js` pushes the texture sampling coordinates inward along the boundary
   normal by `max(0.0, d + inset)` where `inset = min(1.0 + 0.5 / uScale, maxInset)`. Both straight
   edges and corner arcs sample clean interior pixels, guaranteeing zero dark seam or notch artifacts
   under fractional scaling while preserving full content fidelity.

### Golden Baseline at 1.0x Integer Scale

Measurements on a 1.0x virtual monitor (`1920x1080`, scale=1.0) in an isolated session
provide the definitive ground truth without fractional scaling distortion.

#### Ghost window cascade discovery
An earlier measurement reported native libadwaita having a 10px top/left shadow and a 22px
bottom/right shadow. Investigation revealed that the test harness did not terminate child
`gjs` processes; Mutter cascade-placed the native window offset by `(+50, +50)` over an
unclosed CSD window, and the bounding box detector sampled a composite of both. In a clean,
isolated session, **native libadwaita is 100% four-way symmetric**, precisely matching its
SCSS definition (`box-shadow: 0 0 14px 5px ..., 0 0 5px 2px ..., 0 0 0 1px ...`).

#### Attenuation Profile (0 to 22px outwards, Red body over White backdrop)

| Offset (px) | Window Nativizer (4-way symmetric) | Native Libadwaita (4-way symmetric) | Delta (G) | Notes |
| :---: | :---: | :---: | :---: | :--- |
| **0 (outline)** | **18** | **18** | **±0** | 1px inner outline (G channel over Red body) |
| **+1** | **191** | **199** | **-8** | First shadow pixel outside window |
| **+2** | **208** | **216** | **-8** | Smooth parallel decay |
| **+3** | **218** | **221** | **-3** | Rapid convergence |
| **+4** | **227** | **227** | **±0** | **Exact match** |
| **+5** | **233** | **231** | **+2** | |
| **+6** | **238** | **235** | **+3** | |
| **+7** | **242** | **238** | **+4** | |
| **+8** | **246** | **241** | **+5** | |
| **+9** | **249** | **243** | **+6** | |
| **+10** | **251** | **245** | **+6** | |
| **+11** | **253** | **247** | **+6** | |
| **+12** | **254** | **248** | **+6** | |
| **+13** | **254** | **250** | **+4** | |
| **+14** | **255 (white)** | **251** | **+4** | Window Nativizer fades into pure white |
| **+15 ~ +21** | 255 | 252 ~ 254 | +1 ~ +3 | Sub-1% native tail |
| **+22** | 255 | **255 (white)** | **±0** | Native fades into pure white |

Both curves are strictly monotonic. Across the primary visible range (+1 to +10px), Window Nativizer
tracks native curvature closely with an average deviation under 5 grey levels, zero banding,
and 100% four-way symmetry.

### At the fractional scale (1.3333), and what it does not change

Measured on a `--virtual-monitor 1920x1080` session moved to scale 1.3333 via
`ApplyMonitorsConfig`, all three windows **unfocused** over the white backdrop, body
`#ff0000`, 440x280, G channel outward from the last body row (physical px):

| Offset | ① native libadwaita | ② ours, GTK3+adw-gtk3 | ③ ours, bare (no ring) | client alone, extension off |
| :---: | :---: | :---: | :---: | :---: |
| +1 | 226 | 216 | 231 | 225 |
| +2 | 239 | 229 | 229 | 230 |
| +3 | 240 | 236 | 236 | 232 |
| +4 | 241 | 238 | 238 | 235 |
| +5 | 243 | 239 | 239 | 236 |
| +6 | 244 | 241 | 241 | 238 |
| +7 | 245 | 243 | 243 | 239 |
| +8 | 246 | 246 | 246 | 242 |

At scale 1.0 the same pair of columns for ② minus ① is `-2 -4 -3 -2 -1 0 +2 +3`;
at 1.3333 it is `-10 -10 -4 -3 -4 -3 -2 0`. The first two physical pixels are the
whole difference, and fractional scaling roughly doubles it.

What the numbers settle:

- **The client's ring is cleared, not overlaid.** Total darkness over +1..+15 is 171
  with the extension on against 227 for the client's own shadow alone. Extension *on*
  is lighter everywhere except the single +1 pixel, so the ring-clearing pass does erase the
  adw-gtk3 `0 3px 8px 1px rgba(0,0,0,0.3)` ring; there is no 0.3 + 0.08 stack.
- **The reference is the right one.** Our style for a backdrop window is libadwaita's
  own `window.csd:backdrop` set (`_window.scss`), so a taken-over window
  *should* profile like the skipped libadwaita one. ① and ② are the same measurement.
- **The remaining gap is the shadow's own edge, not a state error.** The shadow parameters
  are right (the unfocused and focused tiers select libadwaita's own `window.csd` sets), baked
  at the same 1px/logical-px grid as `decoration-model.md` describes; our profile is a
  few grey levels darker across the first ~5 logical px, closing by the sixth. Column
  ③ (a bare window, so no client ring anywhere) shows the same +2 difference, which
  puts it in our shadow rather than in the ring.
- **The one-pixel boundary row belongs to the clip.** With the shadow's style
  zeroed and ring clearing on, the first ring pixel of ② still reads 239 over white
  (255 would be fully erased); ③, whose ring is empty, has nothing there. At scale 1.0
  the offscreen is 1:1 and ② and ③ agree at +1, so the difference is the fractional
  offscreen downsample meeting the clip's anti-aliased body boundary, not the shadow
  texture: re-baking the same shadow into a 2x texture (window, radius and padding all
  doubled, offscreen origin scaled with them) leaves every profile above unchanged.

The last two bullets are why the fractional profile is not byte-identical to native.
The magnitude is a handful of grey levels on the first two physical pixels (about 1.5
logical px); whether that reads as a heavier shadow depends on the sub-pixel phase the
window happens to land on, so two windows on the same monitor can differ by ~5/255
purely from where their edges fall.

### The inner outline, which is a shader band

Ours is not drawn by the client: the 1px inner outline is the shader's coverage ramp, and its
strength is where that ramp sits relative to the pixel grid. With the ramp centred on the
body boundary, the innermost body pixel — the only one whose centre can fall
inside a ring that is one pixel wide — came out at half coverage: G **9** against native's
**18**, at every edge and every scale where the boundary lands on a whole pixel. Centring
the ring half a pixel inside the body instead
puts that pixel centre at full coverage, and the two agree exactly at 1.0.

Measured as in the profile above — innermost body rows per edge, G channel, red body over
white backdrop — for four window positions one logical pixel apart, which is four sub-pixel
phases per edge:

| scale |  | before | after | native |
| :---: | :--- | :---: | :---: | :---: |
| 1.0 | each edge, each phase | 9 | **18** | 18 |
| 1.3333 | strongest edge | 7 | **18** (16 + 2) | 49 (37 + 12) |
| 1.3333 | weakest edge | 0 | 0 | 12 |
| 1.3333 | total, four edges | 9–16 | 31–47 | 97–171 |

What the numbers say:

- **At 1.0 the ring is now native's value exactly**, at every edge and every phase, and it is
  still one pixel: one row reads 18, the row inside it 0.
- **At 1.3333 the change doubles the ink** (per edge 7 -> 18 on the best phase, 2 -> 11 on the
  next, 0 -> 0 where the phase was already empty) and never puts `G >= 3` on two body rows,
  so the ring does not become 2px. A row at G 0 with the ink one row further out is the
  anti-aliased body boundary against the shadow, which native has too.
- **The phase spread is older than this change.** At 1.3333 the four edges of one window sit
  at four different sub-pixel phases; one can read 18 while another reads 0, and moving the
  window one logical pixel moves the ink between edges. Before the change the same sweep read
  7/2/0/0, so the fix raises the level and leaves the spread; native spreads the same way
  (across the same four positions its per-edge reading moves between 12 and 49 — one row of 12
  up to 37 + 12). Closing that
  last gap means drawing the outline at the physical resolution — as a clipped actor like the
  shadow rather than a coverage term in the offscreen pass — and is not what this changed.
- **High contrast scales with it.** At 1.0 the 30% tier reads 76 after the change where it read
  38 before, against the 7% tier's 18 — the two tiers keep their 30/7 ratio, and both are still
  one pixel.

### Automated benchmark tool

The decoration is measured against **libadwaita's own, on one frame**, because that is the claim: a
window we decorate is decorated the way libadwaita decorates one.

```bash
pnpm run test:decoration          # measure and print every profile
pnpm run check:decoration         # exit 1 unless both decorated windows match the reference
```

Source: `tools/check-decoration.py`.

Three windows are on screen at once, all unfocused, over one maximized white backdrop, and one
screenshot is compared:

| Subject | What it is | Why |
|---|---|---|
| `native` | an `Adw.ApplicationWindow`, decorated by libadwaita | the reference |
| `declared` | a GTK4 client with its own decoration left on, so it **declares a shadow margin ring** | the extension clears that ring and takes the shadow over |
| `bare` | a GTK4 client with no decoration at all | the extension draws corners and a shadow where the client reserved nothing |

Because the reference is in the same screenshot, nothing about the machine - colour management, scale,
backdrop colour, animation phase - has to be assumed stable: none of it differs between the two sides
of the comparison. And nothing is stored: a stored copy of our own earlier output can only say that we
changed, and a stored copy of upstream's still has to be trusted as a description of this machine.

Samples are anchored to the compositor's `frame_rect` - the window's visible rectangle - which is the
same definition for a client that paints its own shadow inside its buffer and for one that has none.
Finding the rectangle in the pixels instead lands on whatever each client happens to paint, and the
three profiles then start at different places and cannot be compared.

The profiles are compared outward from the boundary pixel (offset 0), where the client's own edge
sits, into the shadow proper. Offset 0 is compared as the departure from the window's own body
(a clean step vs a shadow leak dip), and four inward body rows are verified flat.
Measured here, the shadow cast and edge transition match libadwaita with **0 grey levels unfocused, 1 focused**.

Two windows cannot both be focused, so the focused half of the claim is read by **alternating which
window has the focus**: one frame per subject, sharing the backdrop and the layout, and the same
unfocused window appears in all of them - which is what makes the alternating comparison mean anything
without a stored profile. The standards are fixed from that measurement, and each has a reason:

| Comparison | Standard | Why |
|---|---|---|
| unfocused, same frame | **0** | the two decorations are identical here, on both paths, so nothing has to be allowed |
| focused, alternating frames | **1** | one extra 8-bit quantisation, and the architecture is why: libadwaita paints the shadow into the window's own buffer, while this extension bakes it into a texture and slices that - the same curve (the bake runs the GLSL generated from GTK4's own `gskgpuboxshadow.glsl`) through one more quantisation. It shows on the focused set, whose three layers accumulate to about 0.30 near the edge, and not on the backdrop set, whose largest layer is transparent. It is not an unsettled fade: that would lighten the whole curve rather than move one step up and two steps down |
| environment witness | **0** | it is a control, not a claim: the same window in the same state read from two frames. Any difference at all means the frames do not describe the same machine, and every alternating comparison built on them is void |

Reading the same window focused twice gives the same profile here, which is what says the focused
level is systematic rather than the frame it was taken in.

Four things are asserted, and the split matters when one fails:

- **fidelity** - our profile against the live libadwaita window's, within 0 grey levels in one frame
  and 1 across alternating frames (per the comparisons above);
- **symmetry** - our four sides are identical, and so are libadwaita's;
- **the environment** - the live libadwaita window read twice, within 0 grey levels. A failure here is
  the machine having moved, not the code, and it says so rather than letting the fidelity number
  above it be read as a verdict;
- **flatness** - every body row the profile samples is flat to `BODY_FLAT_TOLERANCE` (0 grey levels),
  which is what separates a decoration from a body the clip is deforming.

The tool used to gate on a stored copy of *our own* earlier profile. That can only ever say "we
changed": when the shadow maths was corrected on 2026-10-04 the stored profile stopped matching, the
run failed for a week without anyone running it, and the failure said nothing about whether the new
output was right - it was, to within a grey level of libadwaita, while the stored profile sat 9 grey
levels away from it. A reference of our own past numbers is blind in the other direction too: it
cannot notice that we never matched libadwaita to begin with. Nothing is stored for later at all, in
either direction: both witnesses compare live reads of the same session.

**This check needs a session.** It runs from the pre-commit hook (`run-checks` skips it only on a
machine without `gnome-shell`), which is what closes the gap that once let it fail for a week
unnoticed; CI cannot run it, because CI has no session.

### GTK3 CSD Pixel-Level Verification in E2E

While `check-decoration.py` focuses on GTK4 shadow curves, GTK3 CSD edge transitions and
corner anti-aliasing are asserted directly in the automated E2E test suite (`tools/test-e2e.sh`).
A minimal GTK3 client with declared margins (`tools/gtk3-probe.py`) is rendered over a pure white
backdrop across four subpixel phase positions (x = 240, 241, 242, 243). A continuous radial ray
scan (19 rays sampled every 5° from top to left shoulder) verifies both minimum intensity thresholds
and monotonic radial/tangential color transitions, ensuring zero dark stroke bleed, notch artifacts,
or subpixel phase jitter.

## Costs and covers measured on the hot path

**The shadow actor's geometry sync.** `_syncGeometry` runs on every position, allocation,
translation, scale and pivot change, and each call writes both axes and both translations. A
one-window 150-step resize measured 293 calls, with the assignments and the relayout they queue
costing about 27 us of shell CPU per call. It writes only what changed, so the signals firing twice
per frame do not restate a value that did not move.

**The slice span must stay exactly `cornerPx`.** `snapSliceRects` snaps the eight quads' positions
to the physical grid but does not re-derive the span from two independently snapped cutlines.
`shadowSlices` fixes the sampled UV span to `cornerPx / buffer` in bake px, so the destination span
has to be exactly `cornerPx` or the corner/edge texture is rescaled instead of mapped 1:1 - up to
about 0.6% at 1.25x, 1.5x and 1.75x.

**The flat safe inset's spare device pixel.** `flatSafeInsets` covers a 1-logical-px client border
with `ceil(scale)` device px plus one spare on fractional scales. The geometric cut was verified
live to be exact on all four sides at every scale (`uFrame` read back off the effect matches the
snap math to float precision), yet at 4/3 the bottom edge kept one full border row at every subpixel
phase (seven positions swept on both axes). The shortfall sits below the geometry, in the paint
mapping, which runs at `ceil(scale)` while the screen composites at `scale`; integer scales paint
1:1 and need no spare. The worst measured drift was about 1.3 device px on the bottom edge at 4/3.
The price is deliberate over-cut, about one invisible device px of clean edge content per side on
fractional scales (issue #129 tracks the residual); deriving the paint origin from the live box at
runtime would remove the need for the spare. The scale is normalised before the integer test and the
`ceil` so the two cannot disagree: a hypothetical 1.0005 reads as integer yet ceils to 2, which once
yielded a ~2px cover on the integer branch.

## Five rules this work generalised

All four were learned by getting them wrong in the edge and overview work above, and none is
specific to this decoration.

**A value defined on the far side of a rasterisation boundary must not be folded into geometry
that crosses it.** Carry it in the representation the compositor already uses, at the layer where
it is defined. The subpixel phase is the instance: § Resolution: Symmetric Device Grid Phase
Locking & Pure Gaussian Shadow records the phase folded into the clip's computed frame, living
across the offscreen FBO's integer-grid boundary where the grid rounding could not keep it, and
attaching the clip to the container carries the phase around the FBO instead of through it. The
rule is that move in general form, not the phase: a value whose definition lives across a
rasterisation boundary has to travel in the compositor's own representation of it, at the layer
that owns it.

**An invariant between two of our own computations does not prove correctness against the system
we composite into.** The clip's cut and the shadow's cutout derive from one function on one
physical phase (`clipFrameFor`), and that invariant held while both edges were wrong relative to
the FBO's rasterisation. What has to hold is "our edge lands where the compositor rasterises it",
and it has to be checked per subpixel phase **and per scale**: the defect was invisible at 4/3,
whose phase steps never reach ±0.5 physical px, and visible at 1.25, a stock preset. Two things
follow. A scale set is part of the test surface, not a sample of it. And a guard that only rejects
one direction of artefact is half a guard - the straight-edge probe asserted only a downward
threshold, so a seam brighter than the shadow passed unseen.

**Observations are tri-state.** When the value comes from an actor or an API we do not own,
"missing or not yet arrived" is a state of its own, not a `false`. The overview mask's readiness
gates are the surviving instance: a shaped texture with no buffer yet, or a window actor with no
paint-able allocation, is neither "mask it" nor "refuse it" but "not this pass", and nothing is
cached, so the buffer's or the allocation's arrival earns a fresh reconcile. Folding "not yet"
into either of the others caches a guess, and a guess is wrong for the rest of the session. The
rule's original instance - Mutter's `paint_to_bitmap()` returning a bitmap, NULL, or nothing at
all - went with the removed probe described below.

**A reading taken inside our own pass is not evidence about a frame.** The clip diagnostics printed
the effects attached to the target before the same pass reached `_syncClip`; the `effects=0` it
showed was read as "the window is drawn unclipped for one frame" and drove two attempted fixes. It
was the state before our own mutation, and the clip was installed later in that same pass. This is
the fourth rule read along the time axis instead of the object axis: a probe after our change reports
our change, a probe before it reports neither, and only the frame boundary reports the frame. An
instrument meant to speak about a frame must be taken where the frame is drawn, or must name the
moment it belongs to.

**An observation must not be taken after we have mutated the thing observed.** A probe read after
our own change reports our change, not the original state. The overview probe was the instance: it
decided whether installing the mask would move Mutter's screenshot path, and the answer was only
meaningful on a texture we had not touched. That probe has since been removed - it protected a
capture-level behaviour no user can perceive at the cost of a rounded preview the user can see, so
it failed the standard that user-perceptible UI behaviour is the criterion and captures are out of
scope (`decoration-model.md`) - but the rule outlives it.


## The root criterion, and the one rule under the others

Everything above follows from a single criterion: **what we draw must match the frame the user is
looking at**, and that frame is defined by the state the compositor is using *in that frame*. The
rule under the other rules is therefore about ownership:

> **A state the compositor owns and changes on its own may only be read in the frame it is used, or
> followed in that same frame. Never copy it into a second copy of our own, update that copy on our
> own clock, and then treat our copy as authoritative. Only when the object the value describes has
> itself not changed may the previous value stand.**

The rules recorded above are the forms that failure takes. *Same quantity* means the copy was
already converted into something else on the way (raw reads instead of the body they imply, a layout
position instead of a subpixel phase). *The frame clock* means the copy is refreshed on our
debounced decision clock while the compositor draws on the frame clock. *Settledness* means the copy
was taken while the object was mid-update - a ring that reads 4 px for one pass and 1 px after, a
probe read after our own mutation.

Two consequences worth keeping in view. What is *ours* - whether a window is decorated, which style,
which insets we chose, the shadow's style - may be cached and decided on the debounced clock, because
it is an input to the drawing rather than an observation of it. What is *not* ours - the window's
frame and buffer rects, the actor's allocation, the surface container's box, the phase, the monitor
scale - must be read when it is used. And the only legitimate reuse of a previous value is the case
where the object has not changed, which is exactly why the settle helpers take "did the subject
itself change" rather than "is this value noisy".


## An externally rebuilt window is a rhythm to follow, not a fault to fix

The WeChat window is unmanaged and re-managed by the compositor once or twice a second: the journal
names `unmanaging` as the caller of our teardown, `winActor=gone` at that moment, and a new window id
on every return, while the X11 window id `xdotool` sees never moves. The window flashes on each
rebuild, and **it still flashes with the extension disabled**, so the rebuild is not ours and not
something to eliminate - what changes with the extension on is only what we contribute to those
frames.

Our obligation in that rhythm is one sentence: **be present in the frames the window is drawn in, and
absent from the frames where its object is not drawn.** The clip is installed on the pass the new
actor exists, never a pass later, because the pass after that is a frame the user has already looked
at. And nothing of ours may outlive the object it describes: a shadow kept for an actor that is gone
is a drawing of something that is not in the frame, which is the state-ownership rule applied to our
own output rather than to our reads.

The test that settles whether we honour it is a differential one: with the extension off and on, the
user-visible result must be the same apart from the decoration itself. Any difference that survives
that comparison is ours to fix.
