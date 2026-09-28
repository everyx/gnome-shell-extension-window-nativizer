import gnome from 'eslint-config-gnome';

/** The GJS / GNOME ruleset, scoped to the extension source it was written for. */
const sourceConfig = gnome.configs.recommended.map(config => ({
    ...config,
    files: ['src/**/*.js'],
}));

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
                print: 'readonly', ARGV: 'readonly',
            },
        },
        rules: devRules,
    },
];
