/**
 * Tests for dream pipeline debug events (Bug 2: dream debug not working).
 *
 * Bug: Dream pipeline never emitted turn_open / loop / turn_close events,
 * so the debug panel showed nothing for dream LLM API calls. Users saw
 * "running start" but no actual API call details.
 *
 * Fix: session-wiring.js now wraps the dream run with turn_open/turn_close
 * and the LLM callable with loop events, emitting through _dreamProgressSink.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRunDreamOpts, createV2DreamScheduler } from '../../../../agent/yeaft/dream/session-wiring.js';

let yeaftDir;
beforeEach(() => { yeaftDir = mkdtempSync(join(tmpdir(), 'dream-debug-')); });
afterEach(() => { rmSync(yeaftDir, { recursive: true, force: true }); });

function seedGroup(id, messages) {
  const dir = join(yeaftDir, 'sessions', id);
  mkdirSync(join(dir, 'messages'), { recursive: true });
  writeFileSync(join(dir, 'group.json'), JSON.stringify({
    id, name: id, roster: [], defaultVpId: null, createdAt: '2026-05-01T00:00:00Z',
  }));
  const logPath = join(dir, 'messages', '0001.jsonl');
  const lines = messages.map(m => JSON.stringify(m)).join('\n');
  writeFileSync(logPath, lines + (lines ? '\n' : ''));
}

describe('dream pipeline debug events', () => {
  it('_dreamProgressSink receives turn_open at dream start', async () => {
    const events = [];
    const session = {
      yeaftDir,
      adapter: {
        call: async () => ({ text: 'triage result', usage: { inputTokens: 10, outputTokens: 5 } }),
      },
      config: { fastModelId: 'test-model' },
      trace: { event: () => {} },
      _dreamProgressSink: (evt) => { events.push({ ...evt }); },
    };

    // Seed a group with messages so dream has something to process
    seedGroup('grp-a', [
      { id: '1', from: 'user', role: 'user', text: 'hello' },
      { id: '2', from: 'vp1', role: 'assistant', text: 'hi there' },
    ]);

    const sched = createV2DreamScheduler(session);

    // Trigger a manual dream run
    const result = await sched.triggerDreamNow();

    // Should have received at least turn_open and turn_close
    const turnOpens = events.filter(e => e.type === 'turn_open');
    const turnCloses = events.filter(e => e.type === 'turn_close');

    expect(turnOpens.length).toBeGreaterThanOrEqual(1);
    expect(turnOpens[0].type).toBe('turn_open');
    expect(turnOpens[0].turnId).toMatch(/^dream-/);
    expect(turnOpens[0].userPrompt).toContain('dream');
    expect(typeof turnOpens[0].at).toBe('number');

    expect(turnCloses.length).toBeGreaterThanOrEqual(1);
    expect(turnCloses[0].type).toBe('turn_close');
    expect(turnCloses[0].turnId).toBe(turnOpens[0].turnId);
    expect(typeof turnCloses[0].totalMs).toBe('number');
    expect(typeof turnCloses[0].loopCount).toBe('number');

    // Clean up
    sched.shutdown();
  });

  it('_dreamProgressSink receives loop events for each LLM call', async () => {
    const events = [];
    const session = {
      yeaftDir,
      adapter: {
        call: async () => ({ text: 'consolidation result', usage: { inputTokens: 20, outputTokens: 10 } }),
      },
      config: { fastModelId: 'test-model' },
      trace: { event: () => {} },
      _dreamProgressSink: (evt) => { events.push({ ...evt }); },
    };

    seedGroup('grp-b', [
      { id: '1', from: 'user', role: 'user', text: 'discussion about coding' },
      { id: '2', from: 'vp1', role: 'assistant', text: 'let me help with that' },
      { id: '3', from: 'user', role: 'user', text: 'thanks' },
      { id: '4', from: 'vp1', role: 'assistant', text: 'anytime' },
    ]);

    const sched = createV2DreamScheduler(session);
    await sched.triggerDreamNow();

    const loopEvents = events.filter(e => e.type === 'loop');
    // Dream should make at least one LLM call (triage or apply)
    expect(loopEvents.length).toBeGreaterThanOrEqual(1);

    // Verify loop event structure
    const firstLoop = loopEvents[0];
    expect(firstLoop.type).toBe('loop');
    expect(firstLoop.turnId).toMatch(/^dream-/);
    expect(typeof firstLoop.loopNumber).toBe('number');
    expect(firstLoop.loopNumber).toBeGreaterThanOrEqual(1);
    expect(firstLoop.model).toBe('test-model');
    expect(typeof firstLoop.systemPrompt).toBe('string');
    expect(firstLoop.systemPrompt.length).toBeGreaterThan(0);
    expect(Array.isArray(firstLoop.messages)).toBe(true);
    expect(typeof firstLoop.response).toBe('string');
    expect(firstLoop.usage).toBeDefined();
    expect(typeof firstLoop.latencyMs).toBe('number');

    sched.shutdown();
  });

  it('turn_open and turn_close have matching turnId', async () => {
    const events = [];
    const session = {
      yeaftDir,
      adapter: {
        call: async () => ({ text: 'ok', usage: { inputTokens: 5, outputTokens: 2 } }),
      },
      config: { fastModelId: 'test-model' },
      trace: { event: () => {} },
      _dreamProgressSink: (evt) => { events.push({ ...evt }); },
    };

    seedGroup('grp-c', [
      { id: '1', from: 'user', role: 'user', text: 'hello world' },
      { id: '2', from: 'vp1', role: 'assistant', text: 'hi' },
    ]);

    const sched = createV2DreamScheduler(session);
    await sched.triggerDreamNow();

    const openEvent = events.find(e => e.type === 'turn_open');
    const closeEvent = events.find(e => e.type === 'turn_close');
    const loopEvents = events.filter(e => e.type === 'loop');

    expect(openEvent).toBeDefined();
    expect(closeEvent).toBeDefined();
    expect(closeEvent.turnId).toBe(openEvent.turnId);

    // All loop events should reference the same turnId
    for (const loop of loopEvents) {
      expect(loop.turnId).toBe(openEvent.turnId);
    }

    sched.shutdown();
  });

  it('turn_close.loopCount matches number of loop events', async () => {
    const events = [];
    const session = {
      yeaftDir,
      adapter: {
        call: async () => ({ text: 'result', usage: { inputTokens: 5, outputTokens: 2 } }),
      },
      config: { fastModelId: 'test-model' },
      trace: { event: () => {} },
      _dreamProgressSink: (evt) => { events.push({ ...evt }); },
    };

    seedGroup('grp-d', [
      { id: '1', from: 'user', role: 'user', text: 'test message' },
      { id: '2', from: 'vp1', role: 'assistant', text: 'response' },
    ]);

    const sched = createV2DreamScheduler(session);
    await sched.triggerDreamNow();

    const closeEvent = events.find(e => e.type === 'turn_close');
    const loopEvents = events.filter(e => e.type === 'loop');

    expect(closeEvent).toBeDefined();
    expect(closeEvent.loopCount).toBe(loopEvents.length);

    sched.shutdown();
  });
});
