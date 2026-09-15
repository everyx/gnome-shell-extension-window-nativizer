/**
 * GTK4 GSK native 2D analytic Gaussian box shadow shader (**Generated file, do not edit**).
 *
 * Source: GTK4 upstream (vendor/gtk/COMMIT = 539d28f33b6d285a784c220e6c53ec499d75c078)
 * Original: gsk/gpu/shaders/gskgpuboxshadow.glsl
 * Generator: node tools/gen-shader.mjs
 */

export const DECLARATIONS = `
uniform vec2 uWinSize;      // Window size (px)
uniform float uRadius;       // Window corner radius (px)
uniform vec4 uShadow1;      // (blur, spread, alpha, 0)
uniform vec4 uShadow2;
uniform vec4 uShadow3;      // Outline layer (blur=0)
uniform vec2 uPad;          // Shadow actor padding per side (px)

const float PI = 3.141592653589793;
const float SQRT1_2 = 0.7071067811865475;

// ClutterOffscreenEffect (_clutter_actor_box_enlarge_for_effects, gen-clutter.mjs)
// Offsets 2px top-left to avoid subpixel jitter, adds 3px in total size
const vec2 FBO_OFFSET = vec2(2.0, 2.0);
const vec2 FBO_EXTRA  = vec2(3.0, 3.0);

// --- GTK4 native 2D analytic Gaussian convolution kernel ---

float
gauss (float x,
       float sigma)
{
  float sigma_2 = sigma * sigma;
  return 1.0 / sqrt (2.0 * PI * sigma_2) * exp (-(x * x) / (2.0 * sigma_2));
}

vec2
erf (vec2 x)
{
  vec2 s = sign(x), a = abs(x);
  x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  x *= x;
  return s - s / (x * x);
}

float
erf_range (vec2 x,
           float sigma)
{
  vec2 from_to = 0.5 - 0.5 * erf (x / (sigma * SQRT1_2));
  return from_to.y - from_to.x;
}

float
ellipse_x (vec2  ellipse,
           float y)
{
  float y_scaled = y / ellipse.y;
  return ellipse.x * sqrt (1.0 - y_scaled * y_scaled);
}

float blur_rect(vec4 r, vec2 pos, float sigma) {
    return erf_range(r.xz - pos.x, sigma) * erf_range(r.yw - pos.y, sigma);
}

float
blur_corner (vec2 p,
             vec2 r,
             float sigma)
{
  if (min (r.x, r.y) <= 0.0)
    return 0.0;

  p /= sigma;
  r /= sigma;

  if (min (p.x, p.y) <= -2.95 ||
      max (p.x - r.x, p.y - r.y) >= 2.95)
    return 0.0;

  float result = 0.0;
  float start = max (p.y - 3.0, 0.0);
  float end = min (p.y + 3.0, r.y);
  float step = (end - start) / 7.0;
  float y = start;
  for (int i = 0; i < 8; i++)
    {
      float x = r.x - ellipse_x (r, r.y - y);
      result -= gauss (p.y - y, 1.0) * erf_range (vec2 (- p.x, x - p.x), 1.0);
      y += step;
    }
  return step * result;
}

float blur_rounded_rect(vec4 r, float radius, vec2 p, float sigma) {
    float result = blur_rect(r, p, sigma);
    if (radius <= 0.0)
        return max(result, 0.0);

    vec2 cr = vec2(radius);
    result -= blur_corner(p - r.xy, cr, sigma);
    result -= blur_corner(vec2(r.z - p.x, p.y - r.y), cr, sigma);
    result -= blur_corner(r.zw - p, cr, sigma);
    result -= blur_corner(vec2(p.x - r.x, r.w - p.y), cr, sigma);

    return max(result, 0.0);
}

// SDF rounded box distance (for unblurred outline layer where blur < 0.5)
float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float evalShadowLayer(vec4 s, vec2 p, vec2 winOrigin, vec2 winSize, float radius, float d) {
    if (s.z <= 0.0)
        return 0.0;
    float blur = s.x;
    float spread = s.y;
    float alpha = s.z;

    if (blur < 0.5) {
        // 1px crisp hollow outset border band between window boundary (d=0) and spread
        float inner = clamp(d + 0.5, 0.0, 1.0);
        float outer = clamp(d - spread + 0.5, 0.0, 1.0);
        return alpha * max(inner - outer, 0.0);
    }

    vec4 bounds = vec4(winOrigin - vec2(spread), winOrigin + winSize + vec2(spread));
    float effRadius = max(radius + spread, 0.0);
    float sigma = 0.5 * blur;
    return alpha * blur_rounded_rect(bounds, effRadius, p, sigma);
}
`;

export const CODE = `
    // Early discard if actor is fully transparent (e.g. at open/close animation bounds)
    if (cogl_color_in.a <= 0.0) {
        cogl_color_out = vec4(0.0);
        return;
    }

    vec2 halfSize = uWinSize * 0.5;
    vec2 quadSize = uWinSize + uPad * 2.0 + FBO_EXTRA;
    vec2 winOrigin = uPad + FBO_OFFSET;
    vec2 c = winOrigin + halfSize;
    vec2 p = cogl_tex_coord0_in.xy * quadSize;
    float d = sdRoundedBox(p - c, halfSize, uRadius);

    // Aligned with GTK4 GSK_RECT_SNAP_GROW philosophy: conservative overlap (SNAP_BLEED = 0.8)
    // Extends shadow under window base to eliminate 1px bright gaps under fractional scaling.
    float clipAlpha = clamp(d + 0.5 + 0.8, 0.0, 1.0);
    if (clipAlpha <= 0.0) {
        cogl_color_out = vec4(0.0);
        return;
    }

    // Alpha-over compositing across layers prevents linear arithmetic saturation
    float a1 = evalShadowLayer(uShadow1, p, winOrigin, uWinSize, uRadius, d);
    float a2 = evalShadowLayer(uShadow2, p, winOrigin, uWinSize, uRadius, d);
    float a3 = evalShadowLayer(uShadow3, p, winOrigin, uWinSize, uRadius, d);
    float a = (1.0 - (1.0 - a1) * (1.0 - a2) * (1.0 - a3)) * clipAlpha;

    // Multiply shadow alpha by vertex alpha (cogl_color_in.a) to smoothly follow fade animations
    cogl_color_out = vec4(vec3(0.0), min(a, 1.0) * cogl_color_in.a);
`;
