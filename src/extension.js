/**
 * Window Nativizer - restores GNOME native rounded corners and drop shadows to undecorated windows.
 *
 * Architecture (module responsibilities):
 *   detector  determines whether a window needs decoration (geometry criteria)
 *   style     decoration style state machine (tracks libadwaita window.csd)
 *   effects   rounded clipping (GLSLEffect) + baked Cogl shadow texture pipeline
 *   manager   state machine responding to window lifecycle, focus, and display changes
 *   inspector interactive window picker and D-Bus service for preferences
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
            // A half-enabled extension must not wedge the idempotency guard: roll the
            // partial state back and let the failure surface. disable() clears that guard
            // itself, so a teardown that fails leaves the extension needing a reload
            // rather than re-enabling on top of a manager that is still live.
            try {
                this.disable();
            } catch (teardownError) {
                // Teardown is best-effort here; surface it rather than hide a leak.
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

