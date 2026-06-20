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
        { role: 'assistant', content: '', sessionId: 'session-fast', speakerVpId: 'vp-linus', toolCalls: [{ id: 'tool-1', name: 'Bash', input: { command: 'echo ok' } }] },
      ]);

      const pending = handleYeaftLoadHistory({ sessionId: 'session-fast', limit: 1 });
      await flushMicrotasks();

      expect(loadSession).toHaveBeenCalledTimes(1);
      const chunk = sent.find(m => m.type === 'yeaft_history_chunk');
      expect(chunk).toMatchObject({
        type: 'yeaft_history_chunk',
        sessionId: 'session-fast',
        mode: 'recent',
        hasMore: true,
        messages: [
          { role: 'user', content: 'new q', sessionId: 'session-fast' },
          { role: 'assistant', content: '', sessionId: 'session-fast', speakerVpId: 'vp-linus', toolSummaryCount: 1 },
        ],
      });
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
      expect(sent.filter(m => m.type === 'yeaft_output' && m.data)).toHaveLength(0);

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

  it('persists inbound user rows with the coordinator receive timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-inbound-ts-'));
    try {
      const store = new ConversationStore(dir);
      __testSetSession({ conversationStore: store });

      const wrote = __testHooks.persistInboundMessageOnceByMsgId({
        msgId: 'g_msg_1',
        text: 'hello at the real send time',
        sessionId: 'session-fast',
        threadId: 'main',
        role: 'user',
        ts: '2026-06-20T01:02:03.456Z',
      });

      expect(wrote).toBe(true);
      const rows = store.loadAllBySession('session-fast');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        role: 'user',
        content: 'hello at the real send time',
        time: '2026-06-20T01:02:03.456Z',
      });
    } finally {
      __testSetSession(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cold-start delta replay preserves timestamps, attachments, and tool summaries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-delta-cold-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      const anchor = store.append({
        role: 'user',
        content: 'already seen',
        sessionId: 'session-fast',
        time: '2026-06-20T01:00:00.000Z',
      });
      store.append({
        role: 'user',
        content: 'with file',
        sessionId: 'session-fast',
        time: '2026-06-20T01:00:01.000Z',
        attachments: [{ fileId: 'file_1', name: 'note.txt', isImage: false }],
      });
      store.append({
        role: 'assistant',
        content: 'I will use a tool',
        sessionId: 'session-fast',
        threadId: 'main',
        speakerVpId: 'vp-linus',
        time: '2026-06-20T01:00:02.000Z',
        toolCalls: [{ id: 'toolu_1', name: 'Bash', input: { command: 'echo ok' } }],
      });
      store.append({
        role: 'tool',
        content: 'ok',
        sessionId: 'session-fast',
        threadId: 'main',
        toolCallId: 'toolu_1',
        time: '2026-06-20T01:00:03.000Z',
      });

      const pending = handleYeaftLoadHistory({ sessionId: 'session-fast', afterMessageId: anchor.id });
      await flushMicrotasks();

      const chunk = sent.find(m => m.type === 'yeaft_history_chunk' && m.mode === 'delta');
      expect(chunk).toMatchObject({
        type: 'yeaft_history_chunk',
        sessionId: 'session-fast',
        mode: 'delta',
        afterSeq: Number(anchor.id.slice(1)),
        messages: [
          {
            role: 'user',
            content: 'with file',
            ts: '2026-06-20T01:00:01.000Z',
            attachments: [{ fileId: 'file_1', name: 'note.txt', isImage: false }],
          },
          {
            role: 'assistant',
            content: 'I will use a tool',
            ts: '2026-06-20T01:00:02.000Z',
            speakerVpId: 'vp-linus',
            toolSummaryCount: 1,
          },
        ],
      });
      expect(chunk.messages).toHaveLength(2);
      expect(sent.filter(m => m.type === 'yeaft_output' && m.data)).toHaveLength(0);
      expect(sent.find(m => m.event?.type === 'history_loaded')?.event).toMatchObject({
        mode: 'delta',
        count: chunk.messages.length,
        sessionId: 'session-fast',
      });

      resolveLoadSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await pending;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ready-session delta replay uses the same projected frame shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-delta-ready-'));
    try {
      const store = new ConversationStore(dir);
      const anchor = store.append({
        role: 'user',
        content: 'already seen',
        sessionId: 'session-fast',
        time: '2026-06-20T02:00:00.000Z',
      });
      store.append({
        role: 'user',
        content: 'ready delta user',
        sessionId: 'session-fast',
        time: '2026-06-20T02:00:01.000Z',
        attachments: [{ fileId: 'file_2', name: 'diagram.png', isImage: true }],
      });
      store.append({
        role: 'assistant',
        content: 'ready delta assistant',
        sessionId: 'session-fast',
        speakerVpId: 'vp-martin',
        time: '2026-06-20T02:00:02.000Z',
        toolCalls: [{ id: 'toolu_2', name: 'WebSearch', input: { query: 'yeaft' } }],
      });
      store.append({
        role: 'tool',
        content: 'result',
        sessionId: 'session-fast',
        toolCallId: 'toolu_2',
        time: '2026-06-20T02:00:03.000Z',
      });
      __testSetSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });

      await handleYeaftLoadHistory({ sessionId: 'session-fast', afterSeq: Number(anchor.id.slice(1)) });

      const chunk = sent.find(m => m.type === 'yeaft_history_chunk' && m.mode === 'delta');
      expect(chunk).toMatchObject({
        type: 'yeaft_history_chunk',
        sessionId: 'session-fast',
        mode: 'delta',
        afterSeq: Number(anchor.id.slice(1)),
        messages: [
          {
            role: 'user',
            content: 'ready delta user',
            ts: '2026-06-20T02:00:01.000Z',
            attachments: [{ fileId: 'file_2', name: 'diagram.png', isImage: true }],
          },
          {
            role: 'assistant',
            content: 'ready delta assistant',
            ts: '2026-06-20T02:00:02.000Z',
            speakerVpId: 'vp-martin',
            toolSummaryCount: 1,
          },
        ],
      });
      expect(chunk.messages).toHaveLength(2);
      expect(sent.filter(m => m.type === 'yeaft_output' && m.data)).toHaveLength(0);
      expect(sent.find(m => m.event?.type === 'history_loaded')?.event).toMatchObject({
        mode: 'delta',
        count: chunk.messages.length,
        sessionId: 'session-fast',
      });
    } finally {
      __testSetSession(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
