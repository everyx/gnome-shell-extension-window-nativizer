/**
 * Window Nativizer entry point. See docs/architecture.md for module map.
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
        this._inspector?.destroy();
        this._inspector = null;

        this._manager?.disable();
        this._manager = null;
    }
}
