# What each upstream call is for

Every row of the API table in [shell-compatibility.md](shell-compatibility.md) links here. The
version status in that table is derived from `tools/shell-api.json` and deliberately not repeated
below, with one exception: a section that explains a watershed has to say which line it happened on,
because "the signature changed" is not actionable on its own. Everything else - which versions share
which shape, what the declaration is - is the table's and the record's to state. A fact a machine
can extract should be extracted, because the four rows that used to state it by hand were wrong.

What is written here is the part nothing can derive - why the extension needs the call, and what to
watch for when a new GNOME line appears. Sections are named after the entry id in
`tools/shell-api.json`, and `tools/gen-shell-api.mjs --check` fails on a link to a section that
does not exist, so the two cannot drift apart silently.

## get_client_type

`win.get_client_type()` - returns `Meta.WindowClientType`. The only reliable way to tell a Wayland
client from an X11 one, which decides whether an X11 frame is in the way.

## get_window_type

`win.get_window_type()` - returns `Meta.WindowType`. Gates the non-decoratable kinds (menus, popups,
docks) in the eligibility checks, the window kinds and the inspector picker.

## is_maximized

`win.is_maximized()` - the canonical query where it exists; the status column of the table in
[shell-compatibility.md](shell-compatibility.md) says from which line, and the record holds the
declaration. The extension probes for the method
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
not a maximize, and the decoration decision has to know the difference (it is transient state, so
it is deliberately not part of the kind).

## get_pid

`win.get_pid()` - the owning process id. Keys the per-process corner inference, and is the only
handle on the client when reading `/proc/<pid>/maps`.

## get_frame_rect

`win.get_frame_rect()` - the window body with the margin excluded; the rectangle the rounded clip
is derived from.

## get_buffer_rect

`win.get_buffer_rect()` - what the clip target is sized from. `buffer_rect - frame_rect` is the ring
the client drew its own shadow into, read per side and never invented where Mutter reports none.
The C prototype takes two parameters and carries no annotation, so a header read suggests GJS takes
two; it takes none and returns the rectangle.

## allows_resize

`win.allows_resize()` - whether the window offers a resize at all; gates the resize band.

## get_monitor

`win.get_monitor()` - the monitor the window is on. The clip scale and the band's bounds are
resolved per monitor, so this is read before either.

## begin_grab_op

`win.begin_grab_op()` - three shapes, not two. 45 takes `(op, device, sequence, time)`; 46-48 adds
`pos_hint`; 49-51 replaces device and sequence with a `sprite`. The extension dispatches on
arity, which separates 46-48 from the rest; 45 and 49-51 both declare four, so it asks a second
question - whether the backend can produce a pointer sprite at all - and that is what tells them
apart.

## get_compositor_private

`win.get_compositor_private()` - the window actor. The shadow actor and the resize band are
parented to `global.window_group` and pinned to this actor, while the clip is attached to it as an
effect, so this is the first thing a reconcile needs.

## is_hidden

`win.is_hidden()` - read together with `minimized` by the inspector picker, which skips windows the
user cannot see.

## is_attached_dialog

`win.is_attached_dialog()` - part of the window kind: an attached dialog is not a window to
decorate on its own.

## get_transient_for

`win.get_transient_for()` - the same kind: a window with a parent is treated as a dialog.

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

`global.display.get_n_monitors()` - bounds the monitor-index checks the extension makes before it resolves a monitor's scale or bounds.

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
The extension degrades on 45-49 without breaking resizing.

## set_child_above_sibling

`global.window_group.set_child_above_sibling()` - re-pins the band above its window actor on the
`restacked` signal.

## set_child_below_sibling

`global.window_group.set_child_below_sibling()` - re-pins the shadow below its window actor, in the
same place.

## bind_constraint_new

`new Clutter.BindConstraint()` - binds the shadow actor and the band to the window actor's position
and size, so their geometry follows a resize without a JS tick.

## actor_meta_set_enabled

`effect.set_enabled()` - the offscreen-pass toggle a `Clutter.ActorMeta` effect exposes. A real
method (`clutter_actor_meta_set_enabled`), not something GJS derives from the property of the same
name; the effect inherits it from `Clutter.ActorMeta`. The extension does not call it: it attaches
and detaches the effect instead, so the entry records the API and its property rather than a call
site.

## actor_meta_enabled

`Clutter.ActorMeta:enabled` - the property behind that method. `clutter-effect.c` points the vfunc
`clutter_effect_set_enabled` at its setter, which is the symbol an earlier version of this table
cited as if it were the API. The extension reads neither the property nor the method.

## actor_meta_get_actor

`effect.get_actor()` - the actor the effect is attached to. `Clutter.Effect` extends
`Clutter.ActorMeta`, which is where the accessor lives.

## offscreen_effect_paint_target

`Clutter.OffscreenEffect:vfunc_paint_target()` - the hook the clip effect reads the live actor
size in. It inherits the slot through `Shell.GLSLEffect` (45-50) or `Clutter.ShaderEffect` (51),
both offscreen effects. The shell's own `FadeEffect` (`messageList.js`) uses the same hook.

## actor_paint_node

`Clutter.Actor:vfunc_paint_node()` - the hook the shadow actor paints its eight slices through. It
is the only place the extension builds geometry rather than setting a parameter.

The vfunc gained its `ClutterPaintContext` argument in 47: on 45-46 it is called with the paint
root alone. The shadow painter reads a Cogl context out of that argument, so on those two lines it
receives `undefined` and cannot build a pipeline - the record's only difference in this surface
with a live consequence. Upstream does offer the context another way there
(`clutter_backend_get_cogl_context`, 45-50), so the fix is small, but it is a change to the paint
path and it is only reachable on lines this project has no shell for: it is recorded here as an
open item rather than guessed at.

## pipeline_node_new

`Clutter.PipelineNode` - the node the eight slices are emitted as: one node per drawn style, with a
textured rectangle per slice. Declared in Clutter's paint-node header, alongside the vfunc it is
used from.

## paint_node_add_child

`Clutter.PaintNode.add_child()` - how a node joins the tree being painted. The shadow actor adds its
pipeline node to the root the vfunc is handed, and the slices hang off that.

## paint_node_add_texture_rectangle

`Clutter.PaintNode.add_texture_rectangle()` - one slice: a destination box in actor coordinates and
the source rectangle in the baked texture. This is what makes the slice layout a paint-node tree
rather than eight actors.

## clutter_set_uniform_float

`effect.set_uniform_float()` - the extension inherits
it rather than reimplementing it: going through `set_uniform_value` would drop vector components.

## cogl_pipeline_set_uniform_float

`pipeline.set_uniform_float()` - uploads the shadow's uniforms on the Cogl pipeline. GJS exposes two
signatures for it, so the extension probes which one the host provides.

## offscreen_effect_get_pipeline

`effect.get_pipeline()` - retrieves the underlying Cogl pipeline from `Clutter.OffscreenEffect`.
The extension queries this during paint to configure hardware mipmapping on the offscreen FBO.

## cogl_pipeline_set_layer_filters

`pipeline.set_layer_filters()` - configures the minification and magnification filters on a Cogl pipeline
texture layer. Used to set `LINEAR_MIPMAP_LINEAR` during overview mode.

## cogl_pipeline_get_layer_filters

`pipeline.get_layer_filters()` - queries the active minification and magnification filters on a Cogl pipeline
texture layer. The C prototype takes two `(out)` parameters (`CoglPipelineFilter *min_filter, *mag_filter`);
GJS folds these out-arguments into a two-element return array `[min_filter, mag_filter]` rather than accepting
pointers. Used in E2E integration test assertions to verify that hardware mipmapping is actually applied
to the pipeline layer during overview mode and restored upon returning to desktop.

## cogl_pipeline_filter

`Cogl.PipelineFilter` - enumeration of texture filtering modes (`LINEAR_MIPMAP_LINEAR`, `LINEAR`, `NEAREST`).
Used when configuring the layer filters for overview thumbnails.

## shell_glsl_set_uniform_float

`effect.set_uniform_float()` on `Shell.GLSLEffect` - the 45-50 uniform upload. The whole file goes
away in 51, which is why the compat class exists at all.

## shell_glsl_add_glsl_snippet

`effect.add_glsl_snippet()` on `Shell.GLSLEffect` - how the clip effect attaches its fragment shader
on 45-50. The hook argument is typed `ShellSnippetHook` through 47 and `CoglSnippetHook` from 48:
the same values, renamed upstream once Cogl exported the enum in its 1.0 API (the Shell header's own
comment calls its copy "a temporary hack ... don't use"). Passing Cogl's value has been the right
hook on every line.

## shader_effect_header

`Clutter.ShaderEffect` - the base class the clip effect takes on 51, once `Shell.GLSLEffect` is gone.
Declared throughout; what 51 changed is that it became the bearer of the snippet hook, below.

## shader_effect_static_snippet

`Clutter.ShaderEffect:vfunc_get_static_snippet()` - the 51 replacement for the hand-built pipeline:
answer a `Cogl.Snippet` instead of calling `add_glsl_snippet`. Absent before 51, which is why the
compat base class forks on the class rather than on a version.

## cogl_snippet_new

`Cogl.Snippet.new()` - builds that snippet at the fragment hook. Stable across 45-51.

## cogl_snippet_set_replace

`Cogl.Snippet.set_replace()` - the replacing form, for source meant to stand in for the stage rather
than post-process it. Stable across 45-51.

## backend_get_sprite

`backend.get_sprite()` - in the same release the grab operation started taking a sprite
instead of a device and a sequence. The extension dispatches on this pair: 45 and 49-51 both
declare four parameters, so arity alone cannot tell them apart.

## backend_get_pointer_sprite

`backend.get_pointer_sprite()` - the fallback spelling of the same call, tried when `get_sprite` is
unavailable. Either one being callable is what marks a shell as 49 or later.

## seat_get_pointer

`seat.get_pointer()` - the core pointer, resolved on 45-48 through the backend's default seat. It is
the device the legacy grab signature takes.

## backend_get_default_seat

`backend.get_default_seat()` - resolves the pointer device on 45-48. The backend is reached the same
way the sprite API's is, through the stage's context.

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
window kind's identity is built from. Guarded, because the tracker is unusable while the session is
tearing down.

## st_box_layout_vertical

`St.BoxLayout:vertical` - deprecated in 48, removed in 51. The migration guide attributes the
removal to `St.Widget`; upstream it is declared on `St.BoxLayout`. The extension does not use it
either way, and the entry is recorded so the attribution stays corrected.

## st_system_color_scheme

`St.SystemColorScheme` - the enum `St.Settings:color-scheme` reports. `PREFER_DARK` is the value the
tiled ring's colour follows, and the only one this extension reads.

## st_settings_enable_animations

`St.Settings:enable-animations` - the user's animation setting, watched for changes. GTK hands a CSS
transition no frame clock when it is off, so a native window changes its shadow in one frame and ours
has to stop blending for the same reason.

## st_settings_color_scheme

`St.Settings:color-scheme` - the system colour scheme, also watched. It is the closest honest signal
for the tiled ring's `currentColor`, which belongs to the client: the client's own foreground is not
readable from the compositor, and the GTK3 theme name is the user's separate choice for exactly the
clients this extension decorates.

## st_settings_get

`St.Settings.get()` - the shell's own settings, read for `high_contrast`, `enable_animations` and
`color_scheme` (each cached and refreshed on its `notify::` signal). The inspector's accent colour
is the `-st-accent-color` CSS term, resolved by St from `St.Settings:accent-color`, not read here.

## main_overview

`Main.overview` - the shell's overview object, exported from `js/ui/main.js`. The extension enables
after the shell has built it, so it is read directly: `visible` seeds the manager's overview
mode, and `showing`/`hidden` flip it.

## main_ui_group

`Main.uiGroup` - the stage-level container the inspector's overlay and highlight are added to.
The shadow and the band are parented to `global.window_group` instead, so they stack with the
window actor rather than inside the window's own actor tree.

## overview_visible

`Main.overview.visible` - seeds the manager's overview mode on `enable()`. `showing`/`hidden`
then switch each clip effect's layer filter to hardware mipmapping,
so downscaled previews stay filtered; the effect is retained, not suspended.
