/**
 * Signal-handler leak probe, evaluated inside the running shell by `Shell.Eval` (see the
 * reload-stress section of `tools/test-e2e.sh`, which substitutes `__UUID__`/`__CYCLES__`).
 *
 * Every GObject `connect` made while the probe runs is remembered, then checked against
 * `GObject.signal_handler_is_connected()` after the extension has been disabled. A handler whose
 * object was collected is *not* a leak - the handlers went with it - which is why a collection is
 * forced first; a handler that is still connected on a live object after `disable()` is one
 * nothing will ever disconnect, and that is the leak this exists to catch.
 *
 * Instrumenting the prototype is the only way to see handlers the extension never disconnects:
 * handlers it *does* track are disconnected long before anything could enumerate them.
 */

const UUID = '__UUID__';
const CYCLES = Number('__CYCLES__');

(async () => {
    const gi = async name => {
        const module = await import(name);
        return module.default ?? module;
    };

    const GObject = await gi('gi://GObject');
    const System = await gi('system');
    const MainMod = await import('resource:///org/gnome/shell/ui/main.js');
    const Main = MainMod.default ?? MainMod;

    const ext = (Main.extensionManager ?? MainMod.extensionManager).lookup(UUID);
    if (!ext?.stateObj)
        return JSON.stringify({ok: false, error: 'extension is not active'});

    const proto = GObject.Object.prototype;
    const originalConnect = proto.connect;
    const originalDisconnect = proto.disconnect;
    if (originalConnect.__leakProbe)
        return JSON.stringify({ok: false, error: 'a previous probe left the prototype instrumented'});

    let records = [];
    proto.connect = function (...args) {
        const id = originalConnect.apply(this, args);
        let type = '?';
        try {
            type = this.constructor?.$gtype?.name ?? '?';
        } catch {
            // A type we cannot name is still a handler worth counting.
        }
        records.push({weak: new WeakRef(this), id, signal: String(args[0]), type});
        return id;
    };
    proto.connect.__leakProbe = true;
    proto.disconnect = function (...args) {
        return originalDisconnect.apply(this, args);
    };
    proto.disconnect.__leakProbe = true;

    const handlers = [];
    let error = null;
    try {
        // Start disabled so the cycles below are the only connects measured.
        ext.stateObj.disable();
        records = [];
        for (let i = 0; i < CYCLES; i++) {
            ext.stateObj.enable();
            ext.stateObj.disable();
        }
        System.gc();
        for (const record of records) {
            const object = record.weak.deref();
            if (object === undefined)
                continue;
            let stillConnected = false;
            try {
                stillConnected = GObject.signal_handler_is_connected(object, record.id);
            } catch {
                stillConnected = false;
            }
            if (stillConnected)
                handlers.push(`${record.type}::${record.signal}`);
        }
    } catch (e) {
        error = e.message;
    } finally {
        proto.connect = originalConnect;
        proto.disconnect = originalDisconnect;
        ext.stateObj.enable();
    }

    return JSON.stringify({ok: error === null, error, cycles: CYCLES, handlers});
})()
