import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { postCompactPath } from '../../../agent/yeaft/post-compact.js';

const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
};

function response(inputTokens, text = 'answer') {
  return [
    { type: 'usage', inputTokens, outputTokens: 100 },
    { type: 'text_delta', text },
    { type: 'stop', stopReason: 'end_turn' },
  ];
}

describe('post-response context compact', () => {
  it('starts after turn_close at 80%, persists separately, and loads next turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-post-compact-'));
    try {
      const calls = [];
      const streams = [response(80_000, 'first answer'), response(1_000, 'second answer')];
      const adapter = {
        async *stream(params) {
          calls.push({ kind: 'stream', params });
          yield* streams.shift();
        },
        async call(params) {
          calls.push({ kind: 'compact', params });
          return { text: 'saved compact summary', usage: { inputTokens: 100, outputTokens: 20 } };
        },
      };
      const store = new ConversationStore(root);
      const engine = new Engine({
        adapter, trace: new NullTrace(), conversationStore: store, yeaftDir: root,
        config: { model: 'post-compact-model', maxContextTokens: 100_000, maxOutputTokens: 1_000 },
      });
      let compactSeenAtClose = false;
      for await (const event of engine.query({ prompt: 'first', sessionId: 'session-a' })) {
        if (event.type === 'turn_close') compactSeenAtClose = calls.some(call => call.kind === 'compact');
      }
      expect(compactSeenAtClose).toBe(false);
      const path = postCompactPath(root, { sessionId: 'session-a', threadId: 'main' });
      expect(await waitFor(() => existsSync(path))).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8')).summary).toBe('saved compact summary');

      for await (const _event of engine.query({ prompt: 'second', sessionId: 'session-a' })) {}
      const secondStream = calls.filter(call => call.kind === 'stream')[1];
      expect(secondStream.params.system).toContain('saved compact summary');
      expect(calls.filter(call => call.kind === 'compact')).toHaveLength(1);
      const durable = store.loadRecentBySession('session-a', Infinity);
      expect(durable.map(row => row.content)).toEqual(['first', 'first answer', 'second', 'second answer']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not compact below 80%, and a newer turn fences a pending result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-post-compact-fence-'));
    try {
      let resolveCompact;
      let compactStarted = false;
      const streams = [response(80_000), response(1_000)];
      const adapter = {
        async *stream() { yield* streams.shift(); },
        async call() {
          compactStarted = true;
          return await new Promise(resolve => { resolveCompact = resolve; });
        },
      };
      const engine = new Engine({
        adapter, trace: new NullTrace(), conversationStore: new ConversationStore(root), yeaftDir: root,
        config: { model: 'post-compact-model', maxContextTokens: 100_000, maxOutputTokens: 1_000 },
      });
      for await (const _event of engine.query({ prompt: 'first', sessionId: 'session-b' })) {}
      expect(await waitFor(() => compactStarted)).toBe(true);
      // The next query completes without waiting for the pending compact and
      // advances the scope revision before the old result resolves.
      for await (const _event of engine.query({ prompt: 'second', sessionId: 'session-b' })) {}
      resolveCompact({ text: 'stale compact', usage: { inputTokens: 1, outputTokens: 1 } });
      await new Promise(resolve => setTimeout(resolve, 30));
      const path = postCompactPath(root, { sessionId: 'session-b', threadId: 'main' });
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a completed response successful when post compact fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-post-compact-failure-'));
    try {
      let compactAttempted = false;
      const adapter = {
        async *stream() { yield* response(80_000, 'visible answer'); },
        async call() {
          compactAttempted = true;
          throw new Error('compact unavailable');
        },
      };
      const engine = new Engine({
        adapter, trace: new NullTrace(), conversationStore: new ConversationStore(root), yeaftDir: root,
        config: { model: 'post-compact-model', maxContextTokens: 100_000, maxOutputTokens: 1_000 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'first', sessionId: 'session-c' })) {
        events.push(event);
      }
      expect(await waitFor(() => compactAttempted)).toBe(true);
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(events.some(event => event.type === 'turn_close')).toBe(true);
      expect(existsSync(postCompactPath(root, {
        sessionId: 'session-c', threadId: 'main',
      }))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('triggers from an earlier peak but compacts the final provider state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-post-compact-final-state-'));
    try {
      const compactCalls = [];
      const streams = [
        [
          { type: 'usage', inputTokens: 80_000, outputTokens: 100 },
          { type: 'text_delta', text: 'partial answer' },
          { type: 'stop', stopReason: 'max_tokens' },
        ],
        response(1_000, 'final answer'),
      ];
      const adapter = {
        async *stream() { yield* streams.shift(); },
        async call(params) {
          compactCalls.push(params);
          return { text: 'complete summary' };
        },
      };
      const engine = new Engine({
        adapter, trace: new NullTrace(), conversationStore: new ConversationStore(root), yeaftDir: root,
        config: { model: 'post-compact-model', maxContextTokens: 100_000, maxOutputTokens: 1_000 },
      });

      for await (const _event of engine.query({ prompt: 'first', sessionId: 'session-d' })) {}
      expect(await waitFor(() => compactCalls.length === 1)).toBe(true);
      expect(JSON.stringify(compactCalls[0].messages)).toContain('final answer');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
