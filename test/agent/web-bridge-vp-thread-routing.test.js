/**
 * web-bridge-vp-thread-routing.test.js — route-level guards for VP
 * multi-thread runtime. These tests inject a fake lightweight classifier so
 * routing semantics are deterministic and never call a real LLM.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn(),
}));

vi.mock('../../agent/yeaft/vp/vp-crud.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    readVp: vi.fn((vpId) => ({
      vpId,
      displayName: vpId,
      role: 'tester',
      persona: `persona of ${vpId}`,
    })),
  };
});

import { sendToServer } from '../../agent/connection/buffer.js';
import {
  __testEnqueueForVp,
  __testGetVpThreads,
  __testGroupHistory,
  __testResetVpState,
  __testSetSession,
  __testSetThreadClassifier,
  __testWaitForRoutePromises,
} from '../../agent/yeaft/web-bridge.js';
import { NullTrace } from '../../agent/yeaft/debug-trace.js';

class QuietAdapter {
  constructor({ delayMs = 0 } = {}) {
    this.delayMs = delayMs;
  }

  async *stream() {
    yield { type: 'text_delta', text: 'ok' };
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    yield { type: 'stop', stopReason: 'end_turn' };
  }

  async call() { return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }; }
}

function mkSession({ delayMs = 0 } = {}) {
  return {
    adapter: new QuietAdapter({ delayMs }),
    trace: new NullTrace(),
    config: { model: 'test-model', fastModel: 'fast-test-model', maxOutputTokens: 64, _readOnly: true, language: 'en' },
    conversationStore: null,
    memoryIndex: null,
    amsRegistry: null,
    toolRegistry: null,
    skillManager: null,
    mcpManager: null,
    yeaftDir: null,
    toolStats: null,
  };
}

function envelope(id, text) {
  return {
    sessionId: 'g1',
    taskId: `task-${id}`,
    trigger: 'mention',
    msg: {
      id,
      from: 'user',
      text,
      meta: {},
    },
  };
}

async function route(id, text, vpId = 'linus') {
  __testEnqueueForVp('g1', vpId, envelope(id, text));
  await __testWaitForRoutePromises(id);
  return __testGetVpThreads('g1', vpId);
}

describe('web-bridge VP thread routing', () => {
  beforeEach(async () => {
    await __testResetVpState();
    __testSetSession(mkSession());
    sendToServer.mockClear();
  });

  afterEach(async () => {
    await __testResetVpState();
    __testSetSession(null);
    __testSetThreadClassifier(null);
  });

  it('creates a threadId for an inactive VP before the turn runs', async () => {
    const threads = await route('msg-1', '@linus inspect this');

    expect(threads).toHaveLength(1);
    expect(threads[0].threadId).toMatch(/^thr_/);
    expect(threads[0].pendingQueries).toHaveLength(0);

    expect(sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'yeaft_output',
      event: expect.objectContaining({
        type: 'vp_typing_start',
        threadId: threads[0].threadId,
      }),
      threadId: threads[0].threadId,
    }));
  });

  it('appends a related query to the existing thread without creating a second thread', async () => {
    const first = await route('msg-1', '@linus fix auth bug');
    const targetThreadId = first[0].threadId;
    __testSetThreadClassifier(vi.fn(async () => ({
      decision: 'related',
      targetThreadId,
      title: 'Fix auth bug',
      reason: 'same issue',
    })));

    const second = await route('msg-2', '@linus also check token refresh');

    expect(second).toHaveLength(1);
    expect(second[0].threadId).toBe(targetThreadId);
    expect(sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'yeaft_output',
      event: expect.objectContaining({
        type: 'vp_thread_user_appended',
        threadId: targetThreadId,
      }),
      threadId: targetThreadId,
    }));
  });

  it('persists a related append into the same thread history exactly once when consumed by the running engine', async () => {
    await __testResetVpState();
    __testSetSession(mkSession({ delayMs: 25 }));
    sendToServer.mockClear();

    const first = await route('msg-1', '@linus fix auth bug');
    const targetThreadId = first[0].threadId;
    __testSetThreadClassifier(vi.fn(async () => ({
      decision: 'related',
      targetThreadId,
      title: 'Fix auth bug',
      reason: 'same issue',
    })));

    await route('msg-2', '@linus also check token refresh');
    await new Promise((resolve) => setTimeout(resolve, 80));

    const history = __testGroupHistory('g1').filter((m) => m.threadId === targetThreadId && m.role === 'user');
    expect(history.map((m) => m.content)).toEqual([
      '@vp-linus @linus fix auth bug',
      '@vp-linus @linus also check token refresh',
    ]);
  });

  it('creates a new thread when the classifier marks the query unrelated', async () => {
    const first = await route('msg-1', '@linus fix auth bug');
    __testSetThreadClassifier(vi.fn(async () => ({
      decision: 'unrelated',
      targetThreadId: null,
      title: 'Plan exports',
      reason: 'different task',
    })));

    const second = await route('msg-2', '@linus design CSV export');

    expect(second).toHaveLength(2);
    const ids = second.map((t) => t.threadId);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(first[0].threadId);
    expect(second.find((t) => t.threadId !== first[0].threadId)?.title).toBe('Plan exports');
  });


  it('falls back to a new thread when related points at an unknown threadId', async () => {
    const first = await route('msg-1', '@linus fix auth bug');
    __testSetThreadClassifier(vi.fn(async () => ({
      decision: 'related',
      targetThreadId: 'missing-thread',
      title: 'Unknown target',
      reason: 'bad classifier output',
    })));

    const second = await route('msg-2', '@linus check a different target');

    expect(second).toHaveLength(2);
    expect(second.map((t) => t.threadId)).toContain(first[0].threadId);
    expect(second.map((t) => t.threadId)).not.toContain('missing-thread');
    expect(second.find((t) => t.threadId === first[0].threadId)?.pendingQueries).toHaveLength(0);
    expect(second.find((t) => t.threadId !== first[0].threadId)?.title).toBe('Unknown target');
  });

  it('invalid classifier fallback with multiple running threads creates a new thread instead of merging', async () => {
    const first = await route('msg-1', '@linus fix auth bug');
    __testSetThreadClassifier(vi.fn(async () => ({ decision: 'unrelated', targetThreadId: null, title: 'Plan exports' })));
    const two = await route('msg-2', '@linus design CSV export');
    const beforeIds = two.map((t) => t.threadId);

    __testSetThreadClassifier(null);
    const after = await route('msg-3', '@linus investigate something else');

    expect(after).toHaveLength(3);
    expect(after.map((t) => t.threadId)).toEqual(expect.arrayContaining(beforeIds));
    for (const id of beforeIds) {
      expect(after.find((t) => t.threadId === id)?.pendingQueries).toHaveLength(0);
    }
    expect(after.some((t) => !beforeIds.includes(t.threadId) && t.threadId !== first[0].threadId)).toBe(true);
  });

  it('lets the classifier select among multiple running threads', async () => {
    const first = await route('msg-1', '@linus fix auth bug');
    __testSetThreadClassifier(vi.fn(async () => ({ decision: 'unrelated', targetThreadId: null, title: 'Plan exports' })));
    const two = await route('msg-2', '@linus design CSV export');
    const exportThreadId = two.find((t) => t.threadId !== first[0].threadId).threadId;

    const classifier = vi.fn(async ({ runningThreads }) => {
      expect(runningThreads.map((t) => t.threadId).sort()).toEqual(two.map((t) => t.threadId).sort());
      return { decision: 'related', targetThreadId: exportThreadId, title: 'Plan exports' };
    });
    __testSetThreadClassifier(classifier);

    const after = await route('msg-3', '@linus add XLSX too');

    expect(classifier).toHaveBeenCalledTimes(1);
    expect(after).toHaveLength(2);
    expect(sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'yeaft_output',
      event: expect.objectContaining({
        type: 'vp_thread_user_appended',
        threadId: exportThreadId,
      }),
      threadId: exportThreadId,
    }));
  });
});
