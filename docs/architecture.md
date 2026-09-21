# Architecture

One extension process that owns the windows, one preferences process that has none,
and a pure core shared by both. The core is where the decisions live, so they can be
tested without a session; the processes only gather inputs and apply results.

## Modules

| Module | Responsibility |
|---|---|
| `lib/clipTarget.js` | clip effect target resolution: selects window actor vs surface actor, skipping injected foreign widgets (e.g. Blur my Shell) and validating geometry (pure) |
| `lib/detector.js` | whether a window needs decoration, and whether a rule would change that (pure) |
| `lib/frame.js` | body-inside-actor geometry: `frameFromInsets`/`bodyFrame`/`insetsFromRects` (pure) |
| `lib/nativeLikeCorners.js` | shell-side probe: whether a window's corners already look like ours — an inference from the Adwaita look, consulted by the corner axis and by the resize band's eligibility |
| `lib/rules.js` | the window-kind rule model: keys, matching, sanitising (pure) |
| `lib/pick.js` | the picker's D-Bus contract and the dictionary it returns (pure) |
| `lib/style.js` | which decoration parameters a window state gets, and pipeline opacity modulation (pure) |
| `lib/settings.js` | GSettings IO adapter |
| `lib/resizeBand.js` | the window's resize band: four hit strips clipped to the monitor, plus `edgeForPoint()`, GTK's direction order (pure) |
| `lib/resizeBandActor.js` | the resize band actor: one reactive child per strip, direction from the pointer, hover cursor and resize grab |
| `lib/window.js` | shell-side identity gathering (`Shell.WindowTracker`, live window list) |
| `lib/manager.js` | state machine: window lifecycle, focus and display changes to effects |
| `lib/inspector.js` | the interactive window picker and its D-Bus service |
| `effects/` | rounded clipping (`clipEffect.js`), shadow actor geometry (`shadowActor.js`), and baked GPU shadow textures (`shadowTexture.js`, `shadowShader.generated.js`) |

## The two processes

- The **extension process** owns the windows. `manager.js` reconciles effects against
  window state; `inspector.js` serves the picker.
- The **preferences process** has no window objects at all. It reads and writes the
  rule store, and asks the extension over D-Bus which window the user clicked.

The picker is the only conversation between them: `inspector.js` implements
`PickWindow() -> a{ss}`, the prefs window calls it, and it refuses to create a rule
the extension reports as ineffective. `lib/pick.js` holds that contract so the prefs
process can speak it without importing shell-only code.

For the selection mechanics we followed KDE's KWin
(`InputRedirection::startInteractiveWindowSelection` with its `clientToVariantMap`)
and GNOME's own equivalent: `Main.pushModal`, `global.stage.set_cursor_type` and a
Clutter event grab.

## The extension lifecycle

`extension.js` is the entry point. `enable()` builds a `Manager`, calls `manager.enable()`
and creates the `InspectorService`; `disable()` destroys both and clears the `_manager`
field, which doubles as the idempotency guard (a second `enable()` returns early while it is
set).

`Manager.enable()` connects only the global signals a decoration input can change on —
`window-created`, `grab-op-end`, `restacked`, `notify::focus-window`,
`notify::high-contrast`, `monitors-changed` — plus `Main.overview`'s `showing` and `hidden`
signals to toggle clip effect suspension during overview mode, and deliberately no workspace
signal: no decoration input depends on the workspace, so switching workspaces cannot change any
window's appearance.

`enable()` sets that field before `manager.enable()`, so a failure after that point would
leave the guard set and make every later `enable()` return early; the catch therefore rolls
the half-enabled state back through `disable()` (relying on the teardown invariants below).
`disable()` clears the guard only as its last step, so a teardown that throws midway leaves
it set as well, and the only recovery is reloading the extension.

### Lifecycle ownership and invariants

Lifecycles strictly govern session boundaries and per-window teardown:
- **Session enable**: `Manager.enable()` re-arms sub-modules, resetting baked shadow texture caches
  and process classification state.
- **Session disable**: `Manager.disable()` guarantees zero resource leaks across session teardown
  (also invoked if `enable()` fails midway). Orphaned shadow actors and resize bands are swept
  from `global.window_group`, active rounded clip effects are removed from window actors, in-flight
  asynchronous process probes are cancelled (`Gio.Cancellable`), and baked shadow texture resources
  are destroyed.
- **Window close (phased teardown)**: When a window is unmanaged (`_forgetWindow`), interactive
  decorators (`ResizeBand`) are destroyed immediately to avoid blocking clicks, while visual
  decorators (`ShadowActor` and `RoundedClipEffect`) remain attached to fade alongside the
  window actor. Once the actor emits `destroy`, `ShadowActor` tears itself down cleanly and
  `RoundedClipEffect` is released alongside the actor.
- **Process cache eviction**: When a closing window is the last active window for its process,
  its cached classification entry is evicted via `forgetProcess(pid)`, keeping memory bounded
  across long sessions without clearing active sibling state.

## Actors

Every decorated window gets a `ShadowActor` inserted below the window actor in
`global.window_group`, drawing an 8-slice baked Cogl shadow texture (`effects/shadowTexture.js`)
with Clutter property and constraint bindings (`Clutter.BindConstraint`). It is cast by the window
body (`setShadowInsets()`), not by the actor, which for a client-decorated window also carries the ring
that client reserved for its own shadow. Both the shadow's cast rect and the clip's body are
computed from the actor's live size at paint time (`lib/frame.js`), so a resize never shows a
geometry the actor has already left. When there is something to clip, the window also gets a
`RoundedClipEffect` (`Shell.GLSLEffect` offscreen pass).
The clip effect's target actor is resolved via `resolveClipTarget` (`lib/clipTarget.js`):
by default it attaches directly to the window actor on Wayland and to the surface child actor
on X11 / XWayland (so coordinates align accurately and the frame ring can be cleared when taking over shadows);
when foreign extensions (e.g. Blur my Shell) inject an `St.Widget` inside the window actor, it safely
bypasses injected widgets to attach directly to the compatible surface actor so the blur effect remains functional.
The manager keeps one state record per window and reconciles add, remove and update on every
state change.

A resizable window that `decideResizeBand()` shows a band for also gets a `ResizeBand`
(`lib/resizeBandActor.js`), the only actor outside the window picker that takes input: a transparent container with
four reactive `St.Widget` children, one per side of the 12px ring (the top and bottom span the
full width, so the outward corners belong to them). The child only says where an event landed;
the direction is resolved from the pointer by `edgeForPoint()`, GTK's first-match order. The
container is inserted in `global.window_group` above its own window actor, so it never covers
another window or shell chrome, and `_restackActors()` re-pins it on `restacked` (the same
signal the shadow is pinned below its window on). Like the shadow it is bound to the window
actor (`Clutter.BindConstraint`, grown by 12px per side, the band's depth) and derives its
regions from the actor's live size in `vfunc_allocate`, from the insets and monitor rect the
manager stored; the debounced reconcile hands over those decisions - the eligibility, and the
relative insets - while the one absolute rectangle it needs, the monitor rect it clips to,
rides along with them, so a resize cannot leave the band behind. The container follows the
window actor's `visible` so a minimized window leaves no strip behind. Created and destroyed by
`_syncResizeBand()`; dropped in `_undecorate()` and, before the close animation, in
`_forgetWindow()` — a band that outlived its window would go on taking clicks.
See `decoration-model.md` § The resize band for why it exists and what it costs.

## Effects — RoundedClipEffect (`effects/clipEffect.js`)

The actor to clip is not the body: a CSD window's actor is body plus the shadow ring the
client painted (`buffer_rect - frame_rect`). The effect stores the ring as per-side insets and
computes the body in `vfunc_paint_target` from the actor's live width/height
(`bodyFrame`), then removes only the four corner caps that lie inside the body's
square bounds. Geometry is thus read in the paint that uses it, after Clutter has sized the
offscreen; `setParams` carries the decisions (insets, radius, outline, clearRing) and may stay
debounced. Nothing in the paint calls `queue_repaint`. A degenerate actor (width or height
≤ 0) skips the pass: the shadow comes from the same actor, so there is no visible body to
leave square. A degenerate *body*, though - insets that outrun the actor for the frame a
resize passes through - does not: `bodyFrame` falls back to the whole actor, so the pass
still runs and the window content is never dropped. `inSquare = 1 - max(step(bodyEdge))` keeps
the client-painted ring intact; `uClearRing` blends that mask away when the shadow is ours
(see `decoration-model.md`: ring cleared exactly when shadow is ours).

Shader SDF: `d = sdRoundedBox(p - frameCenter, frameHalf, uRadius)` — `d < 0` inside body,
`d > 0` in removed corners, `d == 0` on boundary. Anti-alias: `corner = 1 - clamp(d+0.5)`,
`keep = min(corner + 1 - inSquare, 1)`, final `mix(keep, corner*inSquare, uClearRing)`.
Inner 1px outline: `m = clamp(1.5+d)*inSquare*uOutline.a*cogl_color_in.a`. The ring is one
logical pixel wide and centred half a pixel inside the body (`d in [-1.5,-0.5]`), which is
where the `d = -0.5` pixel centre of the innermost body pixel sits; `1+d` centred it on the
boundary instead and rendered that pixel at half strength (measured, with the reasoning, in
`decoration-alignment.md`).
`uOutline` is `rgb in [0,1], a in [0,1]`; `a == 0` disables it. Its color is normalized
from `0..255` to `0..1` on upload. Radius 0 means square body — used when a reversed shadow axis
clears the ring without rounding.

Clutter enlarges the offscreen by `FBO_OFFSET` and `FBO_EXTRA` (what those pixels are, and
the measured split, are in `decoration-alignment.md`). The shader computes
`quadSize = uSize + FBO_EXTRA` and `frameCenter = uFrame.xy + uFrame.zw*0.5 + FBO_OFFSET`.

Upload cost: `setParams` deduplicates decoration decisions (radius, outline, clearRing) and
queues a repaint only on change. During paint, live geometry is guarded by dirty checks,
synchronising only when dimensions or frame insets actually shift. Static repaints therefore
incur no uniform uploads, and dynamic resizing avoids redundant pipeline state changes.
See `FBO_OFFSET`/`FBO_EXTRA` in `DECLARATIONS` for the FBO constants.

During GNOME Shell overview mode, `RoundedClipEffect` is suspended (`set_enabled(false)`)
to prevent aliasing artifacts on downscaled window previews; newly created windows inherit
the suspended state until overview exit.

During window close transitions, Clutter property bindings (opacity, scale, transform) keep
`ShadowActor` synchronized with `windowActor` until actor destruction, preventing jarring shadow
popping mid-transition.

## Effects — Shadow baking and slicing (`effects/shadowTexture.js`)

Why eight slices describe a shadow, and why the middle stays empty, is the model in
`decoration-model.md`. One baked `buffer x buffer` texture per style
is shared by all windows of that style. The bake runs the GLSL from
`shadowShader.generated.js` (generated by `tools/gen-shader.mjs` from GTK4's
`gskgpuboxshadow.glsl`), so it stays the upstream shadow, not a second rendering.

Canonical bake window: square `2*(pad+radius)` — leaves a straight middle `2*pad` which
exceeds the blur reach, so a strip from the middle is a settled profile. Geometry
(`shadowGeometry`):
`corner = SHADOW_PAD + radius`, `window = 2*corner`, `buffer = 2*corner + 2*SHADOW_PAD + BAKE_EXTRA`.
`SHADOW_PAD` is generated (`ADWAITA_STYLE.shadowPad`, `tools/gen-style.mjs`): the farthest
Gaussian reach over every shadow set — `3 * 0.5 * blur + spread`, i.e. `3σ` with
`σ = blur/2`, 26px for the largest layer — plus the 2px Cogl offscreen offset
(`EFFECT_PADDING_ORIGIN`, see below). All sizes in logical px.

Slicing (`shadowSlices`): 8 rects (4 corners 1:1, 4 edges stretched from a 1px strip), no
middle — the interior is the hollow mask of `decoration-model.md`.
A window smaller than `2*corner` scales corners down (`c = min(corner, w/2, h/2)`),
which is the correct shape when the window is all corner. Tex coords are normalized
(`1/buffer`). The edge strip is taken from the middle of the canonical edge
(`edge = (BAKE_ORIGIN + SHADOW_PAD + window/2)/buffer`), not at the corner boundary:
the corner pulls the profile tighter for ~3σ along its edge, so sampling at the
boundary would make the stretched edge darker and shorter.

The shader quad is `FBO_EXTRA` wider than the padded rect and offset by `FBO_OFFSET`, which
is where `BAKE_ORIGIN` (`2px` top/left) and `BAKE_EXTRA` (`3px` total per axis) come from.
Both are Cogl's `_clutter_actor_box_enlarge_for_effects`, vendored at
`vendor/mutter/clutter-actor-box.c` and parsed by `tools/gen-clutter.mjs` into
`clutterEffectPadding.generated.js`; `shadowTexture.js` and `clipEffect.js` read that one
generated source at runtime, while `gen-shader.mjs` and `gen-style.mjs` read it at
generation time to bake the constants, instead of each writing 2/3 by hand.
Only the `3px` per-axis total is an upstream literal — it covers up to 1.75px on the
bottom/right while leaving >0.75px on the top/left. The `2px` top/left **origin is derived**,
not a literal: it is what `box->x1 - (ceilf (box->x2 + 0.75f) - width - 3)` yields on an
integer-aligned box. The 2/1 split therefore only holds when the box is integer-aligned;
the per-axis total stays 3. `tools/gen-shader.mjs` also carries `SNAP_BLEED`, whose
measured role in hiding subpixel seams is in `decoration-alignment.md`.

Caching (`pipelines`): a map from `styleKey(radius, shadows)` — which joins
`blur,spread,alpha` per layer — to a baked pipeline. A window gets its own
`Cogl.Pipeline` sharing the baked texture (`shadowPipelineFor`) so cross-fade can
animate per-window opacity via `setPipelineOpacity`. Scaling alpha is enough because
the pipeline colour stays opaque white and Cogl's blend is premultiplied: the baked
shadow's RGB scales with it, so no colour has to change.
A bake that fails to allocate is not cached, so the next paint retries. `destroy()`
seals the cache for `disable()`; `reset()` re-arms for a new cycle.

Bake steps (`bake()`): allocate `buffer x buffer` texture +
offscreen, set `opaqueWhite` (pipeline color must stay opaque — shader alpha does
opacity), add snippet `DECLARATIONS+CODE`, which replaces the fragment stage's tail
(the same non-replacing form the shell's GLSL effect uses) rather than standing as a
program of its own, upload `uWinSize/uRadius/uPad/uShadow1..3`,
use a 1px placeholder layer for `cogl_tex_coord0_in`, orthographic `buffer`,
`clear4f(CLEAR_COLOR_BUFFER,0,0,0,0)` (driver texture is not zeroed; hollow mask
skips interior writes, so uncleared pixels would show through rounded corners),
`draw_textured_rectangle` + `flush`, then wrap texture in a drawing pipeline.

Cogl uniform setter probes two GJS signatures once per session:
`set_uniform_float(loc, n, 1, values)` vs `set_uniform_float(loc, n, values)`
(`uniform()`).

## Effects — ShadowActor (`effects/shadowActor.js`)

One `ShadowActor` per decorated window, sibling below `windowActor` in
`global.window_group`. Four `Clutter.BindConstraint`s sync the padded rect
(`x -SHADOW_PAD, y -SHADOW_PAD, w+2*PAD, h+2*PAD`) and seven `bind_property`s
(`opacity, visible, pivot-point, scale-x/y, translation-x/y` via `GObject.BindingFlags.SYNC_CREATE`)
carry map/close/minimize animations with no JS per frame. Inserted with
`container.insert_child_below(shadow, windowActor)`.

Shadow is cast by the body, not the actor: `setShadowInsets(insets)` stores the ring
(`buffer_rect - frame_rect`) per side; null insets mean the whole actor. `_castRect()` computes
`bodyFrame(this.width/height, insets)` from the actor's live size on every paint, so
`cast = body + PAD on every side` tracks a resize frame by frame; the actor itself sits at
`-PAD` from the window actor, so cast is `body` shifted by zero then grown.
`shadowSlices(shadowGeometry(radius), cast.w, cast.h)` yields dest boxes and normalized sources;
sources never change. `_relayout` caches `slices/boxes/cast` per style and recomputes them when
cast changes — eight small rects per frame during a drag, which is the cost the live geometry
buys.

Paint (`vfunc_paint_node`): obtains `Cogl.Context` from the framebuffer (only exists
inside paint), gets `Cogl.Pipeline` via `_pipelineFor` (lazy `shadowPipelineFor`),
then adds a `Clutter.PipelineNode` with eight `add_texture_rectangle`s. Opacity is
set via `setPipelineOpacity` (0..1, converted internally to 0-255 alpha), modulating style transition weights via
`pipelineOpacityFor(weight, this.get_paint_opacity() / 255)` (culled early if `<= 0`
for zero overdraw, settling any completed outgoing fade first) so window close/minimize
fade animations (propagated via `bind_property`) smoothly fade the shadow with zero
per-frame JS timers.

The style (and therefore the baked texture) still changes only on a decision: `styleKey` ignores
the window size, so a resize never re-bakes, and the actor is not rebuilt. What runs per frame
is the offscreen window pass (the clip) plus these eight textured rectangles; this change buys
correctness and less per-frame JS reconcile, not an order-of-magnitude cheaper redraw.

Style change cross-fades (the transition and why nothing resizes are the model in
`decoration-model.md`, *How a style change is drawn*). The fade is driven at
`FADE_STEP_MS = 16ms` (~60fps) with `GLib.timeout_add`,
Stepping `bezier(t, EASE_OUT)` solved by four Newton iterations. Mid-fade arrival keeps
whichever side is more visible (`_progress >= 0.5`) as outgoing and carries its weight
(`keptWeight = progress` or `(1-progress)*outgoing.weight`), so a burst of focus
changes reads as one motion, never a pop.

Lifecycle: `destroy()` removes `GLib.Source`, unbinds, disconnects `windowActor::destroy`,
clears style/outgoing and removes from container — idempotent for disable/reload.
`FADE_MS` and `EASE_OUT` are both read from the generated `ADWAITA_STYLE.transition`
(libadwaita `$backdrop_transition` = `200ms ease-out`); only `FADE_STEP_MS` is local. See
`_relayout` for the relayout cache.

## Preferences (`src/prefs.js`)

`prefs.js` runs in the preferences process with no window actors. It reads/writes
`window-rules` via `lib/settings.js` and calls the extension over D-Bus (`PickWindow`).
Axis names, axis corrections and type nouns are thunks (`() => _('...')`) because the module
loads before the prefs process binds the gettext domain — a plain `_()` would capture the
untranslated string (`AXIS_NAMES`, `AXIS_CORRECTIONS`, `WINDOW_TYPE_NOUNS`).

Each rule is an `Adw.ExpanderRow`: the header names the app, the subtitle the kind
sentence, the suffix one bundled icon per **corrected** axis (`src/icons/`, drawn on the GNOME
symbolic grid from one window: its rounded corner, the shadow it casts, the resize cursor's
arrow; registered on a bare icon-theme search path as `*-symbolic` so recoloring applies
without an `index.theme`, in the row's own foreground). The delete button is a
header suffix left of the expander arrow - `ExpanderRow` prepends suffixes to keep its arrow
last, so siblings are added in reverse visual order - spaced apart from the icon group. The
expanded body carries one `Adw.SwitchRow` per axis, titled with the correction it makes
("Correct corners"; an unavailable axis shows its reason across the full suffix width
instead) - conditions are not repeated per line, and the group description says what the
switches do.

`windowKindSentence` names all seven structural attributes of a rule key (and folds
`has_parent`/`attached_dialog` into one phrase; the frame clause carries `has_ring` and
`has_ssd`, which cannot both describe a window we read); see `docs/rule-model.md` for the full grammar. `asMarkup` escapes text for `Adw.PreferencesGroup`/`ActionRow`
(Pango markup); `Adw.Toast`/`AlertDialog` and bare `Gtk.Label` take plain text.

The rule list shows a count in the group title so the group need not be opened to
know it has items. Rows are destroyed from within their own signal handlers,
so rebuild is deferred to `GLib.PRIORITY_DEFAULT_IDLE`; one pending idle is enough
because it reads the rules when it runs. The prefs window may be hidden for the
modal picker and still be closed — `windowAlive` guards the D-Bus reply. An empty
reply means cancelled/abandoned pick and is silent; a missing suggestion (a Shell that has
not reloaded since an update) is refused with its own toast, because there is no correction
to apply. Writes are verified (`hasOwnProperty`) before claiming success.
Translator note in `windowKindSentence()` explains why the sentence template is the
translatable unit and fragments are translated separately.
