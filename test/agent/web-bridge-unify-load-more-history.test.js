/**
 * web-bridge-unify-load-more-history.test.js — pagination handler.
 *
 * Validates `handleUnifyLoadMoreHistory`:
 *   - emits a `unify_history_chunk` envelope with the projected
 *     user/assistant rows, oldestSeq, hasMore from
 *     ConversationStore.loadOlderByGroup
 *   - empty branch (no session yet, or no groupId) still emits a chunk so
 *     the frontend spinner clears
 *   - error branch (loadOlderByGroup throws) still emits an empty chunk
 *
 * Also covers the `handleUnifyLoadHistory` extension that primes the
 * pagination cursor: after bootstrap replay, the `history_loaded` event
 * carries `hasMore` + `oldestSeq` so the frontend knows whether to render
 * the "Load older messages" hint.
 *
 * NOTE on isolation: web-bridge keeps `session` and `unifyConversationId`
 * as module-level vars that can't be reset from outside. Once the first
 * `handleUnifyLoadHistory` populates them, subsequent tests inherit the
 * same `session.conversationStore`. We work with that by sharing ONE store
 * across all tests and isolating tests via unique groupIds + scoped
 * `outbound` clears in beforeEach.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outbound = [];

vi.mock('../../agent/connection/buffer.js', () => ({
  sendToServer: (msg) => { outbound.push(msg); },
  flushMessageBuffer: () => {},
}));

let stubSession;
vi.mock('../../agent/unify/session.js', () => ({
  loadSession: async () => stubSession,
}));

import {
  handleUnifyLoadHistory,
  handleUnifyLoadMoreHistory,
} from '../../agent/unify/web-bridge.js';
import { ConversationStore } from '../../agent/unify/conversation/persist.js';

let TEST_DIR;
let sharedStore;

beforeAll(async () => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'unify-loadmore-'));
  sharedStore = new ConversationStore(TEST_DIR);
  stubSession = {
    conversationStore: sharedStore,
    config: { model: 'm', availableModels: [] },
    status: { skills: [], mcpServers: [], tools: [] },
    _dreamProgressSink: null,
  };
  // Eagerly initialize the bridge's module-level `session` and
  // `unifyConversationId` exactly once so per-test interference is gone.
  await handleUnifyLoadHistory({ limit: 0 });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  outbound.length = 0;
});

/** Find the most recent `unify_history_chunk` envelope. */
function lastChunk() {
  for (let i = outbound.length - 1; i >= 0; i--) {
    if (outbound[i].type === 'unify_history_chunk') return outbound[i];
  }
  return null;
}

/** Find the most recent `history_loaded` event payload. */
function lastHistoryLoadedEvent() {
  for (let i = outbound.length - 1; i >= 0; i--) {
    const m = outbound[i];
    if (m && m.type === 'unify_output' && m.event && m.event.type === 'history_loaded') {
      return m.event;
    }
  }
  return null;
}

function seedTurns(groupId, n, prefix = 'q') {
  const batch = [];
  for (let i = 1; i <= n; i++) {
    batch.push({ role: 'user',      content: `${prefix}${i}`, groupId });
    batch.push({ role: 'assistant', content: `a${prefix}${i}`, groupId });
  }
  sharedStore.appendBatch(batch);
}

describe('handleUnifyLoadMoreHistory — chunk emission', () => {
  it('emits an empty chunk when groupId is missing', async () => {
    await handleUnifyLoadMoreHistory({ groupId: null, beforeSeq: null, turns: 5 });
    const chunk = lastChunk();
    expect(chunk).toBeDefined();
    expect(chunk.type).toBe('unify_history_chunk');
    expect(chunk.messages).toEqual([]);
    expect(chunk.oldestSeq).toBeNull();
    expect(chunk.hasMore).toBe(false);
    // Defensive: empty branch still stamps groupId so the server relay
    // routing can't choke on undefined.
    expect(chunk.groupId).toBeNull();
  });

  it('emits a chunk with projected rows + cursor + hasMore for a populated group', async () => {
    const gid = 'g_chunk';
    seedTurns(gid, 5);

    await handleUnifyLoadMoreHistory({ groupId: gid, beforeSeq: null, turns: 2 });
    const chunk = lastChunk();
    expect(chunk).toBeDefined();
    expect(chunk.type).toBe('unify_history_chunk');
    expect(chunk.groupId).toBe(gid);
    // 2 newest turns: q4/aq4, q5/aq5.
    expect(chunk.messages.map(m => m.content))
      .toEqual(['q4', 'aq4', 'q5', 'aq5']);
    // Each row carries role/content/groupId; stable ids and assistant
    // speaker attribution are included when present.
    for (const m of chunk.messages) {
      expect(m).toEqual(expect.objectContaining({
        role: expect.stringMatching(/^(user|assistant)$/),
        content: expect.any(String),
        groupId: gid,
      }));
      expect(m).not.toHaveProperty('time');
    }
    expect(typeof chunk.oldestSeq).toBe('number');
    expect(chunk.oldestSeq).toBeGreaterThan(0);
    expect(chunk.hasMore).toBe(true);
  });


  it('filters internal reflection rows and preserves ids + speaker attribution in older history', async () => {
    const gid = 'g_chunk_visible_projection';
    sharedStore.appendBatch([
      { id: 'visible-u', role: 'user', content: 'visible question', groupId: gid },
      { id: 'reflection-u', role: 'user', content: 'The previous tool calls have been folded', groupId: gid, _reflection: true },
      { id: 'internal-a', role: 'assistant', content: 'internal assistant', groupId: gid, internal: true, speakerVpId: 'vp-hidden' },
      { id: 'visible-a', role: 'assistant', content: 'visible answer', groupId: gid, speakerVpId: 'vp-linus' },
    ]);

    await handleUnifyLoadMoreHistory({ groupId: gid, beforeSeq: null, turns: 10 });
    const chunk = lastChunk();
    expect(chunk).toBeDefined();
    expect(chunk.messages.map(m => m.content)).toEqual(['visible question', 'visible answer']);
    expect(chunk.messages[0]).toEqual(expect.objectContaining({ role: 'user', groupId: gid }));
    expect(chunk.messages[0].id).toEqual(expect.any(String));
    expect(chunk.messages[1]).toEqual(expect.objectContaining({ role: 'assistant', groupId: gid, speakerVpId: 'vp-linus' }));
    expect(chunk.messages[1].id).toEqual(expect.any(String));
  });

  it('walks the cursor through history until exhausted', async () => {
    const gid = 'g_walk';
    seedTurns(gid, 3);

    // Page 1.
    await handleUnifyLoadMoreHistory({ groupId: gid, beforeSeq: null, turns: 2 });
    const p1 = lastChunk();
    expect(p1.messages.map(m => m.content)).toEqual(['q2', 'aq2', 'q3', 'aq3']);
    expect(p1.hasMore).toBe(true);

    outbound.length = 0;
    // Page 2 — final.
    await handleUnifyLoadMoreHistory({ groupId: gid, beforeSeq: p1.oldestSeq, turns: 2 });
    const p2 = lastChunk();
    expect(p2.messages.map(m => m.content)).toEqual(['q1', 'aq1']);
    expect(p2.hasMore).toBe(false);

    outbound.length = 0;
    // Page 3 — empty.
    await handleUnifyLoadMoreHistory({ groupId: gid, beforeSeq: p2.oldestSeq, turns: 2 });
    const p3 = lastChunk();
    expect(p3.messages).toEqual([]);
    expect(p3.oldestSeq).toBeNull();
    expect(p3.hasMore).toBe(false);
  });

  it('emits an empty chunk when the persistence layer throws', async () => {
    const gid = 'g_throw';
    seedTurns(gid, 3);

    const original = sharedStore.loadOlderByGroup.bind(sharedStore);
    sharedStore.loadOlderByGroup = () => { throw new Error('disk gone'); };
    try {
      await handleUnifyLoadMoreHistory({ groupId: gid, beforeSeq: null, turns: 2 });
      const chunk = lastChunk();
      expect(chunk).toBeDefined();
      expect(chunk.messages).toEqual([]);
      expect(chunk.oldestSeq).toBeNull();
      expect(chunk.hasMore).toBe(false);
    } finally {
      sharedStore.loadOlderByGroup = original;
    }
  });

  it('defaults turns to 20 when caller omits it', async () => {
    const gid = 'g_default';
    seedTurns(gid, 25);

    let capturedTurns = null;
    const original = sharedStore.loadOlderByGroup.bind(sharedStore);
    sharedStore.loadOlderByGroup = (gidArg, before, turns) => {
      capturedTurns = turns;
      return original(gidArg, before, turns);
    };
    try {
      await handleUnifyLoadMoreHistory({ groupId: gid, beforeSeq: null /* turns omitted */ });
    } finally {
      sharedStore.loadOlderByGroup = original;
    }
    expect(capturedTurns).toBe(20);
  });

  it('rejects non-positive turns and falls back to default 20', async () => {
    const gid = 'g_default2';
    seedTurns(gid, 25);

    let capturedTurns = null;
    const original = sharedStore.loadOlderByGroup.bind(sharedStore);
    sharedStore.loadOlderByGroup = (gidArg, before, turns) => {
      capturedTurns = turns;
      return original(gidArg, before, turns);
    };
    try {
      await handleUnifyLoadMoreHistory({ groupId: gid, beforeSeq: null, turns: 0 });
    } finally {
      sharedStore.loadOlderByGroup = original;
    }
    expect(capturedTurns).toBe(20);
  });
});

describe('handleUnifyLoadHistory — pagination cursor priming', () => {
  it('history_loaded carries hasMore + oldestSeq when older messages remain', async () => {
    const gid = 'g_prime_more';
    seedTurns(gid, 5);

    await handleUnifyLoadHistory({ groupId: gid, limit: 2 });

    const evt = lastHistoryLoadedEvent();
    expect(evt).toBeDefined();
    expect(evt.type).toBe('history_loaded');
    expect(evt.groupId).toBe(gid);
    expect(evt.count).toBe(4); // 2 turns × (user + assistant) = 4 messages
    expect(evt.hasMore).toBe(true);
    expect(typeof evt.oldestSeq).toBe('number');
    expect(evt.oldestSeq).toBeGreaterThan(0);
  });


  it('refresh replay filters reflection/internal rows and emits stable ids + speaker envelopes', async () => {
    const gid = 'g_refresh_visible_projection';
    sharedStore.appendBatch([
      { id: 'refresh-u', role: 'user', content: 'refresh question', groupId: gid },
      { id: 'refresh-reflection', role: 'user', content: 'The previous 30 tool calls have been folded', groupId: gid, _reflection: true },
      { id: 'refresh-internal', role: 'assistant', content: 'internal note', groupId: gid, internal: true, speakerVpId: 'vp-hidden' },
      { id: 'refresh-a', role: 'assistant', content: 'refresh answer', groupId: gid, speakerVpId: 'vp-ada' },
    ]);

    await handleUnifyLoadHistory({ groupId: gid, limit: 10 });

    const replay = outbound.filter(m => m.type === 'unify_output' && m.data);
    const visibleData = replay.map(m => ({ groupId: m.groupId, vpId: m.vpId || null, data: m.data }));
    expect(visibleData.filter(x => x.data.type === 'user').map(x => x.data.message.content)).toEqual(['refresh question']);
    expect(visibleData.filter(x => x.data.type === 'assistant').map(x => x.data.message.content[0].text)).toEqual(['refresh answer']);
    const assistant = visibleData.find(x => x.data.type === 'assistant');
    expect(assistant).toEqual(expect.objectContaining({ groupId: gid, vpId: 'vp-ada' }));
    expect(assistant.data.message.id).toEqual(expect.any(String));
    const user = visibleData.find(x => x.data.type === 'user');
    expect(user.data.message.id).toEqual(expect.any(String));
    expect(user.data.message.id).not.toBe(assistant.data.message.id);
  });

  it('history_loaded reports hasMore=false when the bootstrap covers everything', async () => {
    const gid = 'g_prime_all';
    seedTurns(gid, 2);
    await handleUnifyLoadHistory({ groupId: gid, limit: 50 });

    const evt = lastHistoryLoadedEvent();
    expect(evt).toBeDefined();
    expect(evt.hasMore).toBe(false);
    expect(typeof evt.oldestSeq).toBe('number');
  });

  it('history_loaded reports hasMore=false and oldestSeq=null when the group has no history', async () => {
    await handleUnifyLoadHistory({ groupId: 'g_empty_unique', limit: 50 });

    const evt = lastHistoryLoadedEvent();
    expect(evt).toBeDefined();
    expect(evt.count).toBe(0);
    expect(evt.hasMore).toBe(false);
    expect(evt.oldestSeq).toBeNull();
  });
});
