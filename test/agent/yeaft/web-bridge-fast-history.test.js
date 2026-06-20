import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sent = [];
let resolveLoadSession;
const loadSession = vi.fn(() => new Promise((resolve) => { resolveLoadSession = resolve; }));

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn((msg) => { sent.push(msg); }),
}));

vi.mock('../../../agent/yeaft/session.js', () => ({
  loadSession,
}));

vi.mock('../../../agent/yeaft/status-cache.js', () => ({
  hydrateYeaftStatusFromSession: vi.fn(),
}));

const ctx = (await import('../../../agent/context.js')).default;
const { ConversationStore } = await import('../../../agent/yeaft/conversation/persist.js');
const { handleYeaftLoadHistory, __testSetSession, __testHooks } = await import('../../../agent/yeaft/web-bridge.js');

function flushMicrotasks() {
  return new Promise(resolve => setImmediate(resolve));
}

describe('Yeaft load-history first paint', () => {
  afterEach(() => {
    __testSetSession(null);
    sent.length = 0;
    loadSession.mockClear();
    resolveLoadSession = null;
    ctx.CONFIG = null;
  });

  it('filters legacy internal-control rows in the visible-history fallback path', () => {
    const rows = [
      { id: 'm0001', role: 'user', content: 'visible q', sessionId: 'session-fast', threadId: 'main' },
      { id: 'm0002', role: 'user', content: '<task-result id="task_1" kind="shell" status="succeeded">\nPASS\n</task-result>', sessionId: 'session-fast', threadId: 'main' },
      { id: 'm0003', role: 'user', content: '[system note] You have called ListAgents with the same arguments 3 times. Previous result: {...}', sessionId: 'session-fast', threadId: 'main' },
      { id: 'm0004', role: 'assistant', content: 'visible a', sessionId: 'session-fast', threadId: 'main', speakerVpId: 'vp-linus' },
      { id: 'm0005', role: 'user', content: 'In docs, <task-result> is just prose', sessionId: 'session-fast', threadId: 'main' },
    ];
    const page = __testHooks.loadVisibleGroupHistoryPage({
      loadOlderBySession() {
        return { messages: rows };
      },
    }, 'session-fast', 10);

    expect(page.messages.map(m => m.content)).toEqual([
      'visible q',
      'visible a',
      'In docs, <task-result> is just prose',
    ]);
  });

  it('replays the recent message window before full session boot resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-fast-history-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      store.appendBatch([
        { role: 'user', content: 'old q', sessionId: 'session-fast' },
        { role: 'assistant', content: 'old a', sessionId: 'session-fast', speakerVpId: 'vp-linus' },
        { role: 'user', content: 'new q', sessionId: 'session-fast' },
        { role: 'assistant', content: 'new a', sessionId: 'session-fast', speakerVpId: 'vp-linus' },
      ]);

      const pending = handleYeaftLoadHistory({ sessionId: 'session-fast', limit: 1 });
      await flushMicrotasks();

      expect(loadSession).toHaveBeenCalledTimes(1);
      const historyDone = sent.find(m => m.event?.type === 'history_loaded');
      expect(historyDone).toMatchObject({
        type: 'yeaft_output',
        event: {
          type: 'history_loaded',
          mode: 'recent',
          count: 2,
          sessionId: 'session-fast',
          hasMore: true,
        },
      });
      const texts = sent
        .filter(m => m.type === 'yeaft_output' && m.data)
        .map(m => m.data?.message?.content?.[0]?.text || m.data?.message?.content)
        .filter(Boolean);
      expect(texts).toEqual(['new q', 'new a']);

      resolveLoadSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await pending;

      const historyLoadedEvents = sent.filter(m => m.event?.type === 'history_loaded');
      expect(historyLoadedEvents).toHaveLength(1);
      expect(sent.some(m => m.event?.type === 'session_ready' && !m.event.partial)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
