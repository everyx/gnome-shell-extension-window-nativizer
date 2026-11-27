/** The sample reader's pure half: what a one-pixel pixbuf says about a corner. */

import {pixbufAlpha} from '../src/platform/cornerAlpha.js';

function fakePixbuf({channels = 4, alpha = true, pixels = [0, 0, 0, 166]} = {}) {
    return {
        get_has_alpha: () => alpha,
        get_n_channels: () => channels,
        get_pixels: () => pixels,
    };
}

describe('pixbufAlpha', () => {
    it('reads the alpha byte of an RGBA sample', () => {
        expect(pixbufAlpha(fakePixbuf())).toBe(166);
    });

    it('calls a pixbuf without an alpha channel opaque, which is not the same as unknown', () => {
        expect(pixbufAlpha(fakePixbuf({channels: 3, alpha: false, pixels: [1, 2, 3]}))).toBe(255);
    });

    it('answers null when there is nothing to read', () => {
        expect(pixbufAlpha(null)).toBeNull();
        expect(pixbufAlpha(fakePixbuf({channels: 4, pixels: [0, 0]}))).toBeNull();
    });
});
