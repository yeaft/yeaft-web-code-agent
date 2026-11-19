/**
 * Vector and easing helpers for the basketball waiting animation.
 * Points and directions are [x, y, z] arrays in feet; y is up.
 */
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = a => Math.hypot(a[0], a[1], a[2]);
export const unit = (a) => {
  const size = length(a) || 1;
  return [a[0] / size, a[1] / size, a[2] / size];
};
export const mix3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
/** `origin` moved by `forward`, `side` and `up` along the three given axes. */
export const offset = (origin, f, forward, r, side, up) => [
  origin[0] + f[0] * forward + r[0] * side,
  origin[1] + f[1] * forward + r[1] * side + up,
  origin[2] + f[2] * forward + r[2] * side,
];
/** Rotate about the vertical axis; a positive angle turns +x toward +z. */
export const turn = (p, angle) => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [p[0] * c - p[2] * s, p[1], p[0] * s + p[2] * c];
};

export const clamp01 = value => Math.min(1, Math.max(0, value));
export const mix = (a, b, u) => a + (b - a) * u;
export const span = (t, from, to) => clamp01((t - from) / (to - from));
export const smooth = u => u * u * (3 - 2 * u);
export const easeIn = u => u * u;
export const easeOut = u => 1 - (1 - u) * (1 - u);
