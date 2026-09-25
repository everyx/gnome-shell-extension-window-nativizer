# The Shell / Mutter API surface we depend on

Audited and verified against GNOME Shell and upstream Mutter official release tags from
**45.0 to 51.0** (spanning 45, 46, 47, 48, 49, 50, and 51). While GNOME 51 aligns the Mutter API
version to `'51'` (packaging `Meta-51`, `Shell-51`, and `Clutter-51` typelibs instead of `18`),
the core compositor and actor pipeline retains long-term architectural stability across 45–51,
with specific evolutionary watersheds handled via defensive polyfills and graceful degradation.

Anything here that stops being true is an upstream compatibility break, not an internal refactor.

| Used | Status | Notes |
|---|---|---|
| `win.get_client_type()` | 45–51 stable | returns `Meta.WindowClientType`; the only reliable way to tell a Wayland client from an X11 one |
| `win.get_window_type()` | 45–51 stable | returns `Meta.WindowType`; gates non-decoratable window kinds (menus, popups, docks) in eligibility checks, rule fingerprints, and the inspector picker |
| `win.decorated` | 45–51 stable | policy flag from `mwm_decorated` (default TRUE), not proof of a live frame — the real frame test is `priv->frame != NULL` (`meta_window_x11_is_ssd`); consumed here as "has frame decorations (SSD)" |
| `win.is_client_decorated()` | **does not exist** | a GTK concept; `Meta.Window` has no counterpart |
| `win.is_maximized()` / `win.get_maximized()` | 45–51 (45–48 fallback) | 49–51 canonical `meta_window_is_maximized()`; 45–48 uses `(win.get_maximized() & 3) === 3` matching `MetaMaximizeFlags.BOTH` (avoiding partial tile misdetection). Polyfilled in `detector.isWindowMaximized()` |
| `win.is_fullscreen()` | 45–51 stable | canonical `meta_window_is_fullscreen` |
| `win.get_tile_match()` | 45–51 stable | the adjacent matching tile, or null |
| `win.get_pid()` | 45–51 stable | owning process id; keys the per-process corner inference and its cache eviction |
| `win.get_frame_rect()` | 45–51 stable | the window body, margin excluded; the rectangle `RoundedClipEffect` rounds |
| `win.get_buffer_rect()` | 45–51 stable | what the clip target is sized from; `buffer_rect - frame_rect` is the ring the client drew its own shadow into, read per side and never invented where Mutter reports none |
| `/proc/pid/maps` via `Gio.File` | kernel + GIO stable | which Adwaita providers a process maps (`libadwaita-1.so`, `libhandy-1.so`, `libxul.so`); per-process, not per-window |
| `global.display.get_monitor_scale(i)` | 45–51 stable | fractional scale, so it is not an integer; called through optional chaining |
| `global.backend.get_monitor_manager()` | 45–51 stable | called through optional chaining |
| `win.allows_resize()` | 45–51 stable | whether the window offers a resize; gates the resize band |
| `win.get_monitor()` / `global.display.get_monitor_geometry(i)` | 45–51 stable | the monitor rectangle the band is clipped to |
| `win.begin_grab_op()` | 45–51 (dual signature) | 49–51 takes 4 args `(op, sprite, time, pos_hint)`; 45–48 takes 5 args `(op, device, sequence, time, pos_hint)`. Dispatched via function arity (`win.begin_grab_op.length === 5`) in `compat/grabOp.js:beginWindowGrabOp()`, avoiding try-catch double-dispatch |
| `backend.get_sprite(stage, event)` | 49–51 | the pointer sprite `begin_grab_op` takes in 49–51; null on 45–48 where grab op takes device/sequence directly |
| `Clutter.Actor:set_cursor_type()` | 50–51 (45–49 degraded) | per-actor cursor introduced in Clutter 50; handled transparently by `compat/actorCursor.js:setActorCursor()` which gracefully degrades on 45–49 without breaking resizing |
| `Clutter.BindConstraint` | 45–51 stable | binds the shadow actor and the band to the window actor's position/size, so their geometry follows a resize without a JS tick |
| `Clutter.Effect:vfunc_paint_target()` / `get_actor()` | 45–51 stable | the hook `RoundedClipEffect` reads the live actor size in; the shell's own `FadeEffect` (`messageList.js`) uses the same pair |
| `Clutter.Effect:set_enabled()` | 45–51 stable | canonical `clutter_effect_set_enabled` in `clutter/clutter/clutter-effect.c`; toggles the offscreen pass without detaching the effect |
| `Main.overview` (`visible`, `showing`, `hidden`) | 45–51 stable | canonical Shell overview lifecycle API (`js/ui/overview.js`); gates clip effect suspension during overview to prevent blurry downscaled previews |
| `global.window_group.set_child_above_sibling()` | 45–51 stable | re-pins the band above its window actor on `restacked` |
| `Meta.Cursor` / `global.display.set_cursor()` | **does not exist** | GNOME Shell has no such API; the cursor is actor-level on 50–51 or seat-level |

## Evolution across GNOME 45–51

Audit of the Mutter and Shell C source code trees from 45.0 through 51.0 identifies five key architectural watersheds. The extension bridges each without platform branching, adhering to the zero-side-effect ponyfill architecture (`src/compat/`):

| Feature / Subsystem | GNOME 45–48 | GNOME 49 | GNOME 50 | GNOME 51 | Extension Strategy |
|---|---|---|---|---|---|
| **Shader Effect** | `Shell.GLSLEffect` | `Shell.GLSLEffect` | `Shell.GLSLEffect` | `Clutter.ShaderEffect` (`Shell.GLSLEffect` removed) | Zero-side-effect base class in `src/compat/shaderEffect.js` exposing modern `ShaderEffect` |
| **Maximized Check** | `get_maximized()` (`MetaMaximizeFlags`) | `is_maximized()` (`gboolean`) | `is_maximized()` (`gboolean`) | `is_maximized()` (`gboolean`) | Pure function fallback in `detector.isWindowMaximized()` with `(flags & 3) === 3` check |
| **Grab Operation** | 5 args: `(op, dev, seq, time, pos)` | 4 args: `(op, sprite, time, pos)` | 4 args: `(op, sprite, time, pos)` | 4 args: `(op, sprite, time, pos)` | Pure helper in `src/compat/grabOp.js:beginWindowGrabOp()` using function arity check |
| **Actor Cursor** | Not available | Not available | `set_cursor_type(type)` | `set_cursor_type(type)` | Pure helper in `src/compat/actorCursor.js:setActorCursor()` |
| **Mutter Typelib** | `Meta-13` .. `Meta-16` | `Meta-17` | `Meta-18` (50) | `Meta-51` (51) | Dynamic ESM import (`import gi://Meta`) automatically binds the host's version |

## Additional GNOME 51 upstream changes audited

GNOME Shell 51 migration guide lists additional upstream breaking changes that were audited for applicability:
- **`disable()` cannot be async**: In GNOME 51, returning a Promise from `Extension.disable()` throws an error. Our `extension.js:disable()` is completely synchronous.
- **`Clutter.get_default_backend()` dropped**: `Clutter.get_default_backend()` was removed upstream. Our codebase avoids it entirely on GNOME 49–51 by gating legacy device lookup behind `win.begin_grab_op.length === 5`.
- **`St.ButtonMask` enum renames**: Not used by this extension.
- **`St.Widget:vertical` property removed**: Not used by this extension.
- **`Gio.DBus.makeProxyWrapper()` returns class needing `new`**: Not used (our IPC uses `Gio.DBusExportedObject` / standard GDBus proxy).

What GJS cannot see at all — the window geometry scale, Mutter's own shadow gates —
is in [decoration-model.md](decoration-model.md).

## Known upstream log noise

The e2e log audit fails on anything the shell prints that is not in its noise list, so an upstream
defect that fires on a normal path has to be dealt with here rather than worked around. One is:

- **`clutter_actor_set_color_state: assertion 'CLUTTER_IS_COLOR_STATE (color_state)' failed`**, from
  `meta_wayland_actor_surface_real_sync_actor_state()` in Mutter's
  `src/wayland/meta-wayland-actor-surface.c`. The function reads the actor's colour state and writes
  it straight back, but `clutter_actor_get_color_state()` returns NULL for an actor that never had one
  (it does not inherit), and `clutter_actor_set_color_state()` requires a non-NULL argument, so the
  write is rejected with a CRITICAL. Both NULL sources are the normal case - a client that does not
  use colour management has no `surface->color_state` either - so it fires on nearly every commit
  that carries a buffer. Introduced in `63fa79c878` (2024-07-16) and still present in 50.4; the
  rejected call returns immediately and there was nothing to write back, so the line is its whole
  effect.
  **Measured, not assumed**: one window mapped and resized produces one of these with the extension
  enabled and one with it disabled, so it is proportional to window activity and not to us. The audit
  exempts exactly that assertion, counts the lines it skipped and prints the count, so a change in
  how often it appears is still visible.

- **`(ibus-portal:<pid>): GLib-GIO-WARNING **: ...: Error releasing name org.freedesktop.portal.IBus: The connection is closed`**,
  from `ibus-portal` when the test headless session D-Bus daemon shuts down on `tools/dev.sh stop`.
  The daemon process attempts to release its well-known name after the bus has already severed client
  connections. The audit exempts this single message by matching its exact signature and reporting its
  count.

## Working rules

- **The decisions and queries are pure (Command-Query Separation).** Everything that decides
  decoration delegates to pure functions (`detector.js`); shell-side queries and predicates
  (`is*`, `has*`, `should*`) strictly read in-memory cache/state snapshots without mutating state
  or launching implicit I/O. Asynchronous operations (such as `/proc/<pid>/maps` reads) are
  triggered exclusively by explicit lifecycle commands, preventing timing inversions and flicker.
- **Outside the window picker, only the resize band takes input.** Every actor the extension
  adds is `reactive: false` except the band's four strip children, which exist to start a
  resize grab, and the picker's full-stage overlay (`lib/inspector.js`), which is reactive and
  takes `button-press-event` under a `pushModal` grab for the duration of a pick.
  `decoration-model.md` § The resize band records what that costs and how to reverse it per kind.
- **`enable()` and `disable()` are idempotent.** After `disable()` nothing of ours
  remains: no connected signals, no actors, no pending sources.
- **Never instantiate long-lived GObjects at JS module scope.** EGO-X-004 rejects
  module-scope GObjects (e.g. `Gio.Cancellable`); tie their lifecycle strictly to session or instance boundaries.
- **Signals that may not exist are connected in "safe" mode.** Window- and
  actor-level signals vary across 45–51, and the object can be unmanaged while we
  connect, so a failure there is expected and swallowed. A failure on a global
  signal is not: it means an API assumption is wrong.
