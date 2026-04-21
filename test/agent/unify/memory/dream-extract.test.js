/**
 * dream-extract.test.js — R6 §Δ26 Phase A dream-extract tests.
 *
 * Coverage: watermark, message collection, dedup classification,
 * full dreamExtract pipeline, DreamScheduler integration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  readWatermark,
  writeWatermark,
  collectNewMessages,
  extractCandidates,
  classifyCandidate,
  dreamExtract,
} from '../../../../agent/unify/memory/dream-extract.js';

import { openMemoryShardStore } from '../../../../agent/unify/memory/shard-store.js';

// ─── Helpers ──────────────────────────────────────────────────

/** Minimal group mock with streamMessages() */
function mockGroup(messages) {
  return {
    streamMessages: function* () { yield* messages; },
  };
}

/** Minimal LLM adapter mock */
function mockAdapter(responseText) {
  return {
    call: vi.fn().mockResolvedValue({ text: responseText }),
  };
}

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dream-extract-test-'));
});

afterEach(() => {
  try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
});

// ─── Watermark ────────────────────────────────────────────────

describe('watermark', () => {
  it('returns null watermark for fresh directory', () => {
    const wm = readWatermark(dir);
    expect(wm.lastMsgId).toBeNull();
    expect(wm.lastTs).toBeNull();
  });

  it('writes and reads back watermark', () => {
    writeWatermark(dir, { lastMsgId: 'msg-42', lastTs: '2026-04-21T00:00:00Z' });
    const wm = readWatermark(dir);
    expect(wm.lastMsgId).toBe('msg-42');
    expect(wm.lastTs).toBe('2026-04-21T00:00:00Z');
  });
});

// ─── Message Collection ──────────────────────────────────────

describe('collectNewMessages', () => {
  it('collects all messages when no watermark', () => {
    const group = mockGroup([
      { id: 'm1', role: 'user', text: 'hello' },
      { id: 'm2', role: 'assistant', text: 'hi' },
    ]);
    const { messages, lastMsg } = collectNewMessages(group, { lastMsgId: null });
    expect(messages).toHaveLength(2);
    expect(lastMsg.id).toBe('m2');
  });

  it('collects only messages after watermark', () => {
    const group = mockGroup([
      { id: 'm1', role: 'user', text: 'old' },
      { id: 'm2', role: 'user', text: 'new' },
      { id: 'm3', role: 'assistant', text: 'reply' },
    ]);
    const { messages } = collectNewMessages(group, { lastMsgId: 'm1' });
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe('m2');
  });

  it('respects maxMessages limit', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`, role: 'user', text: `msg ${i}`,
    }));
    const group = mockGroup(msgs);
    const { messages } = collectNewMessages(group, { lastMsgId: null }, { maxMessages: 3 });
    expect(messages).toHaveLength(3);
  });
});

// ─── Dedup Classification ────────────────────────────────────

describe('classifyCandidate', () => {
  it('returns is_new for empty existing', () => {
    const result = classifyCandidate({ body: 'hello world' }, []);
    expect(result.action).toBe('is_new');
  });

  it('returns is_duplicate for exact match', () => {
    const result = classifyCandidate(
      { body: 'User prefers TypeScript' },
      [{ id: 'e1', body: 'User prefers TypeScript' }],
    );
    expect(result.action).toBe('is_duplicate');
    expect(result.matchId).toBe('e1');
  });

  it('returns is_duplicate for case-insensitive exact match', () => {
    const result = classifyCandidate(
      { body: 'USER PREFERS TYPESCRIPT' },
      [{ id: 'e1', body: 'user prefers typescript' }],
    );
    expect(result.action).toBe('is_duplicate');
  });

  it('returns is_update for high word overlap', () => {
    const result = classifyCandidate(
      { body: 'User prefers TypeScript and uses ESLint with strict config' },
      [{ id: 'e1', body: 'User prefers TypeScript and uses ESLint for linting' }],
    );
    expect(result.action).toBe('is_update');
    expect(result.matchId).toBe('e1');
  });

  it('returns is_new for low overlap', () => {
    const result = classifyCandidate(
      { body: 'The team meets every Monday for standup' },
      [{ id: 'e1', body: 'User prefers dark mode in their editor' }],
    );
    expect(result.action).toBe('is_new');
  });
});

// ─── extractCandidates ──────────────────────────────────────

describe('extractCandidates', () => {
  it('returns empty array for no messages', async () => {
    const result = await extractCandidates({ messages: [], adapter: {}, config: {} });
    expect(result).toEqual([]);
  });

  it('parses LLM JSON response into candidates', async () => {
    const adapter = mockAdapter(JSON.stringify([
      { body: 'User prefers vim', kind: 'preference', tags: ['editor'], importance: 'normal' },
      { body: 'Working on dashboard app', kind: 'context', tags: ['project'], importance: 'high' },
    ]));
    const result = await extractCandidates({
      messages: [{ role: 'user', text: 'I use vim for the dashboard' }],
      adapter,
      config: { model: 'test' },
    });
    expect(result).toHaveLength(2);
    expect(result[0].body).toBe('User prefers vim');
    expect(result[0].kind).toBe('preference');
    expect(result[1].kind).toBe('context');
  });

  it('returns empty on LLM failure', async () => {
    const adapter = { call: vi.fn().mockRejectedValue(new Error('timeout')) };
    const result = await extractCandidates({
      messages: [{ role: 'user', text: 'hello' }],
      adapter,
      config: { model: 'test' },
    });
    expect(result).toEqual([]);
  });
});

// ─── Full dreamExtract pipeline ──────────────────────────────

describe('dreamExtract', () => {
  it('returns zeros when no group provided', async () => {
    const result = await dreamExtract({
      group: null,
      shardStore: {},
      adapter: {},
      config: {},
      memoryDir: dir,
    });
    expect(result.messagesRead).toBe(0);
    expect(result.written).toBe(0);
  });

  it('extracts and writes new entries to shard store', async () => {
    const group = mockGroup([
      { id: 'm1', role: 'user', text: 'I prefer dark mode', ts: '2026-04-21T01:00:00Z' },
      { id: 'm2', role: 'assistant', text: 'Noted!', ts: '2026-04-21T01:01:00Z' },
    ]);

    const storeDir = mkdtempSync(join(tmpdir(), 'dream-extract-store-'));
    const shardStore = openMemoryShardStore(storeDir, 'user');

    const adapter = mockAdapter(JSON.stringify([
      { body: 'User prefers dark mode', kind: 'preference', tags: ['ui'], importance: 'normal' },
    ]));

    const result = await dreamExtract({
      group,
      shardStore,
      adapter,
      config: { model: 'test' },
      memoryDir: dir,
    });

    expect(result.messagesRead).toBe(2);
    expect(result.candidatesExtracted).toBe(1);
    expect(result.written).toBe(1);
    expect(result.duplicatesSkipped).toBe(0);

    // Watermark should be advanced
    const wm = readWatermark(dir);
    expect(wm.lastMsgId).toBe('m2');

    rmSync(storeDir, { recursive: true });
  });

  it('advances watermark even when nothing extracted', async () => {
    const group = mockGroup([
      { id: 'm1', role: 'user', text: 'hi', ts: '2026-04-21T01:00:00Z' },
    ]);

    const storeDir = mkdtempSync(join(tmpdir(), 'dream-extract-store2-'));
    const shardStore = openMemoryShardStore(storeDir, 'user');
    const adapter = mockAdapter('[]');

    await dreamExtract({
      group,
      shardStore,
      adapter,
      config: { model: 'test' },
      memoryDir: dir,
    });

    const wm = readWatermark(dir);
    expect(wm.lastMsgId).toBe('m1');

    rmSync(storeDir, { recursive: true });
  });

  it('skips duplicate candidates against existing entries', async () => {
    const group = mockGroup([
      { id: 'm1', role: 'user', text: 'I like TypeScript', ts: '2026-04-21T01:00:00Z' },
    ]);

    const storeDir = mkdtempSync(join(tmpdir(), 'dream-extract-store3-'));
    const shardStore = openMemoryShardStore(storeDir, 'user');

    // Pre-populate with existing entry
    shardStore.put({
      id: 'existing-1',
      shard: 'preferences',
      kind: 'preference',
      body: 'User likes TypeScript',
      tags: ['lang'],
      sourceRef: { hint: 'test' },
      authoredBy: 'user:self',
    });

    // LLM returns exact duplicate
    const adapter = mockAdapter(JSON.stringify([
      { body: 'User likes TypeScript', kind: 'preference', tags: ['lang'], importance: 'normal' },
    ]));

    const result = await dreamExtract({
      group,
      shardStore,
      adapter,
      config: { model: 'test' },
      memoryDir: dir,
    });

    expect(result.duplicatesSkipped).toBe(1);
    expect(result.written).toBe(0);

    rmSync(storeDir, { recursive: true });
  });
});
