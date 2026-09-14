# Architecture

One extension process that owns the windows, one preferences process that has none,
and a pure core shared by both. The core is where the decisions live, so they can be
tested without a session; the processes only gather inputs and apply results.

## Modules

| Module | Responsibility |
|---|---|
| `lib/detector.js` | whether a window needs decoration, and whether a rule would change that (pure) |
| `lib/frame.js` | body-inside-actor geometry: `frameFromInsets`/`insetsFromRects` (pure) |
| `lib/nativeLikeCorners.js` | shell-side probe: whether a window's corners already look like ours — an inference from the Adwaita look, consulted only by the corner axis |
| `lib/rules.js` | the window-kind rule model: keys, matching, sanitising (pure) |
| `lib/pick.js` | the picker's D-Bus contract and the dictionary it returns (pure) |
| `lib/style.js` | which decoration parameters a window state gets (pure) |
| `lib/settings.js` | GSettings IO adapter |
| `lib/resizeBand.js` | the window's resize band as twelve rectangles, clipped to the monitor (pure) |
| `lib/resizeBandActor.js` | the resize band actor: one reactive child per region, hover cursor and resize grab |
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
`notify::high-contrast`, `monitors-changed` — and deliberately no workspace signal: no
decoration input depends on the workspace, so switching workspaces cannot change any
window's appearance.

`enable()` sets that field before `manager.enable()`, so a failure after that point would
leave the guard set and make every later `enable()` return early; the catch therefore rolls
the half-enabled state back through `disable()`. `disable()` clears the guard only as its
last step, so a teardown that throws midway leaves it set as well, and the only recovery is
reloading the extension.

## Actors

Every decorated window gets a `ShadowActor` inserted below the window actor in
`global.window_group`, drawing an 8-slice baked Cogl shadow texture (`effects/shadowTexture.js`)
with Clutter property and constraint bindings (`Clutter.BindConstraint`). It is cast by the window
body (`setShadowInsets()`), not by the actor, which for a client-decorated window also carries the ring
that client reserved for its own shadow. Both the shadow's cast rect and the clip's body are
computed from the actor's live size at paint time (`lib/frame.js`), so a resize never shows a
geometry the actor has already left. When there is something to clip, the window also gets a
`RoundedClipEffect` (`Shell.GLSLEffect` offscreen pass).
On Wayland, the clip effect attaches directly to the window actor; on X11 / XWayland, it attaches
to the surface child actor (`actor.get_first_child()`) so the native / frames-client drop shadow is preserved
and coordinates align accurately.
The manager keeps one state record per window and reconciles add, remove and update on every
state change.

A resizable window that passes `shouldShowResizeBand()` also gets a `ResizeBand`
(`lib/resizeBandActor.js`), the only actor here that takes input: a transparent container with
twelve reactive `St.Widget` children, one per region of the band (12px edges stopping 24px
short of each corner, each corner split into its two 24px edge reaches). The
container is inserted in `global.window_group` above its own window actor, so it never covers
another window or shell chrome, and `_restackActors()` re-pins it on `restacked` (the same
signal the shadow is pinned below its window on). Like the shadow it is bound to the window
actor (`Clutter.BindConstraint`, grown by 12px per side, the band's depth) and derives its
regions from the actor's live size in `vfunc_allocate`, from the insets and monitor rect the
manager stored; the debounced reconcile hands over those decisions, never absolute pixel
geometry, so a resize cannot leave the band behind. The container follows the window actor's
`visible` so a minimized window leaves no strip behind. Created and destroyed by
`_syncResizeBand()`; dropped in `_undecorate()` and, before the close animation, in
`_forgetWindow()` — a band that outlived its window would go on taking clicks.
See `decoration-model.md` § The resize band for why it exists and what it costs.

## Effects — RoundedClipEffect (`effects/clipEffect.js`)

The actor to clip is not the body: a CSD window's actor is body plus the shadow ring the
client painted (`buffer_rect - frame_rect`). The effect stores the ring as per-side insets and
computes the body in `vfunc_paint_target` from the actor's live width/height
(`frameFromInsets`), then removes only the four corner caps that lie inside the body's
square bounds. Geometry is thus read in the paint that uses it, after Clutter has sized the
offscreen; `setParams` carries the decisions (insets, radius, outline, clearRing) and may stay
debounced. Nothing in the paint calls `queue_repaint`. A degenerate actor (width or height
≤ 0) skips the pass: the shadow comes from the same actor, so there is no visible body to
leave square. `inSquare = 1 - max(step(bodyEdge))` keeps the client-painted ring
intact; `uClearRing` blends that mask away when the shadow is ours (see
`decoration-model.md`: ring cleared exactly when shadow is ours).

Shader SDF: `d = sdRoundedBox(p - frameCenter, frameHalf, uRadius)` — `d < 0` inside body,
`d > 0` in removed corners, `d == 0` on boundary. Anti-alias: `corner = 1 - clamp(d+0.5)`,
`keep = min(corner + 1 - inSquare, 1)`, final `mix(keep, corner*inSquare, uClearRing)`.
Inner 1px outline: `m = clamp(1.5+d)*inSquare*uOutline.a*cogl_color_in.a`. The ring is one
logical pixel wide and centred half a pixel inside the body (`d in [-1.5,-0.5]`), which is
where the `d = -0.5` pixel centre of the innermost body pixel sits; `1+d` centred it on the
boundary instead and rendered that pixel at half strength (measured, with the reasoning, in
`decoration-alignment.md`).
`uOutline` is `rgb in [0,1], a in [0,1]`; `a == 0` disables it. Its color is normalized
from `0..255` to `0..1` on upload. Radius 0 means square body — used by the `shadow` rule to
clear the ring without rounding.

Clutter enlarges the offscreen by `FBO_OFFSET` and `FBO_EXTRA` (what those pixels are, and
the measured split, are in `decoration-alignment.md`). The shader computes
`quadSize = uSize + FBO_EXTRA` and `frameCenter = uFrame.xy + uFrame.zw*0.5 + FBO_OFFSET`.

Upload cost: `setParams` deduplicates the decisions (insets, radius, outline, clearRing) and
`queue_repaint`s only when one changes, so the debounced reconcile is cheap. The paint then
uploads five uniforms per frame, which is what reading live geometry costs;
`set_uniform_float` dirties Cogl pipeline state but does not schedule a frame (the paint is
already running). See `FBO_OFFSET`/`FBO_EXTRA` in `DECLARATIONS` for the FBO constants.

## Effects — Shadow baking and slicing (`effects/shadowTexture.js`)

Why eight slices describe a shadow, and why the middle stays empty, is the model in
`decoration-model.md`. One baked `buffer x buffer` texture per style
is shared by all windows of that style. The bake runs the GLSL from
`shadowShader.generated.js` (generated by `tools/gen-shader.mjs` from GTK4's
`gskgpuboxshadow.glsl`), so it stays the upstream shadow, not a second rendering.

Canonical bake window: square `2*(pad+radius)` — leaves a straight middle `2*pad` which
exceeds the blur reach, so a strip from the middle is a settled profile. Geometry
(`shadowGeometry`):
`corner = SHADOW_PAD + radius`, `window = 2*corner`, `buffer = 2*corner + 2*SHADOW_PAD + 3`.
`SHADOW_PAD = 28` covers max blur 14 (3σ=21) + spread 5. All sizes in logical px.

Slicing (`shadowSlices`): 8 rects (4 corners 1:1, 4 edges stretched from a 1px strip), no
middle — the interior is the hollow mask of `decoration-model.md`.
A window smaller than `2*corner` scales corners down (`c = min(corner, w/2, h/2)`),
which is the correct shape when the window is all corner. Tex coords are normalized
(`1/buffer`). The edge strip is taken from the middle of the canonical edge
(`edge = (BAKE_ORIGIN + SHADOW_PAD + window/2)/buffer`), not at the corner boundary:
the corner pulls the profile tighter for ~3σ along its edge, so sampling at the
boundary would make the stretched edge darker and shorter.

The shader quad is `FBO_EXTRA` wider than the padded rect and offset by `FBO_OFFSET`, which
is where `BAKE_ORIGIN` comes from. `tools/gen-shader.mjs` also carries `SNAP_BLEED`, whose
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
`frameFromInsets(this.width/height, insets)` from the actor's live size on every paint, so
`cast = body + PAD on every side` tracks a resize frame by frame; the actor itself sits at
`-PAD` from the window actor, so cast is `body` shifted by zero then grown.
`shadowSlices(shadowGeometry(radius), cast.w, cast.h)` yields dest boxes and normalized sources;
sources never change. `_relayout` caches `slices/boxes/cast` per style and recomputes them when
cast changes — eight small rects per frame during a drag, which is the cost the live geometry
buys.

Paint (`vfunc_paint_node`): obtains `Cogl.Context` from the framebuffer (only exists
inside paint), gets `Cogl.Pipeline` via `_pipelineFor` (lazy `shadowPipelineFor`),
then adds a `Clutter.PipelineNode` with eight `add_texture_rectangle`s. Opacity is
set via `setPipelineOpacity` (alpha 0-255).

The style (and therefore the baked texture) still changes only on a decision: `styleKey` ignores
the window size, so a resize never re-bakes, and the actor is not rebuilt. What runs per frame
is the offscreen window pass (the clip) plus these eight textured rectangles; this change buys
correctness and less per-frame JS reconcile, not an order-of-magnitude cheaper redraw.

Style change cross-fades (the transition and why nothing resizes are the model in
`decoration-model.md`, *How a style change is drawn*). The fade is driven at
`FADE_STEP_MS = 16ms` (~60fps) with `GLib.timeout_add`,
stepping `bezier(t, EASE_OUT)` solved by four Newton iterations. Mid-fade arrival keeps
whichever side is more visible (`_progress >= 0.5`) as outgoing and carries its weight
(`keptWeight = progress` or `(1-progress)*outgoing.weight`), so a burst of focus
changes reads as one motion, never a pop.

Lifecycle: `destroy()` removes `GLib.Source`, unbinds, disconnects `windowActor::destroy`,
clears style/outgoing and removes from container — idempotent for disable/reload.
See `FADE_MS`, `EASE_OUT` and `FADE_STEP_MS` for the fade constants and `_relayout` for the
relayout cache.

## Preferences (`src/prefs.js`)

`prefs.js` runs in the preferences process with no window actors. It reads/writes
`window-rules` via `lib/settings.js` and calls the extension over D-Bus (`PickWindow`).
State labels and type nouns are thunks (`() => _('...')`) because the module loads
before the prefs process binds the gettext domain — a plain `_()` would capture the
untranslated string (`STATE_LABELS`, `WINDOW_TYPE_NOUNS`).

`windowKindSentence` names all five structural attributes of a rule key (and folds
`has_parent`/`attached_dialog` into one phrase); see `docs/rule-model.md` for the
full grammar. `asMarkup` escapes text for `Adw.PreferencesGroup`/`ActionRow`
(Pango markup); `Adw.Toast`/`AlertDialog` and bare `Gtk.Label` take plain text.

The rule list shows a count in the group title so the group need not be opened to
know it has items. Rows are destroyed from within their own signal handlers,
so rebuild is deferred to `GLib.PRIORITY_DEFAULT_IDLE`; one pending idle is enough
because it reads the rules when it runs. The prefs window may be hidden for the
modal picker and still be closed — `windowAlive` guards the D-Bus reply. An empty
reply means cancelled/abandoned pick and is silent; a missing suggestion falls
back to `both`. Writes are verified (`hasOwnProperty`) before claiming success.
Translator note in `windowKindSentence()` explains why the sentence template is the
translatable unit and fragments are translated separately.
