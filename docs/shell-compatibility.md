# The Shell / Mutter API surface we depend on

Audited against the newest patch release of every GNOME line from 45 to 51, with each declaration
below extracted from a clone at that tag instead of read by hand. The extraction and its result are
recorded in `tools/shell-api.json`, together with the tag and commit each one came from;
`tools/audit-shell-api.mjs` re-derives them, and [development.md](development.md) describes when to
run it.

While GNOME 51 aligns the Mutter API
version to `'51'` (packaging `Meta-51`, `Shell-51`, and `Clutter-51` typelibs instead of `18`),
the core compositor and actor pipeline retains long-term architectural stability across 45–51,
with specific evolutionary watersheds handled via defensive polyfills and graceful degradation.

The table is generated from `tools/shell-api.json` by `tools/gen-shell-api.mjs`, and the status column
is computed from the declarations recorded there - see [shell-api.md](shell-api.md) for what each call is
for. One thing the extension relies on is not in it, because it is not Mutter's surface: the Adwaita
detection reads `/proc/<pid>/maps` through `Gio.File`, which is kernel and GIO API.

Anything here that stops being true is an upstream compatibility break, not an internal refactor.

<!-- shell-api-table:start -->
| Used | Status | Notes |
|---|---|---|
| `win.is_client_decorated()` | 45–46 / 47–51 absent | [why](shell-api.md#is_client_decorated) |
| `global.display.set_cursor()` | 45–49 / 50–51 absent | [why](shell-api.md#display_set_cursor) |
| `win.get_client_type()` | 45–51 stable | [why](shell-api.md#get_client_type) |
| `win.get_window_type()` | 45–51 stable | [why](shell-api.md#get_window_type) |
| `win.is_maximized()` | 45–48 absent / 49–51 | [why](shell-api.md#is_maximized) |
| `win.get_maximized()` | 45–48 / 49–51 absent | [why](shell-api.md#get_maximized) |
| `win.is_fullscreen()` | 45–51 stable | [why](shell-api.md#is_fullscreen) |
| `win.get_tile_match()` | 45–51 stable | [why](shell-api.md#get_tile_match) |
| `win.get_pid()` | 45–51 stable | [why](shell-api.md#get_pid) |
| `win.get_frame_rect()` | 45–51 stable | [why](shell-api.md#get_frame_rect) |
| `win.get_buffer_rect()` | 45–51 stable | [why](shell-api.md#get_buffer_rect) |
| `win.allows_resize()` | 45–51 stable | [why](shell-api.md#allows_resize) |
| `win.get_monitor()` | 45–51 stable | [why](shell-api.md#get_monitor) |
| `win.begin_grab_op()` | 45 / 46–48 / 49–51 | [why](shell-api.md#begin_grab_op) |
| `win.get_compositor_private()` | 45–51 stable | [why](shell-api.md#get_compositor_private) |
| `win.is_hidden()` | 45–51 stable | [why](shell-api.md#is_hidden) |
| `win.is_attached_dialog()` | 45–51 stable | [why](shell-api.md#is_attached_dialog) |
| `win.get_transient_for()` | 45–51 stable | [why](shell-api.md#get_transient_for) |
| `win.located_on_workspace()` | 45–51 stable | [why](shell-api.md#located_on_workspace) |
| `win.is_on_all_workspaces()` | 45–51 stable | [why](shell-api.md#is_on_all_workspaces) |
| `win.decorated` | 45–51 stable | [why](shell-api.md#decorated) |
| `win.maximized_vertically` | 45–51 stable | [why](shell-api.md#maximized_vertically) |
| `win.maximized_horizontally` | 45–51 stable | [why](shell-api.md#maximized_horizontally) |
| `win.minimized` | 45–51 stable | [why](shell-api.md#minimized) |
| `global.display.get_monitor_geometry(i)` | 45–51 stable | [why](shell-api.md#get_monitor_geometry) |
| `global.display.get_monitor_scale(i)` | 45–51 stable | [why](shell-api.md#get_monitor_scale) |
| `global.display.get_n_monitors()` | 45–51 stable | [why](shell-api.md#get_n_monitors) |
| `global.display.get_tab_list()` | 45–51 stable | [why](shell-api.md#get_tab_list) |
| `global.backend.get_monitor_manager()` | 45–51 stable | [why](shell-api.md#get_monitor_manager) |
| `actor.set_cursor_type()` | 45–49 absent / 50–51 | [why](shell-api.md#set_cursor_type) |
| `global.window_group.set_child_above_sibling()` | 45–51 stable | [why](shell-api.md#set_child_above_sibling) |
| `global.window_group.set_child_below_sibling()` | 45–51 stable | [why](shell-api.md#set_child_below_sibling) |
| `new Clutter.BindConstraint()` | 45–51 stable | [why](shell-api.md#bind_constraint_new) |
| `effect.set_enabled()` | 45–51 stable | [why](shell-api.md#actor_meta_set_enabled) |
| `Clutter.ActorMeta:enabled` | 45 / 46–51 | [why](shell-api.md#actor_meta_enabled) |
| `effect.get_actor()` | 45–51 stable | [why](shell-api.md#actor_meta_get_actor) |
| `Clutter.OffscreenEffect:vfunc_paint_target()` | 45–51 stable | [why](shell-api.md#offscreen_effect_paint_target) |
| `effect.set_uniform_float()` | 45–50 absent / 51 | [why](shell-api.md#clutter_set_uniform_float) |
| `pipeline.set_uniform_float()` | 45–51 stable | [why](shell-api.md#cogl_pipeline_set_uniform_float) |
| `effect.set_uniform_float() [Shell.GLSLEffect]` | 45–50 / 51 absent | [why](shell-api.md#shell_glsl_set_uniform_float) |
| `backend.get_sprite()` | 45–48 absent / 49–51 | [why](shell-api.md#backend_get_sprite) |
| `backend.get_pointer_sprite()` | 45–48 absent / 49–51 | [why](shell-api.md#backend_get_pointer_sprite) |
| `seat.get_pointer()` | 45–48 / 49–51 absent | [why](shell-api.md#seat_get_pointer) |
| `backend.get_default_seat()` | 45–51 stable | [why](shell-api.md#backend_get_default_seat) |
| `Meta-<api> / Shell-<api> typelibs` | 45 / 46 / 47 / 48 / 49 / 50 / 51 | [why](shell-api.md#mutter_api_version) |
| `Shell.GLSLEffect` | 45–50 / 51 absent | [why](shell-api.md#shell_glsl_effect_h) |
| `Shell.WindowTracker.get_default()` | 45–51 stable | [why](shell-api.md#window_tracker_get_default) |
| `St.BoxLayout:vertical` | 45 / 46–47 / 48–50 / 51 absent | [why](shell-api.md#st_box_layout_vertical) |
| `St.SystemColorScheme` | 45–51 stable | [why](shell-api.md#st_system_color_scheme) |
| `St.Settings:enable-animations` | 45 / 46–51 | [why](shell-api.md#st_settings_enable_animations) |
| `St.Settings:color-scheme` | 45 / 46–51 | [why](shell-api.md#st_settings_color_scheme) |
| `St.Settings.get()` | 45–51 stable | [why](shell-api.md#st_settings_get) |
| `Main.overview` | 45–51 stable | [why](shell-api.md#main_overview) |
| `Main.uiGroup` | 45–51 stable | [why](shell-api.md#main_ui_group) |
| `Main.overview.visible` | 45–51 stable | [why](shell-api.md#overview_visible) |
<!-- shell-api-table:end -->

## Evolution across GNOME 45–51

Five upstream watersheds fall in this range - the shader base class, the maximize query, the grab
operation signature, the per-actor cursor, and the Mutter typelib naming. The extension bridges each
through `src/compat/` without platform branching. What changed and what the extension does about it
is described where each call appears in [shell-api.md](shell-api.md); which versions share which
shape is in the table above, computed rather than remembered.

## Additional GNOME 51 upstream changes audited

GNOME Shell 51 migration guide lists additional upstream breaking changes that were audited for applicability:
- **`disable()` cannot be async**: In GNOME 51, returning a Promise from `Extension.disable()` throws an error. Our `extension.js:disable()` is completely synchronous.
- **`Clutter.get_default_backend()` dropped**: `Clutter.get_default_backend()` was removed upstream. Our codebase avoids it entirely on GNOME 49–51: the dispatch asks whether the backend can produce a pointer sprite at all, and only the 45–48 path reaches for a device.
- **`St.ButtonMask` enum renames**: Not used by this extension.
- **`St.BoxLayout:vertical` property removed** (deprecated since 48): Not used by this extension. The migration guide attributes it to `St.Widget`; upstream it is declared on `St.BoxLayout`.
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
