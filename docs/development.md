# Development

## Setup

```sh
pnpm install
```

Unit tests need `jasmine` (from the `jasmine-gjs` project below) on `PATH`. It is not an npm package:

```sh
git clone --depth 1 https://github.com/ptomato/jasmine-gjs.git
meson setup jasmine-gjs/build jasmine-gjs && ninja -C jasmine-gjs/build install
```

## Checks

| Command | What it does |
|---|---|
| `pnpm run check` | full health check chain before commit: `lint`, `check:style`, `lint:ego`, `test`, and `check:decoration` |
| `pnpm run lint` | ESLint static syntax and style checks for `src/`, `tests/` and `tools/` |
| `pnpm test` | unit tests, run under gjs (automatically compiles locales via `pretest`) |
| `pnpm run test:e2e` | headless end-to-end run in a nested session: lifecycle, resize/move stress, overview/popup/pick guards, XWayland and multi-window cases, and a zero-warning audit of the log |
| `pnpm run stats` | code size and EGO `quality/code-volume` budget; CI posts the base→head delta as a PR comment |
| `pnpm run check:volume` | exits 1 when EGO non-blank exceeds 8,000; `stats` itself only reports |
| `pnpm run test:decoration` | measures three windows across multiple frames with alternating focus (a live libadwaita reference, one with declared shadow margins, and a bare one) and prints their outward attenuation profiles |
| `pnpm run check:decoration` | fidelity guard: exits 1 unless shadows match live libadwaita (0 grey levels unfocused same-frame, 1 grey level focused alternating-frames), each is 4-way symmetric, and zero shadow bleeds inward |
| `pnpm run test:flat-border` | minimal repro for issue #129: two flat ringless subjects (clean + 1px client border) over the backdrop at a given session scale; prints raw pixel runs per edge. Append `-- --check` to gate: exits 1 unless the clip excised the stroke outright |
| `pnpm run test:perf` | CPU and memory footprint benchmark for undecorated windows (Disabled vs Enabled) |
| `pnpm run check:perf` | automated performance budget guard (exits 1 when a budget is exceeded; a lone stress-ratio miss inside the known swing exits 2, which is the tool saying one re-run is worth it) |
| `pnpm run check:style` | re-derives generated styling, shader, padding, locale and Shell API-table artifacts and fails if they drifted; validates that all version-dependent APIs are owned by `src/platform/` or guarded by a call-site probe (via `check-platform-boundary.mjs`); and fails if `src/metadata.json` claims a Shell version `tools/shell-api.json` has not audited |
| `pnpm run lint:ego` | the EGO reviewer's linter, compared against `tools/ego-lint-baseline.txt`: a finding that is not in the baseline, one that now appears more often, or a baseline entry that no longer appears all exit 1. `-- --update` rewrites the baseline; `EGO_LINT_DIR` points at a prepared checkout |
| `pnpm run build` | builds `dist/<uuid>.shell-extension.zip` |
| `pnpm run lint:zip` | analyses that zip with shexli |
| `pnpm run gen:code` | regenerates all transpiled shaders, styling constants, and upstream bindings |
| `pnpm run gen:preview` | regenerates `assets/preview.webp` before/after comparison image in a nested session |

## What an extensions.gnome.org review rejects

The [guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html) allow AI as a
development tool, and reject submissions that look unreviewed: unnecessary code, inconsistent style,
imaginary API usage, and comments that read as prompts. Three of those are mechanical, and the check
chain above is what answers them - `tools/shell-api.json` and `tools/gjs-surface.js` are what catch a
call the shell does not have before a reviewer does. The fourth is a judgement the code has to earn:
a comment here explains the line it sits on, and the reasoning goes in `docs/`.

**What a stub may stand for, and what only pixels settle.** A stub may only stand for something the
type declares. `tests/platform.test.js` used to stub `display.get_default_seat`, a method
`Meta.Display` has never declared, so the test passed while the code path resolved nothing and the
resize band stayed silently inert. The names the code may rely on are in
`tools/shell-api.json`, `tools/gjs-surface.js` proves them against a real shell, and a stub for a
name neither has is a test for a shell that does not exist. The same honesty applies one level up: a
resolved style is what was asked for, not what was drawn, so whether anything renders is settled by
pixels and nothing else - which is what the ring check in `tools/test-e2e.sh` samples.

## Upstream API audit

The extension claims a range of GNOME versions, and the facts behind that claim live in
`tools/shell-api.json`: one declaration per symbol in the audited surface (the extension's calls
and the negatives recorded to pin an absence), extracted from a clone at a pinned tag rather than
typed. Extracted because the hand-written version of the same facts had
four wrong rows, and two more were wrong in the negative entries nobody re-checks.

`research/` holds uncommitted clones (see `.gitignore`) kept for exactly this reading, and
`tools/audit-shell-api.mjs` is what reads them:

| Command | What it does |
|---|---|
| `node tools/audit-shell-api.mjs --update` | re-extracts every declaration and rewrites `tools/shell-api.json` |
| `node tools/audit-shell-api.mjs --check` | re-derives and fails on any difference (needs `research/`, so it is not in CI) |
| `node tools/audit-shell-api.mjs --diff 51.0 52.0` | prints what changed for our surface between two tags |

Adding a GNOME line: fetch the tag, `--diff` it against the newest line already recorded, decide
whether what changed matters, then `--update`. That stays a human act - it needs the migration guide
and a judgement about what a change means - so it is not a CI job. What CI enforces is that the docs
agree with the record: `tools/gen-shell-api.mjs --check` runs inside `check:style` and fails if the
table in `docs/shell-compatibility.md` does not match `tools/shell-api.json`, or if a row links to
prose that does not exist.

Prose is hand-written, one section per entry id, in `docs/shell-api.md`. A fact a machine can
extract belongs in the record and not in a sentence: the version ranges used to be typed into the
table, and that is where the four wrong rows came from. The rule of thumb - if the sentence contains
a version number or a signature, it belongs in the record.

Two things stay outside both files. `tools/gjs-surface.js` asserts at runtime that the members the
extension calls are callable with the shape the code assumes (a header proves a declaration exists,
not that GJS can reach it) and runs inside `test:e2e`. Behavioural changes that upstream documents
in prose - "`disable()` cannot be async in 51" - cannot be extracted from a declaration at all, and
are what reading the migration guide during an audit is for.

**Where the mechanical part stops.** Declaration compatibility is checked across every recorded line,
and the manifest may only claim a line the record holds: `tools/check-shell-version.mjs`, inside
`check:style`, fails if `src/metadata.json` claims a major `tools/shell-api.json` has not audited.
Behaviour is not checked that way - it is verified by hand, through `test:e2e` and the eye, on the one
line the maintainer runs. There is deliberately no per-version build or runtime matrix: the extension
branches on what the shell offers at runtime (backend capability checks, arity dispatch,
optional-method probes) rather than on a version number, so a matrix would buy "does this shell
start" at seven builds per push, while the failure it would catch - a declaration we rely on and a
line no longer has - is what the record answers already.

The lower bound stays a decision nothing derives: the record covers 50-51, `shell-version` claims a
subset of it, and which subset is a choice made by hand while auditing a new line. release-please
owns only the manifest's `$.version-name` (`release-please-config.json`).

## Git hooks

`pnpm install` points git at `.githooks/`, and each check has exactly one hook: a check that ran in
both would only make the second run slow, so the split follows what a check guards.

- **every commit** runs `lint`, `check:style`, the unit tests and `check:decoration` (or all via `check`), unless every staged path is inert - documentation or assets, the list lives in `run-checks` - because none of them can see such a commit. Each guards
  something the commit itself can break, so the commit that breaks one is the commit that fixes it,
  and every commit stays valid on its own. The rendering is one of those things: the unit tests see
  the decisions, not the pixels, so a shadow or a clip change that misses libadwaita by a level is
  exactly what they cannot catch. That check needs a GNOME session to render in, so a machine without
  one skips it and says so rather than blocking every commit there - on a machine that has one it
  runs, and it took the place of a stored baseline that was found to have been failing unnoticed for
  a week;
- **every push** drives `test:e2e` through a nested session: it guards what a commit can break - a lifecycle, a
  resize band - but it costs about two minutes, and a commit hook slow enough to be bypassed is worth less than
  a push hook nobody minds. Pushes are rare; commits are not. Everything else that covers what leaves the
  machine moved to CI, which runs it on every push: `lint:ego`, `build`, and `lint:zip` (`shexli`, the reader
  extensions.gnome.org will use). `check:perf` no longer runs in a hook at all - its swing across sessions
  (0.70-0.90 against a 0.85 budget) is wider than its guard band, so as a per-push gate it flipped coins; run it
  by hand after a push that touches the frame paths. It needs no quiet machine either way: the budget is a ratio
  against the same round's disabled baseline, so a busy machine moves
  both arms and the guard reads it the same.

A commit made with `--no-verify` therefore reaches CI unchecked; that is the trade for not running
the same checks twice on every push. Either hook can be skipped the same way.

A check's output goes to a file rather than straight to the terminal, so that the one that fails can
be printed whole. A failure or an interrupt keeps that file and names its path, because a hook that
deletes the output of its own failure costs a re-run to learn what it already knew; a green run's
file is removed. The path is `<tmpdir>/window-nativizer-<hook>.<pid>.log`, one per run.

## Commit messages

Conventional Commits, matching the history: `type(scope): verb …`, no trailing
period, body in the imperative explaining why. release-please derives the next
version and the CHANGELOG from them.

A `BREAKING CHANGE:` footer must be **one paragraph**. release-please reads the
footer only up to the first blank line, so a second paragraph - typically the
migration commands - is silently dropped from the CHANGELOG. Keep the whole
explanation in one paragraph and put commands inline in `backticks`, not in a
fenced block.

## What a log line is for

A line in the journal has exactly two legitimate readers. The first is a developer or a tester, and
the question they are asking is one of two: which design invariant did the code violate, or which
exception did a `catch` swallow. The second is the user, whose question is "did I configure this
wrong".

That decides where a message goes. A problem the user can act on belongs on screen - a dialog, a
row, a toast - because the journal is not a place a user looks, and a line there is at most the
developer-side trace of the same event. What the user does on purpose is not logged at all: turning
a setting on, importing a rule file or picking a window is not an event, and a message that narrates
it is noise for both readers. A log line earns its place only when it reports a fault the code
cannot show the user, or one it recovered from.

The warnings that stay on have two shapes. A persistent violation of a design invariant goes
through a `Diagnostic` (`diagnosticInvariants.js`), which owns the edge-triggered latch: it speaks
once per episode and re-arms when the violation clears, so a condition that lasts many frames is
one line rather than one per frame. Its `check()` is called every pass with null when there is
nothing to say, because a pass that skips the call leaves the latch armed and the next episode
silent. An exception a `catch` would otherwise swallow goes through `journal.failure`, which keeps the stack
and the context the catch would have discarded - unless the catch is the reconcile pass's, whose
`apply()` touches actors Mutter is destroying and legitimately throws once per closed window. The
rule there is positional rather than about the exception: reads and the decision run outside the
`try`, so a bug in them escapes as a `JS ERROR`, and only the decoration's own calls are absorbed.
A guard that fires has to be visible; a teardown that throws is not news.

Every line is written by `src/platform/journal.js`, which owns the `[window-nativizer]` prefix and the
sink. Nothing else in `src/` writes to the console: the predicate returns content, the journal adds
the tag, and a lint rule keeps the two roles apart. Everything else is either the user's business
(on screen) or nobody's (not written).

## Measuring in the nested session

`tools/dev.sh shell` starts the headless shell with `--unsafe-mode`, which exposes
`org.gnome.Shell.Eval`. Together with the session bus address in the shell's
`/proc/<pid>/environ` (the way `tools/test-e2e.sh` reads it), that
is enough to measure the effects from outside, with no probe code added to the
extension:

```sh
PID=$(cat /tmp/window-nativizer-dev/shell.pid)
BUS=$(tr '\0' '\n' < /proc/$PID/environ | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)
gdbus call --address "$BUS" --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval 'global.get_window_actors().length + " windows"'
```

**Runs queue instead of colliding.** The nested shell, the installed extension path and
`/tmp/window-nativizer-dev` are one shared resource, and two runs that overlap corrupt each
other's session: a fidelity check can read a neighbour's frame (`environment witness ... 28 gray
level(s)`) and the e2e can fail purely because a second session is up, and both pass again on a
quiet re-run. Every tool that drives the session - `tools/devkit.sh`, `tools/dev.sh`,
`tools/dev-shell.sh`, `tools/test-e2e.sh`, `tools/benchmark-perf.py`,
`tools/check-decoration.py`, `tools/flat-border-runs.py` and `tools/generate-preview.py` - queues
on an exclusive `flock` at `${XDG_RUNTIME_DIR:-/tmp}/window-nativizer-session.lock` for the part
that drives the session only; lint, the unit tests and the style checks never take it. A second
run prints `[session-lock] waiting for the nested session (held by PID ...)` and waits instead of
driving the session underneath the first. The lock is re-entrant within one process tree: the
helper exports `WN_SESSION_LOCK_HELD`, so a holder that starts another tool (`test-e2e.sh` starts
`dev.sh`, which starts `dev-shell.sh`) skips it instead of deadlocking against itself.
`WN_SESSION_LOCK_TIMEOUT` is the wait in whole seconds; `0` fails immediately with a clear message
instead of queueing and the default is 1800. The lock is released when the command exits,
whatever its status, so a failing run does not wedge the machine.

Things about it that cost time to find:

- **Session readiness contract (`$STATE_DIR/ready`).** Starting the nested shell
  asynchronously is prone to races if callers probe before actors and the extension settle.
  `tools/dev-shell.sh` guarantees readiness by forcing `global.window_group.show()`,
  polling until the initial overview is genuinely dismissed (`Main.overview.hide()`),
  and verifying that the extension reports `State: ACTIVE`. Only when all conditions hold
  does it touch `/tmp/window-nativizer-dev/ready`. `tools/dev.sh` gates on this marker
  alongside the pidfile, ensuring that every downstream caller (`tools/test-e2e.sh`,
  the benchmark tools) reaches readiness through `dev.sh shell`.
- **The stage has to be shown, all of it.** `tools/dev-shell.sh` calls
  `global.window_group.show()`, which is not enough: without the GDM activation flow
  nothing below the stage is painted, so an offscreen effect never allocates its
  framebuffer (`get_texture()` comes back null) and actors report a stale allocation
  instead of their geometry. In a manual `Eval`, walking the stage and calling `show()` on every
  actor fixes it for that session.
- **`Eval` escaping rules.** GVariant decodes a `\n` escape sequence into a real
  newline before the shell evals the string, so an unescaped `\n` inside a JS string
  literal fails with `SyntaxError: "" string literal contains an unescaped line break`
  (literal newlines in the script body itself are permitted). The same decoding eats a
  single backslash, so a regular expression has to be written as `[0-9]` rather than
  `\d`. Where compact, join statements with semicolons and split the answer afterwards;
  a heredoc or multi-line script can be passed if internal strings avoid raw `\n` escapes.
- **This session does not reproduce the rendering.** Compiling, allocating and painting
  all succeed, and the offscreen sizes are right, but what reaches the screen is not
  what a real session shows: a shadow can be missing here and correct in the developer's
  session. Use it for geometry, state and framebuffer sizes, and use
  `gnome-shell --devkit --wayland --unsafe-mode` (a nested shell with a real GL path,
  where `Eval` and `Screenshot` both work) for anything visual.
- **Screenshots are in device px, rects are logical.**
  `Meta.Window.get_frame_rect()` answers in logical px while the screenshot is
  `logical x global.display.get_monitor_scale(monitor)`. On a fractional-scale display
  that is a 4/3 difference here, enough to sample the wrong place entirely and conclude
  that nothing is drawn.
- **`dconf` writes go to the session, not to `XDG_CONFIG_HOME`.** The nested session keeps
  its settings in `$XDG_CONFIG_HOME/dconf/user` (`/tmp/window-nativizer-dev/config`, wiped by
  `dev.sh shell`), but a plain `dconf write` performs the write through the *current* session's
  dconf service and lands in the developer's real desktop settings however
  `XDG_CONFIG_HOME` is set. `./tools/dev.sh dconf <args>` points both the bus and
  `XDG_CONFIG_HOME` at the nested session, so reads and writes hit the same isolated database
  the nested shell reads.
- **Per-frame cost is measurable without a profiler.** `ClutterStage` emits
  `before-paint` and `after-paint`; a `GLib.timeout_add(..., 16, ...)` that calls
  `global.stage.queue_redraw()` keeps frames coming, and enabling or disabling the
  extension within one session gives the share that belongs to the decoration.

Timings from this rig do not transfer. It is a headless virtual monitor on whatever
driver the developer happens to run, so only the difference between two runs in the
same session means anything, and that is all the comparison needs.

The subject for visual work is any window the detector decorates. `tools/probe-window.js`
is one: a GTK4 window with its own decoration turned off, fixed size, theme background,
so two screenshots of one session are comparable.

```sh
./tools/dev.sh app gjs tools/probe-window.js
```

`./tools/dev.sh xapp <cmd>` runs the same client as an XWayland window instead, which is
what exercises the XWayland clip target; it resolves the nested XWayland's display and authority.

With `WINDOW_NATIVIZER_BACKDROP=1` the same script becomes a uniform white surface to measure a
shadow against, under a separate application id so it can run beside the subject, and
meant to be maximized: a maximized window is one the detector never decorates, so it is
background rather than subject. That beats changing the desktop background, which alters
something outside the session under test.

`WINDOW_NATIVIZER_BODY=#rrggbb` paints the window body a known colour. Against the white backdrop
and a black shadow the three channels then separate the body, the 1px outline and the shadow
in one profile, and a missing corner clip becomes visible - none of which can be seen when
the window and the background are both white.

Prototype actors must be destroyed and any `GLib` sources removed before
`tools/dev.sh stop`, otherwise the next run inherits them.

## Inspecting a window over D-Bus

The inspector exposes one method, `PickWindow`, on the extension's own bus name
(`org.gnome.Shell.Extensions.WindowNativizer`, object path
`/org/gnome/Shell/Extensions/WindowNativizer`):

```
PickWindow(b debug) -> a{ss}
```

It exists for the live question that needs shell-side state on a real session without the shell's
unsafe mode: why a window briefly shrinks in width when a popup closes. **The boolean is required.**
`false` is exactly the old pick: an interactive crosshair pick that returns the public fields only
and touches no extra state. `true` is the same interactive pick with the diagnostics-only fields
added to the reply. There is no non-interactive path - the diagnostics still require the click, and
that gesture is the user's authorisation to read the state. There is one knob, so a map would add
parsing rules without adding meaning.

**Who may call it: any local process.** The click is the gate, not the caller's identity. The
method takes a modal grab and answers with the picked window's title, so a caller can freeze input
until the user clicks or presses Escape, and then learn that one title. That is the whole of what an
unwanted caller gets, and it is worth being explicit about why nothing narrower is in place.

A session bus cannot tell two processes of one user apart: unique names change per connection,
`GetConnectionUnixProcessID` proves a pid and nothing about what the process is, and the file it
could be asked to read is readable by the caller too. The candidates left are worse than the
problem. A well-known name the preferences window owns is a capability rather than an identity -
whoever claims it first is trusted, and claiming it costs one call - so it filters out exactly the
callers that would never have called. An allowlist of names baked in at build time has nothing
stable to name.

The model the platform already uses is installation, not invocation: an extension is JavaScript
running inside the shell process, so anything that could get past a check here can call
`Meta.Window.get_title()` directly. Installing an extension, or running a program, is the user's
trust decision; a method that needs a click on a window is not the place to re-take it.

The reply is a **read-only** observation of the live window, its actor and its decoration: it does
not mutate the window or its decoration, does not start a probe, and prints nothing to the journal.
Even the process classification is read from the cache (`nativeLikeCorners`); the reply never
triggers the async `/proc/<pid>/maps` read.

```sh
PID=$(cat /tmp/window-nativizer-dev/shell.pid)
BUS=$(tr '\0' '\n' < /proc/$PID/environ | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)
IFACE=org.gnome.Shell.Extensions.WindowNativizer
OBJ=/org/gnome/Shell/Extensions/WindowNativizer

# Quiet interactive pick (needs a click; public fields only)
gdbus call --address "$BUS" --dest "$IFACE" --object-path "$OBJ" \
    --method "$IFACE".PickWindow false

# Same pick with diagnostics: also needs a click, then the reply carries the fields below
gdbus call --address "$BUS" --dest "$IFACE" --object-path "$OBJ" \
    --method "$IFACE".PickWindow true
```

A call with no argument is rejected with `InvalidArgs` rather than read as `false`: D-Bus has no
default arguments, and a stale caller must fail loudly. Nothing else is required - no unsafe mode,
no name to claim - because the click already gates it.

### Field split

The reply is one `a{ss}` map, so every value is a string. Fields that cannot be read from the
live objects say `unavailable` explicitly rather than being omitted.

**Public - present in both modes**, so a script that passes `false` keeps working unchanged:

`wmClass`, `windowTitle`, `width`, `height`, `clientType`, `hasRing`, `hasSsd`, `isMaximized`,
`isFullscreen`, `hasTileMatch`, `allowsResize`, `isAttachedDialog`, `hasParent`, `windowType`,
`suggestedState`, `suggestedStateWouldChange`.

**Diagnostics-only - present only when `debug` is `true`**:

| Group | Fields |
|---|---|
| subpixel phase | `mirrorPhaseX`, `mirrorPhaseY`, `appliedPhaseX`, `appliedPhaseY` |
| window geometry | `frameRect`, `bufferRect`, `windowActorAllocation` |
| process | `nativeLikeCorners` |
| clip | `clipTargetType`, `clipTargetName`, `phaseInTransform`, `clipFrame`, `clipInsets`, `clipScale`, `clipEnabled`, `clipSuspended` |
| clip body authority | `containerBox`, `shadowWidth`, `shadowHeight`, `shadowCast`, `shadowRightBand` |

`frameRect`, `bufferRect` and `windowActorAllocation` are JSON `{"x":…,"y":…,"width":…,"height":…}`;
`clipFrame` is the clip shader's live `uFrame` as `[x,y,width,height]`; `clipInsets` is JSON
`{"left":…,"top":…,"right":…,"bottom":…}`. `containerBox` is the resolved clip target's live box
in that same JSON - the surface container on the container path, the window actor on the fallback -
so it pairs with `windowActorAllocation` to show which side moved. `shadowCast` is the shadow's
derived body cast in the same JSON, `shadowRightBand` is the snapped right-edge slice
`{x1,y1,x2,y2}`, and `shadowWidth`/`shadowHeight` are bare numbers. Booleans are `"true"`/`"false"`.

**No-answer vocabulary**, kept distinct so a consumer cannot read a missing answer as a negative
one: `unavailable` is a read that was reachable but did not return; `unknown` is `mirrorPhaseX/Y`
when the monitor scan cannot complete, and `nativeLikeCorners` when the process classification has
not landed; `n/a` is `appliedPhaseX/Y` on a non-Wayland client, where no applied phase exists;
`cannotTell` is `nativeLikeCorners` when there is no classifier to ask.

## Documents

| Document | Contents |
|---|---|
| [decoration-model.md](decoration-model.md) | how a window's decoration is decided, and where it diverges from Mutter on purpose |
| [decoration-alignment.md](decoration-alignment.md) | how the decoration is measured against libadwaita, what is verified, and what is still open |
| [rule-model.md](rule-model.md) | the rule key and state format, the reversed axes, identity resolution |
| [architecture.md](architecture.md) | modules, the two processes, the actors |
| [shell-compatibility.md](shell-compatibility.md) | the Shell/Mutter API surface and the rules we work by |
| [shell-api.md](shell-api.md) | what each upstream Shell/Mutter call is for, and why the extension needs it |

**Comments are for the line they sit on.** Keep one when deleting it would make the next
line unreadable or easy to misread: what an otherwise arbitrary condition selects (a
window-type test), which entry of a literal array means
what (the slice table in the shadow texture), a unit, an endpoint. Anything that needs
another file, the history of a decision, or an upstream source to make sense belongs in
`docs/` - measured numbers and their evidence, trade-offs, rejected alternatives, case
tables. A pointer at the model is worth one line, and only where the code cannot be read
without it.

**A comment explains the code, not the tooling.** Anything about a linter, a check, a rule id, a
test runner or CI belongs to the check that enforces it and finds its own way to complain; in the
source it is noise the next reader has to skip, and it rots the moment the tool changes. Write the
fact the code acts on instead: "pure, so the arithmetic can be read as data", not "so a spec can
assert it". If a comment only makes sense to someone reading the pipeline, it belongs in this file,
not beside the code. The two halves of that a grep can hold - a rule id, and the name of a checker
or a script - are in `check-style.sh`; the rest is left to the reader.

Moving is not deleting: before dropping a comment, the fact it carries has to be readable
from the names and structure around it, or already in `docs/` - compress while moving, never
drop. JSDoc on an export keeps types, what it returns, and when it throws; the reasoning
goes to `docs/`. The concern is that comment density rots: `comment-density` in ego-lint
(over 50% of a file, ignoring its first ten lines) is a signal, not the goal.

**Prefer durable domain contracts over volatile micro-implementation metrics.** When writing or
updating documentation and user-facing explanations, avoid hardcoding transient pixel values
(such as specific corner radii or margin depths) unless citing an upstream literal. Refer instead
to domain concepts (e.g. Libadwaita continuous curvature, GTK standard input regions, GPU-baked
meshes) to prevent documentation drift as upstream styling and rendering heuristics evolve.

### Anti-drift documentation hierarchy (抗漂移文档分层)

Spatial distance from code governs the probability of documentation rot: the farther documentation
lives from the point of change, the higher the risk of drift. Furthermore, **never duplicate what can
be introspected from code** (exports, function signatures, syntax expressions, AST structures, or caller
rosters). Anything discoverable via types, tests, or grep belongs to the machine, not to prose.
An introspectable fact written in markdown is merely an unverified, rotting cache.

1. **Machine-verified layer (`tests/`)**: High churn, zero drift. All concrete parameters, edge cases,
   and geometric formulas live in executable unit tests (`pnpm test`). If code shifts, tests fail immediately.
   When a function's contract is "equals upstream function F", the spec names F and pins the boundary
   cases that distinguish the rule - negatives and exact halves. `tests/snap.test.js`'s direction
   boundary values are the model: they are what a `Math.round` stand-in would fail. The companion
   case: if we deliberately deviate from F, the spec must name the deviation, the upstream behaviour
   it departs from, and the property the deviation buys - a deviation asserted only in prose is a
   silent "fix" waiting to happen. `tests/snap.test.js`'s origin-odd ROUND is the model there.
2. **In-code comments layer (JSDoc & inline)**: Co-located with code, high locality. Carries local "Why",
   counter-intuitive workarounds, and non-obvious traps. Omits restatements of code syntax or trivial types.
   Kept in the same file and reviewed in the same git diff as the code change.
3. **Architecture & decision layer (`docs/*.md`)**: Low churn, macro scope. Records cross-module
   interactions, rationale for chosen designs over rejected alternatives, and alignment with GNOME/Mutter.
   Never duplicates volatile micro-implementation details (variable names, parameter lists, or internal thresholds).

### House style (行文风格)

The rules below are the ones the doctrine above does not decide. They exist because one fact
written two ways reads as two facts; each line here had a majority form already, and the rest were
the minority that got aligned to it.

**Terminology.** One concept, one noun. The code's vocabulary wins over prose's:

| Term | Means | Not |
|---|---|---|
| `logical px` | Clutter's unit, what an actor's allocation is in | logical pixel |
| `device px` | a pixel of the composited output, which is what a screenshot holds - as opposed to an FBO's own grid | physical px, physical pixel, screen px, device pixel |
| `physical` | an adjective for device space: `physical grid`, `physical phase`, `physical scale` | never a unit on its own |
| pass | one decoration recompute, the unit a signal wakes | frame |
| frame | one rendered output of the stage | pass |
| `FBO` | the offscreen allocation Clutter gives an effect | offscreen buffer |
| `quad` | the four-vertex geometry a paint writes | rect |
| `extent` | a box's size in one space, the thing a read is compared against | size |

`physical` survives as an adjective because `physical grid` and `physical phase` name device space
rather than a unit - a distinction `device px` cannot carry on its own.

**Typography.** English prose uses one aside marker, in `docs/` and in comments alike:

| Mark | Use | Count before this rule |
|---|---|---|
| ` - ` | an aside inside a sentence, a label followed by its gloss | 300 |
| `–` | a numeric or version range only: `50–51`, `9–16` | 55 |
| `—` | retired | 106 |
| `:` | a heading's subtitle: `## Effects: the rounded clip` | - |

The em dash is retired rather than allowed in `docs/` and banned in `src/`: `slop/no-em-dash`
already rejects it in a comment, so keeping it in prose would make the same author punctuate the
same sentence differently depending on the file. `README.zh-CN.md` follows Chinese punctuation
(`——`, `、`) and is not covered by this row.

Spelling is British throughout - `colour`, `behaviour`, `centre`, `cancelled`, `normalise` - which
is what the tree already used; `color` only ever appears inside a code identifier such as
`color-scheme`. Scale factors are written `1.25x`, not `1.25×`; `×` stays for multiplication and
dimensions (`440 × 1.333333`, `550×524`, `4.0×4.0`).

**Voice.** `we` is the maintainers, and it is the default for a decision or a measurement: *we hold
the derivation*. `the extension` is the running process: *the extension connects once*. A document
describing runtime behaviour does not say "we" for it, and `docs/` does not address a `you` - the
reader is whoever maintains the file. `README.md` is the exception: it is read by users, so it keeps
its second person.

**Length.** A sentence carries one claim and stays under about 40 words; a paragraph carries one
argument and stays under about 120. The tree before this rule sat at a median of 27 words per
sentence and a 90th percentile of 52, with paragraphs at 66 and 176 - the long tail is where a
claim and its evidence got fused into one sentence and became hard to check.

**Code.** Formatting is `eslint-config-gnome`'s, not this document's: 4 spaces, single quotes,
semicolons. Private members are `_method` and `_field`, which is what the GJS tree around this
extension does: 77 `_method` declarations, and not one `#field`. Lines aim at 100 characters, and
an `import` or a call chain may run past it - a width forced there would be won back by an alias
nobody wants to read. Formatting is not machine-checked here on purpose, but five lexical rules
are, in `check-style.sh`: a `docs/` pointer, `@param {type}`, a hand-written `.disconnect(`, a
comment naming a rule id, and a comment naming a checker. Those five are names, not prose - a grep
for how a comment reads would only teach the tree to write around it.

## Code conventions (代码约定)

The lint config fixes formatting - braces, quotes, indentation. What it cannot see is what this
section records: the decisions the tree already makes consistently, which a newcomer would otherwise
make by taste. The ratios below were counted when this was written; they are evidence, not totals.

**Shape.** A module exports names, not a default. The only two defaults are the entry classes GNOME
requires (`extension.js`, `prefs.js`). A named function is a `function` declaration; an arrow is a
callback and nothing else. A single-statement `if` takes no braces, which is every one of them.

**Absence.** `null` means there is no value: a read that could not answer. `undefined` means the
caller passed nothing, or the property does not exist. Nothing returns `undefined` - a function that
cannot answer says so with `null`. Code crossing a boundary (parsed JSON, a D-Bus reply, a GObject
property) tests both, because either can arrive there. A fallback is `??`, not `||`, except where
swallowing `0`, `''` or `false` is the intent: a divisor guard (`bufferScale || 1`), an empty title
(`title || existing?.title`), a boolean turned into `null`.

**Vocabulary.** The verb is the contract:

| Verb | Contract |
|---|---|
| `get*` | the platform value, with the fallback its caller chose: `strict` asks for `null`, otherwise a safe default |
| `read*` | a value built from one or more reads; never throws, and its failure answer cannot be mistaken for data |
| `resolve*` | several inputs in, one decided value out |
| `is*` | a predicate on a value it is handed |
| a domain prefix (`offscreen*`, `shadow*`, `clip*`, `snap*`) | pure arithmetic in that domain |

**Parameters.** Positional, including past three, while the arguments are of different kinds and
read at the call site. A record appears for one of two reasons: several optional values travelling
together (`{wmClassOverride, classifier}`, `{animate, nowMs}`, `{strict}`), or a call site that
would otherwise be a row of same-shaped values (`declaredSides`'s five numbers,
`chooseWindowIdentity`'s four strings). One optional argument does not earn a record; it stays a
trailing `= null`. A per-frame path is positional without exception, because a record is an
allocation.

**Allocation.** A writer on a per-frame path takes its output container as the first argument and
returns nothing (`bandParamsInto`, `snapSliceBoxesInto`, `clipValuesInto`). Everything else returns
a new record. Both forms exist on purpose, and the pair is deliberate, not an unfinished refactor.

**Lifetime.** A class when something owns a lifetime, a signal or a resource; a function in `lib/`
when it is a derivation. Five classes are `GObject.registerClass`, where the Shell supplies the
lifetime; the rest are the extension's own state holders.

**Control flow.** A guard at the top returns, and `else` is the exception - under a tenth of the
`if`s in the tree have one. An exception is thrown only where the caller cannot go on; everything
else answers `null`. A `catch` that swallows says why in a comment beside it.

**Specs.** A spec name states the behaviour in the third person - `prefers the frame rect over the
buffer rect` - and never opens with `should`. The name is the claim; the expectations beneath it are
its evidence.

Deliberately not regulated, because a rule would cost more than it returns:

| Left alone | Why |
|---|---|
| file length | a file ends where its responsibility does, whatever line that lands on |
| short local names | `const s = usableScale(scale)` reads better than `scale` twice in twenty lines |
| export comments | most exports carry one; the rest are upstream constants and self-evident predicates |
| comment density | `comment-density` in ego-lint is already a signal, and a second opinion would not be |
