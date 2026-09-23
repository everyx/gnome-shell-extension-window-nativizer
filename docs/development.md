# Development

## Setup

```sh
pnpm install
```

Unit tests need `jasmine-gjs` on `PATH`. It is not an npm package:

```sh
git clone --depth 1 https://github.com/ptomato/jasmine-gjs.git
meson setup jasmine-gjs/build jasmine-gjs && ninja -C jasmine-gjs/build install
```

## Checks

| Command | What it does |
|---|---|
| `pnpm run lint` | ESLint static syntax and style checks for `src/`, `tests/` and `tools/` |
| `pnpm test` | unit tests, run under gjs |
| `pnpm run test:e2e` | headless end-to-end run in a nested session: lifecycle, resize/move stress, a zero-warning audit of the log |
| `pnpm run benchmark` | visual decoration attenuation benchmark against 1.0x golden baseline |
| `pnpm run benchmark:check` | zero visual regression guard (exits 1 if attenuation profile or symmetry drifts) |
| `pnpm run benchmark:perf` | CPU and memory footprint benchmark for undecorated windows (Disabled vs Enabled) |
| `pnpm run benchmark:perf:check` | automated performance budget guard (exits 1 if CPU/RAM regression exceeds budget) |
| `pnpm run preview` | regenerates `assets/preview.webp` before/after comparison image in a nested session |
| `pnpm run check-style` | re-derives the generated style, shader, Cogl/Clutter padding, Mutter and locale artifacts from their sources and fails if they drifted |
| `pnpm run ego-lint` | the EGO review tool; `EGO_LINT` overrides which checkout it runs |
| `pnpm run pack` | builds `dist/<uuid>.zip` |
| `pnpm run shexli` | analyses that zip |

## Git hooks

`pnpm install` points git at `.githooks/`, so:

- **every commit** runs lint, `check-style`, the unit tests and ego-lint. The commit that
  breaks one is the commit that fixes it, so each commit stays valid on its own;
- **every push** additionally packs the extension, which is the one CI job a commit hook
  cannot cover.

Either can be skipped with `--no-verify` when that is what you mean.

## Commit messages

Conventional Commits, matching the history: `type(scope): verb …`, no trailing
period, body in the imperative explaining why. release-please derives the next
version and the CHANGELOG from them.

A `BREAKING CHANGE:` footer must be **one paragraph**. release-please reads the
footer only up to the first blank line, so a second paragraph - typically the
migration commands - is silently dropped from the CHANGELOG. Keep the whole
explanation in one paragraph and put commands inline in `backticks`, not in a
fenced block.

## Measuring in the nested session

`tools/dev.sh shell` starts the headless shell with `--unsafe-mode`, which exposes
`org.gnome.Shell.Eval`. Together with the session bus address in the shell's
`/proc/<pid>/environ` (the way `get_dbus_bus()` in `tools/test-e2e.sh` reads it), that
is enough to measure the effects from outside, with no probe code added to the
extension:

```sh
PID=$(cat /tmp/window-nativizer-dev/shell.pid)
BUS=$(tr '\0' '\n' < /proc/$PID/environ | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)
gdbus call --address "$BUS" --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval 'global.get_window_actors().length + " windows"'
```

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
  instead of their geometry. Walking the stage and calling `show()` on every actor
  fixes it.
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
- **Screenshots are in physical pixels, rects are logical.**
  `Meta.Window.get_frame_rect()` answers in logical pixels while the screenshot is
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

With `WINDOW_NATIVIZER_BACKDROP=1` the same script becomes a uniform white surface to measure a
shadow against, under a separate application id so it can run beside the subject, and
meant to be maximized: a maximized window is one the detector never decorates, so it is
background rather than subject. That beats changing the desktop background, which alters
something outside the session under test.

`WINDOW_NATIVIZER_BODY=#rrggbb` paints the window body a known colour. Against the white backdrop
and a black shadow the three channels then separate the body, the 1px outline and the shadow
in one profile, and a missing corner clip becomes visible — none of which can be seen when
the window and the background are both white.

Prototype actors must be destroyed and any `GLib` sources removed before
`tools/dev.sh stop`, otherwise the next run inherits them.

## Documents

| Document | Contents |
|---|---|
| [decoration-model.md](decoration-model.md) | how a window's decoration is decided, and where it diverges from Mutter on purpose |
| [decoration-alignment.md](decoration-alignment.md) | how the decoration is measured against libadwaita, what is verified, and what is still open |
| [rule-model.md](rule-model.md) | the rule key and state format, the reversed axes, identity resolution |
| [architecture.md](architecture.md) | modules, the two processes, the actors |
| [shell-compatibility.md](shell-compatibility.md) | the Shell/Mutter API surface and the rules we work by |

**Comments are for the line they sit on.** Keep one when deleting it would make the next
line unreadable or easy to misread: what an otherwise arbitrary condition selects (the
window-type test in `checkDecorationEligibility()`), which entry of a literal array means
what (the slice table in the shadow texture), a unit, an endpoint. Anything that needs
another file, the history of a decision, or an upstream source to make sense belongs in
`docs/` — measured numbers and their evidence, trade-offs, rejected alternatives, case
tables. A pointer at the model is worth one line, and only where the code cannot be read
without it.

Moving is not deleting: before dropping a comment, the fact it carries has to be readable
from the names and structure around it, or already in `docs/` — compress while moving, never
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
   and geometric formulas live in executable unit tests (`npm test`). If code shifts, tests fail immediately.
2. **In-code comments layer (JSDoc & inline)**: Co-located with code, high locality. Carries local "Why",
   counter-intuitive workarounds, and non-obvious traps. Omits restatements of code syntax or trivial types.
   Kept in the same file and reviewed in the same git diff as the code change.
3. **Architecture & decision layer (`docs/*.md`)**: Low churn, macro scope. Records cross-module
   interactions, rationale for chosen designs over rejected alternatives, and alignment with GNOME/Mutter.
   Never duplicates volatile micro-implementation details (variable names, parameter lists, or internal thresholds).
