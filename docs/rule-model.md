# The rule model

A rule is keyed by an application identity plus five structural attributes of the
window, and it moves named decoration axes in one direction. The picker writes rules,
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

## Value grammar

`shadow`, `corners`, or both in canonical order (`shadow,corners`). A fresh pick names
both: the user then narrows the rule down, instead of starting from one that silently
covers only part of the window.

## Two groups, one kind

| Settings key | Meaning |
|---|---|
| `suppress-rules` | remove the named decorations |
| `force-rules` | add them, where the baseline decided something else already did |

A window kind belongs to **at most one** group. On collision the suppression wins:
under-decorating is visible and reversible, while the double decoration a stray force
rule causes is neither. The invariant is enforced when rules are read, so stored
settings cannot break it, and the picker moves a kind between groups rather than
letting it appear in both.

`force` overrides the inferred baseline and nothing else — never the structural facts,
never the preferences, never a policy. See [decoration-model.md](decoration-model.md).

It stays available on the shadow axis too, although that axis is reliable in one
direction only: a shadow rule of yours is an explicit act whose consequence is visible
(a second shadow, as against the *stray* force rule the collision rule guards against)
and can be taken back. What it cannot do is put a shadow on a window that a structural
fact or a policy forbids one on.

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
