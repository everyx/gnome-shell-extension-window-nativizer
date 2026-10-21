/** A_8 corner mask bytes for the overview preview; pure, so a unit test can check the corners. */

function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
}

function fillRect(data, width, height, x, y, w, h, value) {
    const x0 = clamp(Math.round(x), 0, width);
    const y0 = clamp(Math.round(y), 0, height);
    const x1 = clamp(Math.round(x + w), x0, width);
    const y1 = clamp(Math.round(y + h), y0, height);
    for (let row = y0; row < y1; row++)
        data.fill(value, row * width + x0, row * width + x1);
}

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

/** 255 over the body, corners stamped; `erase` clears the ring outside. Null if degenerate. */
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

    const r = Math.min(Math.max(radius, 0), fw / 2, fh / 2);
    if (r >= 0.5) {
        writeCorner(data, width, height, fx, fy, fx + r, fy + r, r);
        writeCorner(data, width, height, fx + fw - r, fy, fx + fw - r, fy + r, r);
        writeCorner(data, width, height, fx, fy + fh - r, fx + r, fy + fh - r, r);
        writeCorner(data, width, height, fx + fw - r, fy + fh - r, fx + fw - r, fy + fh - r, r);
    }

    return {data, width, height};
}
