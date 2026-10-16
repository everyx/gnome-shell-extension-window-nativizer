/**
 * Uniform location cache resolution.
 *
 * `get_uniform_location` returns -1 until shader compilation on first paint.
 * Misses (-1) are never cached to avoid freezing uniforms.
 */

/**
 * @param cache - name -> location; only non-negative hits
 * @returns a valid location, or -1 when the uniform is still unresolved
 */
export function resolveUniformLocation(cache, name, getLocation) {
    let loc = cache.get(name);
    if (loc === undefined || loc === -1) {
        loc = getLocation(name);
        if (loc !== -1)
            cache.set(name, loc);
    }
    return loc;
}
