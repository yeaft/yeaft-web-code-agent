/**
 * Basketball waiting animation: number 30 against his defender, one
 * possession after another for as long as the wait lasts. A crossover and a
 * behind-the-back dribble into a step-back three, a drive to a floater, a
 * hesitation into a long two, a drive to a layup — and the score going up.
 *
 * This file is the animation; `hoops/` holds its parts (choreography,
 * camera, court, players, ball and renderer), `stick/` the skeleton and
 * motion kit it shares with other scenes, and `styles/waiting/hoops.css` its
 * colours.
 */
import { resolveHoopsCamera } from './hoops/camera.js';
import { drawHoopsFrame } from './hoops/draw.js';
import { HOOPS_POSTER_MS, HOOPS_STILLS, resolveHoopsPlay } from './hoops/play.js';
import { createStageAnimation } from './stage.js';

export const scene = {
  name: 'HoopsWaiting',
  className: 'hoops-scene',
  posterMs: HOOPS_POSTER_MS,
  // With motion reduced: the moments that tell each possession (the move,
  // the shot leaving his hand, the ball going in), one possession after another.
  stills: HOOPS_STILLS,
  tokens: {
    ink: '--hoops-ink', surface: '--hoops-surface',
    line: '--hoops-line', arc: '--hoops-arc', rig: '--hoops-rig', net: '--hoops-net', rim: '--hoops-rim',
    ball: '--hoops-ball', seam: '--hoops-seam', glint: '--hoops-glint', dust: '--hoops-dust', shade: '--hoops-shade', text: '--hoops-text',
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
