/** get_uniform_location answers -1 until the first paint, so a miss must never be cached. */

/** @returns a valid location, or -1 while the uniform is still unresolved */
export function resolveUniformLocation(cache, name, getLocation) {
    let loc = cache.get(name);
    if (loc === undefined || loc === -1) {
        loc = getLocation(name);
        if (loc !== -1)
            cache.set(name, loc);
    }
    return loc;
}
