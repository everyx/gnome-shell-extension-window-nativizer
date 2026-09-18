// A subject for visual work in the nested session: a window the detector decorates.
//
//   ./tools/dev.sh app gjs tools/probe-window.js
//
// CSD is off by default, so the window declares no frame extents and the extension draws the
// decoration. WINDOW_NATIVIZER_DECORATED=1 keeps GTK's own decoration instead, which declares a
// shadow margin: a subject that reserves the ring the resize band lives in. The size is fixed and the content is the theme's box background, so
// two screenshots of the same session are comparable.
//
// WINDOW_NATIVIZER_MODE=native draws the same size and content through libadwaita instead, which
// is what the decoration is aligned with: same shadow, same corners, drawn by GTK. It also
// has a headerbar, so a virtual pointer can drag it into a tiled state -- the undecorated
// subject has no drag region and cannot be moved that way.
//
// WINDOW_NATIVIZER_BACKDROP=1 makes it the uniform surface a shadow is measured against: white,
// a separate application id, and meant to be maximized, a state the detector never
// decorates.
imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Gdk = '4.0';
imports.gi.versions.Adw = '1';

const GLib = imports.gi.GLib;
const Gdk = imports.gi.Gdk;
const Gtk = imports.gi.Gtk;

const native = GLib.getenv('WINDOW_NATIVIZER_MODE') === 'native';
const backdrop = Boolean(GLib.getenv('WINDOW_NATIVIZER_BACKDROP'));
const decorated = Boolean(GLib.getenv('WINDOW_NATIVIZER_DECORATED'));
// WINDOW_NATIVIZER_BODY=#rrggbb paints the window body a known colour. Against a white backdrop and
// a black shadow the three channels then separate three different things in one profile, and
// a missing corner clip becomes visible, which it is not when everything is white.
const bodyColor = GLib.getenv('WINDOW_NATIVIZER_BODY') || null;
// WINDOW_NATIVIZER_SIZE=WxH fixes the window size (so subject and native can be measured at the
// same geometry without compositor-side positioning).
const sizeMatch = GLib.getenv('WINDOW_NATIVIZER_SIZE')?.match(/^(\d+)x(\d+)$/);
const sizeW = sizeMatch ? parseInt(sizeMatch[1], 10) : 900;
const sizeH = sizeMatch ? parseInt(sizeMatch[2], 10) : 600;

const applicationId = native
    ? 'dev.windownativizer.native'
    : (backdrop ? 'dev.windownativizer.backdrop' : 'dev.windownativizer.probe');

let Adw = null;
if (native)
    Adw = imports.gi.Adw;

const Application = native ? Adw.Application : Gtk.Application;
const app = new Application({application_id: applicationId});

app.connect('activate', () => {
    if (backdrop || bodyColor) {
        const css = new Gtk.CssProvider();
        // window.background is the node GTK actually paints, and the content box sits on top
        // of it: colouring only the window node left the interior white on some edges, which
        // made a white-on-white outline look like it was not drawn.
        const color = backdrop ? '#ffffff' : bodyColor;
        css.load_from_string('window, window.background, window > box, window > * ' +
            '{ background-color: ' + color + '; }');
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }

    const Window = native ? Adw.ApplicationWindow : Gtk.ApplicationWindow;
    const win = new Window({
        application: app,
        title: native ? 'window-nativizer native' : (backdrop ? 'window-nativizer backdrop' : 'window-nativizer probe'),
        default_width: sizeW,
        default_height: sizeH,
    });
    if (!native && !decorated)
        win.set_decorated(false);
    // The backdrop is meant to fill the work area behind the subject, so the
    // shadow is measured against a uniform white surface.
    if (backdrop)
        win.maximize();
    const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    // libadwaita's window refuses set_child; its content goes through set_content.
    if (native)
        win.set_content(content);
    else
        win.set_child(content);
    win.present();
});

app.run([]);
