/**
 * Basketball waiting animation: number 30 working the ball through three
 * defenders and pulling up for a three, then the ball dropping through the
 * net — over and over for as long as the wait lasts, with the score going up.
 *
 * The players move as players do because the possession is traced, frame by
 * frame, from footage of one: every joint of all four, the ball and the
 * camera's own framing.
 *
 * This file is the animation; `hoops/` holds its parts (the capture and its
 * reader, the play's timeline, camera, setting, players, ball and renderer)
 * and `styles/waiting/hoops.css` its colours.
 */
import { resolveHoopsCamera } from './hoops/camera.js';
import { drawHoopsFrame } from './hoops/draw.js';
import { HOOPS_POSTER_MS, HOOPS_STILLS, resolveHoopsPlay } from './hoops/play.js';
import { createStageAnimation } from './stage.js';

export const scene = {
  name: 'HoopsWaiting',
  className: 'hoops-scene',
  posterMs: HOOPS_POSTER_MS,
  // With motion reduced: the moments that tell the possession (the handle, the
  // hesitation, the escape, the shot leaving his hand, the ball going in).
  stills: HOOPS_STILLS,
  tokens: {
    line: '--hoops-line', arc: '--hoops-arc', rig: '--hoops-rig', net: '--hoops-net', rim: '--hoops-rim',
    ball: '--hoops-ball', seam: '--hoops-seam', glint: '--hoops-glint', shade: '--hoops-shade', text: '--hoops-text',
    skin: '--hoops-skin', hair: '--hoops-hair', jersey: '--hoops-jersey', trim: '--hoops-trim', number: '--hoops-number',
    shoe: '--hoops-shoe', sole: '--hoops-sole',
    rival: '--hoops-rival', rivalSkin: '--hoops-rival-skin', sock: '--hoops-sock',
  },
  paint(ctx, { elapsedMs, width, height, colors, core, backdrop }) {
    const play = resolveHoopsPlay(elapsedMs);
    const camera = resolveHoopsCamera(play, core);
    drawHoopsFrame(ctx, { play, camera, width, height, colors, core, backdrop });
    return { beat: play.beat, shot: camera.shot };
  },
};

export default { id: 'hoops', layout: 'stage', component: createStageAnimation(scene) };
