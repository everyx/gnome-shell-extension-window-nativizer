/**
 * Native-like corners: inference that a window already has Adwaita radius because
 * its process maps an Adwaita provider. GTK theme is not a provider.
 * See docs/decoration-model.md § When a window's corners already look like ours.
 */

import Gio from 'gi://Gio';

// Per-process via /proc/<pid>/maps; see docs/decoration-model.md for provider table.
const ADWAITA_PROVIDERS = [
    'libadwaita-1.so', // GTK4
    'libhandy-1.so',  // GTK3 predecessor (window.csd.unified)
];

/** pid -> has an Adwaita provider; freed by forgetProcess(pid) and destroy(). */
const processCache = new Map();

/** @throws when /proc/<pid>/maps cannot be read */
function readMaps(pid) {
    const file = Gio.File.new_for_path(`/proc/${pid}/maps`);
    const [ok, bytes] = file.load_contents(null);
    if (!ok || !bytes)
        throw new Error(`could not read /proc/${pid}/maps`);
    return new TextDecoder().decode(bytes);
}

/**
 * @param {string} mapsText - Contents of /proc/pid/maps
 * @returns {boolean} Whether the process maps an Adwaita provider
 */
export function classifyProcess(mapsText) {
    if (!mapsText || typeof mapsText !== 'string')
        return false;
    return ADWAITA_PROVIDERS.some(name => mapsText.includes(name));
}

/**
 * @param {number} pid
 * @param {object} [deps]
 * @param {(pid: number) => string} [deps.readMaps]
 * @returns {boolean} Whether process has Adwaita look (cached per pid; miss not cached).
 */
export function hasAdwaitaLook(pid, deps = {}) {
    if (!pid || typeof pid !== 'number' || pid <= 0)
        return false;

    if (!processCache.has(pid)) {
        try {
            processCache.set(pid, classifyProcess((deps.readMaps ?? readMaps)(pid)));
        } catch {
            // Permission/sandbox/dead process — don't cache; may succeed later.
            return false;
        }
    }

    return processCache.get(pid);
}

/**
 * @param {object} win - Meta.Window
 * @returns {boolean} Whether window's own process already rounds corners.
 */
export function hasNativeLikeCorners(win) {
    if (!win)
        return false;
    return hasAdwaitaLook(win.get_pid?.());
}

/**
 * @param {number} pid
 */
export function forgetProcess(pid) {
    processCache.delete(pid);
}

/** Clear process cache (counterpart of extension disable(); also cleared per-pid in manager.js). */
export function destroy() {
    processCache.clear();
}
