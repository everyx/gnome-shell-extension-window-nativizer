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
                // One rule, three exits: the slot holds an id only while that source lives. A throw
                // ends its source; one that queued a replacement already put it in the slot.
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
