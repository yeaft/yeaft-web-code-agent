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
import { mix, mix3, smooth, span } from '../stick/vec.js';
import { RIM } from './play.js';

const AT_RIM = [0.3, RIM.y - 0.5, 0];

const VIEWS = {
  /** Travels with him, ahead and to one side. */
  intro(play) {
    const [x, , z] = play.hero.ground;
    return { eye: [x + 6.5, 5.0, z + 12.5 * play.side], target: [x + 1.6, 2.7, z], fov: 30 };
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
      eye: mix3(mix3([x - 2.8, 6.2, z + 12.6 * side], [x - 2.4, 5.4, z + 11.8 * side], push), [x - 2.6, 6.0, z + 14.8 * side], rise),
      target: mix3(mix3([x + 1.7, 2.7, z + 0.3 * side], [x + 1.9, 2.4, z + 0.5 * side], push), [x + 1.6, 3.9, z + 0.3 * side], rise),
      // Tight on the two of them while he works, so the handle fills a small stage.
      fov: mix(28, 34, rise),
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
    return { eye: [-9.5, 7.4, 19 * play.side], target: mix3([-4.4, 6.6, 0], AT_RIM, zoom), fov: mix(39.5, 14, zoom) };
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
      target: mix3([x + 14.9, 1.6 + 1.8 * smooth(span(t, marks.flight, marks.flight + 0.6)), z + 0.2], AT_RIM, zoom),
      fov: mix(36, 10, zoom),
    };
  },
  /** Backs away in front of him at walking pace, from the side his defender is not on. */
  walkoff(play) {
    const [x, , z] = play.hero.ground;
    return { eye: [x - 8.6, 5.0, z + 2.6 * play.side], target: [x, 4.85, z + 0.25 * play.side], fov: 30 };
  },
};

/** For each possession: [view, starts at, seconds to glide into it from the view before; 0 cuts]. */
// A jump shot stays on the sideline until the ball is gone: his feet, the dip and the release read best from there.
const jumpShot = m => [['intro', 0, 0], ['duel', m.sizeup - 0.35, 0.8], ['shot', m.flight - 0.08, 0.9], ['walkoff', m.celebrate, 0]];
const toTheRim = m => [['intro', 0, 0], ['duel', m.sizeup - 0.35, 0.8], ['drive', m.move + 0.2, 0.6], ['finish', m.gather - 0.1, 0.6], ['walkoff', m.celebrate, 0]];
const SEQUENCES = { stepback: jumpShot, longtwo: jumpShot, floater: toTheRim, layup: toTheRim };

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
  // The defender hitting the floor knocks the camera.
  if (play.shake > 0.01) {
    const jolt = 0.1 * play.shake * Math.sin(play.time * 74);
    shot = { eye: [shot.eye[0], shot.eye[1] + jolt, shot.eye[2] + 0.8 * jolt], target: [shot.target[0], shot.target[1] - 0.6 * jolt, shot.target[2]], fov: shot.fov };
  }
  const camera = makeCamera(shot, width, height);
  camera.shot = name;
  return camera;
}
