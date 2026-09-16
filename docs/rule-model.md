# The rule model

A rule is keyed by an application identity plus five structural attributes of the
window, and its state names which decoration axes are ours. The picker writes rules,
the runtime matches them, and the settings layer sanitises them; this is the shared
description of what a key means.

## Key grammar

    <identity>:client_type=<wayland|x11>,window_type=<n>,has_parent=<bool>,allows_resize=<bool>,attached_dialog=<bool>

For example:

    wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false

- Field **order is part of the format**: `rules.js` renders it canonically, so string
  comparison is enough to match.
- An **attached dialog always has a parent** — Mutter only attaches a transient whose
  parent exists (`meta_window_should_attach_to_parent()`) — so `has_parent` and
  `attached_dialog` cannot vary independently: `attached_dialog=true` implies
  `has_parent=true`. That is why the prefs sentence can fold both into one phrase
  (`windowKindSentence()` in `prefs.js`) without losing a case.
- The identity is percent-encoded, because `:` and whitespace are delimiters.
  Realistic identities (WM_CLASS, Flatpak id, reverse-DNS app id) pass through
  unchanged; only exotic ones are escaped, and parsing decodes them back.
- Those five attributes are the whole key. There is deliberately **no app-wide form**
  — a rule never generalises to every window of an application — and no specificity
  hierarchy or fallback: a rule applies if and only if the kind matches exactly.
- `title`, `role` and the size hints are deliberately *not* part of the key. They
  change while a window lives, so they cannot define a kind.

The rules live in one settings key, `window-rules` (`a{ss}`), fingerprint → state. The
old `suppress-rules` / `force-rules` pair is gone and its contents are not migrated:
a group plus a named axis has no equivalent in the four states below.

## State grammar: the four states

The state names the axes that are ours, and only these four are valid:

| State | Corners | Shadow | What it does |
|---|---|---|---|
| `both` | ours | ours | we round the window and draw its shadow |
| `none` | theirs | theirs | we draw neither; the window stays exactly as the client drew it |
| `corners` | ours | theirs | we round it; its own shadow stays untouched |
| `shadow` | theirs | ours | we take its shadow over; its corners stay |

`parseRuleState()` and `buildRuleState()` in `rules.js` are the only place this
grammar is spelled out, so the settings layer, the picker and the runtime cannot
disagree about it.

A rule names *both* axes even when it leaves one to the client: there is no rule that
touches only one axis and lets the inference answer for the other. `corners` is a
complete statement that the shadow is theirs, not a partial one. Taking the shadow of a
client that declared a ring (`buffer_rect - frame_rect`) is the one takeover that
borrows the other axis: clearing that ring is the clip's job, so `shadow` still attaches
the clip, at radius 0, and leaves the corners as the client drew them. The boundaries are
listed in [decoration-model.md](decoration-model.md).

## One rule per window kind

A rule is keyed by the whole window kind, not by the application, because one
application routinely opens kinds that need opposite answers. WeChat is the example:
its main and chat windows run on Wayland while its article/browser windows run on
XWayland (with a declared 4px ring), and some of its dialogs are
self-decorated where others are not. An app-wide rule would have to be wrong for one
of them, so the picker writes exactly the kind it was pointed at and nothing else.

There is no direction any more, and so no collision to resolve: one kind has one row,
and that row says what the window ends up with on both axes. A rule overrides the
inferred baseline and nothing else — never the structural facts (window type,
maximized/fullscreen), never a user preference, never a policy. The same direction
guides the override layers themselves: we overrule the user only where honouring the
request would be meaningless — a structural disqualifier, a window state (maximized,
tiled, matched), or a window the user cannot see — never where the request is merely
imperfect. See [decoration-model.md](decoration-model.md).

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

Picking a window means "this looks wrong", so the picker proposes the state that
corrects what the window currently shows.

### Never-Maintain-Status-Quo Principle

A user actively invoking the window picker to add a rule is demonstrably dissatisfied
with how the window currently looks. Therefore, the suggestion must **never maintain
the status quo** (i.e. it must never suggest a no-op state that keeps the window as-is).
Instead, it chooses the state that inverts or breaks the current presentation:

- **State 2 (Decorated / Taken over)**: Any axis of ours is currently on screen
  (`drawShadow || drawClip`).
  → **Suggest `none`**. The user picked an already-decorated window because our override
  caused issues (e.g. black clipping artifacts, shadow collision, performance glitch);
  the most natural corrective intent is to retract our decoration and restore the
  untouched native/client look.
- **State 1 (Untouched / Native-like)**: No axis of ours is currently on screen
  (`!drawShadow && !drawClip`).
  → **Suggest `both`**. The user picked an undecorated or pass-through window because they
  want this extension to actively step in and bring native GNOME Adwaita ergonomics
  (rounded corners and GPU-baked shadow) to it.
  *(Physical constraint safeguard)*: If the window is a bare X11 window whose server-side
  Mutter shadow cannot be cleared, the suggestion safely degrades to **`corners`** to avoid
  painting an unsightly double shadow.

### Normalization and safety

The suggestion follows the window's **kind** — the transient state (maximized, tiled,
fullscreen) is normalized away by `kindParams()`, because a rule outlives transient states.

The guess is safe and ergonomic because:
1. **Never a no-op**: Under the "never maintain status quo" principle, State 1 yields `both`
   and State 2 yields `none`, so every valid pick produces a tangible, actionable change.
2. **Cheap to adjust**: The newly added/updated row in preferences is automatically focused,
   and the dropdown offers all four states (`both`, `none`, `corners`, `shadow`) for instant
   one-click adjustment.
3. **Pre-flight verification**: The extension re-evaluates the proposed state via
   `suggestedRuleWouldChange()` before storing, refusing any rule that would have no physical
   effect on the target window kind. `suggestedRuleState()` and `suggestedRuleWouldChange()`
   in `detector.js` are pure and unit-tested; the inspector passes both answers over D-Bus with
   the picked window's properties, and an absent answer means an extension too old to judge,
   in which case prefs stores the rule.

