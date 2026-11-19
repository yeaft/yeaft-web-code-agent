/**
 * Perspective camera for stick-figure scenes. A shot is { eye, target, fov }
 * (fov in degrees, vertical). Shots can be mixed, so a scene can glide from
 * one to the next instead of cutting.
 */
import { cross, dot, mix, mix3, sub, unit } from './vec.js';

const UP = [0, 1, 0];

/** Part-way from shot `a` to shot `b`. */
export const mixShots = (a, b, u) => ({ eye: mix3(a.eye, b.eye, u), target: mix3(a.target, b.target, u), fov: mix(a.fov, b.fov, u) });

/**
 * @param {{ eye: number[], target: number[], fov: number }} shot
 * @param {number} width Picture width in CSS px.
 * @param {number} height Picture height in CSS px.
 * @returns Camera with `project(point)` giving screen `x`/`y`, `depth` in
 *   feet along the view, and `k` pixels per foot there.
 */
export function makeCamera({ eye, target, fov }, width, height) {
  const forward = unit(sub(target, eye));
  const right = unit(cross(forward, UP));
  const up = cross(right, forward);
  const focal = (height / 2) / Math.tan((fov * Math.PI) / 360);
  return {
    eye, forward, right, up, focal, width, height,
    /** How much a circle lying on the floor is squashed by the camera's tilt. */
    squash: Math.max(0.16, Math.abs(forward[1])),
    /** Camera-space [right, up, depth] of a point. */
    view(point) {
      const reach = sub(point, eye);
      return [dot(reach, right), dot(reach, up), dot(reach, forward)];
    },
    /** Screen position of a camera-space point. */
    screen(v) {
      const k = focal / Math.max(v[2], 0.05);
      return { x: width / 2 + v[0] * k, y: height / 2 - v[1] * k, depth: v[2], k };
    },
    project(point) {
      return this.screen(this.view(point));
    },
  };
}
