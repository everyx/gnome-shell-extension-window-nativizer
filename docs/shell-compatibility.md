# The Shell / Mutter API surface we depend on

Audited against the newest patch release of both GNOME lines this extension supports, 50 and 51, with
each declaration below extracted from a clone at that tag instead of read by hand. The extraction and
its result are recorded in `tools/shell-api.json`, together with the tag and commit each one came
from; `tools/audit-shell-api.mjs` re-derives them, and [development.md](development.md) describes when
to run it.

While GNOME 51 aligns the Mutter API
version to `'51'` (packaging `Meta-51`, `Shell-51`, and `Clutter-51` typelibs instead of `18`),
the core compositor and actor pipeline retains long-term architectural stability across 50–51,
with the shader base class bridged across 50 and 51.

The table is generated from `tools/shell-api.json` by `tools/gen-shell-api.mjs`, and the status column
is computed from the declarations recorded there - see [shell-api.md](shell-api.md) for what each call is
for. One thing the extension relies on is not in it, because it is not Mutter's surface: the Adwaita
detection reads `/proc/<pid>/maps` through `Gio.File`, which is kernel and GIO API.

Anything here that stops being true is an upstream compatibility break, not an internal refactor.

<!-- shell-api-table:start -->
| Used | Status | Notes |
|---|---|---|
| `win.get_client_type()` | 50–51 stable | [why](shell-api.md#get_client_type) |
| `win.get_window_type()` | 50–51 stable | [why](shell-api.md#get_window_type) |
| `win.is_maximized()` | 50–51 stable | [why](shell-api.md#is_maximized) |
| `win.is_fullscreen()` | 50–51 stable | [why](shell-api.md#is_fullscreen) |
| `win.get_tile_match()` | 50–51 stable | [why](shell-api.md#get_tile_match) |
| `win.get_pid()` | 50–51 stable | [why](shell-api.md#get_pid) |
| `win.get_frame_rect()` | 50–51 stable | [why](shell-api.md#get_frame_rect) |
| `win.get_buffer_rect()` | 50–51 stable | [why](shell-api.md#get_buffer_rect) |
| `win.allows_resize()` | 50–51 stable | [why](shell-api.md#allows_resize) |
| `win.get_monitor()` | 50–51 stable | [why](shell-api.md#get_monitor) |
| `win.begin_grab_op()` | 50–51 stable | [why](shell-api.md#begin_grab_op) |
| `win.get_compositor_private()` | 50–51 stable | [why](shell-api.md#get_compositor_private) |
| `win.is_hidden()` | 50–51 stable | [why](shell-api.md#is_hidden) |
| `win.is_attached_dialog()` | 50–51 stable | [why](shell-api.md#is_attached_dialog) |
| `win.get_transient_for()` | 50–51 stable | [why](shell-api.md#get_transient_for) |
| `win.located_on_workspace()` | 50–51 stable | [why](shell-api.md#located_on_workspace) |
| `win.is_on_all_workspaces()` | 50–51 stable | [why](shell-api.md#is_on_all_workspaces) |
| `win.decorated` | 50–51 stable | [why](shell-api.md#decorated) |
| `win.maximized_vertically` | 50–51 stable | [why](shell-api.md#maximized_vertically) |
| `win.maximized_horizontally` | 50–51 stable | [why](shell-api.md#maximized_horizontally) |
| `win.minimized` | 50–51 stable | [why](shell-api.md#minimized) |
| `global.display.get_monitor_geometry(i)` | 50–51 stable | [why](shell-api.md#get_monitor_geometry) |
| `global.display.get_monitor_scale(i)` | 50–51 stable | [why](shell-api.md#get_monitor_scale) |
| `global.display.get_n_monitors()` | 50–51 stable | [why](shell-api.md#get_n_monitors) |
| `global.display.get_tab_list()` | 50–51 stable | [why](shell-api.md#get_tab_list) |
| `global.backend.get_monitor_manager()` | 50–51 stable | [why](shell-api.md#get_monitor_manager) |
| `actor.set_cursor_type()` | 50–51 stable | [why](shell-api.md#set_cursor_type) |
| `global.window_group.set_child_above_sibling()` | 50–51 stable | [why](shell-api.md#set_child_above_sibling) |
| `global.window_group.set_child_below_sibling()` | 50–51 stable | [why](shell-api.md#set_child_below_sibling) |
| `actor.get_transform()` | 50–51 stable | [why](shell-api.md#actor_get_transform) |
| `new Clutter.BindConstraint()` | 50–51 stable | [why](shell-api.md#bind_constraint_new) |
| `effect.set_enabled()` | 50–51 stable | [why](shell-api.md#actor_meta_set_enabled) |
| `Clutter.ActorMeta:enabled` | 50–51 stable | [why](shell-api.md#actor_meta_enabled) |
| `effect.get_actor()` | 50–51 stable | [why](shell-api.md#actor_meta_get_actor) |
| `Clutter.OffscreenEffect:vfunc_paint_target()` | 50–51 stable | [why](shell-api.md#offscreen_effect_paint_target) |
| `effect.set_uniform_float()` | 50 absent / 51 | [why](shell-api.md#clutter_set_uniform_float) |
| `pipeline.set_uniform_float()` | 50–51 stable | [why](shell-api.md#cogl_pipeline_set_uniform_float) |
| `Cogl.PixelFormat` | 50–51 stable | [why](shell-api.md#cogl_pixel_format) |
| `Clutter.CursorType` | 50–51 stable | [why](shell-api.md#clutter_cursor_type) |
| `effect.set_uniform_float() [Shell.GLSLEffect]` | 50 / 51 absent | [why](shell-api.md#shell_glsl_set_uniform_float) |
| `backend.get_sprite()` | 50–51 stable | [why](shell-api.md#backend_get_sprite) |
| `backend.get_pointer_sprite()` | 50–51 stable | [why](shell-api.md#backend_get_pointer_sprite) |
| `Meta-<api> / Shell-<api> typelibs` | 50 / 51 | [why](shell-api.md#mutter_api_version) |
| `Shell.GLSLEffect` | 50 / 51 absent | [why](shell-api.md#shell_glsl_effect_h) |
| `Shell.WindowTracker.get_default()` | 50–51 stable | [why](shell-api.md#window_tracker_get_default) |
| `St.BoxLayout:vertical` | 50 / 51 absent | [why](shell-api.md#st_box_layout_vertical) |
| `St.SystemColorScheme` | 50–51 stable | [why](shell-api.md#st_system_color_scheme) |
| `St.Settings:enable-animations` | 50–51 stable | [why](shell-api.md#st_settings_enable_animations) |
| `St.Settings:color-scheme` | 50–51 stable | [why](shell-api.md#st_settings_color_scheme) |
| `St.Settings.get()` | 50–51 stable | [why](shell-api.md#st_settings_get) |
| `Main.overview` | 50–51 stable | [why](shell-api.md#main_overview) |
| `Main.uiGroup` | 50–51 stable | [why](shell-api.md#main_ui_group) |
| `Main.overview.visible` | 50–51 stable | [why](shell-api.md#overview_visible) |
<!-- shell-api-table:end -->

> **Removed probe.** An earlier version read `Meta.ShapedTexture.paint_to_bitmap()` (51; the
> 50-era `get_image()` could abort GJS on a NULL) to decide whether masking an overview window
> would move Mutter's screenshot off the direct-read path, and left a directly readable window
> square when it would. That refusal protected a capture-level behaviour no user can perceive, at
> the cost of a rounded preview the user can see, so it failed the project's standard: the
> criterion is user-perceptible UI behaviour, and a capture or a window share is out of scope
> because the decoration already changes what a capture shows. The probe and its capability record
> are gone.

## Evolution across GNOME 50–51

Two upstream watersheds fall in this range - the shader base class and the Mutter typelib naming -
and the shader base class continues to bridge both: GNOME 50 (`Shell.GLSLEffect`) and 51
(`Clutter.ShaderEffect`), with the typelib binding dynamically via `gi://Meta`. The grab operation
signature and the maximize query already target the modern upstream APIs on this baseline, and the
per-actor cursor is resolved by capability rather than by a version. What changed and what the
extension does about it is described where each call appears in [shell-api.md](shell-api.md); which
of the two lines share which shape is in the table above, computed rather than remembered.

## Re-checking the mirrored monitor scan on a Mutter bump

`tools/check-upstream-mirrors.mjs` pins the phase arithmetic to the vendored
`meta-window-actor-wayland.c`, but `resolveHighestScaleMonitorIndex` (`src/platform/window.js`) also
re-runs the monitor-selection rule behind `meta_window_get_highest_scale_monitor`: max scale over
the logical monitors whose layout rect intersects the window frame. That rule lives in
`meta_monitor_manager_get_highest_scale_monitor_from_rect` (`meta-monitor-manager.c`), which is not
vendored, so the check cannot assert it; `meta_window_find_highest_scale_monitor_from_frame_rect`
(`window.c`) is the only path that reaches it from the window side.

The scan takes the rect it intersects, because two callers need two rects. The phase mirror passes
the **frame** rect, matching `meta_window_get_highest_scale_monitor`. The clip's FBO-scale candidate
set passes the **buffer** rect, because that is the actor's allocation and what
`clutter_actor_get_real_resource_scale` scans: `update_stage_views` takes
`clutter_actor_get_transformed_extents` of the actor's own box, and Mutter sizes the window actor
and its surface container at the buffer rect. That second rule lives in `clutter-actor.c`, also not
vendored.

When bumping Mutter, re-read the functions and confirm the scan still matches: the same positive-area
intersection test, the same "highest scale wins" pick (a tie keeps the earlier index), and -1 when
a readable rect intersects no monitor, with null when the rect itself cannot be read. Re-read
`update_stage_views` and `clutter_actor_get_transformed_extents` too, and confirm a window actor is
still allocated at its buffer rect (`meta_window_actor_sync_actor_geometry`). Neither file is
vendored, so this is a manual step by necessity; `docs/decoration-model.md` records the same
re-check at the phase mirror's reopen condition.

The pick reply makes the gap observable: on a mixed-DPI multi-monitor machine with the extension
enabled, pick a decorated Wayland window interactively with `debug` true (`PickWindow`;
see `development.md`) and compare `mirrorPhaseX/Y` with `appliedPhaseX/Y`. They agree when the scan
is right; a mismatch is what a `resolveHighestScaleMonitorIndex` re-check is for. The single-monitor
dev session cannot exercise this, which is exactly why the reply carries both.

## Additional GNOME 51 upstream changes audited

GNOME Shell 51 migration guide lists additional upstream breaking changes that were audited for applicability:
- **`disable()` cannot be async**: In GNOME 51, returning a Promise from `Extension.disable()` throws an error. The extension's `disable()` is completely synchronous.
- **`Clutter.get_default_backend()` dropped**: `Clutter.get_default_backend()` was removed upstream. Our codebase avoids it entirely: the dispatch obtains the backend from `stage.get_context().get_backend()` or `global.backend`.
- **`St.ButtonMask` enum renames**: Not used by this extension.
- **`St.BoxLayout:vertical` property removed** (in 51): Not used by this extension. The migration guide attributes it to `St.Widget`; upstream it is declared on `St.BoxLayout`.
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
  that carries a buffer. Introduced in `63fa79c878` (2024-07-16) and still present in 50.5; the
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

- **`Gtk-CRITICAL **: ...: Unable to register the application: ... Could not activate remote peer 'org.a11y.atspi.Registry'`**,
  logged by GTK applications in headless/nested sessions without an AT-SPI accessibility bus. Process-independent
  environment noise, counted and reported.

- **`Gjs-WARNING **: ...: Type GITypeInfo of property ... does not match ... Falling back to slow path`**,
  from upstream GJS property introspection where C getter return types disagree with introspection metadata
  (e.g. `Adw.PreferencesWindow::visible-page`). Counted and reported.

- **`libmutter-WARNING **: ...: Tried to ping window ... with a bad serial! Not allowed.`**,
  from Mutter when pinging a client window that has unmapped or severed its Wayland connection during stress
  tests. Counted and reported.

## Working rules

- **The decisions and queries are pure (Command-Query Separation).** Everything that decides
  decoration delegates to pure functions; shell-side queries and predicates
  (`is*`, `has*`, `should*`) strictly read in-memory cache/state snapshots without mutating state
  or launching implicit I/O. Asynchronous operations (such as `/proc/<pid>/maps` reads) are
  triggered exclusively by explicit lifecycle commands, preventing timing inversions and flicker.
- **Outside the window picker, only the resize band takes input.** Every actor the extension
  adds is `reactive: false` except the band's four strip children, which exist to start a
  resize grab, and the picker's full-stage overlay, which is reactive and
  takes `button-press-event` under a `pushModal` grab for the duration of a pick.
  `decoration-model.md` § The resize band records what that costs and how to reverse it per kind.
- **`enable()` and `disable()` are idempotent.** After `disable()` nothing of ours
  remains: no connected signals, no actors, no pending sources.
- **Never instantiate long-lived GObjects at JS module scope.** EGO-X-004 rejects
  module-scope GObjects (e.g. `Gio.Cancellable`); tie their lifecycle strictly to session or instance boundaries.
- **Signals that may not exist are connected in "safe" mode.** Window- and
  actor-level signals vary across the audited 50–51 lines, and the object can be unmanaged while we
  connect, so a failure there is expected and swallowed. A failure on a global
  signal is not: it means an API assumption is wrong.
