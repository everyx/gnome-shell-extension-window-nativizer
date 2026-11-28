import GLib from 'gi://GLib';

export function defaultProbeCachePath(uuid = 'window-nativizer@everyx.github.io') {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), uuid, 'corner-probe.json']);
}

/**
 * The kinds the probe measured as safe to clip, as rule keys. A set, not a record of booleans:
 * presence is the whole answer, because "our clip would cut something" is the stand-down an unprobed
 * window already takes. Nothing bounds the file - a cap would evict the kinds this machine decorates.
 */
export function loadProbeCache(path) {
    const kinds = new Set();
    if (!path)
        return kinds;
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok || !bytes)
            return kinds;
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (!Array.isArray(parsed))
            return kinds;
        for (const key of parsed) {
            if (typeof key === 'string')
                kinds.add(key);
        }
    } catch {
        // Missing or corrupt cache file is non-fatal; probing will rebuild it.
    }
    return kinds;
}

export function saveProbeCache(path, kinds) {
    if (!path || !(kinds instanceof Set))
        return;
    try {
        const dir = GLib.path_get_dirname(path);
        GLib.mkdir_with_parents(dir, 0o755);
        GLib.file_set_contents(path, JSON.stringify([...kinds]));
    } catch {
        // Non-fatal: cache persistence is best-effort.
    }
}
