/** Bake margin in logical px: 2 near, 1 far, keeping the Gaussian tail off the texture edge. */
export const SHADOW_BAKE_ORIGIN = 2;

/** Extra size per axis, origin plus the far margin; shared so the generated shader cannot drift. */
export const SHADOW_BAKE_EXTRA = 3;
