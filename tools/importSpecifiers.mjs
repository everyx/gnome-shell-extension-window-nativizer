/**
 * importSpecifiers - every module specifier an ES module names, with its line.
 *
 * A checker that matches `from '...'` misses two forms that load a module just as well:
 * `import 'x'` (side effect, no clause) and `import('x')` (dynamic). Re-exports (`export ... from`)
 * carry a specifier too. The scan is line-based on purpose: a line that does not begin with
 * `import`/`export` can only contribute a dynamic import, which is what the second pattern finds.
 *
 * Known limit: a string literal on an import line that merely looks like a specifier is reported.
 * That errs towards a false positive, which the caller turns into a message a reader can judge.
 */

const STATIC_LINE = /^\s*(?:import|export)\b/u;
const SPECIFIER = /(?:\bfrom\s*|(?<![\w.$])import\s*\(?\s*|^import\s+)['"]([^'"]+)['"]/gu;
const DYNAMIC = /(?<![\w.$])import\s*\(\s*['"]([^'"]+)['"]/gu;

export function importSpecifiers(text) {
    const found = [];
    const lines = text.split('\n');
    lines.forEach((line, index) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
            return;
        const patterns = STATIC_LINE.test(line) ? [SPECIFIER, DYNAMIC] : [DYNAMIC];
        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            for (const match of line.matchAll(pattern))
                found.push({specifier: match[1], line: index + 1});
        }
    });
    return found;
}
