import { describe, expect, it } from 'vitest';
import { scene } from '../../web/components/waiting/hoops.js';
import { resolveHoopsCamera } from '../../web/components/waiting/hoops/camera.js';
import {
  HOOPS_LOOP_MS,
  HOOPS_POSTER_MS,
  HOOPS_STILLS,
  resolveHoopsPlay,
} from '../../web/components/waiting/hoops/play.js';

describe('hoops motion-captured waiting animation', () => {
  it('exposes the minimalist ink/slate token palette without legacy jersey branding', () => {
    expect(scene.tokens).toMatchObject({
      ink: '--hoops-ink',
      soft: '--hoops-soft',
      surface: '--hoops-surface',
      ball: '--hoops-ball',
      rim: '--hoops-rim',
    });
    expect(scene.tokens.number).toBeUndefined();
    expect(scene.tokens.jersey).toBeUndefined();
  });

  it('cycles cleanly through pullup, floater, layup and replay with smooth tracks and makes', () => {
    const seenIds = new Set();
    const makes = new Set();
    let last = null;
    for (let ms = 0; ms < HOOPS_LOOP_MS; ms += 1000 / 60) {
      const play = resolveHoopsPlay(ms);
      seenIds.add(play.id);
      if (play.beat === 'swish') makes.add(play.id);
      if (play.shot === 'court') {
        const cam = resolveHoopsCamera(play, { x: 0, y: 0, width: 220, height: 100 });
        expect(Number.isFinite(cam.k) && cam.k > 0).toBe(true);
        for (const [role, p] of Object.entries(play.capture.players)) {
          expect(p.points).toHaveLength(19);
          expect(p.size).toBeGreaterThan(60);
          if (last && last.id === play.id && last.shot === 'court') {
            const prev = last.capture.players[role];
            for (let j = 0; j < 19; j += 1) {
              const step = Math.hypot(p.points[j][0] - prev.points[j][0], p.points[j][1] - prev.points[j][1]);
              expect(step).toBeLessThan(0.18 * p.size);
            }
          }
        }
      }
      last = play;
    }
    expect([...seenIds]).toEqual(['pullup', 'floater', 'layup', 'replay']);
    expect([...makes]).toEqual(['pullup', 'floater', 'layup', 'replay']);
    expect(resolveHoopsPlay(HOOPS_POSTER_MS)).toMatchObject({ shot: 'court', capture: { ball: { held: true } } });
    expect(HOOPS_STILLS.length).toBeGreaterThanOrEqual(8);
  });
});
