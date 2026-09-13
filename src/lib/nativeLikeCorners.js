/**
 * Native-like corners - whether a window's corners already look like ours because
 * something other than us rounded them.
 *
 * An inference, not an observation: a surface never reports whether it is rounded, so
 * the presence of the Adwaita look stands in for it. Only the corner axis consults
 * this; the shadow axis reads what the window itself declares and what Mutter reports
 * about the frame.
 *
 * Which look that is, and where it is visible, is in docs/decoration-model.md.
 *
 * Shell-side probe (IO-dependent, not pure).
 */

import Gio from 'gi://Gio';

/**
 * Shared objects whose presence in a process means it draws the Adwaita look,
 * corners included, for its own windows.
 */
const ADWAITA_PROVIDERS = [
    'libadwaita-1.so',                                     // GTK4 applications
    'libhandy-1.so',                                       // its GTK3 predecessor
    'wayland-decoration-client/libqadwaitadecorations.so', // Qt: a reimplementation, not a link
    'wayland-decoration-client/libadwaita.so',             // qtwayland's same-named plugin
];

/** Only a GTK program's own window decoration is drawn by the GTK theme. */
const GTK_LIBRARIES = ['libgtk-4.so', 'libgtk-3.so'];

/**
 * Themes that hand a GTK program the Adwaita window radius, as prefixes so the
 * dark and compact variants are covered.
 *
 * Deliberately not `Adwaita`: on this platform that name resolves to GTK's own
 * fallback theme, which rounds the top corners 8px and leaves the bottom square.
 */
const ADWAITA_THEME_PREFIXES = ['adw-gtk3'];

/** pid -> {hasProvider, isGtk}: both are facts about the running process. */
const processCache = new Map();

let interfaceSettings = null;

/** Reads /proc/<pid>/maps; throws when it cannot be read. */
function readMaps(pid) {
    const file = Gio.File.new_for_path(`/proc/${pid}/maps`);
    const [ok, bytes] = file.load_contents(null);
    if (!ok || !bytes)
        throw new Error(`could not read /proc/${pid}/maps`);
    return new TextDecoder().decode(bytes);
}

/** The configured GTK theme. Constructed once; GSettings caches the value too. */
function gtkThemeName() {
    interfaceSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    return interfaceSettings.get_string('gtk-theme');
}

/**
 * What a maps listing says about its process.
 *
 * @param {string} mapsText - Contents of /proc/pid/maps
 * @returns {{hasProvider: boolean, isGtk: boolean}}
 */
export function classifyProcess(mapsText) {
    if (!mapsText || typeof mapsText !== 'string')
        return {hasProvider: false, isGtk: false};
    return {
        hasProvider: ADWAITA_PROVIDERS.some(name => mapsText.includes(name)),
        isGtk: GTK_LIBRARIES.some(name => mapsText.includes(name)),
    };
}

/**
 * Whether a GTK theme name is an Adwaita copy.
 *
 * @param {string} themeName
 * @returns {boolean}
 */
export function isAdwaitaTheme(themeName) {
    if (typeof themeName !== 'string')
        return false;
    // Theme names are conventionally lowercase, but nothing enforces it.
    return ADWAITA_THEME_PREFIXES.some(prefix => themeName.toLowerCase().startsWith(prefix));
}

/**
 * Whether a process's windows already have the Adwaita look - from a library the
 * process maps, or from the configured theme.
 *
 * The theme is consulted last and never cached: unlike the process's own mappings
 * it can change while the process runs.
 *
 * @param {number} pid - Process ID
 * @param {object} [deps] - overrides, injectable for tests
 * @param {(pid: number) => string} [deps.readMaps] - maps reader
 * @param {() => string} [deps.gtkTheme] - configured GTK theme name
 * @returns {boolean}
 */
export function hasAdwaitaLook(pid, deps = {}) {
    if (!pid || typeof pid !== 'number' || pid <= 0)
        return false;

    let info = processCache.get(pid);
    if (!info) {
        try {
            info = classifyProcess((deps.readMaps ?? readMaps)(pid));
        } catch {
            // Permission denied, dead process, or sandbox restriction. Not cached:
            // the read may succeed next time.
            return false;
        }
        processCache.set(pid, info);
    }

    if (info.hasProvider)
        return true;
    if (!info.isGtk)
        return false;

    return isAdwaitaTheme((deps.gtkTheme ?? gtkThemeName)());
}

/**
 * Whether the window's corners already look like ours, rounded by its own process
 * or theme. A window whose process cannot be probed counts as not rounded.
 *
 * @param {object} win - Meta.Window instance
 * @returns {boolean}
 */
export function hasNativeLikeCorners(win) {
    if (!win)
        return false;
    return hasAdwaitaLook(win.get_pid?.());
}

/**
 * Forgets what a gone process taught us.
 *
 * @param {number} pid - Process ID
 */
export function forgetProcess(pid) {
    processCache.delete(pid);
}

/**
 * Releases everything this module holds: the process cache and the settings object.
 * The counterpart of the extension's `disable()`, alongside `shadowTexture.destroy()`.
 */
export function destroy() {
    processCache.clear();
    interfaceSettings = null;
}
