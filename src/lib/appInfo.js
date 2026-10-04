import Gio from 'gi://Gio';

/**
 * Strips the .desktop suffix from an application identifier.
 * 'org.gnome.Nautilus.desktop' -> 'org.gnome.Nautilus'
 * @param {string} id
 * @returns {string}
 */
export function stripDesktopSuffix(id) {
    return id.endsWith('.desktop') ? id.slice(0, -8) : id;
}

/**
 * Retrieves all installed applications that should be displayed in the system.
 * @returns {Array<{app:Gio.AppInfo,name:string,id:string,wmClass:string,icon:Gio.Icon|null}>}
 */
export function getInstalledApps() {
    const apps = Gio.AppInfo.get_all();
    const result = [];
    for (const app of apps) {
        if (!app.should_show())
            continue;

        const name = app.get_name() || '';
        const id = app.get_id() || '';
        const startupWmClass = app.get_startup_wm_class ? app.get_startup_wm_class() : null;
        const executable = app.get_executable ? app.get_executable() : null;
        const icon = app.get_icon();

        let wmClass = startupWmClass;
        if (!wmClass && id)
            wmClass = stripDesktopSuffix(id);
        if (!wmClass && executable)
            wmClass = executable.split('/').pop();

        result.push({
            app,
            name,
            id,
            wmClass: wmClass || id,
            icon,
        });
    }
    return result;
}

/**
 * Resolves an AppInfo descriptor by matching WM_CLASS or desktop IDs.
 * @param {string|null} wmClass
 * @param {Array<{app:Gio.AppInfo,name:string,id:string,wmClass:string,icon:Gio.Icon|null}>} appsList
 * @returns {{app:Gio.AppInfo,name:string,id:string,wmClass:string,icon:Gio.Icon|null}|null}
 */
export function findAppInfoByWmClass(wmClass, appsList) {
    if (!wmClass)
        return null;
    const lower = wmClass.toLowerCase();
    return appsList.find(a =>
        a.wmClass.toLowerCase() === lower ||
        a.id.toLowerCase() === lower ||
        (a.id.endsWith('.desktop') && stripDesktopSuffix(a.id).toLowerCase() === lower) ||
        (a.app.get_startup_wm_class && a.app.get_startup_wm_class()?.toLowerCase() === lower)
    ) || null;
}
