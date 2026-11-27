/**
 * The pick reply is a `a{ss}` map, so every value it carries is a string and a field it cannot fill is
 * still a field: "unknown" is a state of its own, and leaving a key out would make the reader guess
 * between "not asked" and "could not read".
 */

import {environmentProperties} from '../src/lib/pickProperties.js';

describe('environmentProperties', () => {
    it('reports the extension version, the scale, the theme and the rule that applies', () => {
        const properties = environmentProperties({
            versionName: '0.13.0',
            monitorScale: 1.25,
            dark: true,
            highContrast: false,
            ruleState: 'corners,shadow',
        });

        expect(properties).toEqual({
            extensionVersion: '0.13.0',
            monitorScale: '1.25',
            theme: 'dark',
            highContrast: 'false',
            ruleState: 'corners,shadow',
        });
        // The wire type is a{ss}: one boolean or number here is a reply the caller cannot parse.
        for (const value of Object.values(properties))
            expect(typeof value).toBe('string');
    });

    it('says unknown and none instead of dropping a field it cannot fill', () => {
        const properties = environmentProperties({});

        expect(properties).toEqual({
            extensionVersion: 'unknown',
            monitorScale: 'unknown',
            theme: 'unknown',
            highContrast: 'unknown',
            ruleState: 'none',
        });
        expect(Object.keys(properties)).toHaveSize(5);
    });

    it('keeps light and high contrast distinguishable from unknown', () => {
        expect(environmentProperties({dark: false}).theme).toBe('light');
        expect(environmentProperties({dark: null}).theme).toBe('unknown');
        expect(environmentProperties({highContrast: true}).highContrast).toBe('true');
    });
});
