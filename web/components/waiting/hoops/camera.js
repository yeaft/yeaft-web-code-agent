/**
 * Camera direction for the basketball waiting animation. The camera stays
 * close to the players and glides from one view to the next: travelling with
 * him as he brings the ball up, round behind his shoulder for the crossover,
 * behind him for the three, then a push in on the rim as the ball comes
 * down. The one cut is to his face-on walk-off. Pure: (play frame, picture
 * size) → camera, in play space.
 */
import { makeCamera, mixShots } from '../stick/camera.js';
import { mix, mix3, smooth, span } from '../stick/vec.js';
import { HOOPS_BEATS as B, RIM } from './play.js';

const VIEWS = {
  /** Travels with him, ahead and to his right. */
  intro(play) {
    const [x, , z] = play.hero.ground;
    return { eye: [x + 6.5, 5.0, z + 12.5], target: [x + 1.6, 2.7, z], fov: 30 };
  },
  /**
   * Behind his right shoulder and well to the side: he stays in front of his
   * defender, and the camera is high enough to read which way each of them
   * goes. Drops as the defender falls.
   */
  duel(play) {
    const push = smooth(span(play.time, B.jab, B.gather));
    return { eye: mix3([-31, 6.4, 11.5], [-30.4, 5.6, 10.8], push), target: mix3([-23.2, 2.7, 0.5], [-22.6, 2.0, 1.2], push), fov: 34 };
  },
  /**
   * Behind the shooter, low enough to show his feet behind the line. Once he
   * has turned away it pushes in on the rim to meet the ball.
   */
  shot(play) {
    const t = play.time;
    const drift = smooth(span(t, B.gather, B.flight + 0.8));
    const zoom = smooth(span(t, B.flight + 0.72, B.flight + 1.2));
    return {
      eye: mix3([-41.5, 9.0, 2.6], [-40.7, 8.8, 2.3], drift),
      target: mix3([-12, 1.6 + 1.8 * smooth(span(t, B.flight, B.flight + 0.6)), -2.2], [0.3, RIM.y - 0.5, 0], zoom),
      fov: mix(36, 10, zoom),
    };
  },
  /** Backs away in front of him at walking pace. */
  walkoff(play) {
    const [x, , z] = play.hero.ground;
    return { eye: [x - 8.6, 5.0, z + 2.6], target: [x, 4.85, z + 0.25], fov: 30 };
  },
};

/** [view, starts at, seconds to glide into it from the view before; 0 cuts]. */
const SEQUENCE = [
  ['intro', B.bringup, 0], ['duel', B.sizeup - 0.35, 0.8], ['shot', B.gather - 0.15, 0.7], ['walkoff', B.swish + 0.5, 0],
];

/**
 * @param play Frame from `resolveHoopsPlay`.
 * @param {number} width Picture width in CSS px.
 * @param {number} height Picture height in CSS px.
 * @returns Camera from `makeCamera`, with the `shot` name added.
 */
export function resolveHoopsCamera(play, width, height) {
  let index = 0;
  for (let i = 1; i < SEQUENCE.length; i += 1) if (play.time >= SEQUENCE[i][1]) index = i;
  const [name, from, glide] = SEQUENCE[index];
  let shot = VIEWS[name](play);
  if (glide > 0 && play.time < from + glide) {
    shot = mixShots(VIEWS[SEQUENCE[index - 1][0]](play), shot, smooth((play.time - from) / glide));
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
