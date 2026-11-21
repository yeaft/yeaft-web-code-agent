/**
 * Framing for the basketball waiting animation: where a point of the play
 * lands on the stage's picture.
 *
 * On the court the capture carries its own framing: it follows the camera
 * that filmed the play from side to side, and holds all of every player and
 * the ball between the stage's soft top and bottom edges. Under the rim the
 * camera does not move.
 */

/** Under the rim: the rim's radius as a fraction of the picture's height, and where its centre sits. */
const RIM_SCALE = 0.17;
const RIM_CENTRE = [0.4, 0.4];

/**
 * @param play Frame from `resolveHoopsPlay`.
 * @param {{ x: number, y: number, width: number, height: number }} core The stage's composed picture, CSS px.
 * @returns {{ shot: string, k: number, x: (x: number) => number, y: (y: number) => number,
 *   worldX: (px: number) => number }} `x`/`y` map the shot's space to CSS px, `k` is px per unit, and
 *   `worldX` goes back from a CSS px x.
 */
export function resolveHoopsCamera(play, core) {
  if (play.shot === 'rim') {
    const k = core.height * RIM_SCALE;
    const cx = core.x + core.width * RIM_CENTRE[0];
    const cy = core.y + core.height * RIM_CENTRE[1];
    return { shot: 'rim', k, x: x => cx + x * k, y: y => cy + y * k, worldX: px => (px - cx) / k };
  }
  const { view } = play.capture;
  const k = core.height / view.height;
  const cx = core.x + core.width / 2;
  const cy = core.y + core.height / 2;
  return {
    shot: 'court', k,
    x: x => cx + (x - view.x) * k,
    y: y => cy + (y - view.y) * k,
    worldX: px => view.x + (px - cx) / k,
  };
}
