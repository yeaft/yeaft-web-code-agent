/**
 * Camera direction for the waiting scene. Two views watch the same play:
 *   court     — a low, wide strip under the transcript; the camera glides
 *               (push in on the shake, pull back for the shot, push in on the rim).
 *   broadcast — a small screen in the status pane; the camera cuts between
 *               framings like a live director.
 * Pure: (view, play frame, viewport size) → transform. `cx`/`cy` is the world
 * point at the viewport centre and `scale` is pixels per foot.
 */
import { HOOPS_BEATS as B, RIM } from './hoops-play.js';

const COURT_FLOOR_INSET = 6;
const SCREEN_FLOOR_INSET = 14;

const clamp01 = value => Math.min(1, Math.max(0, value));
const mix = (a, b, u) => a + (b - a) * u;
const smooth = u => u * u * (3 - 2 * u);

/** World y at the viewport centre that puts the floor `inset` px above the bottom edge. */
const floorCentre = (height, inset, scale) => (height / 2 - inset) / scale;

function courtCamera(play, width, height) {
  const { hero, defender, time } = play;
  // `air` is the feet of height a frame holds above the floor line.
  const scaleFor = air => (height - COURT_FLOOR_INSET - 2) / air;
  const onFloor = (air, cx) => ({ scale: scaleFor(air), cx, cy: floorCentre(height, COURT_FLOOR_INSET, scaleFor(air)) });
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
  if (!next) return { ...from, roll: 0, shot: keys[index][1] };
  const to = frames[next[1]];
  const u = smooth(clamp01((time - keys[index][0]) / (next[0] - keys[index][0])));
  return {
    scale: Math.exp(mix(Math.log(from.scale), Math.log(to.scale), u)),
    cx: mix(from.cx, to.cx, u), cy: mix(from.cy, to.cy, u),
    roll: 0, shot: u < 0.5 ? keys[index][1] : next[1],
  };
}

/**
 * Shot list for the screen. `air` is the feet of height in frame; `at` is where
 * the focus point sits in the viewport (0–1). Floor shots omit `fy`/`ay` and
 * stand the floor on the lower edge.
 */
const SHOTS = [
  [0, 'track', ({ hero }) => ({ air: 11.5, fx: hero.x + 2.6, ax: 0.42 })],
  [2.55, 'matchup', ({ hero, defender }) => ({ air: 9.6, fx: (hero.x + defender.x) / 2, ax: 0.5 })],
  [B.drive, 'handle', ({ hero }) => ({ air: 7.7, fx: hero.x + 2.2, ax: 0.44, roll: -0.04 })],
  [B.snatch, 'ankles', ({ hero, defender }) => ({ air: 8.4, fx: (hero.x + defender.x) / 2 + 0.2, ax: 0.5, roll: 0.03 })],
  [B.rise, 'launch', ({ hero }) => ({ air: 12.6, fx: hero.x + 1.6, ax: 0.36 })],
  [B.flight + 0.12, 'arc', ({ spot }) => ({ air: 20.6, fx: (spot + RIM.x) / 2 + 2, ax: 0.5 })],
  [B.swish - 0.38, 'rim', () => ({ air: 6, fx: RIM.x - 0.9, fy: RIM.y - 0.45, ax: 0.58, ay: 0.52 })],
  [B.celebrate + 0.25, 'walkoff', ({ hero }) => ({ air: 9.4, fx: hero.x - 0.8, ax: 0.52 })],
];

function broadcastCamera(play, width, height) {
  let index = 0;
  for (let i = 1; i < SHOTS.length; i += 1) if (play.time >= SHOTS[i][0]) index = i;
  const [from, shot, frame] = SHOTS[index];
  const { air, fx, fy, ax, ay, roll = 0 } = frame(play);
  // Every shot creeps in a little so a held frame never looks frozen.
  const scale = height / (air * (1 - 0.05 * clamp01((play.time - from) / 1.6)));
  return {
    scale, roll, shot,
    cx: fx - (ax - 0.5) * width / scale,
    cy: ay === undefined ? floorCentre(height, SCREEN_FLOOR_INSET, scale) : fy + (ay - 0.5) * height / scale,
  };
}

/**
 * @param {'court'|'broadcast'} view
 * @param play Frame from `resolveHoopsPlay`.
 * @param {number} width Viewport width in CSS px.
 * @param {number} height Viewport height in CSS px.
 * @returns {{ scale: number, cx: number, cy: number, roll: number, shot: string }}
 */
export function resolveHoopsCamera(view, play, width, height) {
  return view === 'broadcast' ? broadcastCamera(play, width, height) : courtCamera(play, width, height);
}
