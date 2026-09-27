/**
 * Uniform location cache resolution.
 *
 * `get_uniform_location` returns -1 until the shader pipeline is compiled, which happens
 * lazily on the first paint. Caching that -1 would freeze the window out of its uniforms:
 * every later repaint would find a "valid" cached miss and skip the upload, leaving the
 * window square. So a miss is never stored and is re-queried on the next call.
 *
 * GI-free so the rule can be unit-tested (see tests/compat.test.js).
 */

/**
 * @param {Map<string, number>} cache - name -> location; only non-negative hits
 * @param {string} name
 * @param {(name: string) => number} getLocation
 * @returns {number} a valid location, or -1 when the uniform is still unresolved
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
