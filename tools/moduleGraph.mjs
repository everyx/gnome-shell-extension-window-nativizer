/**
 * moduleGraph - the relative-import graph of this tree's own modules.
 *
 * A boundary rule that only reads direct imports answers a narrower question than the one that
 * matters: a preferences page may import `lib/x.js` and `lib/x.js` may import the session manager.
 * The edges are the ones this tree owns - a relative specifier - because a namespace has no file to
 * follow.
 */

import path from 'node:path';

const RELATIVE = /^\.{1,2}\//u;

/** Absolute path a relative specifier points at, or null when it leaves this tree or names a package. */
export function resolveRelative(fromFile, specifier) {
    if (!RELATIVE.test(specifier))
        return null;
    return path.resolve(path.dirname(fromFile), specifier);
}

/**
 * Adjacency of the modules that exist in `files`. `files` is `[{file, specifiers}]`; a specifier that
 * resolves to a file which is not in the set is dropped, so a graph never points outside itself.
 */
export function buildGraph(files) {
    const known = new Set(files.map(entry => entry.file));
    const graph = new Map();
    for (const {file, specifiers} of files) {
        const edges = [];
        for (const {specifier} of specifiers) {
            if (specifier === null)
                continue;
            const target = resolveRelative(file, specifier);
            if (target && known.has(target))
                edges.push(target);
        }
        graph.set(file, edges);
    }
    return graph;
}

/** Node -> the node it was first reached from, for every module `entry` loads transitively. */
export function reachableFrom(entry, graph) {
    const parents = new Map([[entry, null]]);
    const queue = [entry];
    while (queue.length > 0) {
        const current = queue.shift();
        for (const next of graph.get(current) ?? []) {
            if (parents.has(next))
                continue;
            parents.set(next, current);
            queue.push(next);
        }
    }
    return parents;
}

/** The import chain from `entry` down to `node`, for a message a reader can act on. */
export function chainTo(reached, node) {
    const chain = [node];
    let current = reached.get(node);
    while (current) {
        chain.unshift(current);
        current = reached.get(current);
    }
    return chain;
}
