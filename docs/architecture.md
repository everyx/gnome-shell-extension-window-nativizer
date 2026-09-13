# Architecture

One extension process that owns the windows, one preferences process that has none,
and a pure core shared by both. The core is where the decisions live, so they can be
tested without a session; the processes only gather inputs and apply results.

## Modules

| Module | Responsibility |
|---|---|
| `lib/detector.js` | whether a window needs decoration, and whether a rule would change that (pure) |
| `lib/nativeLikeCorners.js` | shell-side probe: whether a window's corners already look like ours — an inference from the Adwaita look, consulted only by the corner axis |
| `lib/rules.js` | the window-kind rule model: keys, matching, sanitising (pure) |
| `lib/pick.js` | the picker's D-Bus contract and the dictionary it returns (pure) |
| `lib/style.js` | which decoration parameters a window state gets (pure) |
| `lib/settings.js` | GSettings IO adapter |
| `lib/window.js` | shell-side identity gathering (`Shell.WindowTracker`, live window list) |
| `lib/manager.js` | state machine: window lifecycle, focus and display changes to effects |
| `lib/inspector.js` | the interactive window picker and its D-Bus service |
| `effects/` | rounded clipping (`clipEffect.js`), shadow actor geometry (`shadowActor.js`), and baked GPU shadow textures (`shadowTexture.js`, `shadowShader.generated.js`) |

## The two processes

- The **extension process** owns the windows. `manager.js` reconciles effects against
  window state; `inspector.js` serves the picker.
- The **preferences process** has no window objects at all. It reads and writes the
  rule store, and asks the extension over D-Bus which window the user clicked.

The picker is the only conversation between them: `inspector.js` implements
`PickWindow() -> a{ss}`, the prefs window calls it, and it refuses to create a rule
the extension reports as ineffective. `lib/pick.js` holds that contract so the prefs
process can speak it without importing shell-only code.

For the selection mechanics we followed KDE's KWin
(`InputRedirection::startInteractiveWindowSelection` with its `clientToVariantMap`)
and GNOME's own equivalent: `Main.pushModal`, `global.stage.set_cursor_type` and a
Clutter event grab.

## Actors

Every decorated window gets a `ShadowActor` inserted below the window actor in
`global.window_group`, drawing an 8-slice baked Cogl shadow texture (`effects/shadowTexture.js`)
with Clutter property and constraint bindings (`Clutter.BindConstraint`). It is cast by the window
body (`setShadowBody()`), not by the actor, which for a client-decorated window also carries the ring
that client reserved for its own shadow. When there is something to clip, the window also gets a
`RoundedClipEffect` (`Shell.GLSLEffect` offscreen pass).
On Wayland, the clip effect attaches directly to the window actor; on X11 / XWayland, it attaches
to the surface child actor (`actor.get_first_child()`) so the native / frames-client drop shadow is preserved
and coordinates align accurately.
The manager keeps one state record per window and reconciles add, remove and update on every
state change.
