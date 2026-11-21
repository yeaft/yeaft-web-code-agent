/**
 * Basketball waiting animation: number 30 against his defender, one
 * possession after another for as long as the wait lasts, moving as players
 * do because the movement is motion capture. A pull-up three off the
 * crossover, a drive to a layup, a jumper off the dribble, a drive to the
 * rim — and the score going up.
 *
 * This file is the animation; `hoops/` holds its parts (choreography and its
 * capture, camera, court, players, ball and renderer), `stick/` the camera,
 * vectors and painter's sort it shares with other scenes, and
 * `styles/waiting/hoops.css` its colours.
 */
import { resolveHoopsCamera } from './hoops/camera.js';
import { drawHoopsFrame } from './hoops/draw.js';
import { HOOPS_POSTER_MS, HOOPS_STILLS, resolveHoopsPlay } from './hoops/play.js';
import { createStageAnimation } from './stage.js';

export const scene = {
  name: 'HoopsWaiting',
  className: 'hoops-scene',
  posterMs: HOOPS_POSTER_MS,
  // With motion reduced: the moments that tell each possession (the move, the
  // gather, the shot leaving his hand, the ball going in), one possession after another.
  stills: HOOPS_STILLS,
  tokens: {
    ink: '--hoops-ink', surface: '--hoops-surface',
    line: '--hoops-line', arc: '--hoops-arc', rig: '--hoops-rig', net: '--hoops-net', rim: '--hoops-rim',
    ball: '--hoops-ball', seam: '--hoops-seam', glint: '--hoops-glint', shade: '--hoops-shade', text: '--hoops-text',
    skin: '--hoops-skin', hair: '--hoops-hair', jersey: '--hoops-jersey', trim: '--hoops-trim', number: '--hoops-number',
    shoe: '--hoops-shoe', sole: '--hoops-sole',
    rival: '--hoops-rival', rivalSkin: '--hoops-rival-skin', sock: '--hoops-sock',
  },
  paint(ctx, { elapsedMs, width, height, colors, core, backdrop }) {
    const play = resolveHoopsPlay(elapsedMs);
    const camera = resolveHoopsCamera(play, width, height);
    drawHoopsFrame(ctx, { play, camera, width, height, colors, core, backdrop });
    return { beat: play.beat, shot: camera.shot };
  },
};

export default { id: 'hoops', layout: 'stage', component: createStageAnimation(scene) };
