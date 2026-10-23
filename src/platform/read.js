/** Read helpers for calls that can throw mid-teardown; platform, because lib may not be imported. */

/** Swallows the throw Mutter raises mid-teardown, so one dead window cannot abort a decision. */
export function safeRead(getter, fallback) {
    try {
        return getter() ?? fallback;
    } catch {
        return fallback;
    }
}

/** '' on unreadable bytes: one non-UTF-8 class must not cost the window its decision. */
export function readWindowString(getter) {
    return safeRead(getter, '');
}
