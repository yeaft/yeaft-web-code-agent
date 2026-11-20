/**
 * Basketball waiting animation: a stick figure crosses his defender over,
 * steps back behind the three-point line, shoots and turns away before it
 * drops. One possession after another for as long as the wait lasts.
 *
 * This file is the animation; `hoops/` holds its parts (choreography,
 * camera, court and renderer), `stick/` the stick-figure kit it shares with
 * other scenes, and `styles/waiting/hoops.css` its colours.
 */
import { resolveHoopsCamera } from './hoops/camera.js';
import { drawHoopsFrame } from './hoops/draw.js';
import { HOOPS_POSTER_MS, resolveHoopsPlay } from './hoops/play.js';
import { createStageAnimation } from './stage.js';

export const scene = {
  name: 'HoopsWaiting',
  className: 'hoops-scene',
  posterMs: HOOPS_POSTER_MS,
  tokens: {
    ink: '--hoops-ink', soft: '--hoops-soft', surface: '--hoops-surface',
    line: '--hoops-line', arc: '--hoops-arc', rig: '--hoops-rig', net: '--hoops-net', rim: '--hoops-rim',
    ball: '--hoops-ball', seam: '--hoops-seam', dust: '--hoops-dust', shade: '--hoops-shade', text: '--hoops-text',
  },
  paint(ctx, { elapsedMs, width, height, colors, core, backdrop }) {
    const play = resolveHoopsPlay(elapsedMs);
    const camera = resolveHoopsCamera(play, width, height);
    drawHoopsFrame(ctx, { play, camera, width, height, colors, core, backdrop });
    return { beat: play.beat, shot: camera.shot };
  },
};

export default { id: 'hoops', layout: 'stage', component: createStageAnimation(scene) };
