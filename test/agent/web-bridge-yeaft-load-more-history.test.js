/**
 * web-bridge-yeaft-load-more-history.test.js — pagination handler.
 *
 * Validates `handleYeaftLoadMoreHistory`:
 *   - emits a `yeaft_history_chunk` envelope with the projected
 *     user/assistant rows, oldestSeq, hasMore from
 *     ConversationStore.loadVisibleBySession
 *   - empty branch (no session yet, or no sessionId) still emits a chunk so
 *     the frontend spinner clears
 *   - error branch (loadVisibleBySession throws) still emits an empty chunk
 *
 * Also covers the `handleYeaftLoadHistory` extension that primes the
 * pagination cursor: after bootstrap replay, the `history_loaded` event
 * carries `hasMore` + `oldestSeq` so the frontend knows whether to render
 * the "Load older messages" hint.
 *
 * NOTE on isolation: web-bridge keeps `session` and `yeaftConversationId`
 * as module-level vars that can't be reset from outside. Once the first
 * `handleYeaftLoadHistory` populates them, subsequent tests inherit the
 * same `session.conversationStore`. We work with that by sharing ONE store
 * across all tests and isolating tests via unique sessionIds + scoped
 * `outbound` clears in beforeEach.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outbound = [];

vi.mock('../../agent/connection/buffer.js', () => ({
  sendToServer: (msg) => { outbound.push(msg); },
  flushMessageBuffer: () => {},
}));

let stubSession;
vi.mock('../../agent/yeaft/session.js', () => ({
  loadSession: async () => stubSession,
}));

import {
  handleYeaftLoadHistory,
  handleYeaftLoadMoreHistory,
} from '../../agent/yeaft/web-bridge.js';
import { ConversationStore } from '../../agent/yeaft/conversation/persist.js';
import { writeSummary } from '../../agent/yeaft/memory/store.js';
import { writeGroupState } from '../../agent/yeaft/dream/state.js';

let TEST_DIR;
let sharedStore;

beforeAll(async () => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'yeaft-loadmore-'));
  sharedStore = new ConversationStore(TEST_DIR);
  writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
    providers: [{
      name: 'local',
      baseUrl: 'http://localhost/v1',
      apiKey: 'test',
      protocol: 'openai-responses',
      models: ['m'],
    }],
    primaryModel: 'local/m',
  }, null, 2));
  stubSession = {
    conversationStore: sharedStore,
    yeaftDir: TEST_DIR,
    config: { model: 'm', availableModels: [] },
    status: { skills: [], mcpServers: [], tools: [] },
    _dreamProgressSink: null,
  };
  // Eagerly initialize the bridge's module-level `session` and
  // `yeaftConversationId` exactly once so per-test interference is gone.
  await handleYeaftLoadHistory({ limit: 0 });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  outbound.length = 0;
});

/** Find the most recent `yeaft_history_chunk` envelope. */
function lastChunk() {
  for (let i = outbound.length - 1; i >= 0; i--) {
    if (outbound[i].type === 'yeaft_history_chunk') return outbound[i];
  }
  return null;
}

/** Find the most recent `history_loaded` event payload. */
function lastHistoryLoadedEvent() {
  for (let i = outbound.length - 1; i >= 0; i--) {
    const m = outbound[i];
    if (m && m.type === 'yeaft_output' && m.event && m.event.type === 'history_loaded') {
      return m.event;
    }
  }
  return null;
}

function lastDreamSnapshotEvent() {
  for (let i = outbound.length - 1; i >= 0; i--) {
    const m = outbound[i];
    if (m && m.type === 'yeaft_output' && m.event && m.event.type === 'yeaft_dream_snapshot') {
      return m.event;
    }
  }
  return null;
}

function seedTurns(sessionId, n, prefix = 'q') {
  const batch = [];
  for (let i = 1; i <= n; i++) {
    batch.push({ role: 'user',      content: `${prefix}${i}`, sessionId });
    batch.push({ role: 'assistant', content: `a${prefix}${i}`, sessionId });
  }
  sharedStore.appendBatch(batch);
}

describe('handleYeaftLoadMoreHistory — chunk emission', () => {
  it('emits an empty chunk when sessionId is missing', async () => {
    await handleYeaftLoadMoreHistory({ sessionId: null, beforeSeq: null, turns: 5 });
    const chunk = lastChunk();
    expect(chunk).toBeDefined();
    expect(chunk.type).toBe('yeaft_history_chunk');
    expect(chunk.messages).toEqual([]);
    expect(chunk.oldestSeq).toBeNull();
    expect(chunk.hasMore).toBe(false);
    // Defensive: empty branch still stamps sessionId so the server relay
    // routing can't choke on undefined.
    expect(chunk.sessionId).toBeNull();
  });

  it('emits a chunk with projected rows + cursor + hasMore for a populated group', async () => {
    const gid = 'g_chunk';
    seedTurns(gid, 5);

    await handleYeaftLoadMoreHistory({ sessionId: gid, beforeSeq: null, turns: 2 });
    const chunk = lastChunk();
    expect(chunk).toBeDefined();
    expect(chunk.type).toBe('yeaft_history_chunk');
    expect(chunk.sessionId).toBe(gid);
    // 2 newest turns: q4/aq4, q5/aq5.
    expect(chunk.messages.map(m => m.content))
      .toEqual(['q4', 'aq4', 'q5', 'aq5']);
    // Each row carries role/content/sessionId; stable ids and assistant
    // speaker attribution are included when present.
    for (const m of chunk.messages) {
      expect(m).toEqual(expect.objectContaining({
        role: expect.stringMatching(/^(user|assistant)$/),
        content: expect.any(String),
        sessionId: gid,
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
      { id: 'visible-u', role: 'user', content: 'visible question', sessionId: gid },
      { id: 'reflection-u', role: 'user', content: 'The previous tool calls have been folded', sessionId: gid, _reflection: true },
      { id: 'internal-a', role: 'assistant', content: 'internal assistant', sessionId: gid, internal: true, speakerVpId: 'vp-hidden' },
      { id: 'visible-a', role: 'assistant', content: 'visible answer', sessionId: gid, speakerVpId: 'vp-linus' },
    ]);

    await handleYeaftLoadMoreHistory({ sessionId: gid, beforeSeq: null, turns: 10 });
    const chunk = lastChunk();
    expect(chunk).toBeDefined();
    expect(chunk.messages.map(m => m.content)).toEqual(['visible question', 'visible answer']);
    expect(chunk.messages[0]).toEqual(expect.objectContaining({ role: 'user', sessionId: gid }));
    expect(chunk.messages[0].id).toEqual(expect.any(String));
    expect(chunk.messages[1]).toEqual(expect.objectContaining({ role: 'assistant', sessionId: gid, speakerVpId: 'vp-linus' }));
    expect(chunk.messages[1].id).toEqual(expect.any(String));
  });

  it('older history pages over invisible rows before the cursor', async () => {
    const gid = 'g_chunk_invisible_before_cursor';
    sharedStore.appendBatch([
      { role: 'user', content: 'older visible', sessionId: gid },
      { role: 'assistant', content: 'older answer', sessionId: gid, speakerVpId: 'vp-ada' },
      { role: 'user', content: 'old reflection', sessionId: gid, _reflection: true },
      { role: 'assistant', content: 'old internal', sessionId: gid, internal: true, speakerVpId: 'vp-hidden' },
      { role: 'user', content: 'newer visible', sessionId: gid },
      { role: 'assistant', content: 'newer answer', sessionId: gid, speakerVpId: 'vp-linus' },
    ]);

    await handleYeaftLoadMoreHistory({ sessionId: gid, beforeSeq: Number.MAX_SAFE_INTEGER, turns: 1 });
    const newest = lastChunk();
    expect(newest.messages.map(m => m.content)).toEqual(['newer visible', 'newer answer']);

    outbound.length = 0;
    await handleYeaftLoadMoreHistory({ sessionId: gid, beforeSeq: newest.oldestSeq, turns: 1 });
    const older = lastChunk();
    expect(older.messages.map(m => m.content)).toEqual(['older visible', 'older answer']);
    expect(older.hasMore).toBe(false);
    expect(older.messages.some(m => m.content.includes('reflection') || m.content.includes('internal'))).toBe(false);
  });

  it('walks the cursor through history until exhausted', async () => {
    const gid = 'g_walk';
    seedTurns(gid, 3);

    // Page 1.
    await handleYeaftLoadMoreHistory({ sessionId: gid, beforeSeq: null, turns: 2 });
    const p1 = lastChunk();
    expect(p1.messages.map(m => m.content)).toEqual(['q2', 'aq2', 'q3', 'aq3']);
    expect(p1.hasMore).toBe(true);

    outbound.length = 0;
    // Page 2 — final.
    await handleYeaftLoadMoreHistory({ sessionId: gid, beforeSeq: p1.oldestSeq, turns: 2 });
    const p2 = lastChunk();
    expect(p2.messages.map(m => m.content)).toEqual(['q1', 'aq1']);
    expect(p2.hasMore).toBe(false);

    outbound.length = 0;
    // Page 3 — empty.
    await handleYeaftLoadMoreHistory({ sessionId: gid, beforeSeq: p2.oldestSeq, turns: 2 });
    const p3 = lastChunk();
    expect(p3.messages).toEqual([]);
    expect(p3.oldestSeq).toBeNull();
    expect(p3.hasMore).toBe(false);
  });

  it('emits an empty chunk when the persistence layer throws', async () => {
    const gid = 'g_throw';
    seedTurns(gid, 3);

    const original = sharedStore.loadVisibleBySession.bind(sharedStore);
    sharedStore.loadVisibleBySession = () => { throw new Error('disk gone'); };
    try {
      await handleYeaftLoadMoreHistory({ sessionId: gid, beforeSeq: null, turns: 2 });
      const chunk = lastChunk();
      expect(chunk).toBeDefined();
      expect(chunk.messages).toEqual([]);
      expect(chunk.oldestSeq).toBeNull();
      expect(chunk.hasMore).toBe(false);
    } finally {
      sharedStore.loadVisibleBySession = original;
    }
  });

  it('defaults turns to 10 when caller omits it', async () => {
    const gid = 'g_default';
    seedTurns(gid, 25);

    await handleYeaftLoadMoreHistory({ sessionId: gid, beforeSeq: null /* turns omitted */ });
    const chunk = lastChunk();
    expect(chunk.messages).toHaveLength(20); // 10 turns × (user + assistant)
    expect(chunk.messages[0].content).toBe('q16');
    expect(chunk.messages.at(-1).content).toBe('aq25');
    expect(chunk.hasMore).toBe(true);
  });

  it('rejects non-positive turns and falls back to default 10', async () => {
    const gid = 'g_default2';
    seedTurns(gid, 25);

    await handleYeaftLoadMoreHistory({ sessionId: gid, beforeSeq: null, turns: 0 });
    const chunk = lastChunk();
    expect(chunk.messages).toHaveLength(20); // 10 turns × (user + assistant)
    expect(chunk.messages[0].content).toBe('q16');
    expect(chunk.messages.at(-1).content).toBe('aq25');
    expect(chunk.hasMore).toBe(true);
  });
});

describe('handleYeaftLoadHistory — pagination cursor priming', () => {


  it('refreshes the session_ready model list from config on every history load', async () => {
    stubSession.config.model = 'stale-model';
    stubSession.config.availableModels = [{ id: 'stale-model' }];
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{
        name: 'local',
        baseUrl: 'http://localhost/v1',
        apiKey: 'test',
        protocol: 'openai-responses',
        models: ['fresh-model'],
      }],
      primaryModel: 'local/fresh-model',
    }, null, 2));

    await handleYeaftLoadHistory({ sessionId: 's_model_refresh', limit: 0 });

    const ready = [...outbound].reverse().find(m => m.type === 'yeaft_output' && m.event?.type === 'session_ready');
    expect(ready.event.model).toBe('fresh-model');
    expect(ready.event.availableModels.map(m => m.id)).toContain('fresh-model');
    expect(ready.event.availableModels.map(m => m.id)).not.toContain('stale-model');

    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{
        name: 'local',
        baseUrl: 'http://localhost/v1',
        apiKey: 'test',
        protocol: 'openai-responses',
        models: ['m'],
      }],
      primaryModel: 'local/m',
    }, null, 2));
  });

  it('initial group replay emits only the latest window in chronological order', async () => {
    const gid = 'g_initial_latest_window';
    seedTurns(gid, 5, 'latest');

    await handleYeaftLoadHistory({ sessionId: gid, limit: 2 });

    const replay = outbound.filter(m => m.type === 'yeaft_output' && m.data);
    const userTexts = replay
      .filter(m => m.sessionId === gid && m.data.type === 'user')
      .map(m => m.data.message.content);
    const assistantTexts = replay
      .filter(m => m.sessionId === gid && m.data.type === 'assistant')
      .map(m => m.data.message.content[0].text);

    expect(userTexts).toEqual(['latest4', 'latest5']);
    expect(assistantTexts).toEqual(['alatest4', 'alatest5']);
    expect(replay.some(m => m.sessionId === gid && JSON.stringify(m.data).includes('latest1'))).toBe(false);

    const evt = lastHistoryLoadedEvent();
    expect(evt).toEqual(expect.objectContaining({ sessionId: gid, count: 4, hasMore: true }));
    expect(typeof evt.oldestSeq).toBe('number');
  });

  it('replays the loadable dream output snapshot for the selected session', async () => {
    const gid = 's_dream_snapshot';
    const root = join(TEST_DIR, 'memory');
    await writeSummary({ kind: 'group', id: gid }, 'dream summary for selected session', { root });
    await writeGroupState(root, gid, {
      lastDreamMessageId: 'm-12',
      lastDreamAt: '2026-06-12T02:03:04.000Z',
      messageCount: 12,
    });

    outbound.length = 0;
    await handleYeaftLoadHistory({ sessionId: gid, limit: 0 });

    const evt = lastDreamSnapshotEvent();
    expect(evt).toBeTruthy();
    expect(evt.trigger).toBe('load_history');
    expect(evt.snapshot.sessionId).toBe(gid);
    expect(evt.snapshot.scope).toBe(`group/${gid}`);
    expect(evt.snapshot.summaryText).toBe('dream summary for selected session');
    expect(evt.snapshot.lastDreamAt).toBe('2026-06-12T02:03:04.000Z');
  });

  it('history_loaded carries hasMore + oldestSeq when older messages remain', async () => {
    const gid = 'g_prime_more';
    seedTurns(gid, 5);

    await handleYeaftLoadHistory({ sessionId: gid, limit: 2 });

    const evt = lastHistoryLoadedEvent();
    expect(evt).toBeDefined();
    expect(evt.type).toBe('history_loaded');
    expect(evt.sessionId).toBe(gid);
    expect(evt.count).toBe(4); // 2 turns × (user + assistant) = 4 messages
    expect(evt.hasMore).toBe(true);
    expect(typeof evt.oldestSeq).toBe('number');
    expect(evt.oldestSeq).toBeGreaterThan(0);
  });


  it('refresh replay filters reflection/internal rows and emits stable ids + speaker envelopes', async () => {
    const gid = 'g_refresh_visible_projection';
    sharedStore.appendBatch([
      { id: 'refresh-u', role: 'user', content: 'refresh question', sessionId: gid },
      { id: 'refresh-reflection', role: 'user', content: 'The previous 30 tool calls have been folded', sessionId: gid, _reflection: true },
      { id: 'refresh-internal', role: 'assistant', content: 'internal note', sessionId: gid, internal: true, speakerVpId: 'vp-hidden' },
      { id: 'refresh-a', role: 'assistant', content: 'refresh answer', sessionId: gid, speakerVpId: 'vp-ada' },
    ]);

    await handleYeaftLoadHistory({ sessionId: gid, limit: 10 });

    const replay = outbound.filter(m => m.type === 'yeaft_output' && m.data);
    const visibleData = replay.map(m => ({ sessionId: m.sessionId, vpId: m.vpId || null, data: m.data }));
    expect(visibleData.filter(x => x.data.type === 'user').map(x => x.data.message.content)).toEqual(['refresh question']);
    expect(visibleData.filter(x => x.data.type === 'assistant').map(x => x.data.message.content[0].text)).toEqual(['refresh answer']);
    const assistant = visibleData.find(x => x.data.type === 'assistant');
    expect(assistant).toEqual(expect.objectContaining({ sessionId: gid, vpId: 'vp-ada' }));
    expect(assistant.data.message.id).toEqual(expect.any(String));
    const user = visibleData.find(x => x.data.type === 'user');
    expect(user.data.message.id).toEqual(expect.any(String));
    expect(user.data.message.id).not.toBe(assistant.data.message.id);
  });

  it('normalizes persisted image content blocks and preserves attachment metadata on refresh replay', async () => {
    const gid = 'g_refresh_image_blocks';
    sharedStore.appendBatch([
      {
        role: 'user',
        sessionId: gid,
        content: JSON.stringify([
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAABASE64' } },
          { type: 'text', text: 'please inspect this\n\n[Uploaded files]\n- .claude-tmp-attachments/g/a.png (image)' },
        ]),
        attachments: [{ name: 'a.png', path: '.claude-tmp-attachments/g/a.png', mimeType: 'image/png', isImage: true }],
      },
      { role: 'assistant', content: 'ok', sessionId: gid, speakerVpId: 'vp-linus' },
    ]);

    await handleYeaftLoadHistory({ sessionId: gid, limit: 10 });

    const replay = outbound.filter(m => m.type === 'yeaft_output' && m.data);
    const user = replay.find(m => m.sessionId === gid && m.data.type === 'user');
    expect(user.data.message.content).toBe('please inspect this');
    expect(JSON.stringify(user.data.message)).not.toContain('AAAABASE64');
    expect(JSON.stringify(user.data.message)).not.toContain('Uploaded files');
    expect(user.data.message.attachments).toEqual([
      expect.objectContaining({ name: 'a.png', mimeType: 'image/png', isImage: true }),
    ]);
  });

  it('hydrates persisted image attachments with previewData on refresh replay', async () => {
    const gid = 'g_refresh_preview_data';
    const relPath = `.claude-tmp-attachments/${gid}/pic.png`;
    mkdirSync(join(process.cwd(), '.claude-tmp-attachments', gid), { recursive: true });
    writeFileSync(join(process.cwd(), relPath), Buffer.from('png-bytes'));
    sharedStore.appendBatch([
      {
        role: 'user',
        sessionId: gid,
        content: 'image please',
        attachments: [{ name: 'pic.png', path: relPath, mimeType: 'image/png', isImage: true }],
      },
    ]);

    await handleYeaftLoadHistory({ sessionId: gid, limit: 10 });

    const user = outbound.find(m => m.type === 'yeaft_output' && m.sessionId === gid && m.data?.type === 'user');
    expect(user.data.message.attachments[0]).toEqual(expect.objectContaining({
      name: 'pic.png',
      path: relPath,
      mimeType: 'image/png',
      isImage: true,
      previewData: expect.objectContaining({
        data: Buffer.from('png-bytes').toString('base64'),
        mimeType: 'image/png',
        filename: 'pic.png',
      }),
    }));
  });

  it('preserves no-attachment history replay shape unchanged', async () => {
    const gid = 'g_refresh_no_attachments';
    sharedStore.appendBatch([{ role: 'user', sessionId: gid, content: 'plain text' }]);

    await handleYeaftLoadHistory({ sessionId: gid, limit: 10 });

    const user = outbound.find(m => m.type === 'yeaft_output' && m.sessionId === gid && m.data?.type === 'user');
    expect(user.data.message.content).toBe('plain text');
    expect(user.data.message).not.toHaveProperty('attachments');
  });

  it('initial group replay pages over visible rows without raw unbounded fallback', async () => {
    const gid = 'g_initial_invisible_tail';
    const before = sharedStore.appendBatch([
      { role: 'user', content: 'visible one', sessionId: gid },
      { role: 'assistant', content: 'visible answer one', sessionId: gid, speakerVpId: 'vp-ada' },
    ]);
    sharedStore.moveToColdBatch(before.map(m => m.id));
    sharedStore.appendBatch([
      { role: 'user', content: 'visible two', sessionId: gid },
      { role: 'assistant', content: 'visible answer two', sessionId: gid, speakerVpId: 'vp-linus' },
      { role: 'user', content: 'reflection one', sessionId: gid, _reflection: true },
      { role: 'assistant', content: 'internal one', sessionId: gid, internal: true, speakerVpId: 'vp-hidden' },
      { role: 'user', content: 'reflection two', sessionId: gid, _reflection: true },
      { role: 'assistant', content: 'system only', sessionId: gid, systemOnly: true, speakerVpId: 'vp-hidden' },
    ]);

    await handleYeaftLoadHistory({ sessionId: gid, limit: 1 });

    const replay = outbound.filter(m => m.type === 'yeaft_output' && m.data);
    const userTexts = replay
      .filter(m => m.sessionId === gid && m.data.type === 'user')
      .map(m => m.data.message.content);
    const assistantRows = replay
      .filter(m => m.sessionId === gid && m.data.type === 'assistant');

    expect(userTexts).toEqual(['visible two']);
    expect(assistantRows.map(m => m.data.message.content[0].text)).toEqual(['visible answer two']);
    expect(assistantRows[0]).toEqual(expect.objectContaining({ vpId: 'vp-linus' }));
    expect(replay.some(m => JSON.stringify(m.data).includes('reflection'))).toBe(false);
    expect(replay.some(m => JSON.stringify(m.data).includes('internal one'))).toBe(false);
    expect(replay.some(m => JSON.stringify(m.data).includes('system only'))).toBe(false);

    const evt = lastHistoryLoadedEvent();
    expect(evt).toEqual(expect.objectContaining({ sessionId: gid, count: 2, hasMore: true }));
    expect(typeof evt.oldestSeq).toBe('number');
  });

  it('history_loaded reports hasMore=false when the bootstrap covers everything', async () => {
    const gid = 'g_prime_all';
    seedTurns(gid, 2);
    await handleYeaftLoadHistory({ sessionId: gid, limit: 10 });

    const evt = lastHistoryLoadedEvent();
    expect(evt).toBeDefined();
    expect(evt.hasMore).toBe(false);
    expect(typeof evt.oldestSeq).toBe('number');
  });

  it('history_loaded reports hasMore=false and oldestSeq=null when the group has no history', async () => {
    await handleYeaftLoadHistory({ sessionId: 'g_empty_unique', limit: 10 });

    const evt = lastHistoryLoadedEvent();
    expect(evt).toBeDefined();
    expect(evt.count).toBe(0);
    expect(evt.hasMore).toBe(false);
    expect(evt.oldestSeq).toBeNull();
  });
});
