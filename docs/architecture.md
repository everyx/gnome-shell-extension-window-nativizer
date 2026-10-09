# Architecture

One extension process that owns the windows, one preferences process that has none,
and a pure core shared by both. The decisions live in the core, so they can be
tested without a session; the processes only gather inputs and apply results.

## Modules

| Module | Responsibility |
|---|---|
| `lib/clipTarget.js` | clip target resolution: window actor vs surface actor, skipping injected foreign widgets (e.g. Blur my Shell) and validating geometry |
| `lib/detector.js` | whether a window needs decoration, and whether a rule would change that (pure) |
| `lib/frame.js` | body-inside-actor geometry (pure) |
| `lib/nativeLikeCorners.js` | process classification: asynchronous `/proc/<pid>/maps` inspection and caching for native Adwaita providers and GTK4 clients |
| `lib/rules.js` | the window-kind rule model: keys, matching, sanitising, and canonical rule evaluation (pure) |
| `lib/pick.js` | the picker's bus name/path and property dictionary |
| `lib/snap.js` | grid snapping math and the 8-slice geometry layout (pure) |
| `lib/style.js` | which decoration parameters a window state gets (pure) |
| `lib/settings.js` | GSettings IO adapter |
| `lib/resizeBand.js` | the resize band's hit strips and GTK's direction order (pure) |
| `lib/resizeBandActor.js` | the resize band actor: one reactive child per strip, direction from the pointer, hover cursor and resize grab |
| `lib/window.js` | reading `Meta.Window` properties, actor discovery, physical monitor scale, and geometry normalization |
| `lib/windowDecoration.js` | single-window decoration lifecycle: the tri-axis actors, phased teardown, and the read-only state view |
| `lib/manager.js` | high-level orchestrator: global signal routing, focus/overview changes, decoration lifecycle, and the inspection surfaces |
| `lib/inspector.js` | the interactive window picker and its D-Bus service |
| `effects/shadowFade.js` | cubic-bezier transition curves and the interrupted cross-fade state machine (pure) |
| `effects/` | rounded clipping, shadow geometry, the shadow actor, and baked GPU shadow textures |
| `compat/` | zero-side-effect ponyfills bridging compositor watersheds (shader effects, grab ops, actor cursors) across GNOME 45–51 |

## The two processes

- The **extension process** owns the windows. The manager reconciles effects against
  window state; the inspector serves the picker.
- The **preferences process** has no window objects at all. It reads and writes the
  rule store, and asks the extension over D-Bus which window the user clicked.

The picker is the only conversation between them: the extension exposes a `PickWindow`
method, the prefs window calls it, and it refuses to create a rule the extension reports as
ineffective. Both sides share one property wire format, so a change to it is a change to
both.

For the selection mechanics we followed KDE's KWin
(`InputRedirection::startInteractiveWindowSelection` with its `clientToVariantMap`)
and GNOME's own equivalent: `Main.pushModal`, a stage cursor and a Clutter event grab.

### Interactive pick & highlight geometry

When hovering over windows during a pick, the picker highlights the target:

- **Target bounding box**: the window's frame rect, outset by the border stroke width, rather
  than the actor's allocation. A Wayland CSD actor's allocation includes the invisible client
  shadow margins, which would leave the highlight floating in empty space (as Looking Glass
  does); the outset also stops St's inward border drawing from eroding into client content.
- **Concentric corner radius**: a rounded window's highlight keeps $R_{outer} = R_{inner} + W$ so
  the stroke stays uniform around the corners. Tiled, maximized and fullscreen windows strictly
  keep square corners; an SSD window keeps the radius of the clip it is actually wearing.
- **Active clip vs. ring clearing**: a window may carry a clip effect purely to erase a
  client-painted frame ring at radius 0, which must not be read as active corner rounding.
- **Styling**: the highlight's 2px border and fill come from the Shell's own pickers - the
  Looking Glass picker and the screenshot window selector - and `vendor/gnome-shell/README.md`
  records which is which and why the border does not follow the selector's 6px.

## The extension lifecycle

`extension.js` is the entry point. Enabling builds the manager and the inspector; disabling
tears both down. The manager field doubles as the idempotency guard - a second enable returns
early while it is set - and is dropped in a `finally`, so a teardown that throws midway still
lets a later enable run rather than wedging on a stale manager.

The manager connects only the shell signals a decoration input can change on, plus the
overview's show/hide transitions (which switch to hardware mipmapping and suppress the inner
outline, keeping the corners), and deliberately no workspace signal: no decoration input
depends on the workspace, so switching workspaces cannot change any window's appearance.

The guard is set before the manager starts, so a failure after that point would otherwise wedge
every later enable; the catch rolls the half-enabled state back through the normal teardown.

### Lifecycle ownership and invariants

Lifecycles strictly govern session boundaries and per-window teardown:

- **Session enable** re-arms the sub-modules, resetting the baked shadow caches and the process
  classification state.
- **Session disable** guarantees zero resource leaks (it is also the rollback if enable fails
  midway): orphaned shadow actors and resize bands are swept from the window group, clip effects
  are detached from their actors, in-flight process probes are cancelled, and the baked shadow
  resources are destroyed.
- **Window close** is a phased teardown: interactive decorators (the resize band) are destroyed
  immediately so they cannot keep taking clicks, while the visual decorators (shadow and clip)
  stay attached to fade with the closing actor and release themselves when it is destroyed.
- **Process cache eviction**: when a closing window was the last active window of its process,
  its classification entry is dropped, keeping memory bounded across long sessions without
  disturbing live siblings.

## Actors

A window we draw a shadow or the tiled ring for gets a shadow actor inserted below the window
actor in `global.window_group`, drawing an 8-slice baked texture under Clutter constraints. It
is cast by the window body, not by the actor - for a client-decorated window the actor also
carries the ring the client reserved for its own shadow. Both the shadow's cast rect and the
clip's body are computed from the actor's live size at paint time, so a resize never shows a
geometry the actor has already left.

To prevent fractional-scaling subpixel seams and blurring, both the shadow tiles and the clip
boundary align to GTK 4.24's physical device-pixel grid:

- **Physical scale resolution**: Mutter's actor resource scale is integer-ceil'd at the C level
  and reports integer scales on fractional displays. The compositor hierarchy is climbed to the
  toplevel window (even through child surface containers under X11 or third-party extensions) to
  query the true fractional monitor scale.
- **Actor-local snapping**: snapping is deliberately confined to the actor-local coordinate
  space. Cutlines stay geometrically invariant while the window moves, leaving stage translation
  entirely to the GPU transform. The trade-off is a subpixel phase offset on stage, in exchange
  for eliminating subpixel shimmering/crawling and hot-path allocations during drags.
- **Multi-monitor cache isolation**: a window can be rendered across displays of differing DPI,
  so snapped shadow boxes are cached per physical scale to prevent cache thrashing.
- **Device-grid clip boundary**: the clip's body snaps to the same grid the shadow cutlines use,
  so the two share one grid and no subpixel seam appears between them. When a foreign extension
  injects an intermediate widget into the window hierarchy, the target resolver bypasses it to
  attach directly to the compatible surface.

A resizable window the band decision draws for also gets a resize band - the only actor outside
the window picker that takes input: a transparent container with four reactive strips, one per
side of the 12px ring (the top and bottom span the full width, so the outward corners belong to
them). A strip only says where an event landed; the direction is resolved from the pointer in
GTK's first-match order. The container is inserted above its window actor so it never covers
another window or shell chrome, is re-pinned on restack (the same signal the shadow is pinned
below its window on), is bound to the window actor and grown by the band's depth, and derives
its regions from the actor's live size, so a resize cannot leave it behind. It follows the
window actor's visibility so a minimized window leaves no strip behind, and it is dropped before
the close animation - a band that outlived its window would go on taking clicks. See
`decoration-model.md` § The resize band for why it exists and what it costs.

## Effects — the rounded clip

**Clip the body, not the actor.** A CSD actor is the body plus the shadow ring the client
painted, so the effect stores that ring as per-side insets and computes the body at paint time
from the actor's live size, removing only the four corner caps that lie inside the body's square
bounds. Reading the geometry in the paint that uses it - after Clutter has sized the offscreen -
is what lets a resize never show a geometry the actor has already left; the effect's own
decisions may stay debounced. A degenerate actor (no width or height) skips the pass, because
the shadow comes from the same actor and there is no visible body to leave square. A degenerate
*body*, though - insets that outrun the actor for the frame a resize passes through - does not:
the body falls back to the whole actor, so window content is never dropped. The client-painted
ring is kept unless the ring we draw is ours.

The corner is a distance field. To keep straight edges crisp under fractional scaling, the 1px
anti-alias ramp is confined strictly to the corner arcs, so straight edges keep full content
alpha and do not blur when the compositor resamples the offscreen a second time; the model and
the measurements are in `decoration-alignment.md`. A 1px inner outline is drawn half a physical
pixel inside the body, and a zero alpha disables it - which is also how overview suppresses it.

Clutter enlarges the offscreen and offsets the actor by fixed amounts, derived from Mutter's
`_clutter_actor_box_enlarge_for_effects` (`vendor/mutter/clutter-actor-box.c`) rather than typed
by hand. The clip body is snapped to the physical grid with the same rule the shadow cutlines
use, so the two stay in phase across fractional scales. When a client ring has to be cleared,
the clip boundary is inset by a safe margin before rounding, which excises GTK3's internal Cairo
half-pixel stroke bleed and outer box-shadow residue without distorting the shadow or the tiled
ring. Under fractional scaling, the fragment shader pushes texture sampling coordinates inward
along the boundary normal (`max(0.0, d + inset)`), preventing hardware bilinear filtering from
sampling external stroke bleed on both straight edges and corner arcs.

Upload cost: the effect deduplicates its decisions and repaints only on change, and the paint
guards its uniform uploads with dirty checks, so a static repaint uploads nothing and a resize
changes only the pipeline state that actually moved.

In overview the clip is retained: hardware trilinear mipmapping replaces the standard filtering
and the inner outline is suppressed, so downscaled previews stay clean; both are restored on
return to the desktop. During a window's close transition, Clutter property bindings keep the
shadow actor in step with the window actor until it is destroyed.

## Effects — shadow baking and slicing

Why eight slices describe a shadow, and why the middle stays empty, is the model in
`decoration-model.md`. One baked texture per style is shared by every window of that style, and
the bake runs the GLSL generated from GTK4's `gskgpuboxshadow.glsl`, so it stays the upstream
shadow rather than a second rendering.

The canonical bake window is a square with a straight middle that exceeds the blur reach, so a
strip from the middle is a settled profile. The baked pad is the farthest Gaussian reach over
every shadow set (`3σ` plus the spread) plus the Cogl offscreen offset - derived, not typed. The
corner slice is made to reach into the straight edge beyond the geometric arc so that its cutline
sits where the Gaussian decay has fully settled to the 1D edge profile; that matches Mutter's own
`inner_border = shape_border + spread` (`meta-shadow-factory.c`) and guarantees $C^0$ continuity
across the corner and edge slices. A window smaller than the two corners scales them down, which
is the correct shape when the window is all corner. All sizes are logical px.

The bake quad's extra size and top/left offset come from the same Cogl padding Mutter uses. Only
the per-axis total is an upstream literal; the top/left split is derived from it for an
integer-aligned box, so the split holds only there while the total always does. The runtime
geometry and the clip import that one generated source, and the generators read it at generation
time to bake the shader and style constants, instead of each writing the numbers by hand.

Pipelines are cached by a style key that joins every layer's parameters - including its colour,
so a light and a dark bake are different textures. Each window gets its own pipeline sharing the
baked texture, so a cross-fade can animate per-window opacity without re-baking; scaling the
pipeline alpha is enough because the pipeline colour stays opaque white under Cogl's
premultiplied blend. A bake that fails to allocate is not cached, so the next paint retries; the
cache is sealed on disable and re-armed for a new session.

The bake allocates a texture and an offscreen, compiles the generated shader as a fragment-stage
tail (the same non-replacing form the shell's own GLSL effect uses), clears to transparent - the
driver texture is not zeroed, and the hollow mask skips interior writes, so uncleared pixels
would show through the rounded corners - draws and flushes, then wraps the texture in a drawing
pipeline. The GJS uniform setter is probed once per session for the two signatures it ships.

## Effects — the shadow actor

One shadow actor per drawn shadow, a sibling below the window actor in the window group. Clutter
constraints and property bindings sync its padded rect and carry the map/close/minimize
animations with no JS per frame.

The shadow is cast by the body, not the actor: the ring between buffer and frame is stored per
side (null meaning the whole actor), and the cast rect is computed from the actor's live size on
every paint, so it tracks a resize frame by frame. The slice destination boxes are snapped to the
physical grid, guaranteeing that adjacent cutlines share identical physical grid lines under
fractional scaling with no gap or overlap; the layout reuses pre-allocated boxes per physical
scale, so the hot path allocates nothing.

On paint the actor draws its eight textured rectangles and sets the pipeline opacity, modulating
the style-transition weights and culling early at zero alpha for no overdraw, so close/minimize
animations fade the shadow with no per-frame timers. The baked style changes only on a decision:
the style key ignores window size, so a resize never re-bakes and the actor is not rebuilt.

A style change cross-fades (the transition and why nothing resizes are the model in
`decoration-model.md`, *How a style change is drawn*). The fade advances from the paint pass, not
from a timer: progress is a cubic-bezier curve solved over monotonic time, and a blend still
running asks for the next frame from inside the paint, so its duration is real time at whatever
rate the display runs. A mid-fade arrival keeps whichever side is more visible as outgoing and
carries its weight, so a burst of focus changes reads as one continuous motion rather than a pop.
The transition parameters come from libadwaita's `$backdrop_transition` (`200ms ease-out`).

## Preferences

The preferences process has no window actors. It reads and writes the rule store through the
settings adapter and calls the extension over the picker D-Bus method; matching never reads the
sample title the pick recorded beside a rule. Axis names and type nouns are thunks
(`() => _('...')`) because the module loads before the prefs process binds the gettext domain, so
a plain `_()` would capture the untranslated string.

Each rule is an `Adw.ExpanderRow`: the header names the app and, for a picked rule, the dimmed
sample title; the subtitle is the kind sentence; the suffix is one bundled icon per **corrected**
axis (drawn on the GNOME symbolic grid, registered on a bare icon-theme search path so
recolouring works without an `index.theme`, in the row's own foreground). The delete button sits
left of the expander arrow, spaced from the icon group. The expanded body carries one switch per
axis, titled with the axis itself - the same word an unavailable axis uses for its reason row -
and the switch's tooltip says what turning it on does.

The kind sentence names all seven structural attributes of a rule key, folding the parent
attributes into one phrase and the two ring attributes into the frame clause;
`docs/rule-model.md` has the full grammar. Text for markup-aware widgets is escaped, while
toasts, alerts and plain labels take plain text.

The pick button and the import/export menu are the group's header suffix (Adwaita's
group-with-a-suffix pattern): a pick is the primary way a rule comes into being, and importing
from the clipboard is the other. Rows destroy themselves from inside their own signal handlers,
so the rebuild is deferred to an idle - one pending idle is enough because it reads the rules
when it runs. The prefs window may be hidden for the modal picker and still be closed, so a
liveness guard backs the D-Bus reply; an empty reply is a cancelled pick and is silent, while a
missing suggestion (a shell that has not reloaded since an update) is refused with its own toast
because there is no correction to apply. Writes are verified before success is claimed.
