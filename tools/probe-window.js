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
// WINDOW_NATIVIZER_BORDER=#rrggbb paints a 1px ring in the outermost surface pixel around the
// body colour (white when no BODY is given). That is the shape of a flat client that draws its own
// border: buffer_rect == frame_rect with client paint flush to the edge. It is drawn with cairo in
// a full-window DrawingArea, never with CSS: GTK4 ignores an inset box-shadow on
// window.background, so a CSS probe would silently paint nothing and measure a clean edge.
const borderColor = GLib.getenv('WINDOW_NATIVIZER_BORDER') || null;
// WINDOW_NATIVIZER_SIZE=WxH fixes the window size (so subject and native can be measured at the
// same geometry without compositor-side positioning).
const sizeMatch = GLib.getenv('WINDOW_NATIVIZER_SIZE')?.match(/^(\d+)x(\d+)$/);
const sizeW = sizeMatch ? parseInt(sizeMatch[1], 10) : 900;
const sizeH = sizeMatch ? parseInt(sizeMatch[2], 10) : 600;

// Overridable so one test can run two clients at once: GApplication is single-instance per id, so a
// second launch with the same id only activates the first window.
const applicationId = GLib.getenv('WINDOW_NATIVIZER_APP_ID') ??
    (native
        ? 'dev.windownativizer.native'
        : (backdrop ? 'dev.windownativizer.backdrop' : 'dev.windownativizer.probe'));
// WINDOW_NATIVIZER_TITLE names the window when a test needs a subject that cannot be confused
// with another probe's default title (e.g. the e2e's red hairline subject beside a decorated one).
const customTitle = GLib.getenv('WINDOW_NATIVIZER_TITLE') || null;

let Adw = null;
if (native)
    Adw = imports.gi.Adw;

const Application = native ? Adw.Application : Gtk.Application;
const app = new Application({application_id: applicationId});

app.connect('activate', () => {
    if ((backdrop || bodyColor) && !borderColor) {
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
        title: customTitle ?? (native ? 'window-nativizer native' : (backdrop ? 'window-nativizer backdrop' : 'window-nativizer probe')),
        default_width: sizeW,
        default_height: sizeH,
    });
    if (!native && !decorated)
        win.set_decorated(false);
    // The backdrop is meant to fill the work area behind the subject, so the
    // shadow is measured against a uniform white surface.
    if (backdrop)
        win.maximize();
    const content = borderColor ? makeBorderedContent() : new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    // libadwaita's window refuses set_child; its content goes through set_content.
    if (native)
        win.set_content(content);
    else
        win.set_child(content);
    win.present();
});

function parseHexColor(spec, fallback) {
    const match = (spec || '').match(/^#([0-9a-fA-F]{6})$/);
    if (!match)
        return fallback;
    const value = parseInt(match[1], 16);
    return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

// A flat ringless subject with a client-painted 1px border: the body colour everywhere, the border
// colour in exactly the outermost surface pixel on all four sides. Four filled rects rather than a
// stroked one, so the corners are the border colour too and no cairo stroke centring is involved.
function makeBorderedContent() {
    const body = parseHexColor(bodyColor, [1, 1, 1]);
    const border = parseHexColor(borderColor, [0, 0, 0]);
    const area = new Gtk.DrawingArea({hexpand: true, vexpand: true});
    area.set_draw_func((drawing, cr, width, height) => {
        cr.setSourceRGB(body[0], body[1], body[2]);
        cr.rectangle(0, 0, width, height);
        cr.fill();
        cr.setSourceRGB(border[0], border[1], border[2]);
        cr.rectangle(0, 0, width, 1);
        cr.fill();
        cr.rectangle(0, height - 1, width, 1);
        cr.fill();
        cr.rectangle(0, 0, 1, height);
        cr.fill();
        cr.rectangle(width - 1, 0, 1, height);
        cr.fill();
    });
    return area;
}

app.run([]);
