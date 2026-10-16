import gnome from 'eslint-config-gnome';
import {createSlopConfig} from 'eslint-plugin-slop';

/** The GJS / GNOME ruleset, scoped to the extension source it was written for. */
const sourceConfig = gnome.configs.recommended.map(config => ({
    ...config,
    files: ['src/**/*.js'],
}));

/**
 * The AI-slop guard, scoped to the source it is meant for.
 *
 * `recent-changes` is what makes it adoptable here: a construct is reported only when its range
 * intersects a line the last five commits touched, so prose that predates the budget is tolerated
 * and new code is held to it. The word budget is the one the comment/docs split already uses - a
 * comment that outgrows it is carrying knowledge that belongs in `docs/` or in the code.
 *
 * `no-em-dash` reads comments only, so the user-facing translated strings keep their own
 * typography: changing one would change a msgid and drop its translation.
 */
const slopConfig = createSlopConfig({inspection: {mode: 'recent-changes', tracebackCommits: 5}})
    .map(config => ({...config, files: ['src/**/*.js']}));

/**
 * Bug-catching rules for the dev scripts and the tests. They are deliberately not
 * held to eslint-config-gnome's source style (brace style, implicit-coercion and
 * so on), which would be a large amount of churn for little value; these are the
 * rules that catch real mistakes.
 */
const devRules = {
    'no-undef': 'error',
    'no-unused-vars': 'error',
    'no-unreachable': 'error',
    'no-dupe-keys': 'error',
    'no-cond-assign': 'error',
    'no-constant-condition': 'error',
    'no-fallthrough': 'error',
    'no-duplicate-case': 'error',
    'no-self-assign': 'error',
    'no-unsafe-negation': 'error',
    'eqeqeq': ['error', 'always', {null: 'ignore'}],
};

export default [
    {
        ignores: [
            'node_modules/**',
            'schemas/**',
            'research/**',
            'vendor/**',
            'src/lib/*.generated.js',
            'src/effects/*.generated.js',
        ],
    },
    ...sourceConfig,
    ...slopConfig,
    {
        files: ['src/**/*.js'],
        rules: {
            // JSDoc counts: the longest blocks in the tree are JSDoc, and the default would skip them.
            'slop/max-comment-length': ['error', {maximumWords: 60, ignoreJSDoc: false}],
            'slop/no-jargon': ['error', {ignoreJSDoc: false}],
        },
    },
    {
        files: ['src/**/*.js'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                global: 'readonly',
            },
        },
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                console: 'readonly',
                describe: 'readonly', it: 'readonly', expect: 'readonly',
                beforeEach: 'readonly', afterEach: 'readonly',
                spyOn: 'readonly', jasmine: 'readonly', fail: 'readonly',
            },
        },
        rules: devRules,
    },
    {
        files: ['tools/**/*.mjs'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                console: 'readonly', process: 'readonly',
            },
        },
        rules: devRules,
    },
    {
        // probe-window.js and gjs-surface.js run under gjs, so they have the GJS globals,
        // not node's - `imports` for the classic one, `print`/`ARGV` for the ESM one.
        files: ['tools/**/*.js'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                console: 'readonly', global: 'readonly', imports: 'readonly',
                print: 'readonly', ARGV: 'readonly', TextDecoder: 'readonly',
            },
        },
        rules: devRules,
    },
];
