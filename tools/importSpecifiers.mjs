/**
 * importSpecifiers - every module an ES module loads, as a specifier plus the line it is on.
 *
 * This reads a parse tree, not text. Two rounds of this checker's life were spent on a scanner that
 * matched the word `import` with a regex: the first version missed a side-effect import and a
 * dynamic one, the second missed a specifier on the next line, and every version reported prose that
 * happened to contain the word. A parser has no such forms, and it fails on syntax the scan cannot
 * represent instead of quietly skipping it.
 *
 * `specifier: null` means the tree holds an import whose target is not a literal - a template, a
 * variable. Callers treat that as a failure: a checker that guesses at a dependency is worse than one
 * that admits it cannot see it.
 */

import {parse} from 'espree';

function collect(node, found) {
    if (!node || typeof node.type !== 'string')
        return;
    switch (node.type) {
    case 'ImportDeclaration':
        found.push({specifier: node.source.value, line: node.loc.start.line});
        break;
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
        if (node.source)
            found.push({specifier: node.source.value, line: node.loc.start.line});
        break;
    case 'ImportExpression':
        found.push({
            specifier: node.source.type === 'Literal' ? node.source.value : null,
            line: node.loc.start.line,
        });
        break;
    default:
        break;
    }
    for (const key of Object.keys(node)) {
        const child = node[key];
        if (Array.isArray(child)) {
            for (const item of child)
                collect(item, found);
        } else if (child && typeof child === 'object') {
            collect(child, found);
        }
    }
}

/**
 * Every module `text` loads. Throws when the text does not parse, because an unparseable file is an
 * unknown dependency graph rather than an empty one.
 */
export function importSpecifiers(text) {
    const tree = parse(text, {ecmaVersion: 'latest', sourceType: 'module', loc: true});
    const found = [];
    collect(tree, found);
    return found;
}
