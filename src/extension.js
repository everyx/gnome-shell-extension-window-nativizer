import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Manager} from './lib/manager.js';
import {InspectorService} from './lib/inspector.js';

export default class WindowNativizerExtension extends Extension {
    enable() {
        if (this._manager)
            return;

        this._manager = new Manager(this);
        try {
            this._manager.enable();
            this._inspector = new InspectorService(this._manager);
        } catch (e) {
            // Roll back a partial enable, or the idempotency guard wedges.
            this.disable();
            throw e;
        }
    }

    disable() {
        // The manager's teardown does not wait on the inspector's: leaving `_manager` set would
        // make enable() return early from then on.
        try {
            this._inspector?.destroy();
        } finally {
            this._inspector = null;
            this._manager.disable();
            this._manager = null;
        }
    }
}
