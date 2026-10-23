/**
 * The shader's uniform surface, read back off the declarations the generator just emitted.
 *
 * Deriving the manifest from the GLSL text rather than restating it is the point: the extension
 * uploads by these names and arities, so a name or a width that only one side knows is a uniform
 * silently left at its default. Both failure modes are thrown here, at generation.
 */

const ARITY = {float: 1, vec2: 2, vec3: 3, vec4: 4};

export function uniformManifest(declarationsText) {
    const entries = [];
    for (const [, type, name] of declarationsText.matchAll(/^uniform\s+(\w+)\s+(\w+);/gm)) {
        const components = ARITY[type];
        // An unknown type has no arity to upload: fail at generation, where the fix is a one-liner,
        // rather than emit a manifest the upload would call with undefined.
        if (components === undefined)
            throw new Error(`[gen-shader] Unsupported uniform type: ${type} ${name}`);
        const key = name.replace(/^u/, '').replace(/^./, first => first.toLowerCase());
        entries.push([key, {name, components}]);
    }
    // A declaration shape the pattern above does not parse - an array, a struct - would otherwise
    // vanish from the manifest without a word, which is the failure this manifest exists to stop.
    const declared = declarationsText.match(/^uniform\b/gm)?.length ?? 0;
    if (declared !== entries.length)
        throw new Error(`[gen-shader] Parsed ${entries.length} of ${declared} uniform declarations`);
    return entries;
}
