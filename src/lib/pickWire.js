/** The picker's D-Bus wire format: the names, the interface, and the flag that selects the reply. */

export const INSPECTOR_DBUS_NAME = 'org.gnome.Shell.Extensions.WindowNativizer';
export const INSPECTOR_DBUS_PATH = '/org/gnome/Shell/Extensions/WindowNativizer';

/** Kept as data, so reading the key needs no St or Main module. */
export const INSPECTOR_DBUS_IFACE_XML = `
<node>
  <interface name="${INSPECTOR_DBUS_NAME}">
    <method name="PickWindow">
      <arg type="b" direction="in" name="debug"/>
      <arg type="a{ss}" direction="out" name="properties"/>
    </method>
  </interface>
</node>`;

/** No arg is invalid, not false: D-Bus has no defaults, so reading it as quiet hides the break. */
export function parseDebugFlag(params) {
    if (!Array.isArray(params) || params.length < 1)
        return {valid: false, diagnostics: false};
    const debug = params[0];
    if (typeof debug !== 'boolean')
        return {valid: false, diagnostics: false};
    return {
        valid: true,
        diagnostics: debug,
    };
}
