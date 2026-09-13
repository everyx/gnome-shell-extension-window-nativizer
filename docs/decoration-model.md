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
     and a bare X11 window has its shadow painted by Mutter. One part of that reading is
     ours, not Mutter's: Mutter asks only whether frame extents exist at all
     (`has_custom_frame_extents`, true for 4px as much as for 40px), whereas a margin
     counts as a shadow ring here only when it reaches Mutter's smallest window shadow
     radius on both axes. The axis is then **one-sided**: "something else already paints
     one" is reliable, while "nobody does, so we add one" misses a client that draws its
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

`nativeLikeCorners.js` answers this, and only the corner axis consults it. Nothing
here claims a window is native: most of what it detects reimplements the Adwaita look
outside GNOME. Two kinds of thing provide that look, and they are visible in
different places:

| Provider | How it is visible |
|---|---|
| libadwaita, libhandy | the process maps `libadwaita-1.so` / `libhandy-1.so` |
| Qt's Adwaita decoration | the process maps `wayland-decoration-client/libqadwaitadecorations.so`, or the same-named `libadwaita.so` plugin — a reimplementation that links no libadwaita, so only its own name gives it away |
| a theme that copies libadwaita's stylesheet (adw-gtk3 and its variants) | nothing inside the process changes; only the configured `gtk-theme` name says so |

The theme branch is gated on the process mapping a GTK library. Qt, Chromium and
Electron never read that theme, and without the gate a Qt window would be skipped just
because the user's GTK theme happens to be an Adwaita copy.

Reading the theme *name* rather than the window's declared margin is deliberate. The
margin does track the effective theme — measured on one GTK4 program with only the
theme changed: adw-gtk3 declares 25px per side, the stock themes 14/12 — but it cannot
say *which* theme produced it: Chromium's tab-strip shadow declares 24px on one axis
while its corners are 8px. A name is also a fact about the configuration, which is what
an inference about the configuration should rest on.

Both branches read the process, not the window, so a process that maps libadwaita and
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
| the client's shadow (`buffer_rect - frame_rect` at or above Mutter's minimum inset on both axes) | yes | cleared, then our shadow is drawn: one shadow, for the corners we drew (for a square body, if a rule left the corners theirs) |
| the client's shadow | no - it already looks like ours, or a rule left it theirs | untouched: its shadow still matches the shape it was painted for |
| too narrow to be a shadow (a resize grip, or nothing) | either | untouched: nothing to own, and the client may have drawn in it |
| none (a bare toplevel) | yes | nothing to clear; the actor is already the body |
| Mutter's own (`has-ssd-frame`, `x11-mutter-native-shadow`) | either | out of reach: that shadow is not in the window's texture |

Two consequences worth knowing. The shadow is cast by the **body**, not by the actor
(`setShadowBody()` in `shadowActor.js`), or ours would be laid out around the ring the
client reserved - the same distinction the clip makes with `uFrame`. Both rectangles are
therefore derived once, in one pass, and the assumption that lets one rect serve both is
that a window we draw a shadow for does not have Mutter's own shadow padding its actor:
either the client declared extents (so Mutter drops its shadow) or the window reserved no
ring at all.

## Where we deliberately differ from Mutter

- **X11 / XWayland without custom frame extents & Server-Side Decorations (SSD).**
  We never paint a redundant shadow (`shadow: false`); who owns the visible one
  depends on the case. For SSD, Mutter's compositor draws none — `has_shadow()`
  (`meta-window-actor-x11.c`) returns FALSE once a frame exists (*"Let the frames
  client put a shadow around frames"*), and the frames client draws its own:
  a GTK window carrying the `ssd-frame` CSS class (`src/frames/meta-frame.c:570`),
  whose shadow comes from the GTK/Adwaita theme (`window.csd { box-shadow: … }`
  in libadwaita's `src/stylesheet/widgets/_window.scss`), not from the compositor. For bare X11 windows Mutter does draw
  one, but strictly outside the window square: it is painted only into the
  beneath-region (`shadow_clip`, strict clip), and it is a soft Gaussian blur of the
  window shape (`default_shadow_classes[]` in `src/x11/meta-shadow-factory.c` gives a
  normal window `{radius 10, opacity 128}` focused), not an opaque square. Either way
  no square shadow sits under the corners we cut, so we clip the window's body with
  `RoundedClipEffect` to the native 15px (`window.radius` in
  `adwaitaStyle.generated.js`, `$button_radius(9)+6`), and the cut corners reveal
  desktop background. SSD is an inference (layer 2), not a
  structural fact as it once was: a rule may override it.
  X11 windows that *do* declare frame extents (WeChat's 4px resize grip) make Mutter drop its
  native shadow, so those receive both shadow and rounded corners.
- **A snap-tiled window loses the shadow it would get from us** when it has an
  adjacent match, following Mutter's own reasoning that the shadow would obstruct the
  neighbour (`meta-window-actor-x11.c`). A lone half-tiled window keeps the shadow on
  its outer edge. This only ever drops *our* shadow: a client that declared its own
  ring keeps it, because tiling is not the client's shape to answer for. Tiled windows
  are flat-cornered either way (*Which style applies*).
- **Corner clipping is skipped under fractional scaling** when the user prefers
  crisp text: the offscreen pass is what blurs text at non-integer scales.

## Known boundaries

What this model cannot do, stated rather than papered over. Most of these follow from
the reading being one-sided; the last is simply not verified yet.

- **A client that draws its own decoration inside its surface without declaring a
  margin** cannot be told apart from one that draws none. Nothing in the window's
  geometry or in Mutter distinguishes them, so the baseline adds our decoration next
  to theirs. A `none` rule is the only remedy.
- **A ring at or above the threshold that is padding rather than a shadow** reads as a
  shadow, and `both` - or the automatic takeover - clears it along with the corners.
  If the client painted something in there, that something goes too.
- **A ring below the threshold that does hold a small shadow** reads as not-a-shadow,
  so we add ours on top of the client's: two shadows, not one.
- **A client whose own corners are larger than ours** keeps a sliver of its shadow
  just inside our arc, where clearing cannot reach: erasing it would need its measured
  corner radius, which we do not have.
- **A tiled window whose client keeps its own shadow keeps it.** Tiling only ever
  drops the shadow we would draw; it does not clear the client's ring.
- **An application that links GTK yet draws its own frame** is skipped by the Adwaita
  look probe whenever the configured GTK theme is an Adwaita copy such as adw-gtk3
  (measured on Chromium: 8px corners, a 24px tab-strip shadow). Picking one of its
  windows once is the correction.
- **X11 with HiDPI: the units of the margin reading are unverified.** On Wayland the
  margin is already in logical pixels and compares directly against the logical
  threshold (*The margins, and the scale question*); whether an X11 / XWayland window
  on a scaled monitor reads the same way has not been checked.

## The margins, and the scale question

`computeInsets()` reads `buffer_rect - frame_rect`. MetaWindow scales both
rectangles by the same window geometry scale, so their difference is the margin the
client declared. That scale is 1 whenever the logical monitor layout is LOGICAL,
and the native backend always reports that
(`meta-window-wayland.c`, `get_window_geometry_scale_for_logical_monitor`) — so on
Wayland the margin is already in logical pixels and compares directly against the
logical threshold.

A backend that lays monitors out physically scales the margin by the integer
monitor scale instead. GJS cannot read that scale:
`meta_backend_is_stage_views_scaled()` is private, and the layout mode is not in
the GIR. The margin is therefore left as it comes, which on such a backend reads
larger than it is — never smaller — so the error stays on the side of declining to
draw.

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

Mutter never needs the clip pass, and Shell 45-50 ships no rounded-clip effect (the
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
