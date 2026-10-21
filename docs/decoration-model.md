# How a window's decoration is decided

Background for `src/lib/detector.js`. The decisions live in the code; this records
the model they implement, and the places where it deliberately diverges from what
Mutter does, so a change there does not have to rediscover them.

> ego-lint warns when a file is more than half comments. `detector.js` is mostly
> policy, and policy wants reasons, so it sits near that line: rationale the call
> site does not need belongs here rather than in the module.

## The principles these decisions are made under

Three rules decide the trade-offs in this file, and they are ordered: where two disagree, the earlier
one wins.

1. **No perceivable cost.** Nothing may add work to a path the compositor walks per frame: a paint, a
   `notify::` handler, a per-window loop. The evidence is a **counting spec** - a stub that counts the
   platform reads, or a spec that pins the reuse of a table - because it is deterministic and runs in
   the unit suite. The wall-clock budget (`pnpm run check:perf`) is a whole-extension release check, run
   by hand: its ratio swings between sessions by more than most changes cost, so it is never attributed
   to a single change and never gates a commit or a push.
2. **Display quality first.** A picture we know we would blur is not drawn that way. The path that
   degrades it stays behind a switch whose description carries the cost (`force-overview-corners`,
   `prefer-crisp-text`), never the answer to a case we cannot classify. Where the loss is only
   conditional - the softening a fractional-scale monitor may cost text - the default keeps the
   feature and records the risk as a known boundary.
3. **Cover what a rule can correct.** On a decoration axis, apply the decoration when the reading is
   right in most cases, because the user corrects the rest with a rule. That license has two conditions:
   the axis must be one a rule can express (the four axes are the whole vocabulary, each with an exit),
   and the correction must be reachable by picking the window while it shows the problem - a rule is a
   correction, captured for the state the window was in (`rule-model.md`).

**One reading is never a value.** A failed read answers `null`, and a default is substituted only where
its caller asks for one: "unknown" and "zero" are different answers, and a fabricated plausible value
propagates into geometry as a wrong cut - an unread phase read as `{x: 0, y: 0}`, an unread scale stored
as `1.0`. This is a precondition for the three above: covering on a fabricated value covers the wrong
thing.

## Four layers, applied in order

```
can we decorate it?        window type, maximized, fullscreen, tiny helper   ── no ──▶ leave it

shadow: who paints one?    declared margin, SSD frame, Mutter's X11 shadow   ── yes ─▶ skip
corners: do they
already look like ours?    the Adwaita look                                  ── yes ─▶ skip

your rules?                per window kind: which axes the user reversed
any policy?                tiled neighbour, crisp text on fractional scaling
rounding them?             the client's own ring is cleared exactly when the ring we draw is ours
                           └───────────────────────────────▶ draw
```

1. **Structural eligibility**. Window type,
   maximized/fullscreen, and a degenerate size (helper surfaces such as
   wl-clipboard's 1x1 transparent toplevel). These are facts about the window,
   and a user rule must never override them.
2. **Inferred baseline**. The two axes do not rest on
   the same kind of evidence, and each is answered only from its own:
   - **Shadows** are a *reading*, not an observation: the window declares a margin
     (`buffer_rect - frame_rect`), Mutter says whether it drew the frame instead (SSD),
     and Mutter paints the shadow of a bare XWayland window unless one of `has_shadow()`'s
     gates excludes it — for a bare window the gate this reading consults is the buffer's own
     alpha channel (*Where we deliberately differ from Mutter*). A declared margin
     is read the way Mutter reads it, as the boolean `has_custom_frame_extents`: **any**
     declared margin is a ring, on one axis or both, 1px as much as 40px. That is why
     the reading is a pure positivity check — any declared margin on either axis, no SSD
     frame — carrying the measured margin but no threshold: a 4.0×4.0 margin
     reads as a ring exactly as a 40px one does. A radius cannot
     answer this question: GTK4 floors a CSD window's margin at 12 logical px
     (`vendor/gtk/gtkwindow.c`: `shadow_width = MAX(css_extents, RESIZE_HANDLE_SIZE)`), so no
     radius separates a 12px resize handle from a 12px shadow. The axis is then
     **one-sided**: "something else already paints one" is reliable, while "nobody
     does, so we add one" misses a client that draws its
     own shadow *without declaring a margin* (measured: `bradient` declares none). The
     error only ever points at a double shadow, never at a missing one, and the remedy is
     the ring (*Rounding a window takes its shadow over*) or a rule.
   - **Rounded corners** are *not* observable: a surface never reports whether it is
     already rounded, and Mutter has no concept of it at all. This axis therefore rests
     on an inference — the Adwaita look implies the Adwaita radius (*When a window's
     corners already look like ours*) — and it is the only axis with nothing but
     inference to go on: the shadow axis at least has the window's own declaration.
     Everything else is rounded to our radius, whether the client rounded itself or not
     (*Which rectangle the clip lands on*).
3. **User rules** — `src/lib/rules.js`. One state per window kind names the axes
   (corners, shadow, resize) whose decision the user reversed. The only layer that may
   overturn an inference.
4. **State modifiers**. Applied last, on top of
   both of the above, because they are visual policies rather than inferences about
   who already paints what.

A rule overrides layer 2 and nothing else: it exists to correct a wrong reading or
inference, not to overrule a structural fact (layer 1) or a policy (layer 4). See
[rule-model.md](rule-model.md) for the three axes and what reversing each one does to the ring.

## What the edge has to carry

`checkDecorationEligibility()` holds two floors, and they read two different sizes. Layer 1 is not
only window type and window state: an edge that cannot hold the decoration is disqualified whatever
the window is.

The geometric floor is `2 * radius` (`MIN_DECORABLE_SIZE`, `detector.js`), the size at which the
two corner arcs of a side would meet: below it no rounded rectangle fits inside the window, so
there is nothing to draw. It is a physical fact about the frame as it is *right now*, and it holds
for every window: dragging a window under it drops the decoration, and dragging it back restores
it, because at that size the shape genuinely stops existing. No rule reaches it - it is a
capability, like the window type.

The visual floor is `max(2.5 * radius, 2 * shadowReach)`, where `shadowReach` is the farthest a
shadow layer reaches (`blur + spread`): at or below it the 15px corners read as a pill and the
shadow dominates the body it is meant to sit behind. It is judged on the **initial stable size** -
the frame size the window had on the first pass its classification had landed on (the manager
closes a per-window latch there, and a pass that still defers or read no extent leaves the latch
open). That is a size the user never chose, so a drag cannot flip the judgment, and a window that
lives most of its life at 1200x800 is not re-judged because the pointer is at 300x200 on the way
there. Unreadable is not a size: `0`, `NaN` and infinity leave the latch open and the pass is
judged without the visual floor, per the no-fabricated-value rule above. Neither does a frame
below the geometric floor close it, because an apply pass only proves the rect is readable and
non-zero: a 1x1 or 20x20 placeholder is not a picture a size can be read from, and latching it
would let the visual floor suppress the decoration of a window that is perfectly large.

The two rejections carry distinct reasons (`too-small(...)` geometric, `too-small-for-corners(...)`
visual). Unlike the geometric floor, the visual one is a *reading* of the decoration rather than a
capability, so it enters as the corner and shadow axes' automatic answer (off) and a rule naming an
axis reverses it, exactly like the readings in layer 2. Its known boundary is the mirror of why it
reads a latch: an application that maps a window at or just above the geometric floor - a 32x32
splash, a collapsed panel - and grows it afterwards is judged on that tiny frame, and loses the
decoration it should have had. The exit is a rule on that window kind, which is why the floor is
reversible.

The shadow can be the reason to abstain too, and there a *reading* decides. Where a bare X11
window's buffer cannot be read, the compositor's own shadow and ours cannot be told apart, and a
second shadow is worse than none, so both axes abstain (`x11-shadow-unknown`). Where the same
read says the shadow is ours (`x11-rgba-shadow-ours`), the ring is drawn, because a shadow known
to be ours is one we can take over.

Both floors are derived from the generated style rather than written down, so a change to the
radius or the shadows moves them. Neither carries the monitor scale. The radius is logical all the
way to the shader, which is where the device conversion happens (`d * uScale`), so the visual floor
is a ratio of the radius and not a device-pixel size; the fractional-scale cases that would need a
scale-aware decision are the crisp-text clip gate's, not this one's.

## When a window's corners already look like ours

`nativeLikeCorners.js` answers this, and both the corner axis and the resize band's
eligibility consult it. Nothing here claims a window is native: most of what it detects
reimplements the Adwaita look outside GNOME. Every provider is a library the process maps,
and all of them are visible in the same place:

| Provider | How it is visible |
|---|---|
| libadwaita, libhandy | the process maps `libadwaita-1.so` / `libhandy-1.so` |

> **QAdwaitaDecorations** (`wayland-decoration-client/libqadwaitadecorations.so`, FedoraQt/QAdwaitaDecorations) is **not** a provider: its `qadwaitadecorations.cpp` rounds only the top two corners (`ceCornerRadius=12`, `arcTo` on `topLeft`/`topRight`), so it cannot supply four-corner Adwaita look. Such windows are now nativized like plain GTK3 — cleared ring + our shadow + 15px four corners — with the expected top 12px vs 15px delta and the other two corners unified by us. Not yet verified on real hardware (requires AUR `qadwaitadecorations`, not installed on Arch dev machine).

> **Qt 6 built-in Adwaita decoration** (`wayland-decoration-client/libadwaita.so`, `qt/qtwayland` `src/plugins/decorations/adwaita/qwaylandadwaitadecoration.cpp`) is **not** a provider: `QWaylandAdwaitaDecoration::paint` (`ceCornerRadius=12`, `arcTo` only on `topLeft`/`topRight`, bottom edge is `lineTo`) and `QWaylandAdwaitaDecoration::margins` (`ceShadowsWidth=10`) show it rounds only the top two corners — bottom two stay square — so it cannot supply four-corner Adwaita look and is nativized the same way (verified against `dev` and `6.8`; cached at `/tmp/qt_qwaylandadwaitadecoration.cpp`).

A GTK **theme** that copies libadwaita's stylesheet — adw-gtk3 and its variants — is
deliberately not a provider, and cannot be one. GTK3 draws a window's decoration in its
own `decoration` node, which does not cover the bottom of the window: the same block
carries the top-only `border-radius` and the `box-shadow` GTK3 reads as the shadow
width, so a plain GTK3 program keeps a square bottom contour no theme can round. The one
way a GTK3 program gets four rounded corners is libhandy's `window.csd.unified`, and such
a program maps `libhandy-1.so`, already caught above. A theme name could therefore only
ever have *skipped* the bottom two corners of a window that needs them — the bright wedge
with a square shadow shoulder at the bottom corners. The theme branch that used to read
`gtk-theme` was removed for exactly that reason.

The probe reads the process, not the window, so a process that maps libadwaita and
also opens a window without client-side decoration — a splash, or one forced to SSD —
is skipped along with the rest. Both ways of being wrong are harmless: a window we skip
when we should not keeps the corners its toolkit drew, and a window we clip when we
need not costs one offscreen pass and comes out identical.

**The probe is asynchronous.** Reading `/proc` synchronously in shell code is what
EGO-X-004 flags, and it blocks the compositor, so the maps go through GIO's async API and
the answer lands a frame or two later. The reading reports the classification as unknown until
then, and a window whose classification is unknown is not decided at all: nothing of ours is drawn
for those frames, so the window keeps the decoration
its toolkit gave it, and the manager runs the decision again when the answer lands. Drawing first and taking it back would flash our corners and a second
shadow over a window that has its own, the direction this axis is built to avoid. What it
costs is a decoration arriving a frame or two late on the *first* window of a process; every
later window of the same process reads the cache. Queries strictly inspect in-memory
snapshots (a process cache and the set of reads in flight), while `/proc` I/O is driven
exclusively by lifecycle commands (the probe). Reading I/O lazily inside queries or predicates (violating Command-Query
Separation) is prohibited: it creates timing inversions where query evaluation order mutates state
and triggers transient visual flicker. The manager drives the probe from the window lifecycle and
the inspector from its hit-test and its pick request; a query handed an unprobed pid answers that it
does not know yet, and never starts the read itself.

The pid a classification is keyed on is read once and remembered. A later read during teardown can
come back empty, which would leave the process classified with no owner left to forget it by;
tracking happens on `window-created`, so an X11 client that sets `_NET_WM_PID` only after the window
exists has its pid learned on the next reconcile instead. A `/proc` read that fails is "unknown",
not a verdict: caching it as definitely not libadwaita would last the process's lifetime, so the
entry is left empty and a bounded retry is scheduled, rather than answering for a window that
recovered with our clip and band over its own handle.

## Which rectangle the clip lands on

The actor a clip is attached to is not the rectangle to round: for a client-side
decorated window it is the buffer, which is the body plus the ring the client filled
with its own shadow. The clip effect takes the body (`frame_rect`, expressed inside
the actor) and removes only the four corner regions that fall inside the body's square
bounds; everything beyond those bounds survives exactly as the client painted it, unless
that ring holds the client's own shadow and we are replacing the corners it was painted
for (*Rounding a window takes its shadow over*). Without that distinction, rounding a
decorated window would cut the outer edge of its shadow and leave the body square.

Rounding a window that already rounds itself is therefore safe, and easy to reason
about: our radius is libadwaita's, so clipping a window libadwaita already drew is an
exact identity, while a toolkit that rounds less ends up at ours.

## Rounding a window takes its shadow over

A window that declares its own shadow margin painted that shadow for the corners it
had. Rounding those corners abandons the shape the shadow was cast by, and the shadow is
pixels inside the window's texture: it cannot be erased selectively, only wholesale. So
the shadow changes owner along with the shape, and the rule is one line:

**the ring is cleared exactly when the ring we draw is ours**. With no rule in play,
clipping a window that declared a ring
makes the shadow ours first, so an ordinary client-decorated window ends up with one
shadow matching the corners we drew. A rule decides each axis itself, by reversing it:
where the decision left the shadow with the client, reversing it clears the ring and draws
ours; where the decision drew ours, reversing it retracts. The clip follows the corners, not
the shadow: a shadow-only reversal leaves the clip at the style radius (the corners are still
ours), while a radius-0 clip is attached only where a ring has to be cleared without our
corners. Our shadow is then cast for the body the corners decision leaves —
square when a rule left the corners theirs.

| What the ring holds | Shadow ours? | What happens |
|---|---|---|
| the client's declared ring (`buffer_rect - frame_rect`, any positive margin on either axis) | yes | cleared, then our shadow is drawn: one shadow, for the corners we drew (for a square body, if a rule left the corners theirs) |
| the client's declared ring | no - it already looks like ours, or a rule left it theirs | untouched: its shadow still matches the shape it was painted for |
| server-side frame ring (a declared frame-extent ring) | yes | cleared, and our 15px rounded shadow is drawn around the body |
| zero client margins (no shadow margin declared by client) | n/a (no client shadow) | outer rectangular edges and sharp 90-degree corners are erased directly by the corner distance field, preventing outer corner fringe |
| Mutter's bare-X11 native shadow | either | out of reach: drawn by compositor outside the window square |

The ring is a **declaration, not content**: `_GTK_FRAME_EXTENTS` on X11 and
`set_window_geometry` on Wayland both say "this much of my buffer is decoration", and
the client drew its frame there. Measured: WeChat's CEF window (XWayland, Depth 32,
extents `4,4,4,4`) paints a 1px decorated edge inside its ring, which clearing removes
along with the square corner it was drawn for.

The reading is resolved once, in the detector, into a single plan: the ring decision it hands on
(`clear`, `safeInset`), whether the stroke is pushed, and from which `WindowDecoration` resolves the
insets the clip is attached with - the fresh ring, the previous one while a fresh read has drifted by
a whole pixel, or `flatSafeInsets(scale)` for a flat client. The clip, the shadow and
the overview mask each read that plan instead of re-deriving it, and `hasPositiveInsets`'
second reading of the same insets is gone.

Two consequences worth knowing. The shadow is cast by the **body**, not by the actor
(the shadow layout in `shadowActor.js`), or ours would be laid out around the ring the
client reserved - the same distinction the clip makes with the body rectangle. Both rectangles are
therefore derived once, in one pass, and the assumption that lets one rect serve both is
that a window we draw a shadow for does not have Mutter's own shadow padding its actor:
either the client declared extents (so Mutter drops its shadow) or the window reserved no
ring at all.

**An unreadable ring is covered like a flat one.** `insetsFromRects` answers null when the
frame does not fit inside the buffer, and the detector reads that null as the flat case:
`clear` stays false, so the client's ring is not erased and only `flatSafeInsets(scale)` of
it is covered. The client's own shadow therefore stays painted under ours, and a window that
declared a ring can show two shadows for as long as the reading lasts. Keeping the takeover
is deliberate: the margin is read as the case that is most often behind an unreadable one, a
client that painted to the actor edge, and the state is correctable because a rule is
captured for the state the window was in when it was picked. The key carries `has_ring`, this
pass reads it false, so picking the window while the double shadow shows records the flat
state - and that is the state the rule then corrects, here and on any other window that
reaches it (`rule-model.md`).

## Where we deliberately differ from Mutter

- **XWayland without custom frame extents & Server-Side Decorations (SSD).**
  Upstream libadwaita/GTK stylesheet explicitly sets
  `window.csd.ssd-frame { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }`,
  so the frame client (`mutter-x11-frames`) bakes a shadow with square bottom corners. When
  the clip effect clips the body to a 15px radius, the square shadow leaves a transparent
  wedge between the rounded body and the square shadow shoulder.
  For a floating SSD window the invisible border ring exists and is within reach: measured
  `frame 500×474 / buffer 550×524` (`_GTK_FRAME_EXTENTS=25,25,25,25` on the frame window,
  `actor 550×524`, first child `550×524`) — `mutter-x11-frames` draws its shadow into that
  ring, clipping the window takes it over (the ring is ours, so it is cleared, and our shadow
  replaces it), and the shadow actor casts our 15px four-corner rounded shadow around the body.
  When Mutter reports zero insets the ring does not exist: maximized SSD reports
  `buffer 1920×1051 == frame 1920×1051`, `_GTK_FRAME_EXTENTS=0,0,0,0`, `actor 1920×1051`,
  first child `1920×1051` — actor and child are equal to the frame, no ring to clear, so
  no fallback assumption is made (the surface is the frame). Such windows are also
  structurally ineligible (`maximized/fullscreen`). For a bare XWayland window (no SSD, no
  extents), who paints the shadow is the next bullet.
- **Who paints a bare X11 window's shadow.** Mutter paints shadows on the X11 side only, and
  `has_shadow()` (`src/compositor/meta-window-actor-x11.c:373-428`) declines in six cases:
  maximized or fullscreen, a tile match, an SSD frame (`meta_window_x11_get_frame`), a non-opaque
  (ARGB32) window, declared `_GTK_FRAME_EXTENTS`, or an X shape. Where it does paint, the shadow
  lands outside the window square in the beneath-region, where the window's own actor cannot cover
  it. The one switch that used to turn it off, `actor.shadow_mode`, was removed upstream in 2024
  (mutter commit `0104fbe`), so a native X11 shadow is permanent once Mutter decides to draw one:
  the choice is never "remove it", only "add ours or not". Five of the six gates have a reading
  here: maximized/fullscreen, the tile match and the SSD frame are window state,
  `has_custom_frame_extents` is the declared ring, and the non-opaque test shows as the
  compositing buffer's own format — four components is RGBA, three is RGB
  (`getWindowBufferAlpha` in `src/platform/window.js`). Only the X shape is out of reach.
  A **bare** X11 window (no SSD frame, no declared ring) is therefore split by that reading, and
  the buffer is read only there: a depth-24 client wrapped in a depth-32 SSD frame reports the
  frame's alpha, not its own. RGB means Mutter's shadow is already on the window, so ours stays off
  (adding one would double it); RGBA means Mutter abstained, so the shadow is ours; an unreadable
  buffer is undecided, and both of our axes abstain rather than risk a second shadow or a clip with
  nothing under it.
- **Whoever paints the shadow paints the shape it was cast for.** Rounding a window's body
  abandons the shape its shadow was cast by, so the two change owner together: an RGBA bare X11
  window gets our shadow and our corners, an unreadable one gets neither, and a window whose own
  declared ring we take over gets both by the takeover rule. The one case that cannot be made
  consistent is the opaque RGB window: Mutter's square shadow cannot be cleared, our corners can
  still be drawn, and the mismatch is a known boundary (below) rather than a reason to drop the
  corners for every window that has one.
- **A snap-tiled window loses the shadow it would get from us** when it has an
  adjacent match, following Mutter's own reasoning that the shadow would obstruct the
  neighbour (`meta-window-actor-x11.c`). A lone half-tiled window keeps the shadow on
  its outer edge. This only ever drops *our* shadow decision; it does not suppress the 1px
  tiled ring on the shared edge, and whether the client's own ring is cleared follows the
  ring we draw, not the tile match. Tiled windows are flat-cornered either way
  (*Which style applies*).
- **Corner clipping is skipped under fractional scaling** when the user prefers
  crisp text: the offscreen pass is what blurs text at non-integer scales.

## Where the problems actually are

Every entry under *Known boundaries*, and every case that has needed a per-window rule, has one
thing in common: the window does not follow the Adwaita conventions. GTK4 and libadwaita do, and
GTK3 with a theme that copies them comes close - it declares a normal margin, draws its shadow
where Adwaita draws one, and rounds its top corners the same way, so taking such a window over
amounts to finishing its bottom two corners. Non-GTK toolkits are the other case: they declare
margins ranging from none to twenty-odd pixels, and they paint borders, grips and shadows
*inside* their own surface, where no reading of the geometry can see them.

That is why a rule, rather than a better predicate, is the answer for those windows: what they
draw inside their surface is invisible to us, and the only technique that would see it is
sampling the alpha of the window's own edge pixels in the offscreen pass - a mechanism of its
own, with a cache and no unit test behind it, and not part of the current model.

## The resize band

The decoration is not the only thing a non-Adwaita window gets wrong: its grab band is
narrower too. A native window answers a drag in the strip hugging its body - GTK4 floors its
input region at `RESIZE_HANDLE_SIZE 12` (`vendor/gtk/gtkwindow.c`, from which our copy of the
rule is generated), GTK3 takes its grip from the theme's decoration node - margin + border
+ padding, a number the theme sets and GTK does not fix (10px with adw-gtk3 as installed here) - so
that strip is the handle every native window offers.
A window whose own band is 4px wide, or absent, is resizable but awkward to grab.

So a window we decorate also gets a **resize band**: four transparent, reactive strips around
its body, exactly filling the 12px ring the frame grows. The top and bottom strips span the
full width, so the outward corners belong to them; the left and right fill the middle height.
The geometry is pure (`lib/resizeBand.js`); the actor that applies it lives in
`lib/resizeBandActor.js`. The strips only decide where an event lands - the direction is
resolved from the pointer, not from which strip was entered.

**The band is exactly GTK's input region.** `update_realized_window_properties`
(`vendor/gtk/gtkwindow.c`) builds a CSD window's input region as the border box grown by
`RESIZE_HANDLE_SIZE 12` on every side, and clicks outside it go through - so 12px out from
the body is as far as a band can reach, and as far as a pointer is delivered at all. Both it
and `RESIZE_HANDLE_CORNER_SIZE` are generated from `vendor/gtk/gtkwindow.c`
(`tools/gen-gtk.mjs`), so upstream drift fails `pnpm run check:style`; `research/gtk` is only
an uncommitted clone for reading.

**How a point becomes a direction.** The resolver follows GTK's own
`get_edge_for_coordinates()` order: the four side bands are tried west, east, north, south, and
inside each the corners come before that side's edge, first match wins. That order is what a
narrow window turns on - on a side shorter than two corner reaches, the earlier band takes the
overlap instead of the two halves meeting at the middle, exactly as GTK does. GTK's corner
reach extends 24px *along* each edge beside it, but the resolver only classifies the ring
outside the body: spending that reach *into the frame* would claim the client's own surface (the
titlebar drag, the window buttons, the tab strip), and the input region stops 12px out, so
there is no room outward either. The four strips tile that ring disjointly, so a point is
delivered to exactly one handler and resolved to exactly one direction.

**Two deliberate differences from GTK.**
1. GTK's resolver also reads a pointer inside the body, within a rounded corner's box, as that
corner. That surface is the client's, so our resolver answers nothing there and the ring is the
whole of its domain; on the ring itself the classification is GTK's, strict inequalities included.
2. Where an axis is constrained (a tile against the monitor edge), GTK drops grabs near the
corners along the divider. We extend straight-edge behaviour through those corner regions, so the
full divider stays grabbable. Suppressing the strips on a constrained edge is **not** a deviation -
GTK suppresses that edge too (*Which edges get one*, below); only the corner behaviour at the end
of the divider is ours.

Three things about the extent:

- **It hugs the body, not the shadow.** The band is `frame_rect` grown by 12px, so a window
  that declares no margin gets 12px of the desktop, and one with a 25px shadow gets the inner
  12px of that ring - exactly the strip its toolkit would have claimed. Making the *visible*
  shadow grabbable is a different proposal, and it was rejected: the gain over 12px is small,
  the swallowed clicks are not, and Mutter moved the other way on purpose
  ([decoration-alignment.md](decoration-alignment.md) has the measurements and the issues).
- **It is logical pixels at every scale.** `frame_rect` and actor coordinates are both stage
  (logical) units and GTK's 12 is logical too, so the monitor scale cancels out. It is passed
  into the geometry so a caller that cannot report a positive one gets no band, never as a
  multiplier.
- **It is clipped to the monitor.** A region that falls off the screen is dropped, so a window
  flush against the edge adds nothing there.

Who gets one is a different question from what is drawn: the resize
axis is independent of the decoration or the tiling - a rule that reverses only the resize axis is valid, and a
tile match takes the shadow but never the grab band. A window gets one when it is a
decoratable kind, is resizable, is not maximized or fullscreen, is not already the client's
own to size (only a GTK4 client can be *shown* to own a native-width handle, and then the
band is skipped), and is not an SSD window (mutter-x11-frames drew that frame and the client
that owns it runs the grab from the invisible border). Reversing the axis is the only lever,
and it is bidirectional: it adds a band where the reading left the window without one, and
retracts the one the reading drew. A bare window with no ring gets
the desktop around it by default; opting out is one reversal away.
**Which edges get one is Mutter's call, read from the window's state.** Mutter publishes a
per-edge constraint - Wayland's xdg-shell tiled states, X11's `_GTK_EDGE_CONSTRAINTS` - and an
edge fixed against the monitor is the one GTK refuses to resize, so it gets no strip. We read
the two maximize flags and nothing else - not the geometry: a window the user merely placed
flush against the work area is not tiled, and calling it tiled would both take away a band it
can still use and hand the style layer a tile look it never had. The one constraint the flags
cannot carry is the lateral edge of a half tile, which Mutter fixes out of the tile mode GJS
cannot read; it is left unconstrained, and safely so - that edge is the outer one, so its strip
falls off the monitor or under the panel or dock that pushed the work area in, and neither is
ours to pick. It also keeps the strip this whole change exists for: the central divider stays
grabbable to the end of the frame.

That last condition reads the client, because the declared ring does not mean the same thing
everywhere. It is a *shadow* for a CSD window and a *handle* only where Mutter's own frame draws
it: for X11 SSD it is the invisible border `mutter-x11-frames` grabs, but on the client side GTK3
computes `_GTK_FRAME_EXTENTS` as `max(box-shadow, decoration margin) + border + padding`
(`get_shadow_width`, gtk-3-24 `gtk/gtkwindow.c`) while the handle it actually offers is just
`margin + border + padding` (`update_realized_window_properties`, same file) - the margin being,
in GTK3's own words, *"the margin size, which we use for resize grips"*. Any theme's shadow inflates
that: adw-gtk3 as installed here declares a 24/21/24/27px ring around a 10px grip, and the numbers are
the theme's throughout - GTK fixes no constant on this side - so a rule that reads margins reads a
shadow as a handle and leaves a window like Firefox's alone with a 10px grip. Only GTK4 escapes this:
there the
handle is the constant, so the ring is sufficient evidence - and only there. The ring is read per side, the
narrowest of the two, and not as the average of a two-sided total: a
0,24 ring averages 12 but has no margin on one side. The source is the same reading the shadow axis
uses (the margin over `buffer_rect - frame_rect`), not a second path; only the per-axis
aggregation differs (the band takes the narrowest side, the shadow axis the
widest, because the two ask different questions).
Below the minimum, at least 24px per side (twice the 12px band) - the bound that keeps the ring
itself placeable, see below - and a 1×1 helper is not a window.

**What it costs.** Measured by reversing the resize axis against the heuristic on the same window
in a nested session
(`pnpm run test:perf`'s band phase; the shell's CPU read from schedstat nanoseconds): no idle
CPU at all, because a window that does not move neither re-allocates nor gets picked; 6.4 KB
resident per window; and about 34 us of shell CPU per resize step per window, measured over ten
windows at once since one window's share sits inside that comparison's noise. Pointer motion adds
a microsecond or two per window for the pick traversal. For the ten or so windows a desktop has,
that is tens of KB and well under one percent of a core while one of them is dragged.

One case is knowingly not 1:1, and it is the price of not guessing: a GTK4 client that does not
map libadwaita cannot be told from a GTK3 one in `/proc`, so it keeps our band on top of the one
its toolkit already offers - the same width and the same action, but ours rather than the
client's. The e2e case `tools/e2e-client.py --decorated` is exactly that window, so the behaviour
is pinned rather than assumed; the alternative would be to skip the band for every client whose
toolkit we cannot name, which is the Firefox PiP bug this rule exists to fix.

**A strip is an ordinary pick, and the window in front of it keeps the press.** The band is inserted
immediately above its own window actor and re-pinned there whenever Mutter restacks, so a window in
front of it draws - and picks - above it: a strip can only be pressed where its own window is the
topmost surface. Measured in a nested session with one client in front of another,
`global.window_group` runs `WIN(lower)`, `BAND(lower)`, `WIN(upper)`, `BAND(upper)`.

That is what keeps the press unambiguous. The topmost surface under a strip is the strip's own window,
so the Wayland pointer focus reaches that window's own client - which may answer with its own handle
where its input region covers the point, since a GTK4 client's grip is the same 12px ring - and the
compositor only then delivers the event to the shell actor whose strip it is:
`meta_wayland_compositor_handle_event()` runs inside `meta_display_handle_event()`, which Clutter
calls as an event *filter* (`research/mutter/src/core/events.c`), before the event reaches any actor.
Both paths resolve the edge the pointer is on, so whichever one ends up driving Mutter's grab, the user
gets the resize they aimed at, and a click can never reach a window they are not looking at. An earlier
build held the pointer with `clutter_stage_grab()` while it was on a strip; that existed to keep a
press from reaching a window *under* the ring, which was only possible while the band could reach past
its own window's surface.

**A bare window gets the desktop around it, by default.** The band is the inner edge of the
margin a client declares for its own shadow where one exists - that strip is inside the window's
own surface, so a press there lands on ground the client itself would use. A window that declares
no margin (an undecorated toplevel, a video popup) gets the 12px of the desktop around its body
instead: that is the tradeoff the default accepts, because a resizable window with no grabbable
edge is the worse outcome, and opting out is one rule reversal away. A strip can still
only be pressed where its own window is topmost (above), so the neighbour's clicks are safe
wherever the neighbour covers; the exposed cost is desktop pixels answering a resize.

The known imprecise case is the fixed-ratio client: measured on the Firefox video popup,
`move_resize_frame(true, ...)` at 403/443/493/553 logical px leaves it at 373x280 (4:3) every time.
A client that keeps an aspect ratio cannot be tracked by a compositor-driven drag - the
compositor proposes the size the pointer implies for the dragged edge, the client re-derives the
other dimension, and the two drift apart. Wayland offers no ratio to read (`xdg_toplevel` carries
minimum and maximum sizes, not an aspect), so no amount of care in the drag path fixes it, while the
client's own handle has the ratio and tracks the pointer exactly. That kind reverses the resize axis.

**Why the size floor is 24, and why it says nothing native.** The floor only says the ring has
to fit: a window thinner than twice the band has no middle once the 12px band is grown on
both sides, and a strip would come back empty. It is **not** a native boundary. GTK's input
region is the body grown by `RESIZE_HANDLE_SIZE 12` on every side whatever the window size is
(`update_realized_window_properties`, `vendor/gtk/gtkwindow.c`), so a native window of 24×24 - or 10×8 -
still has a full grab ring; ours now reaches down to 24×24, the smallest window whose ring the
strips can tile, and no further. The earlier floor of 48px - twice the GTK corner reach of 24px -
existed only because the symmetric partition could not reproduce GTK's first-match order on a
short side; the direction resolver does, so that floor is gone.

### It is the persistent thing that takes clicks

Outside the window picker, everything else is `reactive: false`: the shadow is painted,
never picked, and until now "we never participate in hit testing" was true of the whole
extension. It is not true of the band. Its four children are reactive, and it is inserted
above its own window actor but below every other window and below shell chrome, because it
lives in `global.window_group`, which `Main.layoutManager.uiGroup` keeps under the panel and
the overview. The picker's full-stage overlay (`lib/inspector.js`) is the other exception: it
is `reactive: true`, takes `button-press-event` under a `pushModal` grab and sets a crosshair
cursor, but only while a pick is running; the band takes clicks for as long as it exists.

The cost is the ring the client does not cover. Inside the window's own surface those clicks
were the client's to begin with, so a band as wide as the toolkit's changes nothing there;
outside it, in the pixels that were **click-through on purpose**, a press now starts a resize
and never reaches what is under the cursor - typically a click on a desktop icon or on the
window behind, a few pixels outside the body. That is the trade the default accepts; reversing
the resize axis on the kind opts out of it.

### What the band cannot fix

The band is ours only from the frame outward. Inside the frame body the client's own hit
region and cursor still win, so where the client draws a different cursor family at its own
edge - WeChat's diagonal double-arrow is the measured example - crossing the frame boundary
still changes the cursor, from the client's inward region to our 12px outward one. Owning that
inner boundary would mean taking the client's whole border band over, and that band is also its
titlebar drag surface and, on Chromium and GTK, its tab strip and window buttons; taking it
breaks them. The mismatch is left where it is.

## Known boundaries

**Message dialogs.** libadwaita gives `.dialog.message` and `.messagedialog` a lighter shadow than a
normal window - `0 0 14px 2px` at 3% and `0 0 5px 2px` at 10%, against `14px 5px` at 15% for
`window.csd` - and a larger corner: `$alert_radius` is 18px, where a window uses `--window-radius`,
which is 15px here. We cannot tell a message dialog from any other dialog: it is a GTK style class,
set inside the client, and the compositor sees only `Meta.WindowType`. The choice is therefore
between drawing the normal window shadow and radius for every dialog - what happens today - and
guessing from the window type, which would be wrong for the dialogs that are not message dialogs.
The guess is worse than the divergence, and the radius is what makes it so: a shadow at 3% instead
of 15% reads as a slightly softer edge, while 18px instead of 15px cuts three pixels off every
corner of a window that was not drawn for it. The dialogs such a rule would reach are not libadwaita
windows to begin with - they come from Qt, Electron or GTK3, which never used these values - so the
guess would trade a visible risk for an invisible gain. A dialog of a real libadwaita application is
not affected either way: the Adwaita-look probe exempts the process.

**Mutter's X11 shadow.** A bare XWayland window whose buffer is opaque (RGB) keeps the shadow Mutter
paints for it, which is what happens to a client that draws its own frame without declaring
`_GTK_FRAME_EXTENTS` (Electron under XWayland). That shadow is out of our reach: the compositor draws it
outside the window square, GJS cannot clear it, and adding ours would put two where there is one.
Its visible cost is the focus transition: Mutter holds a focused and an unfocused shadow and swaps
the two objects without easing, so such a window drops its halo in a single step where every window
we decorate fades. This is one of the three readings of a bare X11 window (*Where we deliberately
differ from Mutter*): the other two are an RGBA buffer, where Mutter abstained and the shadow is
ours, and an unreadable one, where neither axis is drawn. A rule still corrects the RGB case per
window by reversing the shadow axis, which draws ours on top - a double shadow, and what a user who
wants the focus fade is asking for. The corners remain ours in that case: a square shadow beside a
rounded body is the mismatch this entry records.

**An ARGB32 window that declares its whole surface opaque.** `_NET_WM_OPAQUE_REGION` is not readable
from GJS, so the buffer's alpha channel is as close as the reading gets: a window can carry alpha and
still declare every pixel opaque, and Mutter then passes its non-opaque gate and paints a shadow for
a window we have already given ours. The double shadow is narrow (the two differ only outside the
body), and the state is correctable - the reading says RGBA, so reversing the shadow axis retracts
ours and leaves Mutter's - which is what *Cover what a rule can correct* is for. The X shape is the
same kind of gap with no reading at all: a shaped window can pass every gate we can see and still
get a shadow from Mutter for pixels it does not own.

**Solid CSD.** `window.solid-csd` gets an inset border rather than a shadow, and the reason is
stronger than "the class belongs to the client": the class is not reachable in this session at all.
GTK4 adds it in `gtk_window_enable_csd()` (`vendor/gtk/gtkwindow.c`), in the branch opposite `.csd`,
gated on `gtk_window_is_composited()` - which is `gdk_display_is_rgba() &&
gdk_display_is_composited()`. A display fails that gate by having no alpha, or by having no
compositing manager owning `_NET_WM_CM_S0` on the root window, and neither can happen under Mutter:
Wayland is always alpha and always composited, and on X11 Mutter itself owns that selection, while
alpha is a property of the display rather than of a window. The solid branch is dead code for every
window this extension manages, so there is nothing to detect and nothing to approximate.

**Flat windows lose their outermost pixel.** A window that declares no margin is clipped, and its
shadow's cutout placed, one pixel inside every edge (`flatSafeInsets`). The clip and the shadow's
cutout move together: insetting the clip alone would leave the shadow's hole a pixel wider than the
body it frames, a transparent hairline around the window. The crop buys the 1px stroke a client may
paint along its buffer edge, which would otherwise show outside our corners (issue #129), and costs
the outer pixel of the window's own content - invisible at that magnitude on ordinary themes, and if
it ever is not, the way out is a switch rather than a different default.


What this model cannot do, stated rather than papered over. Most of these follow from
the reading being one-sided; the last is simply not verified yet.

- **A client that draws its own decoration inside its surface without declaring a
  margin** cannot be told apart from one that draws none. Nothing in the window's
  geometry or in Mutter distinguishes them, so the baseline adds our decoration next
  to theirs. Reversing the shadow axis is the only remedy.
- **A declared ring that is padding rather than a shadow** reads as a ring, and a
  shadow-on reversal - or the automatic takeover - clears it along with the corners. If the client painted
  something in there, that something goes too. The client's own declaration is the only
  evidence there is, and it says the ring is decoration.
- **Extents of all zeros read as a bare window.** Mutter sets `has_custom_frame_extents`
  for the property alone, zeros included (GTK4 writes `0,0,0,0` whenever the surface has
  a client shadow but no extents to declare, e.g. while maximized), and our margin is
  then 0x0. On XWayland that lands in the bare case where we decline to paint, so such a
  window keeps our corners and gets no shadow at all.
- **A client whose own corners are larger than ours** keeps a sliver of its shadow
  just inside our arc, where clearing cannot reach: erasing it would need its measured
  corner radius, which we do not have.
- **A window whose body cannot be placed inside its buffer is rounded as a flat one.**
  The margin reading answers null when the frame does not fit inside the buffer at all, and a null
  reading is read as *flat*: the clip is attached at `flatSafeInsets(scale)` instead of at a ring the
  window never declared, so the ring is never cut where it cannot be placed and the corners are
  still ours, one logical pixel inside. The guess is deliberate rather than a leftover: in the
  desktop state a wrong one is recoverable, because a rule can correct the axes it names for that
  kind, so the choice is to read the margin as the case that is most often behind an unreadable one -
  a client that painted to the actor edge - and keep the corners, rather than leave the window square.
  While the ring itself is unreadable, the rule that corrects it is the one captured in that state
  (*Rounding a window takes its shadow over*). A rect read that throws is caught where the inputs are
  gathered and the window is skipped instead - a different outcome. A framed XWayland window is not
  that case: Mutter sets `buffer_rect = frame->rect`, and `frame->rect` is the frame grown
  by the frame's **invisible borders** (`window-x11.c`, `meta-x11-frame.c`), so the insets
  are that border width (≥ 0) and the body lands exactly on `frame_rect`. Measured in the
  nested session on a GTK3 SSD window: frame 500×437, buffer 550×487, insets 25 on each
  side, and the surface child the clip attaches to is buffer-sized (550×487) - the clip
  cuts the frame rect, not the client surface, so it is not new harm. It no longer consults
  any actor size: the body is placed against the actor's live size at paint time, so a
  resize cannot turn this into "no body" for a frame. A window that *declared* a ring gets
  no shadow in a pass without a clip (clearing a ring with no clip defers it). Tiled windows
  reach a square-corner-with-shadow look on purpose (the tiled style has radius 0 and
  no outline, *Which style applies*), as does `prefer-crisp-text` on a fractional
  monitor and a reversed shadow axis.
- **A tiled window whose client keeps its own shadow keeps it.** Tiling only ever
  drops the shadow we would draw. The tiled style is the case that is not a shadow: it draws the 1px
  ring itself, so the client's ring is cleared for ours to replace rather than stack on top - and only
  when we are in fact drawing one, so an SSD frame or a window that does not allow resizing keeps its
  own.
- **XWayland with HiDPI: the units of the margin reading are unverified.** On Wayland the
  margin is already in logical pixels and answers "declared or not" directly (*The
  margins, and the scale question*); whether an XWayland window on a scaled
  monitor reads the same way has not been checked.

## The margins, and the scale question

The margin reading takes `buffer_rect - frame_rect` per side (with the
two-sided totals as a fallback). MetaWindow scales both
rectangles by the same window geometry scale, so their difference is the margin the
client declared. That scale is 1 whenever the logical monitor layout is LOGICAL,
and the native backend always reports that
(`meta-window-wayland.c`, `get_window_geometry_scale_for_logical_monitor`) — so on
Wayland the margin is already in logical pixels, and the predicate only asks whether
either axis is positive.

A backend that lays monitors out physically scales the margin by the integer
monitor scale instead. GJS cannot read that scale:
`meta_backend_is_stage_views_scaled()` is private, and the layout mode is not in
the GIR. The margin is therefore left as it comes, which on such a backend reads
larger than it is — never smaller.

On the shadow axis that cannot change an answer: the reading only asks whether a
side is positive, and inflating a non-negative reading keeps a declared margin declared and a
zero zero. The resize band is not so lucky: its gate is a magnitude comparison,
the narrowest side being at least 12px (only in the GTK4-client gate - the default
path bands bare windows regardless), so a reading inflated past 12 on a backend
like this can skip the band for a window whose real margin is narrower than a native one. That
is the one place the unreadable scale can change what we do.

## Which style applies

`style.js` turns a window state into the parameters we draw, tracking libadwaita's
`window.csd` so a decorated window looks like a native one. The precedence mirrors
libadwaita's own CSS selectors:

    fullscreen > maximized > tiled > focused | backdrop

The result is the resolved style: the corner radius, up to three shadow layers, and the outline
libadwaita paints around a decorated window - plus, since a style change is not always a shadow
change, whether that change animates and whether the window is drawing the tiled ring. The style
resolver in `src/lib/style.js` is what returns it and `tools/gen-style.mjs` is where its fields come from. Fullscreen and maximized windows get neither outline nor
shadows — they are flush with the screen edge, where a shadow would be a line on it.
Tiled windows drop the outline and rounded corners (radius 0); the 1px tiled ring is still
drawn on every edge, so the client's own ring is cleared for ours to replace. A tile match only
drops the shadow decision, never the ring we draw.
High contrast — upstream's `@media (prefers-contrast: more)` — replaces the shadow set
and deepens the outline from 7% to 30%.
Flat ringless windows (`hasRing=false`, `ring.clear=false`, such as WeChat) apply a device-derived safe inward inset (`flatSafeInsets`: `ceil(scale)` device px for the 1px client border plus one spare device px on fractional scales, exactly `FLAT_SAFE_INSET` at integer scales) to excise client-drawn rectangular borders outside the clip body. With the client's rigid rectangular stroke excised, the window receives the native Adwaita inner white outline and box shadow across its entire perimeter, eliminating double-line stroke artifacts, corner seam gaps, and cut-point white fringes.

## What the decoration costs

One offscreen per decorated window, plus one baked buffer per shadow style for the whole
session:

| Part | Where | Size |
|---|---|---|
| clip | `clipEffect.js`, on the window actor (surface child on XWayland) | window size + 3px, ~8.3 MB at 1920x1080 (also paints inner outline) |
| shadow | `shadowTexture.js`, baked once per style | 145x145, ~82 KB, shared by every window (pure Gaussian diffuse shadow) |

The corner-clipping pass is skipped when there is nothing to round (radius 0 and no outline);
the effect is still attached at radius 0 when a client ring has to be cleared.
A window with no shadow never touches a baked buffer. It costs nothing while nothing
damages the window: it is one framebuffer, re-rendered whole whenever the window paints,
local damage included. Measured against one 500x350 target (`pnpm run test:perf`):
no idle CPU difference, about 0.59 ms of shell CPU per frame while dragging a resize (five
counterbalanced rounds of `pnpm run test:perf`, the shell's CPU read from schedstat
nanoseconds; the 0.9 ms recorded earlier came from a jiffy clock that cannot resolve it), and the
framebuffer's size in the shell's memory. The harness' budget for that is a ratio, 0.85 of the same
round's disabled baseline (`BUDGET_MAX_STRESS_CPU_RATIO`), not a flat time: the delta tracked its own
baseline and moved by ±13 ms between sessions, so a flat guard flaked instead of guarding. Six
sessions read 0.514-0.681, and a failure inside the 0.06 marginal band exits 2 so the hook measures
once more before it fails.

That per-window cost is what `nativeLikeCorners.js` exists to avoid paying where the
clip would be an identity — a window already drawn with libadwaita's radius.

The shadow's buffer is small because a shadow is a blurred rounded rectangle: its pixels
depend on the window's size only through the length of its straight edges, so four corners
and a one-pixel strip from each edge describe the whole shape and the strips stretch. That
is Mutter's approach as well: `MetaShadow` (`src/x11/meta-shadow-factory.c`) is a
`CoglTexture` rendered once and painted as a nine-slice. The bake draws the same GLSL the
generator takes from GTK4, so this stays the upstream shadow, computed once instead of
every frame.

A corner slice draws a corner of the bake at 1:1, which is what fixes the position of
everything inside it: the body's cutout, the arc, the Gaussian falloff are all laid out in bake
px. Shrinking the corner quad into a cast narrower than two corners therefore has to show fewer
bake px, not the same ones scaled down, or the cutout stops landing on the frame and the shadow
pulls away from the window - measured on a 60x180 window (cast 116x236, corner 58 against a
corner of 71), the cutout came out 5px inside the frame, leaving a white gap where the shadow
should have met the window. That stays exact for every decorated window because the two limits
are one inequality: every decoration we draw has a frame of at least `2 * radius`
(`MIN_DECORABLE_SIZE`, `detector.js`; the visual floor is judged on the initial size, so it never
lowers that current-size bound), which puts the cast at `2 * radius + 2 * SHADOW_PAD` = `2 * (SHADOW_PAD +
radius)` - and `SHADOW_PAD + radius` is exactly how far the arc reaches in from the cast edge,
so the corner the crop keeps always covers it. The straight-edge cut, the margin snapping and the inward sampling are alignment mechanisms; their
decisions and measurements live in `decoration-alignment.md`.

The clip's cut and the shadow's cutout are the same line: both are the body's edge, and they have
to land on the same physical phase. This extension owns both ends of that line, so a gap opening
between them is a defect in us, not a rounding artefact to live with. The edge is derived twice
today - the clip effect computes it on every paint, the shadow actor on every relayout - but both
build it with `clipFrameFor` in `lib/snap.js`, which requires the phase of the frame it derives.
The clip targets the Wayland surface container, whose own transform carries the buffer's phase, so
its local frame is phase-free; the shadow actor passes zero and carries the same phase as its
translation. Both therefore meet on one physical position, and the phase stays out of the FBO's
box rounding that clipping the window actor used to disturb at 1.25x. `resolveClipTarget`
(`lib/clipTarget.js`) reports that container strategy together with the actor; when it cannot
identify the container it falls back to the window actor and the clip folds the phase into its
geometry instead, where the FBO's box rounding can still part the two cuts. `decoration-alignment.md`
owns that limitation and the model behind it.

**How the container is identified.** The container's type (`MetaSurfaceContainerActorWayland`) is
private and unreachable from GJS, so `getSurfaceContainer` (`src/platform/window.js`) infers it from
the window actor's children: a sole non-foreign child is the container, an unallocated one is
returned so the resolver defers on it, and otherwise the unique non-foreign child whose box passes
`isCompatibleSurfaceGeometry` - origin at (0,0), dimensions equal to the buffer, the same predicate
the clip re-checks before attaching - is the container. A geometry that cannot be verified is not
accepted: an unreadable buffer or an unallocated candidate once failed open, so an offset or
letterboxed container could be attached on a failed read and the clip then cut the wrong body. The four branches, with what each does about
an ambiguous tree, are in *Identifying the surface container* below. The geometric filter is what
separates Mutter's black full-monitor backing (`do_sync_geometry`'s plain `Clutter.Actor`, not an
`St.Widget`, so it counts as non-foreign) from the buffer-sized container for an acked-fullscreen
window that does not cover the monitor opaquely; when both are monitor-sized - the opaque-fullscreen
shape - two children pass and the tree is ambiguous, so the rule falls back exactly as a tie does.
Every actor the rule offers has passed the same `isCompatibleSurfaceGeometry` predicate the container
path trusts, so the new branch can never select something the container path would have rejected.

**The residual, and its consequence.** If the real container has not allocated yet while another
non-foreign child is already buffer-compatible, the unique-compatible branch could take that
backing for one reconcile. The private type would distinguish them and is unreachable, but an
unallocated non-foreign child is the tell that the tree is not settled: the rule returns that
unallocated child, the resolver's existing defer path fires, and it keeps its last good target
(`{defer: true}`) rather than attaching to the backing. If the real container is allocated but its
own box is off the buffer origin while a sibling is buffer-sized and at the origin, the two cannot
be told apart from geometry alone; there the rule takes the tie fallback and the clip stays on the
window actor for that reconcile. That residual's consequence is bounded to appearance: the two
cuts can part by the fractional-scale hairline the container path exists to avoid, for the one
reconcile, and the clip never attaches to an actor the container path would reject and never
deforms the window.

**Where the phase comes from.** On the container path the phase is read back from the transform
Mutter cached on the surface container (`getAppliedSubpixelPhase`, `src/platform/window.js`),
because the clip's local frame is phase-free and the shadow actor is a sibling that must translate
by that same value explicitly. Both cuts then follow one source. Both phase readers
(`getAppliedSubpixelPhase` and the mirror `getWindowSubpixelOffset`) identify the container through
`getSurfaceContainer` with the same `St` the clip resolved its target with, threaded from the
manager through the decoration into the effect and the shadow actor, so the foreign-widget rule is
one rule everywhere and never falls back to `globalThis.St` or the constructor-name heuristic. The
rule itself is read **once per pass**: `WindowTracking.observe()` resolves the container because it
is the module that decides which actor's allocation wakes a pass, and the decoration consumes that
answer (`apply({surfaceContainer})`) instead of asking again - so the clip's target and the phase
pair's actor are the same read rather than two reads that agree. The read only reflects a move once
Mutter has invalidated the cached transform, which it does on the window actor's allocation change,
so `ShadowActor` syncs on `notify::allocation` as well as position, translation, scale and pivot -
on position alone the read held the previous position's phase indefinitely (measured at 1.25x: the
shadow stayed one x behind while the clip painted the new phase, and the straight-edge probe caught
the hairline it opened). The mirror (`getWindowSubpixelOffset`) is the fallback for every case the read
cannot answer - a non-Wayland client, an ambiguous container, a non-unit matrix scale, a
non-finite transform - and remains the primary source on the fallback path, where the clip folds it
into its frame. Reading the same transform the clip paints with is also what keeps the two cuts
together on a monitor change, where the mirror's reconstructed highest-scale monitor can name a
different monitor than Mutter's cached pointer. `shadowPhaseOffset`
(`src/effects/shadowGeometry.js`) is the one place that choice lives.

**The fallback must land on Mutter's applied phase.** On the fallback path the mirror *is* the
phase the clip folds and the shadow translates by, so a mirror that does not reproduce the phase
Mutter actually put on the container's transform moves both cuts off the buffer - the
fractional-scale hairline, and the class of alignment defect that used to be invisible. The pass
compares the two reads (`phaseAlignmentWarning`, `src/lib/diagnosticInvariants.js`) whenever the
resolved target's strategy is the fallback, and emits one `[window-nativizer]` WARNING per episode
naming both phases and the window. The container path does not compare: there the phase comes from
the transform and the mirror is unused, so a disagreement is not a defect and the check is not
even read.

The pair is only compared when both reads name the same surface container: `_readPhases` resolves
the container once and hands it to both readers, and each read carries that actor. A mirror folded
from one actor and a transform read from another are a phase against a position - the field false
positive where a window actor's layout position `(-960,-600)` was reported as a phase - so the pair
is unavailable and takes no part in the comparison. A read whose magnitude exceeds
`PHASE_MAGNITUDE_BOUND` (2 logical px, far above the sub-one-pixel range of a real phase) is
likewise unavailable, but the journal still gets the raw value so the misread is visible. The bound
is generous: Mutter's `surface_container_apply_transform` shifts a layout coordinate to the nearest
physical grid line, so a real phase is smaller than half a physical pixel - below `1 / scale`
logical px, strictly under one logical pixel at any monitor scale - while a layout position or a
transform read from the wrong actor is hundreds of pixels.

**The ordering that keeps the read fresh is an assumption, not something we own.**
`ShadowActor`'s own `notify::allocation` handler sees a fresh transform only because Mutter
connected the invalidation (`clutter_actor_notify_transform_invalid`) to the window actor's
allocation in the actor's init, before the extension connects; the vendored
`meta-window-actor-wayland.c` shows that order, and `tools/check-upstream-mirrors.mjs` asserts the
wiring so a bump that moves it fails the style gate. It is a recorded boundary: if the wiring
moves, or we connect earlier, the shadow's cutout trails the clip's cut by one frame - up to one
physical pixel, the hairline the straight-edge probe caught at 1.25x when the read lagged a
position. The fix, if it ever fires, is a settled-transform trigger on the surface container plus
a `ShadowActor` harness that exercises the ordering; neither is built while the assertion holds.

The mirror is still spec-pinned: the `getWindowSubpixelOffset` guard in
`tools/check-upstream-mirrors.mjs` and the e2e subpixel-phase guard keep it matching the upstream
arithmetic it mirrors, and `getAppliedSubpixelPhase` is read back against it. One part of the
mirror is not machine-guarded - the monitor scan in `resolveHighestScaleMonitorIndex`, because
`meta_monitor_manager_get_highest_scale_monitor_from_rect` lives in an unvendored file - so it is
also re-checked by hand on a Mutter bump: re-read
`meta_window_find_highest_scale_monitor_from_frame_rect` (`window.c`) and that manager function and
confirm the scan still matches, as `docs/shell-compatibility.md` records.

**What the mirror's monitor scan answers, and why.** `resolveHighestScaleMonitorIndex` answers null
for a degenerate frame - unreadable, or a width or height that is not positive - so the caller keeps
its last good phase instead of reading a fabricated zero. A readable frame that overlaps no monitor
is the one decided `-1`, which the caller maps to a zero offset. It used to return
`win.get_monitor()`, the main monitor, as a third rule on top of upstream's
two, but Mutter's own two writers of the cached pointer disagree: `meta_window_constructed` stores
the current logical monitor (`window.c:1250-1260`) while `meta_window_update_monitor` stores
`window->monitor`, the last resolved main monitor (`window.c:4195-4199`).
`surface_container_apply_transform` (`meta-window-actor-wayland.c:130`) applies no phase at all while
that pointer is NULL, so mirroring either path buys nothing once a decoration is live - and a
degenerate frame means exactly that it is not. An unreadable monitor geometry, count or intersecting
scale is answered as null rather than skipped or defaulted: "unknown" and "no overlap" are different
answers, and `getMonitorCount` would fold a failed read into 0 (an empty scan, read as no overlap)
and `getMonitorScale` into 1.0 (an integer scale, read as a zero offset). Those strict reads are
scoped to this resolver; the helpers keep their defaults for every other caller.

**The mirror's snap is `roundf`, not `Math.round`.** `Math.round` sends an exact half toward
+Infinity while `roundf` sends it away from zero, so on a negative half they differ by one snapped
integer: at 1.25, `relX = -2` gives `-2.5`, where `roundf` snaps to `-3` and `Math.round` stays at
`-2` - 0.8 logical px, one physical pixel of offset. An earlier revision claimed this could not
happen; that holds on the 4/3 path, where an integer times 4/3 never ends in .5, but not in general:
on a 1.25 monitor the negative halves are reachable whenever `relX ≡ 2 (mod 4)`, and likewise at 1.5.
`roundHalfAwayFromZero` (`platform/numeric.js`) encodes `roundf`'s rule and leaves the 4/3 path
unchanged. The window's `translation_x`/`translation_y` is deliberately not a term of the mirror:
Mutter computes the phase from layout coordinates and carries the translation in the base transform,
so folding it in would move our cut while the buffer was somewhere else.

Mutter never needs the clip pass, and Shell 50/51 ships no rounded-clip effect (the
typelib has `BlurEffect` and nothing else): a window that decorates itself also rounds
itself and arrives with alpha, so the compositor has nothing left to clip. Decorating
windows that do not round themselves is what makes an offscreen pass inherent here.

## How a style change is drawn

Only the backdrop state animates, because that is the only state where libadwaita declares a
transition; whether a change animates is generated from that declaration by `tools/gen-style.mjs`, and
`tests/style.test.js` asserts the asymmetry. It is also gated on `org.gnome.desktop.interface
enable-animations`: GTK hands a CSS transition no frame clock when animations are off, so a native
window changes its shadow in one frame there, and a blend of ours would be the only thing still
moving.


A change is cross-faded over 200ms with CSS `ease-out`, which is what the source of these
numbers does: libadwaita's backdrop rule declares `transition: box-shadow
$backdrop_transition`, and `$backdrop_transition` is `200ms ease-out`.

Upstream also makes the *biggest* shadow layer **transparent** in the backdrop state, with
the comment "to enforce that the shadow extents don't change when we go to backdrop, to
prevent jumping windows". That is why the backdrop set looks like it loses its shadow:
the visible one becomes the smaller remaining layer, and the reserved space stays put. Our
padding is fixed for the same reason, so a change never resizes the shadow.

Mutter's own window shadows behave differently, and the difference is worth knowing
because it is not the model we follow: `default_shadow_classes[]`
(`src/x11/meta-shadow-factory.c`) gives a normal window `{radius 10, opacity 128}` focused
and `{radius 8, opacity 64}` unfocused, so its unfocused shadow only weakens and tightens.
It keeps both cached and swaps between them with no transition, and recomputes lazily when
the window shape or focus changes.

Two things that look like shortcuts are not, and it saves time to know why:

- **St's CSS transitions animate a widget's theme node, not a window's shadow.** The shell's
  CSS engine parses `transition-duration` and cross-fades an St widget's old and new node paint
  through `StThemeNodeTransition`, but our shadow is a Cogl actor with no St theme node to
  animate, so the fade has to be driven from our own code.
- **St's `box-shadow` is a different blur, and no cheaper.** It is pre-rendered into a
  cached pipeline the way ours is (`_st_create_shadow_pipeline` in
  `st-theme-node-drawing.c`, painted through a `ClutterPipelineNode` in the same file), but
  the blurring is St's own, not GTK4's, and the shell's own theme uses it only on its own
  widgets, never for a window shadow.
  Drawing through it would give up the reason the shader was transpiled from GSK. It would
  not be faster either: both approaches blit a baked texture, and ours is baked once per
  *style* rather than per node, so a resize costs nothing at all.

The shader earns its place as a *bake* and not as a per-frame cost. The first version ran
it over the padded rectangle every frame, with an offscreen that size per window (8.6 MiB
at 1920x1080), which is what fidelity cost. Baking reduced it to one 145x145 buffer per
style for the whole session; what runs per frame is eight textured rectangles.

## What is not introspectable at all

`has_shadow()` also gates on ARGB32 windows, shaped windows, and `has_custom_frame_extents`. Two of
the three are read here in their own terms: `has_custom_frame_extents` is the declared ring
(*Rounding a window takes its shadow over*), and ARGB32 shows as the compositing buffer's alpha
channel (*Where we deliberately differ from Mutter*), which is what splits a bare X11 window's
shadow between Mutter and us. What stays unreachable is the opaque region that can make an ARGB32
window opaque again, and the X shape, a window that is not the rectangle it appears to be; both are
recorded under *Known boundaries*.

`_KDE_NET_WM_WINDOW_TYPE_OVERRIDE` is the same kind of gap on the type axis. A KDE client uses it to
ask for a popup that is still a managed toplevel, and the shell never sees it: Mutter's X11 property
reader keeps only the **first atom it recognises** from `_NET_WM_WINDOW_TYPE`
(`src/x11/window-props.c:285`) and the KDE atom is not on that list, so a window carrying it beside
`_NET_WM_WINDOW_TYPE_NORMAL` arrives as `NORMAL` (`recalc_window_type`, `src/x11/window-x11.c`).
Supporting it would mean exposing the raw atom list; mapping the one atom onto
`META_WINDOW_OVERRIDE_OTHER` is not, because that would hide the other atoms and hand every window
that names it a type it did not ask for.

## Overview downscaling and offscreen effects

When GNOME Shell enters the Overview, window preview clones are rendered downscaled to
around ~0.25x scale.

Mutter's `MetaShapedTexture` (`src/compositor/meta-shaped-texture.c`) handles native window
scaling with high visual fidelity: when downscaled below 0.5x, if `create_mipmaps` is enabled,
it switches its minification filter to `COGL_PIPELINE_FILTER_LINEAR_MIPMAP_NEAREST` (bilinear
mipmapped filtering), ensuring sharp and alias-free thumbnails.

However, our clip effect subclasses a shader effect (which inherits `Clutter.ShaderEffect` on GNOME 51+ or `Shell.GLSLEffect` on 50, deriving from `Clutter.OffscreenEffect`).
When an effect redirects an actor's subtree to an offscreen FBO texture, the actor preview in the
overview clones this FBO texture instead of sampling directly from `MetaShapedTexture`.
In `Clutter.OffscreenEffect` (`ensure_pipeline_filter_for_scale()` in Mutter's
`clutter/clutter/clutter-offscreen-effect.c`):
- The pipeline min/mag filter decision is based strictly on actor / display `resource_scale`
  (integer vs fractional monitor scale), NOT the preview clone's ~0.25x downscaling factor.
- Crucially, `ClutterOffscreenEffect` creates an ordinary FBO target texture and does not generate
  a mipmap chain.

As a consequence, downscaling the full-resolution offscreen FBO texture to ~0.25x in overview
thumbnails suffers from severe aliasing, moiré patterns, and text blur (GNOME Shell upstream
issue #7903).

### Retaining rounded corners through the shaped-texture mask

The FBO has no mipmaps, so the fix is to not use one in the overview at all. Mutter exposes
`Meta.ShapedTexture.set_mask_texture()` — the A_8 alpha mask it already uses for shaped X11
windows — and its paint path samples that mask as a second layer of the *same* Cogl pipeline
as the window colour (`get_masked_pipeline()` in `src/compositor/meta-shaped-texture.c`),
under the same `LINEAR_MIPMAP_NEAREST` minification the mipmap tower gets. Rounding therefore
rides Mutter's native hardware mipmapping: the thumbnail is rounded and exactly as sharp as an
undecorated window, with no offscreen pass.

Entering the overview, the manager tells every decoration, which:

- Suspends the desktop clip effect, unless the window falls back to it (see below). It is the FBO
  that blurs, so it must not stay attached while the mask or the square path is in use.
- Builds a rounded A_8 mask matching the clip's body geometry — insets and radius scaled from
  logical pixels into the client's buffer pixels — and installs it with `set_mask_texture()`.
  Alpha is 255 over the body, carries the corner coverage in the four corner squares, and is
  255 outside the body unless the ring is cleared (flat windows): the same coverage the desktop
  shader computes. `tools/test-e2e.sh` checks the preview corner's 50% contour against the same
  corner on the desktop and against a live libadwaita window's preview; at preview resolution it
  cannot pin the per-byte coverage. `set_auto_mipmap(true)` keeps it valid under the mipmap filter.
- Drops the window's **surface container** — the window actor's child that every preview clone
  paints through — to 254. Mutter consults the mask only on its blended path
  (`use_opaque_region = stex->opaque_region && opacity == 255`, `meta-shaped-texture.c`), and an
  opaque client declares a full-surface opaque region, so the fast path would paint square
  corners. One step below 255 forces the blended path; the cost is 1/255 of alpha, a single level
  of difference on a 0-255 channel, measured and imperceptible. The actor is the window's own
  container rather than a preview card: its opacity multiplies into every surface the clone
  paints, so one handle covers every preview of the window. The card used before was
  `metaWindow._delegate`, which `WindowPreview._init` overwrites on every build and which is
  therefore only the *last-built* card. A window shown on all workspaces has one preview per
  workspace (`WorkspacesView._updateWorkspaces` builds a `Workspace` for each and
  `Workspace._isMyWindow` accepts the window in every one), so the delegate can name an off-screen
  card, and a card built after the pass gets no bypass at all; a preview left at 255 then takes
  Mutter's opaque fast path and paints square although the mask could round it. A card's own
  opacity is also what the shell animates, so it was never ours to hold.

The mask is keyed on the readings it was built from: buffer size, buffer scale, insets, radius,
erase and monitor scale. Mutter clears the `mask_texture` slot itself on any destination-size
change (`update_size()` in `meta-shaped-texture.c` calls
`meta_shaped_texture_set_mask_texture (stex, NULL)`), and a buffer-scale or viewport move reaches
the extension through no signal it listens to, so "already wearing the mask" is only true while
that key is unchanged; a moved key re-installs. Comparing the key turns the install into a reading
of this pass instead of a memory of an earlier one.

Leaving the overview, the mask is replaced by a 1x1 fully opaque texture (`set_mask_texture`
rejects `null`) and the surface container's opacity is restored; the clip effect is re-enabled.

**The acceptance standard is the user's screen.** A refusal to round a preview is admissible only
when the user can perceive the problem it avoids. A screenshot or a window-level capture is not
part of that test: our decoration already changes what a capture of a window shows, and that is
simply what the decoration is. So the criterion for every branch below is a user-visible effect -
a deformed window, or a missing rounded preview - never a capture-level difference.

**XWayland is one refusal; the mask's own reach is the other.** An XWayland window keeps the
window's shape in that same `mask_texture` slot, and Mutter rewrites it from the shape on every
surface sync. `set_mask_texture` cannot be undone from GJS (it rejects `null`, and nothing else
reaches the slot), so an overwritten slot would deform a shaped window once the overview ends.
That is a perceptible deformation, so the exclusion stays.

**A Wayland window takes the mask - but taking it is not the same as rounding the window.** The
mask lives on one shaped texture: `mask_texture` is a per-texture slot (`meta-shaped-texture.c`),
and `meta_window_actor_get_texture()` returns only the main surface's texture
(`meta_surface_actor_get_texture (priv->surface)`, `meta-window-actor.c`), while
`meta_window_actor_wayland_rebuild_surface_tree()` makes the whole surface tree - the toplevel and
every subsurface - children of the surface container the clone paints. A window whose visible
corners another surface of the same window paints therefore keeps square previews although the
mask installs and the container drops to 254. Measured on Firefox's Picture-in-Picture window,
which holds two live `560x315` surfaces at `(0,0)`: the mask installed, the container dropped to
254, and re-installing the mask changed nothing. The other surfaces' *textures* are unreachable
from GJS (`MetaSurfaceActor.content` is a private `MetaSurfaceContent`, and
`Meta.SurfaceActor.get_texture()` and `Meta.WindowActor.get_image()` are not in the introspection
data), but the surface actors are not: `meta_window_actor_wayland_rebuild_surface_tree()` hangs
them on the container, and `countSurfaceActorsCoveringBox` (`src/platform/window.js`) counts the
ones whose box covers the container's own. Two covering actors is the reading that the corners are
not the mask's to round - the criterion behind the `force-overview-corners` routing below. Measured
in a nested session: a single-surface window reads 1, a small subsurface reads 1, a full-box
subsurface reads 2. With the setting off this is the same kind of admitted square as XWayland's,
and it keeps the same policy: display quality first, the sharp mask as the primary path, and the
legacy offscreen clip only behind the `force-overview-corners` setting. It is tracked upstream in
issue #27 (`Track upstream limits on overview corner fidelity: offscreen-effect blur and
per-shaped-texture masks`), whose body records this analysis and a third re-enable criterion.

**Not ready yet is not a refusal.** A window whose preview is built before the client's first
buffer arrives has no shape to mask, and one whose window actor has no positive allocation has no
draw target to mask into. Both mean "do not mask this pass, cache nothing": the next reconcile,
after the buffer or the allocation arrives, installs it. Those are the only gates, and they read
`_textureBufferKey` (a real texture size) and `isPaintableFrame` (the authority the clip uses).

**A refusal after those gates is the "square in the overview" defect, and it is loud.** Once the
buffer and the actor are ready, a pass that still cannot install the mask - no mask builder, no
shaped-texture context, a non-positive size, or a builder that returned nothing - leaves a preview
square that should have been rounded. It emits one `[window-nativizer]` WARNING per overview
episode, naming the gate and the window; an install or leaving the overview re-arms it. As with
the geometry invariants, the warning speaks on the second consecutive violating pass
(`INVARIANT_STRIKES`), so a single transient miss does not journal.

**Why the Wayland refusal was removed.** An earlier version refused the mask for a Wayland window
whose shaped texture was still on Mutter's direct-read screenshot path, and showed it square. That
protected a capture-level behaviour no user can perceive, at the cost of a rounded preview the user
can see, so it failed the standard: the probe and its `shaped_texture_paint_to_bitmap` capability
record were removed. Attaching the mask does force Mutter off that path for the rest of the
session, and GJS cannot detach it (`set_mask_texture` rejects `null`), so a window-level capture or
share of a masked window carries the transparent corners; under this standard that is not a cost,
because it is the same kind of capture-level difference the decoration already makes. The
`force-overview-corners` setting (off by default) still keeps the legacy offscreen clip for
XWayland, for the window whose corners another surface paints, and for the fallback cases where the
mask cannot be built: rounded, and blurrier. The clip never touches the mask slot, so the desktop
is left exactly as Mutter had it either way.

Upstream has no native window rounded-clip to fall back on —
`Meta.BackgroundContent.set_rounded_clip_radius` is a deliberately non-generic background-only
implementation (MR !1717) and the Clutter rounded-corner-clipping roadmap item (issue #2087) is
still open.

**Cost.** The mask is one byte per texel, generated once per window per overview entry and rebuilt
when the mask key moves - the buffer, its scale, the resolved insets, radius, erase or monitor
scale (only the four corner squares are computed; the body is a memset) - and released on exit. Its
resolution is the largest preview the overview can draw — Shell's `WINDOW_PREVIEW_MAXIMUM_SCALE`
(0.95, js/ui/workspace.js) applied to the window at the monitor's scale, expressed in buffer
texels as `0.95 * monitorScale / bufferScale` — with a hard ceiling of 2560 texels on the
longest side. The ceiling is calibrated against rendered corners: the arc turns visibly
polygonal below roughly 0.7 mask texels per screen pixel and is indistinguishable from a
full-resolution mask at 1.0, so 2560 keeps a 4K window's arc above that threshold and degrades
it gradually beyond. No per-frame work, no offscreen pass, no mipmap regeneration.

### Why the desktop keeps the offscreen clip

One policy, two mechanisms. Drawing the radius the window would have natively, instead of a blurred
approximation of it, is the same decision in both contexts (*The principles these decisions are made
under*, rule 2). The mechanism each context can use is not, and the split is deliberate rather than
an unfinished merge.

On the desktop the radius is drawn by the offscreen effect: the shader cuts the body out of the
window's FBO. That path costs two things, both known. It has to know which scale Mutter allocated
that FBO for - the texture is not the actor's box - so the clip reverse-solves the allocation from
the FBO's own extent and picks between candidate scales. And the window's content is resampled once
through the offscreen target, which at fractional scales can soften text: the cost
`prefer-crisp-text` names.

In the overview the radius is drawn by the mask on the window's own shaped texture instead. There is
no intermediate FBO and the mask is sampled by Mutter's own minification alongside the window
colour, so the preview is rounded and exactly as sharp as an undecorated one, and the path needs no
allocation scale to work.

The desktop cannot be moved onto it whole, for three reasons: an XWayland window cannot reach the
mask path at all; a window whose visible corners another surface paints - a picture-in-picture
window, for instance - would need a mask per surface, while the mask is a per-shaped-texture slot
and those surfaces do not share coordinates; and the 1px ring is drawn inside the offscreen shader,
with no equivalent on the mask path. The offscreen path therefore stays for the visible future, and
the scale inference bound to it stays with it.

That is not a duplicated implementation. The desktop layer answers "should this window be decorated
at all" - type, size floor, SSD ring, maximized, tiling - while the overview layer answers "can a
mask reach this window's corners". Those are different questions, and folding them into one decision
would be worse than the split: the eligibility layer would be answering a reachability question it
has no evidence for.

Revisit this if the mask path learns to cover XWayland and multi-surface windows, if the ring can be
drawn equivalently under it, or if the two layers are caught fixing the same defect in two places.

### Overview shadows via a preview shadow clone

The desktop shadow is a sibling of the window actor in `global.window_group`, so a preview's
`Clutter.Clone` of the window actor never carries it. A `Clutter.Clone` has one parent, so one
preview's clone of the shadow cannot be mounted under another: `overviewShadow.js` adds one
`Clutter.Clone` of the shadow actor per preview, as a child of that preview below
`window_container`, and overrides `vfunc_allocate()` to expand the thumbnail box by `SHADOW_PAD`
scaled to the preview. The extension mounts them by walking the stage for every actor carrying
`metaWindow === win && window_container` (`getOverviewPreviews`), so a window shown on all
workspaces - one preview per workspace - gets one clone each. The walk visits every actor in the
scene (2189 of them with five windows open on the machine this was measured on, 3.6ms a call), so
it runs only while the mounted set is smaller than the window's preview set can be (one, or the
workspace count for a window on all workspaces): a complete set costs no walk, and a preview built
after the pass is topped up on the next reconcile while the set is short. Beyond that the entry
that follows re-resolves it.
The clone paints the shadow's baked 8-slice mesh, so scaling it is a texture sample, not a
re-blur. It monkey-patches nothing: the allocation is a Clutter vfunc, not a GJS signal handler
recomputing matrices per frame, and the clone is a plain scene-graph child of the preview.

## One body, one authority

The clip and the shadow describe the same body, so they read it from the same call. The authority is chosen by `resolveBodyAuthority(targetRead, windowActorRead, resizeInFlight)`: the clip target's own read - the surface container - in steady state, and the window actor's read while a resize is in flight, because the actor takes its new size a frame or two before the container's allocation follows, so the actor is the fresh one and the cut must track the frame the user is dragging rather than the older, smaller box. The other read stays the fallback when the preferred one has no extent, exactly as `resolveClipSize` had it. The two body reads and the window's own size are taken live at paint (`resolvePaintBody`): `WindowDecoration` hands both cuts one plan - the reference points the hold compares against (`previousBody`, `previousAuthority`, `previousWindowSize`) and the consecutive pair-disagreement count that bounds the hold, owned by `BodyPlan` (`src/effects/bodyPlan.js`) and handed over as the pass found it, before it advances; the insets, scale and phase strategy travel through the setters as before - and the clip's `vfunc_paint_target` and the shadow's `_relayout` each settle the body from the live reads there, so the cast and its eight slices derive from the same body the cut is drawing that frame. The plan decides no body: it is the pass's data, and the geometry clock is the frame the compositor paints. Reading the window's own size live (`frameRect`, else `bufferRect`) matters because it is what separates a resize from a body that moved on its own, and a resize must be seen on the frame it starts rather than 50 ms later; only its previous value stays on the pass clock. Healthy agreement (`frameRect == bufferRect == windowActorAllocation`) produces a byte-identical cast, so nothing changes in the ordinary case.

A disagreement is not silent: when the authority and the shadow's own body differ by more than `SHADOW_BODY_TOLERANCE = 1.0` logical px, one WARNING per episode names both body extents, the window actor, and the signed delta, each with two decimals (agreement re-arms it). The tolerance is one logical pixel rather than the old half: at a fractional monitor scale the container's logical body is `buffer / scale` while the window actor's allocation is an integer, so the two differ by a sub-pixel residue by construction, and half a pixel sat below that and false-positived on ordinary windows. The observed defect is 2px, so 1.0 still separates it from normality. Health means it never fires — the e2e log audit treats an unexpected WARNING as a failure — and on a real machine it is what leaves the evidence when something outside our code moves one of the two.

**An unsettled body is not acted on.** The settle runs on the paint clock, but it holds the previous settled body while the pair is uncertain. When the container's read and the window actor disagree by more than `BODY_SETTLE_TOLERANCE` (1.0) logical px and no resize is in flight, at least one of the two reads is stale. The window's own size (`frameRect`, else `bufferRect`) is the independent reading that resolves it: whichever of the two reads matches it within the tolerance is the fresh one and is acted on, if exactly one does. When neither or both match, the disagreement is held, but not indefinitely - `WindowDecoration` counts consecutive passes and after `INVARIANT_STRIKES` (2) the window actor, the documented fallback for an unusable read, is preferred over holding forever. When the pair agrees but the body moved by `BODY_SETTLE_TOLERANCE` or more since the previous pass while the window's own size did not, the pair is stale together - a focus hand-off can leave both trailing by the same whole pixel, which the pair comparison reads as agreement - and the window's own size separates a moving body from a resizing window; when the window resized too, the body is genuinely new and is used. A resize in flight is the case the pair disagreement is already resolved: the window actor is the fresh read by construction, so the lagging container is expected and the actor is acted on instead of held. While a body is held the geometry path keeps the previous settled body: the clip's cut and the shadow's cast both keep the geometry they had, and the visible decoration does not shift. The fresh authority is still returned, so the body-authority warning above still fires and the journal keeps the record, and the between-pass hold re-reads the live quantities, so once the body stops moving the fresh body is acted on. A degenerate target read is the documented window-actor fallback, not a disagreement, and does not defer.

**The ring is held on the buffer's witness.** The ring is read in one pass, and its two inputs - the
buffer and the frame rect - can be updated a step apart, which leaves a ring that is a mixture of both
and shows as the window edge stepping in and back. A ring that moved while its witness stood still is
therefore held; any move at all re-opens the decision, so nothing latches. The witness has to be the
**buffer**: the ring is `buffer - frame`, so the buffer is the only quantity the ring's own pixels come
from. A rebuild moves it on every one of its steps - measured on an unmaximize, the frame stayed at
400x300 through nine ring changes (20 -> 25) while the buffer grew 440 -> 450 - whereas the frame can
stand still while the ring legitimately changes, so asking the frame whether the ring may move would
hold a correct ring indefinitely. A decoration dropped for a reading it could not take drops the
witness with it: the buffer it was compared against is gone, so a later hold cannot compare against a
subject this decoration never saw.

**The shadow is not resized to match; only its cast follows the authority.** That is deliberate, and it was verified rather than assumed: driving the authority larger than the shadow actor's own allocation in a nested session at 1.3333 (control 700×500; +28 ⇒ +28.5 logical px of visible shadow; +120 ⇒ +120) showed the added area is painted. `ShadowActor` overrides no paint volume, so a custom paint node is not clipped by the allocation, and the extra slices appear.

**A target read that changes in place must schedule a relayout.** `setClipTarget()` compares not only the target reference but the read it was given: the same container resized is a change, and an unknown↔known read is a change too. Without that comparison the shadow kept a stale cast while the clip — which re-reads its size at paint — moved its cut, which is exactly the "shadow edge shifts" symptom on a window whose target resized without the window actor following.

**The pass's own two reads must agree.** The body-authority warning above only fires when the authority has already moved away from the actor, so it is blind to the transient where *the authority itself* is briefly wrong: a Wayland window whose buffer rect lags its window actor allocation (or the reverse) has both cuts faithfully following a body that is 2px narrower, and nothing in the authority comparison can say which of the two reads was behind. Every pass that assembles a decoration reading therefore compares the window's `bufferRect` with the window actor's allocation (`bufferAllocationWarning`, `src/lib/diagnosticInvariants.js`): they are equal in health (`frameRect == bufferRect == windowActorAllocation`), so a disagreement names both extents and the window in one `[window-nativizer]` WARNING. Only the extents are compared — origins may legitimately differ by an animation's translation — and one pass is *not* enough: a resize in flight shows the buffer and the allocation settling one pass apart, so the latch requires `INVARIANT_STRIKES = 2` consecutive violating passes and re-arms on agreement. That keeps a real lagging read (which survives the next pass) loud and every resize silent.

**Reusing a reading is only sound where the consumers accept the same inputs.** Two resolvers in
one pass can name the same actor and still answer different questions: the clip's target resolution
refuses a surface container the *clip* cannot use (unallocated, off the buffer origin, not
integer-aligned) and falls back to the window actor, while the overview's opacity bypass lowers that
same container because the shaped texture still paints through it. "The same actor was already
resolved this pass" is therefore not by itself a reason to hand the answer over: where the acceptance
conditions differ, the second resolution is not duplication but a different question.

## Identifying the surface container

The container is not introspectable, so it is identified structurally, by one rule shared by the clip resolver and both phase readers (they take the same `St`, so `isForeignWidget` uses the live `instanceof St.Widget` branch everywhere instead of a global or a constructor-name guess):

1. exactly one non-foreign child of the window actor — that child, unchanged;
2. any non-foreign child without an allocation — return it, and the resolver defers, keeping the last good target (it may be the container waiting for its first buffer);
3. otherwise exactly one non-foreign child whose box passes `isCompatibleSurfaceGeometry` — that child, the container path;
4. none, more than one, or another child that is buffer-sized but off the buffer origin — null, and the clip falls back to the window actor.

Branch 3 is what separates Mutter's own fullscreen backing actor (a plain `Clutter.Actor`, non-foreign by type, monitor-sized, inserted by `do_sync_geometry` for a letterboxed fullscreen window) from the buffer-sized container. In the opaque-fullscreen shape both are monitor-sized, so two candidates pass and branch 4 falls back rather than guess. The residual, recorded rather than hidden: when a container is buffer-sized but off the buffer origin and another child is compatible, geometry cannot separate them, so that reconcile stays on the window-actor fallback — the known-worse phase path, where the two cuts can briefly part by the fractional-scale hairline. That is an appearance difference, never a deformation, and the next reconcile re-resolves.
