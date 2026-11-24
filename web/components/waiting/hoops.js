// Basketball waiting stage: four real motion-captured possessions rendered as crisp minimalist ink silhouettes.
import { resolveHoopsCamera } from './hoops/camera.js';
import { drawHoopsFrame } from './hoops/draw.js';
import { HOOPS_POSTER_MS, HOOPS_STILLS, resolveHoopsPlay } from './hoops/play.js';
import { createStageAnimation } from './stage.js';

export const scene = {
  name: 'HoopsWaiting',
  className: 'hoops-scene',
  posterMs: HOOPS_POSTER_MS,
  // With motion reduced, show the key moments without the moving camera.
  stills: HOOPS_STILLS,
  tokens: {
    ink: '--hoops-ink', soft: '--hoops-soft', surface: '--hoops-surface',
    line: '--hoops-line', arc: '--hoops-arc', rig: '--hoops-rig', net: '--hoops-net', rim: '--hoops-rim',
    ball: '--hoops-ball', seam: '--hoops-seam', glint: '--hoops-glint', shade: '--hoops-shade', text: '--hoops-text',
  },
  paint(ctx, { elapsedMs, width, height, colors, core, backdrop }) {
    const play = resolveHoopsPlay(elapsedMs);
    const camera = resolveHoopsCamera(play, core);
    drawHoopsFrame(ctx, { play, camera, width, height, colors, core, backdrop });
    return { beat: play.beat, shot: camera.shot, id: play.id };
  },
};

export default { id: 'hoops', layout: 'stage', component: createStageAnimation(scene) };
