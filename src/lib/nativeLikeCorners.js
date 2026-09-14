/**
 * Native-like corners - whether a window's corners already look like ours because
 * something other than us rounded them.
 *
 * An inference, not an observation: a surface never reports whether it is rounded, so
 * the presence of the Adwaita look stands in for it. Only the corner axis consults
 * this; the shadow axis reads what the window itself declares and what Mutter reports
 * about the frame.
 *
 * A GTK theme is not a provider. GTK3's `decoration` node does not cover the bottom of
 * the window - its top-only `border-radius` shares that block with the `box-shadow` GTK3
 * reads as the shadow width - so a theme can round only the top corners, and the one
 * way a GTK3 program gets four (libhandy's `window.csd.unified`) already maps
 * `libhandy-1.so`. A theme name could therefore only skip the bottom two corners of a
 * window that needs them (docs/decoration-model.md).
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

/** pid -> {hasProvider}: a fact about the running process. */
const processCache = new Map();

/** Reads /proc/<pid>/maps; throws when it cannot be read. */
function readMaps(pid) {
    const file = Gio.File.new_for_path(`/proc/${pid}/maps`);
    const [ok, bytes] = file.load_contents(null);
    if (!ok || !bytes)
        throw new Error(`could not read /proc/${pid}/maps`);
    return new TextDecoder().decode(bytes);
}

/**
 * What a maps listing says about its process.
 *
 * @param {string} mapsText - Contents of /proc/pid/maps
 * @returns {{hasProvider: boolean}}
 */
export function classifyProcess(mapsText) {
    if (!mapsText || typeof mapsText !== 'string')
        return {hasProvider: false};
    return {
        hasProvider: ADWAITA_PROVIDERS.some(name => mapsText.includes(name)),
    };
}

/**
 * Whether a process's windows already have the Adwaita look, from a library the
 * process maps.
 *
 * @param {number} pid - Process ID
 * @param {object} [deps] - overrides, injectable for tests
 * @param {(pid: number) => string} [deps.readMaps] - maps reader
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

    return info.hasProvider;
}

/**
 * Whether the window's corners already look like ours, rounded by its own process.
 * A window whose process cannot be probed counts as not rounded.
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
 * Releases everything this module holds: the process cache, the counterpart of the
 * extension's `disable()`, alongside `shadowTexture.destroy()`.
 */
export function destroy() {
    processCache.clear();
}
