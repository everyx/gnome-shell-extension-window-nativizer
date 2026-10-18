/**
 * Padding the shadow bake texture carries around the cast, in logical bake px.
 *
 * The bake is our own `Cogl.Offscreen`, so these are a layout choice rather than a fact about
 * Mutter. The split is 2px on the near side and 1px on the far side, the shape Clutter's
 * `_clutter_actor_box_enlarge_for_effects` produces on an integer-aligned box, which the bake
 * shader's quad reproduces (`FBO_OFFSET`/`FBO_EXTRA` in shadowShader.generated.js) and the slice
 * table reads back (`near = SHADOW_BAKE_ORIGIN / buffer` in shadowGeometry.js). It exists to keep
 * the Gaussian tail off the texture edge, not to describe the window: the clip's own offscreen
 * box is derived separately, per paint, in offscreenBox.js.
 *
 * One module because the bake shader is generated: the values have to agree between
 * shadowGeometry.js, tools/gen-style.mjs and tools/gen-shader.mjs, and a shared import is the only
 * thing that keeps three copies from drifting.
 */

/** Transparent margin on the near (top-left) side of the baked cast. */
export const SHADOW_BAKE_ORIGIN = 2;

/** Total extra size per axis: `SHADOW_BAKE_ORIGIN` near plus 1px far. */
export const SHADOW_BAKE_EXTRA = 3;
