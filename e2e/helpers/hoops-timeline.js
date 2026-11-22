import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

// Run the time-addressable scene separately from the wall clock in the existing
// waiting-stage scenario. Bundle here so the check also works with SERVE_DIST.
const scene = fileURLToPath(new URL('../../web/components/waiting/hoops/play.js', import.meta.url));

export async function expectHoopsTimeline() {
  const { outputFiles } = await build({ entryPoints: [scene], bundle: true, write: false, format: 'esm', platform: 'node' });
  const api = Buffer.from(outputFiles[0].contents).toString('base64');
  const { HOOPS_LOOP_MS, HOOPS_POSTER_MS, HOOPS_STILLS, resolveHoopsPlay } = await import('data:text/javascript;base64,' + api);
  const frameMs = 1000 / 60;
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const frames = Array.from({ length: Math.ceil(HOOPS_LOOP_MS / frameMs) }, (_, i) => resolveHoopsPlay(i * frameMs));
  expect([...new Set(frames.map(p => p.id))]).toEqual(['pullup', 'floater', 'layup', 'replay']);
  let last = frames[0];
  const makes = [];
  for (const frame of frames.slice(1)) {
    if (frame.points !== last.points) {
      expect(last.beat).toBe('drop');
      expect(frame.beat).toBe('swish');
      expect(frame.points - last.points).toBe(frame.worth);
      makes.push(frame.points);
    }
    last = frame;
  }
  expect(makes).toEqual([2, 4, 6, 9]);
  expect(resolveHoopsPlay(HOOPS_LOOP_MS)).toMatchObject({ id: 'pullup', shot: 'court', points: 9 });
  expect(resolveHoopsPlay(-100)).toEqual(frames[0]);

  last = undefined;
  for (const frame of frames) {
    const court = frame.shot === 'court' && frame.id !== 'replay';
    if (!court) { last = undefined; continue; }
    const { players, ball, view } = frame.capture;
    expect(Object.keys(players)).toContain('guard');
    const ballXY = [ball.x, ball.y];
    const radius = players.hero.size * 0.0617;
    // Account for the 8px/6px top/bottom fades on a nominal 219×100 stage.
    expect(Math.abs(ball.x - view.x) + radius).toBeLessThan(1.095 * view.height);
    expect(ball.y - radius).toBeGreaterThan(view.y - 0.42 * view.height);
    expect(ball.y + radius).toBeLessThan(view.y + 0.44 * view.height);
    for (const [name, player] of Object.entries(players)) {
      expect(player.points).toHaveLength(19);
      expect(player.points.every(point => point.every(Number.isFinite))).toBe(true);
      if (last?.id === frame.id) {
        const before = last.capture.players[name].points;
        expect(Math.max(...player.points.map((point, i) => distance(point, before[i])))).toBeLessThan(0.16 * player.size);
      }
    }
    if (last?.id === frame.id) expect(distance(ballXY, [last.capture.ball.x, last.capture.ball.y])).toBeLessThan(20);
    last = frame;
  }

  const opening = frames.filter(frame => frame.id === 'pullup');
  const release = opening.findIndex(frame => frame.beat === 'release');
  const cut = opening.findIndex(frame => frame.shot === 'rim');
  const make = opening.findIndex(frame => frame.beat === 'swish');
  expect(release * frameMs).toBeLessThan(2300);
  expect((make - release) * frameMs).toBeLessThan(1000);
  expect((make - cut) * frameMs).toBeLessThan(150);
  for (const id of ['pullup', 'floater', 'layup']) {
    const index = frames.findIndex(frame => frame.id === id && frame.shot === 'rim');
    const before = frames[index - 1];
    const inRim = frames[index];
    const { x, y } = before.capture.ball;
    expect(distance([x, y], [286 + 12 * inRim.ball.x, -155 + 12 * inRim.ball.y])).toBeLessThan(14);
    expect(Math.abs(before.spin - inRim.ball.spin)).toBeLessThan(0.25);
  }
  expect(resolveHoopsPlay(HOOPS_POSTER_MS)).toMatchObject({ shot: 'court', capture: { ball: { held: true } } });
  expect(HOOPS_STILLS.every((ms, i) => ms >= 0 && ms < HOOPS_LOOP_MS && (i === 0 || ms > HOOPS_STILLS[i - 1]))).toBe(true);
  const stills = HOOPS_STILLS.map(resolveHoopsPlay);
  for (const id of ['pullup', 'floater', 'layup', 'replay']) {
    expect(stills.some(p => p.id === id && p.shot === 'court')).toBe(true);
    expect(stills.some(p => p.id === id && p.beat === 'swish')).toBe(true);
  }
}
