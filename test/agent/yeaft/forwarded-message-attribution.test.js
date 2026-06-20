import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';

const sent = [];

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn((msg) => { sent.push(msg); }),
}));

const { handleYeaftLoadHistory, __testSetSession } = await import('../../../agent/yeaft/web-bridge.js');

class MockAdapter {
  async *stream() {
    yield { type: 'text_delta', text: 'Martin review: fix is good.' };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
}

function makeTempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'yeaft-forward-attribution-'));
  return { dir, store: new ConversationStore(dir) };
}

describe('forwarded message VP attribution', () => {
  afterEach(() => {
    __testSetSession(null);
    sent.length = 0;
  });

  it('persists target VP assistant output with the producing VP speaker id', async () => {
    const { dir, store } = makeTempStore();
    try {
      const engine = new Engine({
        adapter: new MockAdapter(),
        trace: new NullTrace(),
        conversationStore: store,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        sessionId: 'session-review',
        vpId: 'vp-martin',
      });

      const events = [];
      for await (const event of engine.query({
        prompt: 'please review this PR',
        sessionId: 'session-review',
        userAlreadyPersisted: true,
        threadId: 'review-thread',
      })) {
        events.push(event.type);
      }

      expect(events).toContain('turn_end');
      const page = store.loadVisibleBySession('session-review', null, 10);
      const assistant = page.messages.find(m => m.role === 'assistant' && m.content.includes('Martin review'));
      expect(assistant).toMatchObject({
        speakerVpId: 'vp-martin',
        threadId: 'review-thread',
        sessionId: 'session-review',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays source and target VP messages with their own vpId after reload', async () => {
    const { dir, store } = makeTempStore();
    try {
      store.append({
        role: 'assistant',
        content: 'Linus forwarded: please review this PR',
        sessionId: 'session-review',
        threadId: 'review-thread',
        speakerVpId: 'vp-linus',
        time: '2026-06-17T00:00:00.000Z',
      });
      store.append({
        role: 'assistant',
        content: 'Martin review: the fix is correct',
        sessionId: 'session-review',
        threadId: 'review-thread',
        speakerVpId: 'vp-martin',
        time: '2026-06-17T00:00:01.000Z',
      });

      __testSetSession({
        conversationStore: store,
        config: {
          model: 'test-model',
          availableModels: [],
        },
        status: {
          skills: [],
          mcpServers: [],
          tools: [],
        },
      });

      await handleYeaftLoadHistory({ sessionId: 'session-review', limit: 10 });

      const chunk = sent.find(msg => msg.type === 'yeaft_history_chunk' && msg.mode === 'recent');
      const assistantRows = (chunk?.messages || [])
        .filter(msg => msg.role === 'assistant')
        .map(msg => ({ vpId: msg.speakerVpId, text: msg.content || '' }));

      expect(assistantRows).toEqual(expect.arrayContaining([
        { vpId: 'vp-linus', text: 'Linus forwarded: please review this PR' },
        { vpId: 'vp-martin', text: 'Martin review: the fix is correct' },
      ]));
      expect(assistantRows.find(row => row.text.startsWith('Martin review'))?.vpId).toBe('vp-martin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
