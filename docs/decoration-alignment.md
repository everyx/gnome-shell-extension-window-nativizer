# Aligning the decoration with libadwaita

The decoration is meant to be indistinguishable from libadwaita's client-side decoration.
This is what that means numerically, how it was measured, what is known, and what is still
open. It exists because the knowledge below cost a great deal to acquire and is not visible
anywhere in the code.

## What is being aligned

libadwaita draws `window.csd` as a rounded rectangle with `box-shadow` and a 1px outline; the
values are generated into `src/lib/adwaitaStyle.generated.js`. Mutter's own X11 window shadows
are **not** the model (they are cached per focus state and swapped with no transition); they
are recorded in `decoration-model.md` as a contrast.

Two things are drawn, and they have different mechanisms:

| Part | Where it lives | Notes |
| --- | --- | --- |
| Rounded clip + inner outline | `RoundedClipEffect` on the window actor (surface actor on X11) | skipped entirely under some settings, see below |
| Shadow | `WindowNativizerShadowActor` (`ShadowActor`), a **sibling** of the window actor | one baked 145x145 texture per style, 8-slice (why eight describe the shape: `decoration-model.md`); only where we paint it — SSD keeps the frames-client shadow, bare X11 keeps Mutter's |

Because our shadow is a sibling and the clip is an effect, a window-scoped screenshot
(`ScreenshotWindow`) can never contain the shadow. Only a full-desktop screenshot shows both.

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
shadow pixel is a 1px border ring (`0 0 0 1px rgba(0,0,0,0.15)`, which the generated style has
as `shadows: [{blur: 0, spread: 1, alpha: 0.15}]`).

## The setting that silently disables half of this

`prefer-crisp-text` (default false) plus a fractional-scale monitor means
`shouldClipWindow()` returns false and **no clip effect is attached at all**: square corners,
no inner outline, and the shadow is baked against a square outline instead. On the machine
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
  right/bottom for an integer position — and the whole box is then multiplied by
  `ceilf(resource_scale)`, which is **2** for a 1.3333 monitor, not 1.3333.
- `clutter_offscreen_effect_paint_texture` applies `1/resource_scale` and the `fbo_offset`
  in one matrix. Read the order in Graphene rather than assuming it.
- Measured live values for a 440x280 window: `w=440.0000 h=280.0000`, `pad=2.0000,2.0000`,
  `target=[true, 886, 566]` (= (440+3)x(280+3) at 2x).
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
- **Confirmation**: The underlying shader distance `d` is mathematically centered and
  four-way symmetric. In native libadwaita, decorations are rendered entirely within the
  client's own Wayland surface via GTK4/GSK; in Window Nativizer, the window content and shadow
  live on separate Mutter Clutter actors, subject to Mutter's offscreen clipping and
  fractional blitting.
- **Trade-off**: When `prefer-crisp-text` is enabled, `RoundedClipEffect` is deliberately omitted
  under fractional scaling to avoid resampling blur on client window content.

### 2. First shadow pixel darkness (185 vs native 198-200)

Originally, Window Nativizer's first shadow pixel measured 185 (about 13-14 grey levels darker
than native's ~199). Two factors contributed to this:

1. **Layer 3 outline mask**: CSS defines the 1px ring as an outset border
   (`0 0 0 1px rgba(0,0,0,0.05)`). In the shader, `blur < 0.5` was evaluated as a solid
   disc (`alpha * (1.0 - clamp(d - spread + 0.5, 0.0, 1.0))`). Because `SNAP_BLEED = 0.8`
   extends the shadow mesh inward under the window to prevent subpixel floating-point seams
   between the window actor and the shadow actor, a solid disc contributed alpha even under
   the window edge and at the first boundary pixel.
2. **Layer compositing**: Multiple shadow layers were previously combined with linear
   arithmetic addition (`a = a1 + a2 + a3`). Native GSK render nodes composite overlapping
   layers via **Alpha-Over** (`1.0 - (1.0 - a1) * (1.0 - a2) * (1.0 - a3)`), preventing
   artificial saturation where blur tails overlap.

### Resolution: Hollow Outset Border & Alpha-Over

In `tools/gen-shader.mjs`:
- Layer 3 is evaluated as a hollow outset band between `d=0` and `d=spread`:
  ```glsl
  float inner = clamp(d + 0.5, 0.0, 1.0);
  float outer = clamp(d - spread + 0.5, 0.0, 1.0);
  return alpha * max(inner - outer, 0.0);
  ```
- Layer alpha is composited using alpha-over:
  ```glsl
  float a = (1.0 - (1.0 - a1) * (1.0 - a2) * (1.0 - a3)) * clipAlpha;
  ```
- `SNAP_BLEED = 0.8` is retained, guaranteeing zero risk of subpixel white gaps under
  fractional scaling.

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
| **0 (outline)** | **9** | **18** | -9 | 1px inner outline (G channel over Red body) |
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

### Automated Benchmark Tool

To measure the current decoration against this baseline and prevent visual regressions:

```bash
pnpm run benchmark          # Print full comparison report against golden baseline
pnpm run benchmark:check    # exit 1 if deviation > 1 grey level
```

Source: `tools/benchmark-decoration.py`.
