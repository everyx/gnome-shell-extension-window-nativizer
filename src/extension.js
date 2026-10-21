import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Manager} from './lib/manager.js';
import {InspectorService} from './lib/inspector.js';
import {journal} from './platform/journal.js';

export default class WindowNativizerExtension extends Extension {
    enable() {
        if (this._manager)
            return;

        const manager = new Manager(this);
        this._manager = manager;
        try {
            manager.enable();
            this._inspector = new InspectorService(manager);
        } catch (e) {
            // Roll back a partial enable, or the idempotency guard wedges; the original error still surfaces.
            try {
                this.disable();
            } catch (teardownError) {
                journal.failure(teardownError, 'teardown after a failed enable()');
            }
            throw e;
        }
    }

    disable() {
        // Drop both refs however teardown ends: enable() guards on _manager, so a partial disable mutes it.
        try {
            this._inspector?.destroy();
        } finally {
            this._inspector = null;
            try {
                this._manager?.disable();
            } finally {
                this._manager = null;
            }
        }
    }
}
