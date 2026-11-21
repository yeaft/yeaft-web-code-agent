/**
 * What the basketball waiting animation shows at any moment of a wait: one
 * possession, over and over, with the score going up.
 *
 * Each round is two shots. On the floor, number 30 works the ball through
 * three defenders and pulls up for a three, exactly as the capture has it
 * (hoops/tracks.js), at the pace of the slow-motion replay it was traced from.
 * Then, from under the rim, the ball drops through the net.
 *
 * Everything here is a function of the time since the wait began, so any
 * moment can be painted on its own.
 */
import { CAPTURE_FPS, CAPTURE_FRAMES, RELEASE_FRAME, sampleCapture } from './tracks.js';

/** The possession on the floor: as long as the captured footage runs. */
export const COURT_MS = (CAPTURE_FRAMES / CAPTURE_FPS) * 1000;
/** The ball dropping through the net. */
export const RIM_MS = 1500;
export const POSSESSION_MS = COURT_MS + RIM_MS;
const SHOT_WORTH = 3;

/** Capture frame each beat of the possession starts at. */
const BEATS = [[0, 'handle'], [68, 'hesitation'], [84, 'escape'], [118, 'gather'], [137, 'rise'], [RELEASE_FRAME, 'release']];

/**
 * The rim shot is measured in rim radii from the centre of the rim, y down.
 * The ball falls in slow motion, is slowed by the net and drops out below.
 */
const RIM_PACE = 1.25; // time units the shot covers
const RIM_AT = 0.557; // time the ball's centre passes the rim
const fall = time => (time < RIM_AT
  ? { x: -2.6 + (2.6 / RIM_AT) * time, y: -4.4 + 4 * time + 7 * time * time }
  : { x: 0.5 * (time - RIM_AT), y: 6.5 * (time - RIM_AT) + 7 * (time - RIM_AT) ** 2 });
/** When in the rim shot the ball goes through, in ms. */
const MAKE_MS = (RIM_AT / RIM_PACE) * RIM_MS;

/** Scene times of the possession's key moments, in order: what is shown with motion reduced. */
export const HOOPS_STILLS = [
  ...[8, 40, 72, 92, 110, 126, 138, 146].map(frame => (frame / CAPTURE_FPS) * 1000),
  COURT_MS + 470, COURT_MS + 760, COURT_MS + 1250,
];
/** The frame held while the connection has stalled: the hesitation, ball in hand, defenders all round. */
export const HOOPS_POSTER_MS = (74 / CAPTURE_FPS) * 1000;

let spins = null;
/** How far the ball has turned by each captured frame: it turns while it is loose, not in his hands. */
function spinAt(frame) {
  if (!spins) {
    spins = new Float32Array(CAPTURE_FRAMES + 2);
    for (let f = 0; f <= CAPTURE_FRAMES; f += 1) {
      const loose = !sampleCapture(f).ball.held;
      spins[f + 1] = spins[f] + (loose ? (f > RELEASE_FRAME ? -0.55 : 0.34) : 0);
    }
  }
  const whole = Math.min(CAPTURE_FRAMES, Math.floor(frame));
  return spins[whole] + (spins[whole + 1] - spins[whole]) * (frame - whole);
}

/**
 * @param {number} elapsedMs Time since the wait began.
 * @returns The frame to paint. Always: `shot` ('court' | 'rim'), `beat`,
 *   `points` scored so far in this wait, `worth` of the shot. On the court:
 *   `capture` (see `sampleCapture`), `spin` of the ball and `trail`, how far
 *   it has come in the last moment, in capture px. At the rim: `ball`
 *   { x, y, spin } in rim radii, `sinceMake` in the shot's time units
 *   (negative before the ball goes through) and `pop` 0..1 for the points
 *   going up (-1 before).
 */
export function resolveHoopsPlay(elapsedMs) {
  const time = Math.max(0, elapsedMs);
  const round = Math.floor(time / POSSESSION_MS);
  const local = time - round * POSSESSION_MS;
  const made = local >= COURT_MS + MAKE_MS;
  const base = { points: (round + (made ? 1 : 0)) * SHOT_WORTH, worth: SHOT_WORTH };

  if (local < COURT_MS) {
    const frame = (local / 1000) * CAPTURE_FPS;
    const capture = sampleCapture(frame);
    const before = sampleCapture(Math.max(0, frame - 0.75)).ball;
    let beat = BEATS[0][1];
    for (const [from, name] of BEATS) if (frame >= from) beat = name;
    return {
      ...base, shot: 'court', beat, capture,
      spin: spinAt(frame), trail: [capture.ball.x - before.x, capture.ball.y - before.y],
    };
  }

  const at = ((local - COURT_MS) / RIM_MS) * RIM_PACE;
  const sinceMake = at - RIM_AT;
  return {
    ...base, shot: 'rim', beat: made ? 'swish' : 'drop',
    ball: { ...fall(at), spin: -at * 9 },
    sinceMake,
    pop: sinceMake < 0 ? -1 : Math.min(1, sinceMake / 0.62),
  };
}
