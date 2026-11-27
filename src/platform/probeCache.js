import GLib from 'gi://GLib';

const MAX_CACHE_ENTRIES = 200;

export function defaultProbeCachePath(uuid = 'window-nativizer@everyx.github.io') {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), uuid, 'corner-probe.json']);
}

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
            if (typeof value === 'boolean')
                map.set(key, value);
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
        while (map.size > MAX_CACHE_ENTRIES) {
            const oldest = map.keys().next().value;
            map.delete(oldest);
        }
        const dir = GLib.path_get_dirname(path);
        GLib.mkdir_with_parents(dir, 0o755);
        const obj = {};
        for (const [key, value] of map.entries())
            obj[key] = value;
        GLib.file_set_contents(path, JSON.stringify(obj));
    } catch {
        // Non-fatal: cache persistence is best-effort.
    }
}
