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
complete statement that the shadow is theirs, not a partial one. The one axis that
cannot always simply be handed back is the shadow of a client that declared a ring
(`buffer_rect - frame_rect`): clearing that ring is the clip's job, so `shadow` alone
cannot take it over on such a window. The boundaries are listed in
[decoration-model.md](decoration-model.md).

## One rule per window kind

A rule is keyed by the whole window kind, not by the application, because one
application routinely opens kinds that need opposite answers. WeChat is the example:
its main and chat windows run on Wayland while its article/browser windows run on
XWayland (and declare only a 4px resize grip), and some of its dialogs are
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

Picking a window means "this looks wrong", so the picker stores the state that
corrects what the window currently shows. The suggestion follows the window's
**kind** — the transient state (maximized, tiled, fullscreen) is normalized away,
because a rule outlives it:

- any axis of ours on screen → suggest `none`
- no axis of ours, and the shadow on screen is ours to clear → suggest `both`
- no axis of ours, and that shadow is not ours to clear (Mutter's, or the frames
  client's) → suggest `corners`, so the suggestion cannot add a second shadow

The guess is safe because it is symmetric and cheap to reverse: whichever state it
lands on, the dropdown on the row offers the other three, and the rule never touches
another window kind. It is also checked before it is stored: the extension re-runs
the evaluator with the proposed state and refuses a rule that would change nothing,
so an inert guess is reported instead of written. `suggestedRuleState()` and
`suggestedRuleWouldChange()` in `detector.js` are pure and unit-tested; the inspector
passes both answers over D-Bus with the picked window's properties, and an absent
answer means an extension too old to judge, in which case prefs stores the rule.
