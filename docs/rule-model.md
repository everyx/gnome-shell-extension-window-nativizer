# The rule model

A rule is keyed by an application identity plus seven structural attributes of the
window, and its state names the axes whose automatic decision the user reversed. The
picker writes rules, the runtime matches them, and the settings layer sanitises them;
this is the shared description of what a key means.

## Key grammar

    <identity>:client_type=<wayland|x11>,window_type=<n>,has_parent=<bool>,allows_resize=<bool>,attached_dialog=<bool>,has_ring=<bool>,has_ssd=<bool>[,size=<W>x<H>]

For example:

    # Firefox main browser window (declares client shadow ring):
    firefox:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false,has_ring=true,has_ssd=false

    # Firefox Picture-in-Picture (PiP) window (compact borderless video surface without shadow margin ring):
    firefox:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false,has_ring=false,has_ssd=false

    # Fixed-size dialog with explicit dimensions:
    wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=false,attached_dialog=false,has_ring=false,has_ssd=false,size=360x420

- Field **order is part of the format**: `rules.js` renders it canonically, so string
  comparison is enough to match.
- **`has_ring=<bool>` distinguishes standard CSD windows from compact/PiP windows**:
  A standard CSD window reserves a margin ring for its own shadow (`buffer_rect - frame_rect > 0`,
  evaluated by `declaresOwnShadow()` in the runtime and `hasDeclaredMarginRing()` in the picker / frame layer). In contrast, media players, floating video popups
  (such as Firefox Picture-in-Picture), or borderless utility windows do not declare any shadow margin
  ring (`buffer_rect === frame_rect`). Incorporating `has_ring` separates these two kinds cleanly,
  preventing rules intended for browser main windows from unintentionally clipping or darkening PiP video surfaces.
- **Backward compatibility**: none. The key and the state grammar are the current
  shape only — an older key or an older state is dropped rather than migrated, which is
  what an unreleased model may do.
- **`has_ssd=<bool>` names a kind the compositor frames itself**: Mutter's own
  `Meta.Window.decorated` is true when it drew the frame (`mutter-x11-frames`), and that
  frame — not the client — runs the resize grab. The flag is part of the key so the
  preferences window can tell the kind apart and not offer a resize axis it could never
  act on. It is a policy flag, the best reading the GJS side has; an application that
  switches decoration mode becomes a different kind.
- An **attached dialog always has a parent** — Mutter only attaches a transient whose
  parent exists (`meta_window_should_attach_to_parent()`) — so `has_parent` and
  `attached_dialog` cannot vary independently: `attached_dialog=true` implies
  `has_parent=true`. That is why the prefs sentence can fold both into one phrase
  (`windowKindSentence()` in `prefs.js`) without losing a case.
- The **`size=<W>x<H>` specifier is exclusively for fixed-size windows** (`allows_resize=false`):
  One application often creates multiple distinct fixed dialogs or floating bars (e.g. login
  QR code dialog, screenshot toolbar, about box) that share identical window type and parent
  attributes. Because fixed-size windows cannot be resized by the user, their dimensions are
  inherently stable static fingerprints. Adding the logical dimensions (`frame_rect` width and
  height rounded to integers) distinguishes these dialogs without collision.
  Resizable windows (`allows_resize=true`) **must never** have a `size` specifier, as manual
  resizing would immediately invalidate the rule.
- **Matching priority and fallback**: For fixed-size windows, `resolveRule()` prefers an
  exact-size key first; if no exact match is stored, it gracefully falls back to a generic
  rule without size (if present).
- The identity is percent-encoded, because `:` and whitespace are delimiters.
  Realistic identities (WM_CLASS, Flatpak id, reverse-DNS app id) pass through
  unchanged; only exotic ones are escaped, and parsing decodes them back.
- `title` and `role` are deliberately *not* part of the key. They change while a window lives
  or across locales, so they cannot define a stable structural kind.

The rules live in one settings key, `window-rules` (`a{ss}`), fingerprint → state. The
old `suppress-rules` / `force-rules` pair is gone and its contents are not migrated:
a group plus a named axis has no equivalent in the axis form below. The `resize-band`
master switch is gone too: the band is the resize axis, reversed per kind like the rest.

## State grammar: the axes a rule reverses

A rule exists because the automatic decision is wrong for one window kind. Its state
names the axes to **reverse** — the runtime flips its own reading on each of them — in
canonical order, e.g. `corners,shadow`. An axis that is not named follows the automatic
decision, and a state naming nothing is the same as no rule, so it is never stored.
`parseRuleState()` and `buildRuleState()` in `rules.js` are the only place this grammar
is spelled out, so the settings layer, the picker and the runtime cannot disagree about
it.

Single principle: the user's disagreement beats the decision, wherever they disagree.
Each axis has exactly one decision and one way to overrule it, so a rule can never
record a no-op: naming an axis always changes something. Capability is not priority:
structural facts (window type, maximized/fullscreen, unresizable windows, SSD frames)
decide what *can* be done, and a reversal never overrides them — an axis the runtime
could not act on is not offered in the first place.

Why a reversal rather than a value: the automatic decision is fixed for a kind, so an
absolute pin could only ever restate it or contradict it. Restating it is a no-op, and it
has to be re-checked every time the heuristic moves; contradicting it is what a reversal
already means. Only the disagreement carries information, it stays meaningful when the
decision changes underneath, and the user can express it without first working out what
the decision was. The preferences window calls this *correcting a misjudgement*: an axis
row reads "Correct X", and its switch inverts that axis's decision.

A rule reverses only what it names. `corners` leaves the shadow to the decision, which
still takes it over when the corners it rounds were painted over the client's ring.
Taking the shadow of a client that declared a ring (`buffer_rect - frame_rect`) is the
one takeover that borrows the other axis: clearing that ring is the clip's job, so a
shadow-only reversal still attaches the clip, at radius 0, and leaves the corners as the
client drew them. The boundaries are listed in [decoration-model.md](decoration-model.md).

## One rule per window kind

A rule is keyed by the whole window kind, not by the application, because one
application routinely opens kinds that need opposite answers. WeChat is the example:
its main and chat windows run on Wayland while its article/browser windows run on
XWayland (with a declared 4px ring), and some of its dialogs are
self-decorated where others are not. An app-wide rule would have to be wrong for one
of them, so the picker writes exactly the kind it was pointed at and nothing else.

There is no direction any more, and so no collision to resolve: one kind has one row,
and that row names the axes to reverse (or follows the decision). A reversal overrides
the inferred baseline on its axis and nothing else — never the structural facts (window
type, maximized/fullscreen), never transient window state (tiled, tile-matched — the
rule outlives it and applies again on restore), never a user preference, never a policy. The same
direction guides the override layers themselves: we overrule the user only where
honouring the request would be meaningless — a structural disqualifier, a window state
(maximized, tiled, matched), or a window the user cannot see — never where the request
is merely imperfect. See [decoration-model.md](decoration-model.md).

## Identity

A rule is only as stable as the identity in its key. Resolution order:

1. what the window declares — `get_wm_class()` → `get_sandboxed_app_id()` →
   `get_gtk_application_id()`;
2. a **sibling of the same pid** — a popup shares its parent application, so the main
   window's WM_CLASS describes both. This keeps the identity stable across restarts
   without reading `/proc` or guessing toolkits;
3. `Shell.WindowTracker`'s app id, **rejecting** the `window:<n>` placeholders that
   Shell invents for windows it cannot attribute — they embed a session-local
   sequence number;
4. `pid-<pid>` as a last resort. It is session-scoped, so a rule keyed on it stops
   matching after a restart.

The identity is stored lowercased, so case is not part of what a key identifies: one
application can report itself as `WeChat` from one window and `wechat` from the next,
and those are one kind. Keys written before that was true are lowercased as they are
read, and the fingerprint has to match exactly.

The picker and the runtime must resolve identity through the same path
(`window.js` + `chooseWindowIdentity`), otherwise a rule created for a picked window
could never match it at runtime.

## The pick heuristic

Picking a window is the user telling us our judgement is wrong for this kind, so the pick
corrects every axis at once: it turns our automatic decisions off rather than retracting
only what happens to be on screen. A window we left square because it looked native comes
back rounded, because those corners were the judgement the user disagreed with.

### Never-Maintain-Status-Quo Principle

A user actively invoking the window picker to add a rule is demonstrably dissatisfied
with how the window currently looks. A pick therefore never produces a rule that changes
nothing: the suggestion is the full correction below, and a kind no axis can act on is
refused rather than stored.

**Correct every axis this kind can be corrected on**, and name nothing else. An axis the
runtime could not act on (the resize axis of an SSD frame or a fixed-size window, any axis
of a menu) is left out, because a rule naming it could not take effect.

`ruleAxisCapabilities()` is the one answer to "can this kind be corrected on this axis",
shared by the picker and by the preferences window's switches, so a suggestion can never
name an axis the window would not offer.

### Normalization and safety

The suggestion follows the window's **kind** — the transient state (maximized, tiled,
fullscreen) is normalized away, because a rule outlives transient states.

The guess is safe and ergonomic because:
1. **Never a no-op**: the suggestion names every axis the kind can be corrected on, and the
   pre-flight below refuses any state that would change nothing — a kind already corrected
   this way, or one whose remaining axes the runtime gates (fractional scale with crisp
   text, for the corners).
2. **Cheap to adjust**: The newly added/updated row in preferences is automatically focused
   and expanded, and each axis carries a switch that corrects it - deleting the row
   restores the automatic decision.
3. **Pre-flight verification**: The extension re-evaluates the proposed state via
   `suggestedRuleWouldChange()` before storing, refusing any rule that would have no physical
   effect on the target window kind. `suggestedRuleState()` and `suggestedRuleWouldChange()`
   in `detector.js` are pure and unit-tested; the inspector passes both answers over D-Bus with
   the picked window's properties (transient state rides along so prefs can toast that the rule
   applies on restore). A pick with no answer at all - a Shell that has not reloaded since an
   update - is refused too, rather than guessed at.

