/**
 * Pure rounded-corner A_8 mask bytes for the overview preview.
 *
 * The mask is arithmetic over a Uint8Array: fill the body, stamp four corner coverage
 * discs. It used to live in the same function as the Cogl texture upload, inside a module
 * that imports Cogl and Mtk, so the corners the user sees in the overview had no unit
 * oracle. It lives here now: this module returns the bytes, overviewMask.js uploads them.
 */

/** @param {number} value @param {number} low @param {number} high @returns {number} */
function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
}

/** @param {Uint8Array} data @param {number} width @param {number} height */
function fillRect(data, width, height, x, y, w, h, value) {
    const x0 = clamp(Math.round(x), 0, width);
    const y0 = clamp(Math.round(y), 0, height);
    const x1 = clamp(Math.round(x + w), x0, width);
    const y1 = clamp(Math.round(y + h), y0, height);
    for (let row = y0; row < y1; row++)
        data.fill(value, row * width + x0, row * width + x1);
}

/**
 * Writes one rounded corner: coverage of the disc centred on (cx, cy) over the
 * square that starts at (squareX, squareY) and spans `r` texture pixels.
 */
function writeCorner(data, width, height, squareX, squareY, cx, cy, r) {
    const x0 = clamp(Math.round(squareX), 0, width);
    const y0 = clamp(Math.round(squareY), 0, height);
    const x1 = clamp(Math.ceil(squareX + r), x0, width);
    const y1 = clamp(Math.ceil(squareY + r), y0, height);
    for (let y = y0; y < y1; y++) {
        const dy = y + 0.5 - cy;
        const rowOffset = y * width;
        for (let x = x0; x < x1; x++) {
            const dx = x + 0.5 - cx;
            const coverage = clamp(r - Math.hypot(dx, dy) + 0.5, 0, 1);
            data[rowOffset + x] = Math.round(coverage * 255);
        }
    }
}

/**
 * Builds a rounded-corner A_8 mask matching the desktop clip's body geometry.
 *
 * Alpha is 255 over the body, the four corners carry the rounded coverage, and
 * outside the body it is 255 unless `erase` asks for the ring to be erased
 * (flat windows, whose clip has no client ring to preserve).
 *
 * @param {object} geometry
 * @param {number} geometry.width - Mask width in texture pixels
 * @param {number} geometry.height - Mask height in texture pixels
 * @param {number} geometry.frameX - Body left, texture pixels
 * @param {number} geometry.frameY - Body top, texture pixels
 * @param {number} geometry.frameW - Body width, texture pixels
 * @param {number} geometry.frameH - Body height, texture pixels
 * @param {number} geometry.radius - Corner radius, texture pixels
 * @param {boolean} geometry.erase - Erase everything outside the body
 * @returns {{data: Uint8Array, width: number, height: number}|null} A_8 alpha bytes,
 *   row-major, with the rounded size the texture must use, or null for a degenerate body
 */
export function roundedMaskBytes({
    width, height, frameX, frameY, frameW, frameH, radius, erase,
}) {
    width = Math.round(width);
    height = Math.round(height);
    if (!(width > 0) || !(height > 0))
        return null;

    const data = new Uint8Array(width * height);
    data.fill(erase ? 0 : 255);

    const fx = clamp(frameX, 0, width);
    const fy = clamp(frameY, 0, height);
    const fw = clamp(frameW, 0, width - fx);
    const fh = clamp(frameH, 0, height - fy);
    if (!(fw > 0) || !(fh > 0))
        return null;

    if (erase)
        fillRect(data, width, height, fx, fy, fw, fh, 255);

    // The body is already filled; only the four corner squares differ.
    const r = Math.min(Math.max(radius, 0), fw / 2, fh / 2);
    if (r >= 0.5) {
        writeCorner(data, width, height, fx, fy, fx + r, fy + r, r);
        writeCorner(data, width, height, fx + fw - r, fy, fx + fw - r, fy + r, r);
        writeCorner(data, width, height, fx, fy + fh - r, fx + r, fy + fh - r, r);
        writeCorner(data, width, height, fx + fw - r, fy + fh - r, fx + fw - r, fy + fh - r, r);
    }

    return {data, width, height};
}
