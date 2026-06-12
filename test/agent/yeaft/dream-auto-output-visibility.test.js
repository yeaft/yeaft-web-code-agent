import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const outbound = [];

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: (msg) => { outbound.push(msg); },
  flushMessageBuffer: () => {},
}));

import { installYeaftRuntimeBridge, __testSetSession } from '../../../agent/yeaft/web-bridge.js';
import { writeMemory, writeSummary } from '../../../agent/yeaft/memory/store.js';
import { writeSessionState } from '../../../agent/yeaft/dream/state.js';

function makeSession(yeaftDir) {
  return {
    yeaftDir,
    config: {},
    status: { skills: [], mcpServers: [], tools: [] },
    engine: null,
    trace: { event() {} },
    dreamScheduler: {},
  };
}

describe('auto dream output visibility', () => {
  beforeEach(() => {
    outbound.length = 0;
    __testSetSession(null);
  });

  it('emits a terminal yeaft_dream_result and loadable snapshot for auto dream output', async () => {
    const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-dream-visible-'));
    const session = makeSession(yeaftDir);
    const root = join(yeaftDir, 'memory');
    await writeMemory({ kind: 'session', id: 'g1' }, 'memory body for g1', { root });
    await writeSummary({ kind: 'session', id: 'g1' }, 'summary body for g1', { root });
    await writeSessionState(root, 'g1', {
      lastDreamMessageId: 'm-9',
      lastDreamAt: '2026-06-12T01:02:03.000Z',
      messageCount: 9,
    });

    __testSetSession(session);
    installYeaftRuntimeBridge(session);

    await session._dreamResultSink({
      trigger: 'auto',
      sessions: [{ sessionId: 'g1', status: 'triaged', new: 3 }],
      targets: [{ target: 'sessions/g1', status: 'done' }],
      startedAt: '2026-06-12T01:00:00.000Z',
    });

    const terminal = outbound.find(m => m.type === 'yeaft_dream_result' && m.sessionId === 'g1');
    expect(terminal).toBeTruthy();
    expect(terminal.success).toBe(true);
    expect(terminal.snapshot.summaryText).toBe('summary body for g1');
    expect(terminal.snapshot.memoryText).toBe('memory body for g1');
    expect(terminal.snapshot.lastDreamAt).toBe('2026-06-12T01:02:03.000Z');

    const snapshotEvents = outbound.filter(m => m.type === 'yeaft_output'
      && m.sessionId === 'g1'
      && m.event?.type === 'yeaft_dream_snapshot');
    expect(snapshotEvents).toHaveLength(0);
  });

  it('does not duplicate manual dream terminal events through the auto sink', async () => {
    const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-dream-visible-'));
    const session = makeSession(yeaftDir);
    __testSetSession(session);
    installYeaftRuntimeBridge(session);

    await session._dreamResultSink({
      trigger: 'manual',
      groups: [{ sessionId: 'g1', status: 'processed' }],
      targets: [{ target: 'sessions/g1', status: 'done' }],
    });

    expect(outbound.filter(m => m.type === 'yeaft_dream_result')).toHaveLength(0);
  });
});
