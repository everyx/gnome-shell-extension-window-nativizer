# What each upstream call is for

Every row of the API table in [shell-compatibility.md](shell-compatibility.md) links here. The
version status in that table is derived from `tools/shell-api.json` and deliberately not repeated
below: a fact a machine can extract should be extracted, because the four rows that used to state
it by hand were wrong.

What is written here is the part nothing can derive - why the extension needs the call, and what to
watch for when a new GNOME line appears. Sections are named after the entry id in
`tools/shell-api.json`, and `tools/gen-shell-api.mjs --check` fails on a link to a section that
does not exist, so the two cannot drift apart silently.

## get_client_type

`win.get_client_type()` - returns `Meta.WindowClientType`. The only reliable way to tell a Wayland
client from an X11 one, which decides whether an X11 frame is in the way.

## get_window_type

`win.get_window_type()` - returns `Meta.WindowType`. Gates the non-decoratable kinds (menus, popups,
docks) in the eligibility checks, the rule fingerprints and the inspector picker.

## is_maximized

`win.is_maximized()` - canonical from 49. `detector.isWindowMaximized()` probes for the method
rather than the version, so the fallback is chosen by what the shell offers. Note that Mutter
defines `meta_window_is_maximized()` in `src/core/window.c` from 48 but does not declare it in the
public header until 49: GJS cannot call what the header does not declare, so 48 still needs the
fallback.

## get_maximized

`win.get_maximized()` - the 45-48 spelling, a `MetaMaximizeFlags` bitmask. Only `(flags & 3) === 3`
means `Meta.MaximizeFlags.BOTH`; a partial tile sets one flag and is not a maximize.

## is_fullscreen

`win.is_fullscreen()` - a fullscreen window has no frame to round, so this gates the decoration
decision before any geometry is computed.

## get_tile_match

`win.get_tile_match()` - the adjacent matching tile, or null. Two tiles that match each other are
not a maximize, and the rule fingerprint has to know the difference.

## get_pid

`win.get_pid()` - the owning process id. Keys the per-process corner inference and its cache
eviction, and is the only handle on the client when reading `/proc/<pid>/maps`.

## get_frame_rect

`win.get_frame_rect()` - the window body with the margin excluded; the rectangle `RoundedClipEffect`
rounds.

## get_buffer_rect

`win.get_buffer_rect()` - what the clip target is sized from. `buffer_rect - frame_rect` is the ring
the client drew its own shadow into, read per side and never invented where Mutter reports none.
The C prototype takes two parameters and carries no annotation, so a header read suggests GJS takes
two; it takes none and returns the rectangle.

## allows_resize

`win.allows_resize()` - whether the window offers a resize at all; gates the resize band.

## get_monitor

`win.get_monitor()` - the monitor the window is on. The clip radius and the band's bounds are
resolved per monitor, so this is read before either.

## begin_grab_op

`win.begin_grab_op()` - three shapes, not two. 45 takes `(op, device, sequence, time)`; 46-48 adds
`pos_hint`; 49-51 replaces device and sequence with a `sprite`. `compat/grabOp.js` dispatches on
arity, which separates 46-48 from the rest but cannot separate 45 from 49-51, so 45 is not reached.

## get_compositor_private

`win.get_compositor_private()` - the window actor. Every decoration added is parented to
`global.window_group` and pinned to this actor, so this is the first thing a reconcile needs.

## is_hidden

`win.is_hidden()` - read together with `minimized` by the inspector picker, which skips windows the
user cannot see.

## is_attached_dialog

`win.is_attached_dialog()` - part of the picker's fingerprint: an attached dialog is not a window to
decorate on its own.

## get_transient_for

`win.get_transient_for()` - the same fingerprint: a window with a parent is treated as a dialog.

## located_on_workspace

`win.located_on_workspace()` - the picker lists only windows on the active workspace.

## is_on_all_workspaces

`win.is_on_all_workspaces()` - read before `located_on_workspace` in the picker's filter, so a
sticky window is not filtered out by the workspace it happens to report.

## decorated

`win.decorated` - the policy flag from `mwm_decorated` (default TRUE), not proof of a live frame.
The real frame test is `priv->frame != NULL` (`meta_window_x11_is_ssd`); consumed here as "has frame
decorations (SSD)".

## is_client_decorated

`win.is_client_decorated()` - declared in 45 and 46, removed in 47. The extension does not call it.
The hand-written version of this table recorded it as "does not exist - a GTK concept with no
counterpart in Meta.Window", which was wrong: Mutter had it and dropped it. It stays as an audited
entry because a negative claim is the kind nobody ever re-checks.

## maximized_vertically

`win.maximized_vertically` - read as a pair with the horizontal flag by the tile check. Mutter gives
every tile mode except `META_TILE_MAXIMIZED` the `META_MAXIMIZE_VERTICAL` flag, so one flag alone is
a half tile.

## maximized_horizontally

`win.maximized_horizontally` - the other half of that pair.

## minimized

`win.minimized` - the picker skips minimized windows.

## get_monitor_geometry

`global.display.get_monitor_geometry(i)` - the monitor rectangle the band is clipped to.

## get_monitor_scale

`global.display.get_monitor_scale(i)` - fractional, so it is not an integer. Called through optional
chaining, and the only place the extension asks for a scale.

## get_n_monitors

`global.display.get_n_monitors()` - bounds the monitor loop in the snap helpers.

## get_tab_list

`global.display.get_tab_list()` - the window list the manager reconciles against
(`Meta.TabList.NORMAL_ALL`), so a window that never emits a map signal is still picked up.

## get_monitor_manager

`global.backend.get_monitor_manager()` - read for the monitor layout, through optional chaining.

## display_set_cursor

`global.display.set_cursor()` - declared from 45 to 49, gone in 50, when the cursor became
actor-level (`Clutter.Actor:set_cursor_type`) and seat-level. The extension does not call it. The
hand-written table called it non-existent, which is true only from 50 on.

## set_cursor_type

`actor.set_cursor_type()` - per-actor cursor, introduced in Clutter 50.
`compat/actorCursor.js:setActorCursor()` degrades on 45-49 without breaking resizing.

## set_child_above_sibling

`global.window_group.set_child_above_sibling()` - re-pins the band above its window actor on
`restacked` (`manager.js:_restackActors`).

## set_child_below_sibling

`global.window_group.set_child_below_sibling()` - re-pins the shadow below its window actor, in the
same place.

## bind_constraint_new

`new Clutter.BindConstraint()` - binds the shadow actor and the band to the window actor's position
and size, so their geometry follows a resize without a JS tick.

## actor_meta_set_enabled

`effect.set_enabled()` - toggles the offscreen pass without detaching the effect. A real method
(`clutter_actor_meta_set_enabled`), not something GJS derives from the property of the same name;
the effect inherits it from `Clutter.ActorMeta`.

## actor_meta_enabled

`Clutter.ActorMeta:enabled` - the property behind that method. `clutter-effect.c` points the vfunc
`clutter_effect_set_enabled` at its setter, which is the symbol an earlier version of this table
cited as if it were the API.

## actor_meta_get_actor

`effect.get_actor()` - the actor the effect is attached to. `Clutter.Effect` extends
`Clutter.ActorMeta`, which is where the accessor lives.

## offscreen_effect_paint_target

`Clutter.OffscreenEffect:vfunc_paint_target()` - the hook `RoundedClipEffect` reads the live actor
size in. It inherits the slot through `Shell.GLSLEffect` (45-50) or `Clutter.ShaderEffect` (51),
both offscreen effects. The shell's own `FadeEffect` (`messageList.js`) uses the same hook.

## clutter_set_uniform_float

`effect.set_uniform_float()` - added in 51. The modern branch of `compat/shaderEffect.js` inherits
it rather than reimplementing it: going through `set_uniform_value` would drop vector components.

## cogl_pipeline_set_uniform_float

`pipeline.set_uniform_float()` - uploads the shadow's uniforms on the Cogl pipeline. GJS exposes two
signatures for it, probed once in `effects/shadowTexture.js`.

## shell_glsl_set_uniform_float

`effect.set_uniform_float()` on `Shell.GLSLEffect` - the 45-50 uniform upload. The whole file goes
away in 51, which is why the compat class exists at all.

## backend_get_default_seat

`backend.get_default_seat()` - resolves the pointer device on 45-48, reached through
`Clutter.get_default_backend()`.

## get_default_backend

`Clutter.get_default_backend()` - dropped in 51. Only reached on 45-48, behind an optional chain.

## shell_glsl_effect_h

`Shell.GLSLEffect` - the shader base class on 45-50. 51 removed it in favour of
`Clutter.ShaderEffect`, and with it `shell_glsl_effect_set_uniform_float`.

## mutter_api_version

`libmutter_api_version` in Mutter's `meson.build` - what the typelibs are called. It runs 13 to 16
across 45-48, is 17 on 49 and 18 on 50, and becomes 51 when Mutter aligns the number to the release.
The extension never names a version: `import gi://Meta` binds whatever the host ships, which is why
this is recorded - to keep the typelib names quoted in prose from drifting.

## window_tracker_get_default

`Shell.WindowTracker.get_default()` - resolves the app a window belongs to, which is the id the
identity fingerprint is built from. Guarded, because the tracker is unusable while the session is
tearing down.

## st_box_layout_vertical

`St.BoxLayout:vertical` - deprecated in 48, removed in 51. The migration guide attributes the
removal to `St.Widget`; upstream it is declared on `St.BoxLayout`. The extension does not use it
either way, and the entry is recorded so the attribution stays corrected.

## st_settings_get

`St.Settings.get()` - the shell's own settings, read for `high_contrast` (cached, and refreshed on
`notify::high-contrast`) and for the accent colour the inspector resolves.

## main_overview

`Main.overview` - the shell's overview object, exported from `js/ui/main.js`. It is null until the
shell builds it, so every read of it goes through optional chaining.

## main_ui_group

`Main.uiGroup` - the stage-level container every decoration we add is parented to, so that the
shadow and the band stack with the window actor rather than with the window's own actor tree.

## overview_visible

`Main.overview.visible` - gates clip effect suspension during the overview, so window previews are
not rendered through the clip effect.
