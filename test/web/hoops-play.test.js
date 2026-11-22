import { describe, expect, it } from 'vitest';
import { HOOPS_LOOP_MS, HOOPS_POSTER_MS, HOOPS_STILLS, resolveHoopsPlay } from '../../web/components/waiting/hoops/play.js';

const frameMs = 1000 / 60;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function loopFrames() {
  return Array.from({ length: Math.ceil(HOOPS_LOOP_MS / frameMs) }, (_, i) => resolveHoopsPlay(i * frameMs));
}

describe('basketball waiting playlist', () => {
  it('plays three distinct twos and the original three, scoring only at each make', () => {
    const frames = loopFrames();
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
  });

  it('keeps new plays in frame with finite, continuous poses and ball positions', () => {
    let last;
    for (const frame of loopFrames()) {
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
  });

  it('has a held-ball poster and at least one key pose and make per reduced-motion play', () => {
    expect(resolveHoopsPlay(HOOPS_POSTER_MS)).toMatchObject({ shot: 'court', capture: { ball: { held: true } } });
    expect(HOOPS_STILLS.every((ms, i) => ms >= 0 && ms < HOOPS_LOOP_MS && (i === 0 || ms > HOOPS_STILLS[i - 1]))).toBe(true);
    const stills = HOOPS_STILLS.map(resolveHoopsPlay);
    for (const id of ['pullup', 'floater', 'layup', 'replay']) {
      expect(stills.some(p => p.id === id && p.shot === 'court')).toBe(true);
      expect(stills.some(p => p.id === id && p.beat === 'swish')).toBe(true);
    }
  });
});
