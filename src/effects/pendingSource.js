/**
 * The one queued GLib source this slot owns: queue() cancels the source it supersedes, so no
 * callback is orphaned, and the slot follows GLib's answer on whether a fired source survives.
 */
export class PendingSource {
    constructor(add, remove) {
        this._add = add;
        this._remove = remove;
        this._id = 0;
    }

    queue(callback) {
        this.cancel();
        const id = this._add(() => {
            let keep = false;
            try {
                // A kept source keeps its id, so cancel() must still be able to reach it.
                keep = callback();
                return keep;
            } finally {
                // Three ways out, one rule: the slot keeps an id only while that source is live.
                // A thrown callback ends its source; a callback that queued a replacement has
                // already put that one in the slot, and clearing here would strand it.
                if (!keep && this._id === id)
                    this._id = 0;
            }
        });
        this._id = id;
    }

    cancel() {
        if (!this._id)
            return;
        this._remove(this._id);
        this._id = 0;
    }
}
