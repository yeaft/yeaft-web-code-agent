/**
 * Camera direction for the basketball waiting scene: a low, wide strip under
 * the transcript. The camera glides — push in on the shake, pull back for the
 * shot, push in on the rim, drift to the walk-off — and never cuts mid-play.
 * Pure: (play frame, viewport size) → transform. `cx`/`cy` is the world point
 * at the viewport centre and `scale` is pixels per foot.
 */
import { HOOPS_BEATS as B, RIM } from './hoops-play.js';

const FLOOR_INSET = 6;

const clamp01 = value => Math.min(1, Math.max(0, value));
const mix = (a, b, u) => a + (b - a) * u;
const smooth = u => u * u * (3 - 2 * u);

/**
 * @param play Frame from `resolveHoopsPlay`.
 * @param {number} width Viewport width in CSS px.
 * @param {number} height Viewport height in CSS px.
 * @returns {{ scale: number, cx: number, cy: number, shot: string }}
 */
export function resolveHoopsCamera(play, width, height) {
  const { hero, defender, time } = play;
  // `air` is the feet of height a frame holds above the floor line.
  const scaleFor = air => Math.max(1, height - FLOOR_INSET - 2) / air;
  // Stand the floor FLOOR_INSET px above the bottom edge.
  const onFloor = (air, cx) => ({ scale: scaleFor(air), cx, cy: (height / 2 - FLOOR_INSET) / scaleFor(air) });
  const frames = {
    // The whole floor with the hoop near the right edge. The strip is kept
    // low so it barely moves the transcript, which means the top of the arc
    // leaves this frame; the ball comes back down in the rim frame.
    wide: onFloor(13.8, 10 - width / (2 * scaleFor(13.8))),
    duel: onFloor(7.5, (hero.x + defender.x) / 2),
    // Hoop left of centre, so the shooter stays out of the bottom corner.
    rim: { scale: scaleFor(7.4), cx: RIM.x + 3, cy: RIM.y + 0.2 },
    walkoff: onFloor(8.2, hero.x - 1),
  };
  const keys = [
    [0, 'wide'], [2.75, 'wide'], [3.4, 'duel'], [B.rise - 0.1, 'duel'], [B.rise + 0.4, 'wide'],
    [B.flight + 0.5, 'wide'], [B.swish - 0.25, 'rim'], [B.swish + 0.5, 'rim'], [B.swish + 1.05, 'walkoff'],
  ];
  let index = 0;
  for (let i = 1; i < keys.length; i += 1) if (time >= keys[i][0]) index = i;
  const from = frames[keys[index][1]];
  const next = keys[index + 1];
  if (!next) return { ...from, shot: keys[index][1] };
  const to = frames[next[1]];
  const u = smooth(clamp01((time - keys[index][0]) / (next[0] - keys[index][0])));
  return {
    scale: Math.exp(mix(Math.log(from.scale), Math.log(to.scale), u)),
    cx: mix(from.cx, to.cx, u), cy: mix(from.cy, to.cy, u),
    shot: u < 0.5 ? keys[index][1] : next[1],
  };
}
