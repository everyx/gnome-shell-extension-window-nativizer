/**
 * Probe cache unit tests: the file is a set of rule keys, and nothing else survives a load.
 * Run: pnpm test
 */

import GLib from 'gi://GLib';

import {loadProbeCache, saveProbeCache} from '../src/platform/probeCache.js';

function tempPath(name) {
    return GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `wn-probecache-${name}-${GLib.get_monotonic_time()}.json`,
    ]);
}

describe('probeCache', () => {
    let file;

    beforeEach(() => {
        file = tempPath('roundtrip');
    });

    afterEach(() => {
        try {
            GLib.unlink(file);
        } catch {
            // Already gone: a test that never wrote it leaves nothing behind.
        }
    });

    it('round-trips a set of rule keys', () => {
        const kinds = new Set(['wechat:client_type=wayland,size=280x380', 'wps:client_type=x11']);
        saveProbeCache(file, kinds);

        const [ok, bytes] = GLib.file_get_contents(file);
        expect(ok).toBeTrue();
        expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual([...kinds]);
        expect(loadProbeCache(file)).toEqual(kinds);
    });

    it('reads an empty set from a missing file', () => {
        expect(loadProbeCache(file).size).toBe(0);
        expect(loadProbeCache(null).size).toBe(0);
    });

    it('reads nothing out of the object form the previous release wrote', () => {
        GLib.file_set_contents(file, JSON.stringify({'wechat:client_type=wayland': true}));

        // Not migrated on purpose: the entry is one probe to redo, and a migration branch would
        // outlive the format it reads.
        expect(loadProbeCache(file).size).toBe(0);
    });

    it('survives a corrupt file, because the next probe rebuilds it', () => {
        GLib.file_set_contents(file, 'not json at all');
        expect(loadProbeCache(file).size).toBe(0);
    });

    it('writes nothing when the caller has no set or no path', () => {
        expect(() => saveProbeCache(file, new Map())).not.toThrow();
        expect(() => saveProbeCache(null, new Set(['a:b']))).not.toThrow();
        expect(GLib.file_test(file, GLib.FileTest.EXISTS)).toBeFalse();
    });
});
