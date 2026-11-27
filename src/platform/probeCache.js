import GLib from 'gi://GLib';

export function defaultProbeCachePath(uuid = 'window-nativizer@everyx.github.io') {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), uuid, 'corner-probe.json']);
}

/**
 * The kinds a probe has answered "decorate" for. Only that answer is worth remembering: it saves a
 * bare first frame, while "it rounds itself" is already the state an unprobed window starts in. So
 * nothing bounds the file - what it holds is the kinds this machine decorates, and a cap would
 * evict them.
 */
export function loadProbeCache(path) {
    const map = new Map();
    if (!path)
        return map;
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok || !bytes)
            return map;
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (!parsed || typeof parsed !== 'object')
            return map;
        for (const [key, value] of Object.entries(parsed)) {
            if (value === true)
                map.set(key, true);
        }
    } catch {
        // Missing or corrupt cache file is non-fatal; probing will rebuild it.
    }
    return map;
}

export function saveProbeCache(path, map) {
    if (!path || !(map instanceof Map))
        return;
    try {
        const dir = GLib.path_get_dirname(path);
        GLib.mkdir_with_parents(dir, 0o755);
        const obj = {};
        for (const [key, value] of map.entries()) {
            if (value === true)
                obj[key] = true;
        }
        GLib.file_set_contents(path, JSON.stringify(obj));
    } catch {
        // Non-fatal: cache persistence is best-effort.
    }
}
