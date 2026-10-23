/**
 * The signals one owner holds: connect through it, hand them all back in one call at teardown.
 *
 * Two shapes were written four times over - a list of `[object, id]` pairs, a connect that may
 * swallow, and a disconnect that always does. The pair is what makes teardown correct: the id
 * alone cannot be disconnected from, and the object alone cannot say which id to drop.
 */

export class Subscriptions {
    constructor() {
        this._pairs = [];
    }

    /**
     * Pushes one signal. A connect that throws is reported unless `lenient`: an owner that expects
     * its own signals must not lose one in silence, while a watcher of objects it does not own
     * cannot let a half-torn-down actor abort the rest.
     */
    connect(obj, signal, handler, {lenient = false} = {}) {
        try {
            this._pairs.push([obj, obj.connect(signal, handler)]);
        } catch (e) {
            if (!lenient)
                throw e;
        }
    }

    /** Drops one object's signals and keeps the rest: a window closing under a shared owner. */
    forget(obj) {
        this._pairs = this._pairs.filter(([owner, id]) => {
            if (owner !== obj)
                return true;
            this._disconnect(owner, id);
            return false;
        });
    }

    /** How many signals are held; a teardown probe asks whether this came back to zero. */
    get count() {
        return this._pairs.length;
    }

    disconnectAll() {
        for (const [obj, id] of this._pairs)
            this._disconnect(obj, id);
        this._pairs.length = 0;
    }

    _disconnect(obj, id) {
        try {
            obj.disconnect(id);
        } catch {
            // The object is already destroyed; its signals went with it.
        }
    }
}
