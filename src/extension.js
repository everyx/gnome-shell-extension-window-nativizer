/**
 * Window Nativizer extension entry point.
 */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Manager} from './lib/manager.js';
import {InspectorService} from './lib/inspector.js';

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
            // Roll back partial enable so idempotency guard does not wedge; surface original error.
            try {
                this.disable();
            } catch (teardownError) {
                logError(teardownError, '[window-nativizer] teardown after a failed enable()');
            }
            throw e;
        }
    }

    disable() {
        // Both references are dropped however teardown ends: `enable()` guards on `_manager`, so a
        // half-finished disable that threw would turn every later enable into a silent no-op.
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
