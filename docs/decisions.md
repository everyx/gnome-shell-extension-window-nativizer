# Decisions

The decisions the rest of `docs/` argues from, one row each. A row is a pointer, not the record: the
canonical section is where the reasoning and its evidence live, and it wins if the two ever disagree.

| Id | Decision | Canonical location | Also stated in |
|---|---|---|---|
| D1 | A rule reverses three axes - `corners`, `shadow`, `resize` - and `RULE_AXES` in `src/lib/rules.js` is the whole list; the fourth layer in the decision order is a layer, not an axis. | [rule-model.md](rule-model.md) § State grammar: the axes a rule reverses | [decoration-model.md](decoration-model.md) § Four layers, applied in order; [architecture.md](architecture.md) § Modules |
| D2 | Key field order is part of the format, and a key splits at its last `:` so the identity stays verbatim. | [rule-model.md](rule-model.md) § Key grammar | - |
| D3 | `has_ring` is one reading - a positive margin on either side of either axis - shared by the picker and the runtime. | [rule-model.md](rule-model.md) § Key grammar | [decoration-model.md](decoration-model.md) § Rounding a window takes its shadow over |
| D4 | One rule per window kind, keyed on the kind rather than the application, so an app with opposite kinds can hold opposite rules. | [rule-model.md](rule-model.md) § One rule per window kind | [decoration-model.md](decoration-model.md) § Four layers, applied in order |
| D5 | A pick corrects every axis the kind can act on and is refused when it would change nothing. | [rule-model.md](rule-model.md) § The pick heuristic | [architecture.md](architecture.md) § The two processes |
| D6 | Identity resolves declared ids first, then a same-pid sibling, then Shell's app id with `window:<n>` rejected, then `pid-<pid>`; the picker and the runtime take that one path. | [rule-model.md](rule-model.md) § Identity | - |
| D7 | Rules live in one `window-rules` map to `{state, title}`, and the title is a display-only sample that matching never reads. | [rule-model.md](rule-model.md) § What the pick remembers for the row | [rule-model.md](rule-model.md) § Key grammar |
| D8 | Three principles decide the trade-offs, ordered: no perceivable cost, then display quality, then cover what a rule can correct. | [decoration-model.md](decoration-model.md) § The principles these decisions are made under | - |
| D9 | A failed read answers `null`, and a default is substituted only where the caller asks for one. | [decoration-model.md](decoration-model.md) § The principles these decisions are made under | [architecture.md](architecture.md) § The extension lifecycle |
| D10 | The decision applies four layers in order, and a rule overrides the inferred baseline alone - never structural eligibility or a later policy. | [decoration-model.md](decoration-model.md) § Four layers, applied in order | [rule-model.md](rule-model.md) § One rule per window kind |
| D11 | A client's ring is cleared exactly when the ring we draw is ours. | [decoration-model.md](decoration-model.md) § Rounding a window takes its shadow over | [rule-model.md](rule-model.md) § State grammar: the axes a rule reverses |
| D12 | The shadow is cast by the window body, not by the actor, so a declared ring is excluded from the cast rect. | [decoration-model.md](decoration-model.md) § Rounding a window takes its shadow over | [architecture.md](architecture.md) § Actors |
| D13 | Two processes: the extension owns the windows, the preferences process owns none, and the picker is their only conversation. | [architecture.md](architecture.md) § The two processes | - |
| D14 | `PickWindow` is callable by any local process; the required click is the gate, not the caller's identity. | [development.md](development.md) § Inspecting a window over D-Bus | - |
| D15 | Outside the picker, only the resize band's strips take input; every other actor we add is `reactive: false`. | [shell-compatibility.md](shell-compatibility.md) § Working rules | [decoration-model.md](decoration-model.md) § It is the persistent thing that takes clicks |
| D16 | The code branches on runtime capability, not on a version number, so there is deliberately no per-version build or runtime matrix. | [development.md](development.md) § Upstream API audit, paragraph "Where the mechanical part stops" | - |
| D17 | Queries read in-memory snapshots and never start I/O; the async reads are lifecycle commands, so evaluation order cannot mutate state. | [shell-compatibility.md](shell-compatibility.md) § Working rules | [decoration-model.md](decoration-model.md) § When a window's corners already look like ours |
| D18 | The visual size floor is judged on the window's initial stable size, so a drag through a small frame cannot flip the decision. | [decoration-model.md](decoration-model.md) § What the edge has to carry | - |
