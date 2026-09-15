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

your rules?                per window kind: which axes are ours
any policy?                tiled neighbour, crisp text on fractional scaling
rounding them?             the client's own ring is cleared exactly when the shadow is ours
                           └───────────────────────────────▶ draw
```

1. **Structural eligibility** — `checkDecorationEligibility()`. Window type,
   maximized/fullscreen, and a degenerate size (helper surfaces such as
   wl-clipboard's 1x1 transparent toplevel). These are facts about the window,
   and a user rule must never override them.
2. **Inferred baseline** — `inferDecorationBaseline()`. The two axes do not rest on
   the same kind of evidence, and each is answered only from its own:
   - **Shadows** are a *reading*, not an observation: the window declares a margin
     (`buffer_rect - frame_rect`), Mutter says whether it drew the frame instead (SSD),
     and Mutter paints the shadow of a bare X11 window unless one of `has_shadow()`'s
     gates excludes it (*Where we deliberately differ from Mutter*). A declared margin
     is read the way Mutter reads it, as the boolean `has_custom_frame_extents`: **any**
     declared margin is a ring, on one axis or both, 1px as much as 40px. That is why
     `declaresOwnShadow()` is `sideW > 0 || sideH > 0`, and why its reason string
     carries the measured margin and no threshold (`has-csd(4.0x4.0)`). A radius cannot
     answer this question: GTK4 floors a CSD window's margin at 12 logical px
     (`gtkwindow.c`: `shadow_width = MAX(css_extents, RESIZE_HANDLE_SIZE)`), so no
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
3. **User rules** — `src/lib/rules.js`. One state per window kind (`both`, `none`,
   `corners`, `shadow`) names which axes are ours. The only layer that may turn an
   axis back on.
4. **State modifiers** — inside `evaluateWindowActions()`. Applied last, on top of
   both of the above, because they are visual policies rather than inferences about
   who already paints what.

A rule overrides layer 2 and nothing else: it exists to correct a wrong reading or
inference, not to overrule a structural fact (layer 1) or a policy (layer 4). See
[rule-model.md](rule-model.md) for the four states and what each does to the ring.

## When a window's corners already look like ours

`nativeLikeCorners.js` answers this, and both the corner axis and the resize band's
eligibility consult it. Nothing here claims a window is native: most of what it detects
reimplements the Adwaita look outside GNOME. Every provider is a library the process maps,
and all of them are visible in the same place:

| Provider | How it is visible |
|---|---|
| libadwaita, libhandy | the process maps `libadwaita-1.so` / `libhandy-1.so` |
| Qt's Adwaita decoration | the process maps `wayland-decoration-client/libqadwaitadecorations.so`, or the same-named `libadwaita.so` plugin — a reimplementation that links no libadwaita, so only its own name gives it away |

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

## Which rectangle the clip lands on

The actor a clip is attached to is not the rectangle to round: for a client-side
decorated window it is the buffer, which is the body plus the ring the client filled
with its own shadow. `RoundedClipEffect` takes the body (`frame_rect`, expressed inside
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

**the ring is cleared exactly when the shadow is ours** (`clearRing` in
`evaluateWindowActions()`). With no rule in play, clipping a window that declared a ring
makes the shadow ours first, so an ordinary client-decorated window ends up with one
shadow matching the corners we drew. A rule decides the axes itself: `both` clears the
ring and draws our shadow, `corners` and `none` leave the shadow with the client and
leave its ring alone, and `shadow` clears the ring and draws ours while the corners stay
the client's. The clip is attached for that last one too, with radius 0: erasing the ring
is the clip's job and needs no corner cut. Our shadow is then cast for a square body,
because a square body is the shape we have.

| What the ring holds | Shadow ours? | What happens |
|---|---|---|
| the client's declared ring (`buffer_rect - frame_rect`, any positive margin on either axis) | yes | cleared, then our shadow is drawn: one shadow, for the corners we drew (for a square body, if a rule left the corners theirs) |
| the client's declared ring | no - it already looks like ours, or a rule left it theirs | untouched: its shadow still matches the shape it was painted for |
| none (a bare toplevel: no margin on either axis) | yes | nothing to clear; the actor is already the body |
| Mutter's own (`has-ssd-frame`, `x11-mutter-native-shadow`) | either | out of reach: that shadow is not in the window's texture |

The ring is a **declaration, not content**: `_GTK_FRAME_EXTENTS` on X11 and
`set_window_geometry` on Wayland both say "this much of my buffer is decoration", and
the client drew its frame there. Measured: WeChat's CEF window (X11, Depth 32,
extents `4,4,4,4`) paints a 1px decorated edge inside its ring, which clearing removes
along with the square corner it was drawn for.

Two consequences worth knowing. The shadow is cast by the **body**, not by the actor
(`setShadowInsets()` in `shadowActor.js`), or ours would be laid out around the ring the
client reserved - the same distinction the clip makes with `uFrame`. Both rectangles are
therefore derived once, in one pass, and the assumption that lets one rect serve both is
that a window we draw a shadow for does not have Mutter's own shadow padding its actor:
either the client declared extents (so Mutter drops its shadow) or the window reserved no
ring at all.

## Where we deliberately differ from Mutter

- **X11 / XWayland without custom frame extents & Server-Side Decorations (SSD).**
  With no rule we never paint a redundant shadow (`shadow: false`); who owns the
  visible one depends on the case. For SSD, Mutter's compositor draws none — `has_shadow()`
  (`meta-window-actor-x11.c`) returns FALSE once a frame exists (*"Let the frames
  client put a shadow around frames"*), and the frames client draws its own:
  a GTK window carrying the `ssd-frame` CSS class (`src/frames/meta-frame.c:570`),
  whose shadow comes from the GTK/Adwaita theme (`window.csd { box-shadow: … }`
  in libadwaita's `src/stylesheet/widgets/_window.scss`), not from the compositor. For a bare X11 window Mutter draws
  one only when every gate in `has_shadow()` (`vendor/mutter/meta-window-actor-x11.c:373-427`)
  passes: not maximized or fullscreen, no snap-tile match, no frames-client frame, an
  opaque window (not ARGB32), no custom frame extents declared, and not shaped.
  When it does, it is painted strictly outside the window square: only into the
  beneath-region (`shadow_clip`, strict clip), and it is a soft Gaussian blur of the
  window shape (`default_shadow_classes[]` in `src/x11/meta-shadow-factory.c`; *How a
  style change is drawn* gives its values), not an opaque square. Either way
  no square shadow sits under the corners we cut, so we clip the window's body with
  `RoundedClipEffect` to the native 15px (`window.radius` in
  `adwaitaStyle.generated.js`, `$button_radius(9)+6`), and the cut corners reveal
  desktop background. SSD is an inference (layer 2), not a
  structural fact as it once was: a rule may override it. So is the bare-X11 shadow,
  and overriding it with `both` or `shadow` adds ours on top of Mutter's — the user's
  explicit choice, not something we override; `corners` is the intended look there,
  leaving one shadow.
  X11 windows that *do* declare frame extents make Mutter drop its native shadow, and
  that declaration is exactly the ring we read (any positive margin), so those receive
  both our shadow and rounded corners, with the ring cleared.
- **A snap-tiled window loses the shadow it would get from us** when it has an
  adjacent match, following Mutter's own reasoning that the shadow would obstruct the
  neighbour (`meta-window-actor-x11.c`). A lone half-tiled window keeps the shadow on
  its outer edge. This only ever drops *our* shadow: a client that declared its own
  ring keeps it, because tiling is not the client's shape to answer for. Tiled windows
  are flat-cornered either way (*Which style applies*).
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
input region at `RESIZE_HANDLE_SIZE 12` (`gtkwindow.c`), GTK3 with adw-gtk3 takes 10px from the
theme's `decoration { margin: 10px }` - so that strip is the handle every native window offers.
A window whose own band is 4px wide, or absent, is resizable but awkward to grab.

So a window we decorate also gets a **resize band**: twelve transparent, reactive
rectangles around its body, exactly filling the 12px ring the frame grows. Four edges are 12
logical px deep, span the frame side between the corners and stop 24px short of each end;
each corner is two rectangles, because a corner reaches 24px along each edge next to it. The
geometry is pure (`lib/resizeBand.js`); one actor with twelve children applies it
(`lib/resizeBandActor.js`).

**The band is exactly GTK's input region.** `update_realized_window_properties`
(`gtkwindow.c`) builds a CSD window's input region as the border box grown by
`RESIZE_HANDLE_SIZE 12` on every side, and clicks outside it go through - so 12px out from
the body is as far as a band can reach, and as far as a pointer is delivered at all.

**Why a corner reaches 24px along the edge.** GTK's corner handle is
`RESIZE_HANDLE_CORNER_SIZE 24` (`gtkwindow.c`, *"How resize corners extend"*), and
`get_edge_for_coordinates` resolves by proximity: a pointer inside an edge's band is the
corner as soon as the other axis is within 24px of the frame's edge. A corner therefore owns
24px of each edge beside it - *along* the edge, not outward. We cannot spend that reach *into
the frame* - that surface belongs to the client, and claiming it is what breaks titlebar
drags, GTK window buttons and Chromium tab clicks - and we cannot spend it *outward* either:
`get_edge_for_coordinates` alone would extend a corner outward by the shadow, but the input
region stops at 12px, so that part of the shadow is click-through upstream. So each corner is
two regions, both only 12px deep: the 24px it takes along one edge, and the 24px it takes
along the other. That is what makes an approach to a corner read as a corner rather than as an
edge, the way the toolkit's own 8-way mapping does - and it is why the narrow strip hugging an
edge next to a corner belongs to the corner, not to the edge. The twelve regions are pairwise
disjoint, so a point has one direction.

**The one column where we differ from GTK.** `get_edge_for_coordinates` tests the reach of
the right and bottom corner with a strict inequality (`x > right - 24`, `y > bottom - 24`), so
the column at exactly `right - 24` is the edge there. Our corner region starts at
`right - rx` *inclusive*, so we call that one column the corner. (The left and top reaches
are `x < left + 24`, which is strict the other way, and there our half-open rectangles already
agree.) The two agree on every other pixel; we do not add a `+1` offset to match, because the
offset would have to be threaded through all twelve rectangles and every bound, for a single
pixel whose direction is one of the two it sits between anyway. The difference is pinned by a
test (`tests/resizeBand.test.js`) so it cannot drift silently.

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

Who gets one is a different question from what is drawn (`shouldShowResizeBand()`): a window
we decorate at all (a `none` rule, or one that fails structural eligibility, draws nothing and
keeps every click it had), resizable, not maximized, fullscreen, tiled or tile-matched, not
already Adwaita-looking (that window has a band), not an SSD window (Mutter drew the frame and
runs the resize grab from it), and not already declaring a margin of at least 12px per side.

That last condition is a **proxy**, not a measurement: the width of the client's own handle is
not introspectable (Chromium answers a 25px ring with a 10px border), so the rule only skips a
window whose declared margin is *obviously* wide enough - at least `RESIZE_BAND` **on every
side**, which is why the ring is read per side (`Math.min(left, right)`, `Math.min(top,
bottom)`) and not as the average of a two-sided total: a 0,24 ring averages 12 but has no
margin on one side. The source is the same reading the shadow axis uses (`insetsFromRects`
over `buffer_rect - frame_rect`), not a second path; only the per-axis aggregation differs
(`declaredSides()` gives the band the narrowest side and the shadow axis the widest, because
the two ask different questions).
Below the minimum, at least `2 * RESIZE_CORNER = 48px` per side - the floor that keeps the
corner reaches from overlapping, see below - and a 1×1 helper is not a window. The
`resize-band` setting turns the whole thing off.

**Why the floor is 48, not 24.** On a side shorter than twice `RESIZE_CORNER`, the two corner
reaches would overlap, so `computeResizeBands` halves them (`rx = min(c, w/2)`) and the two
corners split the short side evenly. That is safe geometry, but it is no longer GTK's: GTK's
`get_edge_for_coordinates` is first-match-wins with a fixed 24px (`x < left + 24` is tested
before the right corner), so on a 30px side it hands the first 24px to NW and only the rest to
NE, where we split the side 15/15. The direction would disagree with GTK, which is what this
model claims not to do. So a window with any side under 48px gets no band - a **deliberate
limit**, not a geometry floor: we would rather draw no band than one whose corner direction
disagrees with GTK's - and the halving stays only as a safety net for a caller that reaches the
geometry directly.

### It is the first thing here that takes clicks

Everything else is `reactive: false`: the shadow is painted, never picked, and until now "we
never participate in hit testing" was true of the whole extension. It is not true of the band.
Its twelve children are reactive, and it is inserted above its own window actor but below every
other window and below shell chrome, because it lives in `global.window_group`, which
`Main.layoutManager.uiGroup` keeps under the panel and the overview.

The cost is the ring the client does not cover. Inside the window's own surface those clicks
were the client's to begin with, so a band as wide as the toolkit's changes nothing there;
outside it, in the pixels that were **click-through on purpose**, a press now starts a resize
and never reaches what is under the cursor - typically a click on a desktop icon or on the
window behind, a few pixels outside the body. That is the trade the setting exists for.

### What the band cannot fix

The band is ours only from the frame outward. Inside the frame body the client's own hit
region and cursor still win, so where the client draws a different cursor family at its own
edge - WeChat's diagonal double-arrow is the measured example - crossing the frame boundary
still changes the cursor, from the client's inward region to our 12px outward one. Owning that
inner boundary would mean taking the client's whole border band over, and that band is also its
titlebar drag surface and, on Chromium and GTK, its tab strip and window buttons; taking it
breaks them. The mismatch is left where it is.

## Known boundaries

What this model cannot do, stated rather than papered over. Most of these follow from
the reading being one-sided; the last is simply not verified yet.

- **A client that draws its own decoration inside its surface without declaring a
  margin** cannot be told apart from one that draws none. Nothing in the window's
  geometry or in Mutter distinguishes them, so the baseline adds our decoration next
  to theirs. A `none` rule is the only remedy.
- **A declared ring that is padding rather than a shadow** reads as a ring, and `both` -
  or the automatic takeover - clears it along with the corners. If the client painted
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
  `_frameInsets()` answers null only when the frame does not fit inside the buffer at all;
  the guard keeps the clip from cutting a ring it cannot place. A framed X11 window is not
  that case: Mutter sets `buffer_rect = frame->rect`, and `frame->rect` is the frame grown
  by the frame's **invisible borders** (`window-x11.c`, `meta-x11-frame.c`), so the insets
  are that border width (≥ 0) and the body lands exactly on `frame_rect`. Measured in the
  nested session on a GTK3 SSD window: frame 500×437, buffer 550×487, insets 25 on each
  side, and the surface child the clip attaches to is buffer-sized (550×487) - the clip
  cuts the frame rect, not the client surface, so it is not new harm. It no longer consults
  any actor size: the body is placed against the actor's live size at paint time, so a
  resize cannot turn this into "no body" for a frame. A window that *declared* a ring gets
  no shadow in a pass without a clip (`clearRing` without a clip defers it). Tiled windows
  reach a square-corner-with-shadow look on purpose (`style.tiled` has radius 0 and
  no outline, *Which style applies*), as does `prefer-crisp-text` on a fractional
  monitor and a `shadow` rule.
- **A tiled window whose client keeps its own shadow keeps it.** Tiling only ever
  drops the shadow we would draw; it does not clear the client's ring.
- **X11 with HiDPI: the units of the margin reading are unverified.** On Wayland the
  margin is already in logical pixels and answers "declared or not" directly (*The
  margins, and the scale question*); whether an X11 / XWayland window on a scaled
  monitor reads the same way has not been checked.

## The margins, and the scale question

`computeInsets()` reads `buffer_rect - frame_rect`. MetaWindow scales both
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
larger than it is — never smaller. Since the reading is only "positive or not",
that error cannot change an answer: a declared margin stays declared and a zero
stays zero.

## Which style applies

`style.js` turns a window state into the parameters we draw, tracking libadwaita's
`window.csd` so a decorated window looks like a native one. The precedence mirrors
libadwaita's own CSS selectors:

    fullscreen > maximized > tiled > focused | backdrop

The result is `{radius, shadows, outline}`: the corner radius, up to three shadow
layers (`{blur, spread, alpha}`), and the outline libadwaita paints around a
decorated window. Fullscreen and maximized windows get neither outline nor
shadows — they are flush with the screen edge, where a shadow would be a line on it.
Tiled windows drop the outline and rounded corners (radius 0), retaining only the 1px
border shadow unless matched with an adjacent tile.
High contrast — upstream's `@media (prefers-contrast: more)` — replaces the shadow set
and deepens the outline from 7% to 30%.

## What the decoration costs

One offscreen per decorated window, plus one baked buffer per shadow style for the whole
session:

| Part | Where | Size |
|---|---|---|
| clip | `clipEffect.js`, on the window actor (surface child on X11) | window size + 3px, ~8.3 MB at 1920x1080 |
| shadow | `shadowTexture.js`, baked once per style | 145x145, ~82 KB, shared by every window |

The clip pass is skipped when there is nothing to clip (radius 0 and no outline) and a
window with no shadow never touches a baked buffer. It costs nothing while nothing
damages the window: it is one framebuffer, re-rendered whole whenever the window paints,
local damage included. Measured against one 500x350 target (`pnpm run benchmark:perf`):
no idle CPU difference, about 0.9 ms of shell CPU per frame while dragging a resize, and
the framebuffer's size in the shell's memory.

That per-window cost is what `nativeLikeCorners.js` exists to avoid paying where the
clip would be an identity — a window already drawn with libadwaita's radius.

The shadow's buffer is small because a shadow is a blurred rounded rectangle: its pixels
depend on the window's size only through the length of its straight edges, so four corners
and a one-pixel strip from each edge describe the whole shape and the strips stretch. That
is Mutter's approach as well: `MetaShadow` (`src/x11/meta-shadow-factory.c`) is a
`CoglTexture` rendered once and painted as a nine-slice. The bake draws the same GLSL the
generator takes from GTK4, so this stays the upstream shadow, computed once instead of
every frame.

Mutter never needs the clip pass, and Shell 50 ships no rounded-clip effect (the
typelib has `BlurEffect` and nothing else): a window that decorates itself also rounds
itself and arrives with alpha, so the compositor has nothing left to clip. Decorating
windows that do not round themselves is what makes an offscreen pass inherent here.

## How a style change is drawn

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

- **St has no CSS transitions.** The shell's CSS engine parses no `transition` property,
  so `transition: box-shadow 200ms ease-out` cannot be written for it; the only
  `ClutterTransition` in `src/st/` belongs to `st-adjustment.c`, which animates a value
  from JS. The fade therefore has to be driven from our own code.
- **St's `box-shadow` is a different blur, and no cheaper.** It is pre-rendered into a
  cached pipeline the way ours is (`_st_create_shadow_pipeline` in
  `st-theme-node-drawing.c`, painted through a `ClutterPipelineNode` in the same file), but
  the blurring is St's own, not GTK4's, and the shell's own theme never uses the property.
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
a `none` rule - the one-sided error above, with the remedy that fits it.
