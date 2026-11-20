/**
 * Dragon Ball waiting animation: Goku and Vegeta, as stick figures, fight it
 * out under the transcript. They trade blows, Vegeta is kicked into the sky
 * and fires his energy wave, Goku answers with the Spirit Bomb, the two grind
 * against each other, and the bomb wins. One round after another for as long
 * as the wait lasts.
 *
 * This file is the animation; `dragon/` holds its parts (choreography,
 * camera, hair, effects and renderer), `stick/` the stick-figure kit it
 * shares with other scenes, and `styles/waiting/dragon.css` its colours.
 */
import { resolveDragonCamera } from './dragon/camera.js';
import { drawDragonFrame } from './dragon/draw.js';
import { DRAGON_POSTER_MS, resolveDragonPlay } from './dragon/play.js';
import { createStageAnimation } from './stage.js';

export const scene = {
  name: 'DragonWaiting',
  className: 'dragon-scene',
  posterMs: DRAGON_POSTER_MS,
  // With motion reduced: stand-off, fists meet, kick, the challenger charges,
  // the wave lands, the energy sphere, wave against sphere, blast, the
  // winner stands.
  stills: [500, 1500, 3250, 5000, 6000, 8250, 10250, 12000, 14250],
  tokens: {
    ink: '--dragon-ink', soft: '--dragon-soft', surface: '--dragon-surface', gi: '--dragon-gi', armor: '--dragon-armor',
    ground: '--dragon-ground', shade: '--dragon-shade', dust: '--dragon-dust', flash: '--dragon-flash', spark: '--dragon-spark',
    beam: '--dragon-beam', beamCore: '--dragon-beam-core', bomb: '--dragon-bomb', bombCore: '--dragon-bomb-core',
  },
  paint(ctx, { elapsedMs, width, height, colors, core, backdrop }) {
    const play = resolveDragonPlay(elapsedMs);
    const camera = resolveDragonCamera(play, width, height);
    drawDragonFrame(ctx, { play, camera, width, height, colors, core, backdrop });
    return { beat: play.beat, shot: camera.shot };
  },
};

export default { id: 'dragon', layout: 'stage', component: createStageAnimation(scene) };
