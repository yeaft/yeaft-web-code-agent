/**
 * Camera direction for the basketball waiting animation. The camera stays
 * close to the players and glides from one view to the next: travelling with
 * him as he brings the ball up, then out to the sideline for his move, the
 * hoop to the right as a broadcast has it. A jump shot leaves his hand in
 * that view, then is followed from behind the shooter; a drive is followed
 * down the lane. Either way it pushes in on the rim as the ball comes down.
 * The one cut is to his face-on walk-off.
 * Pure: (play frame, picture size) → camera, in play space.
 */
import { makeCamera, mixShots } from '../stick/camera.js';
import { add, mix, mix3, mul, smooth, span, unit } from '../stick/vec.js';
import { RIM } from './play.js';

const AT_RIM = [0.3, RIM.y - 0.5, 0];
/** How far toward the picture's edge the ball may get before the camera turns after it. */
const SAFE = 0.62;
/** How much of that again the turn takes to come up to speed, so it eases in instead of snapping on. */
const EASE = 0.12;

/**
 * Turn a shot about its eye just far enough to keep `point` in the picture:
 * up, and to either side. Nothing changes while the point is well inside,
 * and the turn eases in as it nears the edge.
 */
function keepInPicture(shot, point, width, height) {
  const camera = makeCamera(shot, width, height);
  const [across, above, depth] = camera.view(point);
  if (depth < 0.5) return shot;
  const half = Math.tan((shot.fov * Math.PI) / 360);
  const past = (tangent, limit) => {
    const edge = Math.atan(limit);
    const over = Math.atan(Math.abs(tangent)) - edge;
    return over <= 0 ? 0 : Math.sign(tangent) * over * over / (over + EASE * edge);
  };
  const tilt = Math.max(0, past(above / depth, SAFE * half));
  const pan = past(across / depth, SAFE * half * width / height);
  if (!tilt && !pan) return shot;
  const { forward, right, up } = camera;
  const aim = unit(add(add(mul(forward, Math.cos(tilt) * Math.cos(pan)), mul(up, Math.sin(tilt))), mul(right, Math.sin(pan) * Math.cos(tilt))));
  const far = Math.hypot(shot.target[0] - shot.eye[0], shot.target[1] - shot.eye[1], shot.target[2] - shot.eye[2]);
  return { eye: shot.eye, target: add(shot.eye, mul(aim, far)), fov: shot.fov };
}

/**
 * Where to look while a shot is in the air, having looked at `from` before
 * it: up after the ball, part of the way from the rim to it, so the arc stays
 * in the picture, and in on the rim (`zoom`) as the ball comes down to it.
 */
function alongArc(play, from, zoom, toward) {
  const { marks, time: t } = play;
  if (!play.ball.loose || t >= marks.swish) return mix3(from, AT_RIM, zoom);
  const up = smooth(span(t, marks.flight, marks.flight + 0.4));
  return mix3(mix3(from, mix3(AT_RIM, play.ball.at, toward), up), AT_RIM, zoom);
}

const VIEWS = {
  /** Travels with him from the sideline, his defender waiting ahead of him toward the hoop. */
  intro(play) {
    const [x, , z] = play.hero.ground;
    return { eye: [x - 1.2, 5.4, z + 15.5 * play.side], target: [x + 2.2, 3.0, z], fov: 31 };
  },
  /**
   * From the sideline, a little behind him: he stays in front of his
   * defender, and the camera is high enough to read which way each of them
   * goes. Drops and closes in as the move develops.
   */
  duel(play) {
    const { marks, side, spot, time: t } = play;
    // Pans with him when his move takes him off his spot, and all the way once he sets his feet.
    const x = mix(spot[0], play.hero.ground[0], mix(0.7, 1, smooth(span(t, marks.gather - 0.5, marks.gather))));
    const z = spot[1];
    const push = smooth(span(t, marks.move, marks.gather));
    // Back and up as he rises to shoot, or before his man leaves the floor: the
    // ball leaves his hand inside the picture, and nobody's head leaves it.
    const rise = Math.max(smooth(span(t, marks.gather - 0.15, marks.gather + 0.3)), play.room);
    return {
      eye: mix3(mix3([x - 2.8, 6.0, z + 15.5 * side], [x - 2.4, 5.4, z + 14.5 * side], push), [x - 2.6, 6.0, z + 16.5 * side], rise),
      target: mix3(mix3([x + 1.8, 2.95, z + 0.3 * side], [x + 1.9, 2.85, z + 0.5 * side], push), [x + 1.6, 3.9, z + 0.3 * side], rise),
      // Close on the two of them while he works, heads to shoes in the picture.
      fov: mix(mix(31, 30, push), 36, rise),
    };
  },
  /** Runs down the sideline with the drive, looking ahead of him until the hoop comes into the picture. */
  drive(play) {
    const ahead = Math.min(play.hero.ground[0] + 4, -4.5);
    return { eye: [ahead - 4.5, 6.4, 19 * play.side], target: [ahead, 4.6, 0], fov: 33 };
  },
  /** Wide enough for the finish and the ball's arc, then in on the rim. */
  finish(play) {
    const zoom = smooth(span(play.time, play.marks.swish - 0.5, play.marks.swish - 0.08));
    return { eye: [-9.5, 7.4, 19 * play.side], target: alongArc(play, [-4.4, 6.6, 0], zoom, 0.5), fov: mix(39.5, 14, zoom) };
  },
  /**
   * Behind the shooter, low enough to show his feet. Once the ball is on its
   * way down it pushes in on the rim to meet it.
   */
  shot(play) {
    const { marks, time: t, stand: [x, z] } = play;
    const drift = smooth(span(t, marks.gather, marks.flight + 0.8));
    const zoom = smooth(span(t, marks.swish - 0.63, marks.swish - 0.15));
    return {
      eye: mix3([x - 14.6, 9.0, z + 5.0], [x - 13.8, 8.8, z + 4.7], drift),
      target: alongArc(play, [x + 14.9, 1.6 + 1.8 * smooth(span(t, marks.flight, marks.flight + 0.6)), z + 0.2], zoom, 0.5),
      fov: mix(36, 10, zoom),
    };
  },
  /** Backs away in front of him at walking pace, from the side his defender is not on, the two of them head to toe. */
  walkoff(play) {
    const [x, , z] = mix3(play.hero.ground, play.defender.ground, 0.4);
    return { eye: [x - 17, 5.2, z + 3.6 * play.side], target: [x, 3.1, z], fov: 31 };
  },
};

/** For each possession: [view, starts at, seconds to glide into it from the view before; 0 cuts]. */
// A jump shot stays on the sideline until the ball is gone: his feet, the dip and the release read best from there.
const jumpShot = m => [['intro', 0, 0], ['duel', m.sizeup - 0.35, 0.8], ['shot', m.flight - 0.08, 0.9], ['walkoff', m.celebrate, 0]];
const toTheRim = m => [['intro', 0, 0], ['duel', m.sizeup - 0.35, 0.8], ['drive', m.move + 0.2, 0.6], ['finish', m.gather - 0.1, 0.6], ['walkoff', m.celebrate, 0]];
const SEQUENCES = { pullup: jumpShot, jumper: jumpShot, layup: toTheRim, drive: toTheRim };

/**
 * @param play Frame from `resolveHoopsPlay`.
 * @param {number} width Picture width in CSS px.
 * @param {number} height Picture height in CSS px.
 * @returns Camera from `makeCamera`, with the `shot` name added.
 */
export function resolveHoopsCamera(play, width, height) {
  const sequence = SEQUENCES[play.name](play.marks);
  let index = 0;
  for (let i = 1; i < sequence.length; i += 1) if (play.time >= sequence[i][1]) index = i;
  const [name, from, glide] = sequence[index];
  let shot = VIEWS[name](play);
  if (glide > 0 && play.time < from + glide) {
    shot = mixShots(VIEWS[sequence[index - 1][0]](play), shot, smooth((play.time - from) / glide));
  }
  // From the pickup until it is through the net the ball stays in the
  // picture: the camera looks up after a shot that would otherwise leave it.
  if (play.time >= play.marks.gather && play.time < play.marks.swish) shot = keepInPicture(shot, play.ball.at, width, height);
  const camera = makeCamera(shot, width, height);
  camera.shot = name;
  return camera;
}
