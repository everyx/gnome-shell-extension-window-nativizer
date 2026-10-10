# How a window's decoration is decided

Background for `src/lib/detector.js`. The decisions live in the code; this records
the model they implement, and the places where it deliberately diverges from what
Mutter does, so a change there does not have to rediscover them.

> ego-lint warns when a file is more than half comments. `detector.js` is mostly
> policy, and policy wants reasons, so it sits near that line: rationale the call
> site does not need belongs here rather than in the module.

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
     and Mutter paints the shadow of a bare X11 window unless one of `has_shadow()`'s
     gates excludes it (*Where we deliberately differ from Mutter*). A declared margin
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
the client drew its frame there. Measured: WeChat's CEF window (X11, Depth 32,
extents `4,4,4,4`) paints a 1px decorated edge inside its ring, which clearing removes
along with the square corner it was drawn for.

Two consequences worth knowing. The shadow is cast by the **body**, not by the actor
(the shadow layout in `shadowActor.js`), or ours would be laid out around the ring the
client reserved - the same distinction the clip makes with the body rectangle. Both rectangles are
therefore derived once, in one pass, and the assumption that lets one rect serve both is
that a window we draw a shadow for does not have Mutter's own shadow padding its actor:
either the client declared extents (so Mutter drops its shadow) or the window reserved no
ring at all.

## Where we deliberately differ from Mutter

- **X11 / XWayland without custom frame extents & Server-Side Decorations (SSD).**
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
  structurally ineligible (`maximized/fullscreen`). For a bare X11 window (no SSD, no
  extents), Mutter paints its native shadow strictly outside the window square into the
  beneath-region; that shadow is out of reach, so a bare window without a rule retains
  Mutter's native shadow.
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

**Mutter's X11 shadow.** A bare X11 window - undecorated, no declared margin - keeps the shadow
Mutter paints for it, which is what happens to a client that draws its own frame without declaring
`_GTK_FRAME_EXTENTS` (Electron under X11). That shadow is out of our reach: the compositor draws it
outside the window square, GJS cannot clear it, and adding ours would put two where there is one.
Its visible cost is the focus transition: Mutter holds a focused and an unfocused shadow and swaps
the two objects without easing, so such a window drops its halo in a single step where every window
we decorate fades. A rule cannot fix it either - the shadow axis retracts ours, and forcing it here
would add rather than replace.

**Solid CSD.** `window.solid-csd` gets an inset border rather than a shadow, and the reason is
stronger than "the class belongs to the client": the class is not reachable in this session at all.
GTK4 adds it in `gtk_window_enable_csd()` (`vendor/gtk/gtkwindow.c`), in the branch opposite `.csd`,
gated on `gtk_window_is_composited()` - which is `gdk_display_is_rgba() &&
gdk_display_is_composited()`. A display fails that gate by having no alpha, or by having no
compositing manager owning `_NET_WM_CM_S0` on the root window, and neither can happen under Mutter:
Wayland is always alpha and always composited, and on X11 Mutter itself owns that selection, while
alpha is a property of the display rather than of a window. The solid branch is dead code for every
window this extension manages, so there is nothing to detect and nothing to approximate.


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
  then 0x0. On X11 that lands in the bare case where we decline to paint, so such a
  window keeps our corners and gets no shadow at all.
- **A client whose own corners are larger than ours** keeps a sliver of its shadow
  just inside our arc, where clearing cannot reach: erasing it would need its measured
  corner radius, which we do not have.
- **A window whose body cannot be placed inside its buffer is never rounded.**
  The margin reading answers null when the frame does not fit inside the buffer at all;
  a rect read that throws is caught where the inputs are gathered, so the window is skipped —
  same outcome: the body cannot be placed;
  the guard keeps the clip from cutting a ring it cannot place. A framed X11 window is not
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
- **X11 with HiDPI: the units of the margin reading are unverified.** On Wayland the
  margin is already in logical pixels and answers "declared or not" directly (*The
  margins, and the scale question*); whether an X11 / XWayland window on a scaled
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
Flat ringless windows (`hasRing=false`, `clearRing=false`, such as WeChat) apply a 1px safe inward inset (`FLAT_SAFE_INSET`) to excise client-drawn rectangular borders outside the clip body. With the client's rigid rectangular stroke excised, the window receives the native Adwaita inner white outline and box shadow across its entire perimeter, eliminating double-line stroke artifacts, corner seam gaps, and cut-point white fringes.

## What the decoration costs

One offscreen per decorated window, plus one baked buffer per shadow style for the whole
session:

| Part | Where | Size |
|---|---|---|
| clip | `clipEffect.js`, on the window actor (surface child on X11) | window size + 3px, ~8.3 MB at 1920x1080 (also paints inner outline) |
| shadow | `shadowTexture.js`, baked once per style | 145x145, ~82 KB, shared by every window (pure Gaussian diffuse shadow) |

The corner-clipping pass is skipped when there is nothing to round (radius 0 and no outline);
the effect is still attached at radius 0 when a client ring has to be cleared.
A window with no shadow never touches a baked buffer. It costs nothing while nothing
damages the window: it is one framebuffer, re-rendered whole whenever the window paints,
local damage included. Measured against one 500x350 target (`pnpm run test:perf`):
no idle CPU difference, about 0.59 ms of shell CPU per frame while dragging a resize (five
counterbalanced rounds of `pnpm run test:perf`, the shell's CPU read from schedstat
nanoseconds; the 0.9 ms recorded earlier came from a jiffy clock that cannot resolve it), and the
framebuffer's size in the shell's memory. The harness' budget for that is 120 ms per 150 frames,
which the measured 88 ms leaves about a third of.

That per-window cost is what `nativeLikeCorners.js` exists to avoid paying where the
clip would be an identity — a window already drawn with libadwaita's radius.

The shadow's buffer is small because a shadow is a blurred rounded rectangle: its pixels
depend on the window's size only through the length of its straight edges, so four corners
and a one-pixel strip from each edge describe the whole shape and the strips stretch. That
is Mutter's approach as well: `MetaShadow` (`src/x11/meta-shadow-factory.c`) is a
`CoglTexture` rendered once and painted as a nine-slice. The bake draws the same GLSL the
generator takes from GTK4, so this stays the upstream shadow, computed once instead of
every frame. In `clipEffect.js`, the 1px SDF AA ramp is restricted strictly to corner arcs,
preserving 100% sharp content alpha on straight edges to prevent subpixel dragging blur from
double-resampling under fractional scaling. Concentric corner alignment and zero-leak clipping are
guaranteed by `clipEffect.js`'s snapping rule locking the physical pixel grid with the shadow
actor, and symmetric physical margin snapping (`snapActorBodyFrame` in `lib/snap.js`)
locks identical per-side cuts onto the device grid, completely excising Cairo half-pixel stroke residue
under fractional scaling while keeping clip body and shadow body strictly unified. To further prevent
GPU hardware bilinear filtering from bleeding external client stroke pixels inward across fractional
boundaries, the fragment shader pushes texture sampling coordinates inward along the boundary normal,
leaving edge transitions completely clean.

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

`has_shadow()` also gates on ARGB32 windows, shaped windows, and
`has_custom_frame_extents`, none of which GJS can see. Those are the windows where
something else is painting and the reading layer 2 makes cannot say so: reimplementing
the gate partially would add a second shadow rather than skip one, so they are left to
a reversed shadow axis - the one-sided error above, with the remedy that fits it.

## Overview downscaling and offscreen effects

When GNOME Shell enters the Overview, window preview clones are rendered downscaled to
around ~0.25x scale.

Mutter's `MetaShapedTexture` (`src/compositor/meta-shaped-texture.c`) handles native window
scaling with high visual fidelity: when downscaled below 0.5x, if `create_mipmaps` is enabled,
it switches its minification filter to `COGL_PIPELINE_FILTER_LINEAR_MIPMAP_NEAREST` (bilinear
mipmapped filtering), ensuring sharp and alias-free thumbnails.

However, our clip effect subclasses a shader effect (which inherits `Clutter.ShaderEffect` on GNOME 51+ or `Shell.GLSLEffect` on 45–50, deriving from `Clutter.OffscreenEffect`).
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

### Retaining rounded corners with hardware mipmapping

To achieve seamless visual consistency with Libadwaita / native CSD windows in Overview thumbnails, the extension retains rounded corners in the overview by default and eliminates downsampling blur through hardware mipmapping:

- **Visual consistency and anti-aliasing quality**: While a 12–15px corner radius mathematically shrinks to ~2–3 logical pixels at ~0.25x thumbnail scale, unclipped 90° rectangular corners create an immediate visual anomaly when positioned directly adjacent to native GTK4/Libadwaita windows (which consistently render rounded corners in overview). Furthermore, when fewer windows are open or when preview cards occupy substantial viewport space, the absolute on-screen prominence of the corners increases significantly. Historically, disabling the clip effect in overview was chosen not because rounded corners were deemed imperceptible, but because bilinear downsampling of an un-mipmapped FBO degraded the 2–3px curves into noisy, aliased artifacts and blurred text. By solving downsampling aliasing at the root through hardware mipmapping, retaining rounded corners achieves both visual consistency and clean edge antialiasing.
- The clip effect remains attached during overview; the decoration is put into mipmapping mode rather than having its clip disabled.
- When entering overview, the manager informs every active decoration.
- Reusing the desktop convention (no outline on tiled/maximized windows), the decoration drops its outline during overview. This completely eliminates subpixel edge fringing and strobing on downscaled ~0.25x thumbnails while preserving crisp rounded corners. Upon returning to the desktop, the normal 1px inner outline is restored seamlessly.
- On each paint, the clip effect dynamically sets its Cogl pipeline's minification filter to `COGL_PIPELINE_FILTER_LINEAR_MIPMAP_LINEAR`.
- **LOD and perimeter antialiasing preservation**:
  - The inward normal sampling offset (`clearStroke`) is strictly suppressed (`clearStroke = false`) during overview. Because Cairo stroke bleed is sub-pixel in miniature thumbnails, normal sampling displacement is unnecessary and would otherwise introduce non-linear coordinate discontinuities across 2x2 fragment quads, triggering false mipmap LOD spikes (blur halos) on thumbnail edges.
  - While desktop straight edges utilize hard step cutoffs to prevent bilinear dragging blur, overview thumbnails restore smooth physical antialiasing across the entire perimeter (`uOverview = 1.0`), eliminating downscaling jaggies, moiré strobing, and corner-to-edge transition kinks.
  - Subpixel actor grid translations are locked to zero during overview to keep thumbnail bounding boxes phase-stable across animations.
- **Cogl cost model**: rendering into the offscreen marks its texture dirty, so with a mipmapped minification filter active Cogl regenerates the mipmap chain on each preview redraw. A static preview pays nothing; a window still committing damage while the overview is open (video, UI animation) regenerates the chain every frame, proportional to its buffer area. The automated benchmarks measure desktop composition, not overview GPU load.
- This hardware mipmapping drastically reduces downsampling moiré and aliasing in the ~0.25x overview clone without monkey-patching GNOME Shell's `WindowPreview` or introducing multi-pass FBO overhead.
- When exiting overview, the override stops. On the next paint frame, Mutter's `ClutterOffscreenEffect.pre_paint` (`ensure_pipeline_filter_for_scale()`) automatically restores the standard `NEAREST` / `LINEAR` filter, ensuring zero mipmap generation overhead during normal desktop composition.

### Why window shadows are omitted in overview

While native Libadwaita / GTK4 windows appear with faint shadows in GNOME Shell's Overview, non-CSD windows decorated by this extension appear as clean, flat rounded cards. A natural architectural question arises: **Why can rounded corners be retained in overview with virtually zero overhead, whereas window shadows cannot be implemented with similarly low performance impact?**

This asymmetry stems from fundamental compositor actor topology and pipeline mechanics, as well as the steep runtime penalties of alternative approaches:

#### 1. First-principles analysis: Intra-actor vs. Extra-actor topology

The reason rounded corners can piggyback on Mutter's native pipeline while shadows cannot is fundamentally topological:

- **Rounded corners are an *intra-actor* operation**:
  - The clip effect operates directly on `MetaWindowActor`. Its bounding box is fully contained within the client window's buffer rectangle (`buffer_rect`).
  - In Mutter's overview architecture (`ShellWindowPreviewLayout.c` / `WindowPreview.js`), GNOME Shell constructs window previews using `clutter_clone_new(window_actor)`. Because the clip effect's offscreen FBO texture is the rendering target of the cloned host actor itself, Mutter's C layout pipeline automatically and seamlessly inherits the clipped texture in the clone.
  - No additional actors, no extra scenegraph nodes, no external layout calculations, and no GJS per-frame matrix tracking are required. The only adaptation needed is switching the hardware mipmap sampler filter in GPU fragment shading.

- **Window shadows are an *extra-actor* operation**:
  - Non-CSD windows (X11 / Xwayland or Wayland clients without client-side decorations) report zero frame extents (`_GTK_FRAME_EXTENTS = 0`). Their physical buffer boundary ends sharply at the window frame.
  - A natural drop shadow must extend 30–60 pixels outward in all directions beyond the window edge. To prevent this expanded area from corrupting compositor input picking (which would cause clicks near window edges to be misrouted) and to decouple shadow state from desktop tiling/maximization, shadows cannot be rendered inside the window actor; they must be managed as separate external sibling actors (the shadow actor lives in `global.window_group`, not `Main.uiGroup`).
  - GNOME Shell's C layout manager (`ShellWindowPreviewLayout`) strictly manages and clones only `MetaWindowActor`. It has no knowledge of external sibling actors. Consequently, shadows are inherently omitted from native preview cloning.

#### 2. Evaluation of potential low-overhead shadow implementations

To explore whether a low-overhead shadow mechanism is possible, we evaluated four potential technical routes:

| Implementation Route | Mechanism | Performance Impact & Feasibility | Verdict |
| :--- | :--- | :--- | :--- |
| **A. Injected Shadow Clone**<br>*(e.g., Rounded Window Corners Reborn)* | Monkey-patch `WindowPreview` to instantiate a secondary `Clutter.Clone` of the shadow actor under each preview card. | **High CPU overhead & stability hazard**: Mutter's C layout manager (`ShellWindowPreviewLayout.c`) only animates and transforms the recognized `window_actor`. Non-window children fall into a fallback branch with fixed sizing. To scale the shadow with the preview card, the extension must hook `scale-x`, `scale-y`, and `allocation-changed` signals in GJS, computing floating-point transformation matrices in the JavaScript main loop on every animation frame (at 144Hz/240Hz, this causes CPU spikes, frame drops, and GC jank). Furthermore, monkey-patching `WindowPreview` breaks cross-version compatibility across GNOME 45–48+, triggers ghost `Clutter.Actor is disposed` crashes during drag-and-drop or workspace switching, and severely conflicts with extensions like Dash to Dock, V-Shell, and Tiling Shell. | ❌ Rejected (High CPU load & severe instability) |
| **B. Intra-actor Shadow Effect**<br>*(Combine shadow into `MetaWindowActor` FBO)* | Expand the FBO bounding box of the clip effect outward by 30–60px padding to draw blurred shadows directly in the shader. | **Prohibitive GPU memory bandwidth & input corruption**: Padding an FBO by 60px on all sides increases the offscreen surface dimensions drastically. On a 4K display, a standard 2560×1440 window FBO area expands by over 20–30%, resulting in millions of additional pixels read and written to offscreen memory each frame. Crucially, expanding the actor allocation breaks desktop pointer picking (shadow fringes intercept mouse events intended for adjacent windows) and makes it impossible to cleanly peel off shadows when windows are tiled or maximized. | ❌ Rejected (Excessive GPU bandwidth & broken desktop input) |
| **C. Shell Theme CSS `box-shadow`** | Apply CSS `box-shadow` to the preview container (`.window-preview`) in the overview stylesheet. | **Double-shadow visual artifacts & software blur**: Clutter / `St.Widget` handles CSS box-shadows inefficiently (often falling back to CPU software-blurred surfaces), causing micro-stutter when opening the overview with many windows. More fatally, native GTK4/Libadwaita windows already contain client-side shadows inside their Wayland buffers; applying a CSS shadow unconditionally causes jarring "double shadows" around native apps, and visually encapsulates floating preview UI elements like the close button. | ❌ Rejected (Unacceptable visual artifacts & CPU blur) |
| **D. Flat Rounded Card**<br>*(Adopted design)* | Retain rounded corners via the native `Clutter.Clone` hierarchy with hardware mipmapping; omit drop shadows in overview. | **Near-zero overhead & zero invasiveness**: Reuses Mutter's existing native clone with zero extra actors, zero GJS matrix tracking, zero monkey-patching, and zero allocation inflation. Mipmapping is handled entirely in GPU texture units on demand. | ✅ Adopted (Optimal performance & full stability) |

#### 3. Alignment with modern human interface guidelines

Beyond performance and compositor mechanics, omitting outer drop shadows in multi-tasking overview modes aligns with contemporary interface design conventions:
- When the overview opens, the desktop background is dimmed and blurred, shifting the visual paradigm from floating, layered desktop windows to a clean, structured workspace grid.
- Modern multitasking interfaces (such as macOS Mission Control, iOS App Switcher, and ChromeOS Overview) consistently favor crisp, flat, rounded preview tiles over heavy cast shadows to minimize visual noise and enhance spatial legibility.
- By retaining smooth, anti-aliased rounded corners without monkey-patching GNOME Shell's layout engine, this extension achieves full geometric harmony with native Libadwaita preview tiles at maximum runtime efficiency and zero crash risk.


