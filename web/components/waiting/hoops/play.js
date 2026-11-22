/** Time-addressable playlist. Start with the short new plays so even brief
 * waits get a new move; keep the original possession as the fourth play. */
import { choreograph, HOOP, HOOP_RADIUS } from './choreography.js';
import floater from './floater.js';
import layup from './layup.js';
import pullup from './pullup.js';
import { CAPTURE_FPS, CAPTURE_FRAMES, RELEASE_FRAME, sampleCapture } from './tracks.js';

const COURT_MS = (CAPTURE_FRAMES / CAPTURE_FPS) * 1000;
const RIM_MS = 1500;
const RIM_PACE = 1.25;
const RIM_AT = 0.557;
const REPLAY_MAKE_MS = (RIM_AT / RIM_PACE) * RIM_MS;
const CUT_MAKE_MS = 380;

const REPLAY_BEATS = [[0, 'handle'], [68, 'hesitation'], [84, 'escape'], [118, 'gather'], [137, 'rise'], [RELEASE_FRAME, 'release']];
const asMs = frame => (frame / CAPTURE_FPS) * 1000;
let spins;
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

const replay = {
  id: 'replay', worth: 3, duration: COURT_MS, make: REPLAY_MAKE_MS,
  stills: [8, 40, 72, 92, 110, 126, 138, 146].map(asMs),
  beats: REPLAY_BEATS.map(([frame, name]) => [asMs(frame), name]),
  sample(ms) {
    const frame = (ms / 1000) * CAPTURE_FPS;
    const capture = sampleCapture(frame);
    const before = sampleCapture(Math.max(0, frame - 0.75)).ball;
    return { capture, spin: spinAt(frame), trail: [capture.ball.x - before.x, capture.ball.y - before.y] };
  },
};

let totalMs = 0;
let totalPoints = 0;
const playlist = [pullup, floater, layup].map(spec => ({ ...choreograph(spec), make: CUT_MAKE_MS })).concat(replay).map(play => {
  const entry = { ...play, start: totalMs, points: totalPoints };
  totalMs += play.duration + RIM_MS;
  totalPoints += play.worth;
  return entry;
});
export const HOOPS_LOOP_MS = totalMs;

/** A clean two-foot gather, ball in hand, held when the connection stalls. */
export const HOOPS_POSTER_MS = 2120;
/** The key frames, including a made basket for each play, under reduced motion. */
export const HOOPS_STILLS = playlist.flatMap(play => [
  ...play.stills,
  play.duration + play.make + 135,
].map(ms => ms + play.start));

function rimShot(play, local) {
  const ms = local - play.duration;
  const sinceMake = ((ms - play.make) / RIM_MS) * RIM_PACE;
  let ball;
  if (play.id === 'replay' && ms < play.make) {
    const at = sinceMake + RIM_AT;
    ball = { x: -2.6 + (2.6 / RIM_AT) * at, y: -4.4 + 4 * at + 7 * at * at, spin: -at * 9 };
  } else if (ms < play.make) {
    const impact = play.targets.at(-1)[0];
    const at = play.duration + (impact - play.duration) * (ms / play.make);
    const { x, y } = play.flight(at);
    ball = { x: (x - HOOP[0]) / HOOP_RADIUS, y: (y - HOOP[1]) / HOOP_RADIUS, spin: play.spinAt(at) };
  } else {
    ball = { x: 0.5 * sinceMake, y: 6.5 * sinceMake + 7 * sinceMake ** 2, spin: (play.id === 'replay' ? -RIM_AT * 9 : play.spinAt(play.targets.at(-1)[0])) - sinceMake * 9 };
  }
  return { shot: 'rim', beat: ms >= play.make ? 'swish' : 'drop', ball, sinceMake,
    pop: sinceMake < 0 ? -1 : Math.min(1, sinceMake / 0.62) };
}

/** Resolves the shot, score and pose using only time since the wait began. */
export function resolveHoopsPlay(elapsedMs) {
  const time = Math.max(0, elapsedMs);
  const loop = Math.floor(time / HOOPS_LOOP_MS);
  const at = time - loop * HOOPS_LOOP_MS;
  const play = playlist.findLast(entry => at >= entry.start);
  const local = at - play.start;
  const made = local >= play.duration + play.make;
  const base = { id: play.id, worth: play.worth, points: loop * totalPoints + play.points + (made ? play.worth : 0) };
  if (local >= play.duration) return { ...base, ...rimShot(play, local) };
  const beat = play.beats.findLast(([from]) => local >= from)[1];
  return { ...base, shot: 'court', beat, ...play.sample(local) };
}
