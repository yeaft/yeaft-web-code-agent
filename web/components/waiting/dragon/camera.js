/**
 * Camera direction for the Dragon Ball waiting animation. The camera watches
 * the fight side-on and never cuts inside a round: it rides in with the
 * clash, opens out as Vegeta is kicked into the sky, pushes in under him
 * while he charges, pulls back from Goku as the bomb outgrows him, and comes
 * down to the floor for what is left. Pure: (fight frame, picture size) →
 * camera, in fight space.
 */
import { makeCamera, mixShots } from '../stick/camera.js';
import { mix, smooth, span } from '../stick/vec.js';

const FOV = 26;
const HALF = Math.tan((FOV * Math.PI) / 360);

/**
 * A shot that shows `tall` feet of the fight plane top to bottom, centred on
 * `centre`, from `turn` radians round to the right and `rise` radians above.
 */
function frame(centre, tall, turn, rise) {
  const far = tall / 2 / HALF;
  const level = Math.cos(rise) * far;
  return { eye: [centre[0] + Math.sin(turn) * level, centre[1] + Math.sin(rise) * far, centre[2] + Math.cos(turn) * level], target: centre, fov: FOV };
}

/** Linear path through [time, value] pairs, eased between them. */
function along(pairs, t) {
  if (t <= pairs[0][0]) return pairs[0][1];
  for (let i = 1; i < pairs.length; i += 1) {
    if (t < pairs[i][0]) return mix(pairs[i - 1][1], pairs[i][1], smooth(span(t, pairs[i - 1][0], pairs[i][0])));
  }
  return pairs[pairs.length - 1][1];
}

/** The whole battlefield: Goku on the floor, Vegeta in the sky, room for the bomb. */
const FIELD = [-0.6, 6.4, 0];

const VIEWS = {
  /** The two of them, squared off. */
  duel() {
    return frame([-0.1, 4.3, 0], 9.6, -0.14, 0.03);
  },
  /** In close, sliding with the exchange. */
  clash(play) {
    const x = along([[1.0, -0.1], [2.1, 0.2], [2.5, -2.3], [2.9, -1.9]], play.time);
    return frame([x, 3.75, 0], 8.5, mix(-0.14, 0.1, smooth(span(play.time, 1.0, 2.8))), 0.03);
  },
  field(play) {
    return frame(FIELD, 14.3, mix(0.1, 0.04, smooth(span(play.time, 2.8, 5.9))), 0.02);
  },
  /** Under Vegeta and ahead of him, looking up: the charge. */
  vegeta(play) {
    const [x, y] = play.vegeta.pelvis;
    const push = smooth(span(play.time, 3.7, 5.1));
    return frame([x + 1.2, y + 0.25, 0], mix(10.6, 9.8, push), 0.42, -0.16);
  },
  /** On Goku as he raises his arms, backing off as the bomb grows. */
  gather(play) {
    const grow = smooth(span(play.time, 6.6, 8.0));
    return frame([mix(7.8, 3.2, grow), mix(4.8, FIELD[1], grow), 0], mix(11, 14.3, grow), mix(-0.2, -0.06, grow), mix(-0.03, 0.02, grow));
  },
  /** Wave against bomb, drifting round as it grinds on. */
  struggle(play) {
    const drift = span(play.time, 8.3, 10.8);
    return frame([FIELD[0] + 0.5 * drift, FIELD[1], 0], 14.3 - 0.5 * drift, mix(-0.06, 0.12, drift), 0.02);
  },
  /** Follows the bomb home. */
  blast() {
    return frame([-4.6, 7.0, 0], 15.4, 0.1, 0.02);
  },
  /** Down on the floor with the two of them. */
  after(play) {
    const settle = smooth(span(play.time, 12.2, 14.4));
    return frame([-5.5, 3.6, 0], mix(8.9, 8.5, settle), mix(0.16, 0.24, settle), 0.05);
  },
};

/** [view, starts at, seconds to glide into it from the view before; 0 cuts]. */
const SEQUENCE = [
  ['duel', 0, 0], ['clash', 0.9, 0.5], ['field', 2.82, 0.7], ['vegeta', 3.6, 0.85], ['field', 5.14, 0.42],
  ['gather', 5.95, 0.85], ['struggle', 8.2, 0.6], ['blast', 10.82, 0.7], ['after', 12.1, 0.95],
];

/**
 * @param play Frame from `resolveDragonPlay`.
 * @param {number} width Picture width in CSS px.
 * @param {number} height Picture height in CSS px.
 * @returns Camera from `makeCamera`, with the `shot` name added.
 */
export function resolveDragonCamera(play, width, height) {
  let index = 0;
  for (let i = 1; i < SEQUENCE.length; i += 1) if (play.time >= SEQUENCE[i][1]) index = i;
  const [name, from, glide] = SEQUENCE[index];
  let shot = VIEWS[name](play);
  if (glide > 0 && play.time < from + glide) {
    shot = mixShots(VIEWS[SEQUENCE[index - 1][0]](play), shot, smooth((play.time - from) / glide));
  }
  const camera = makeCamera(shot, width, height);
  camera.shot = name;
  return camera;
}
