/**
 * importRules - which specifiers each directory may not name.
 *
 * The rules are kept here, apart from the loop that applies them, so a specifier can be judged
 * without a file tree: the scanner decides what an import is, this decides whether it is allowed,
 * and the checker only walks. Splitting them that way is also what makes a side-effect import and a
 * dynamic one testable cases rather than a promise.
 */

/** Business code reaches these through src/platform/ only. */
const BUSINESS_FORBIDDEN_NAMESPACES = ['gi://Meta', 'gi://Shell'];

/** `gi://Meta?version=51` names the same namespace as `gi://Meta`; only the first part decides. */
const namespaceOf = specifier => {
    const match = /^gi:\/\/([A-Za-z0-9_]+)(?:[?/]|$)/u.exec(specifier);
    return match ? `gi://${match[1]}` : null;
};

const namesForbiddenNamespace = specifier => {
    const namespace = namespaceOf(specifier);
    return namespace !== null && BUSINESS_FORBIDDEN_NAMESPACES.includes(namespace);
};

const isRelative = specifier => specifier.startsWith('./') || specifier.startsWith('../');

/**
 * The namespaces and modules that exist only inside the shell process: preferences runs its own
 * process, where loading one of these is the boundary being crossed.
 */
const SHELL_PROCESS_NAMESPACES = ['gi://Meta', 'gi://Shell', 'gi://St', 'gi://Clutter'];
const SHELL_MODULE_PREFIX = 'resource:///org/gnome/shell';

/** True when loading `specifier` needs the shell process. Null (unresolved) is never shell-only. */
export function namesShellProcess(specifier) {
    if (specifier === null)
        return false;
    if (specifier.startsWith(SHELL_MODULE_PREFIX))
        return true;
    const namespace = namespaceOf(specifier);
    return namespace !== null && SHELL_PROCESS_NAMESPACES.includes(namespace);
}

/** A path suffix, so `../lib/x.js` and `lib/x.js` are the same edge. */
const underDirectory = (specifier, directory) => new RegExp(`(^|/)${directory}/`, 'u').test(specifier);
const isModule = (specifier, file) => new RegExp(`(^|/)${file}$`, 'u').test(specifier);

/** Why `specifier`, imported from lib/ or effects/, is refused; null when it is allowed. */
export function businessViolation(specifier) {
    if (namesForbiddenNamespace(specifier))
        return `direct ${namespaceOf(specifier)} import (must use src/platform/)`;
    return null;
}

/** Why `specifier`, imported from prefs/, is refused; null when it is allowed. */
export function prefsViolation(specifier) {
    if (namesForbiddenNamespace(specifier))
        return `prefs must not import ${namespaceOf(specifier)} (that is the shell side)`;
    if (!isRelative(specifier))
        return null;
    if (underDirectory(specifier, 'platform'))
        return 'prefs must not import src/platform/ (that is the shell side)';
    if (underDirectory(specifier, 'effects'))
        return 'prefs must not import src/effects/ (no actors in the prefs process)';
    if (isModule(specifier, 'manager\\.js'))
        return 'prefs must not import the session manager';
    if (isModule(specifier, 'inspector\\.js'))
        return 'prefs must not import the shell-side inspector';
    return null;
}

/** Why `specifier`, imported from platform/, is refused; null when it is allowed. */
export function platformViolation(specifier) {
    if (!isRelative(specifier))
        return null;
    if (underDirectory(specifier, 'lib') && !isModule(specifier, 'mutterRules\\.generated\\.js'))
        return 'platform must not depend on business modules in src/lib/';
    if (underDirectory(specifier, 'effects'))
        return 'platform must not depend on src/effects/';
    return null;
}
