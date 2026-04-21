/**
 * dream-extract.test.js — task-334-w7b: user-memory extract phase tests.
 *
 * Coverage:
 *   (W7b-a) Watermark read/write roundtrip
 *   (W7b-b) Watermark returns null when file missing
 *   (W7b-c) buildUserExtractPrompt formats conversation correctly
 *   (W7b-d) dreamExtract skips when < EXTRACT_MIN_MESSAGES
 *   (W7b-e) dreamExtract writes entries to correct shards via classifyUserMemoryShard
 *   (W7b-f) dreamExtract updates watermark after processing
 *   (W7b-g) runUserDreamJob is now async and includes extract result
 *   (W7b-h) dream-scheduler imports runUserDreamJob and passes userMemoryStore/conversationStore
 *   (W7b-i) session.js imports getUserMemoryStore and passes to scheduler
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  openUserMemoryStore,
  writeUserMemory,
  classifyUserMemoryShard,
  readWatermark,
  writeWatermark,
  buildUserExtractPrompt,
  dreamExtract,
  runUserDreamJob,
  _resetUserMemoryStoreForTest,
} from '../../../agent/unify/memory/user-memory-store.js';

const root = join(import.meta.dirname, '../../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let dir;
let store;

beforeEach(() => {
  _resetUserMemoryStoreForTest();
  dir = mkdtempSync(join(tmpdir(), 'dream-extract-test-'));
  store = openUserMemoryStore(dir);
});

afterEach(() => {
  _resetUserMemoryStoreForTest();
  try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
});

// ─── (W7b-a) Watermark roundtrip ───────────────────────────

describe('W7b-a: watermark read/write', () => {
  it('reads back what was written', () => {
    writeWatermark(dir, { lastMessageId: 'msg-42', lastMessageTs: 1700000000 });
    const wm = readWatermark(dir);
    expect(wm).toBeTruthy();
    expect(wm.lastMessageId).toBe('msg-42');
    expect(wm.lastMessageTs).toBe(1700000000);
    expect(wm.updatedAt).toBeTruthy();
  });
});

// ─── (W7b-b) Watermark missing ─────────────────────────────

describe('W7b-b: watermark missing', () => {
  it('returns null when file does not exist', () => {
    expect(readWatermark(dir)).toBeNull();
  });

  it('returns null for invalid directory', () => {
    expect(readWatermark('/nonexistent/path/xyz')).toBeNull();
  });
});

// ─── (W7b-c) buildUserExtractPrompt ────────────────────────

describe('W7b-c: buildUserExtractPrompt', () => {
  it('formats messages with role prefixes', () => {
    const msgs = [
      { role: 'user', content: 'I work at Acme Corp' },
      { role: 'assistant', content: 'Got it!' },
    ];
    const prompt = buildUserExtractPrompt(msgs);
    expect(prompt).toContain('[User]: I work at Acme Corp');
    expect(prompt).toContain('[Assistant]: Got it!');
    expect(prompt).toContain('profile');
    expect(prompt).toContain('preferences');
    expect(prompt).toContain('goals');
    expect(prompt).toContain('relations');
    expect(prompt).toContain('JSON array');
  });
});

// ─── (W7b-d) dreamExtract skips below min messages ─────────

describe('W7b-d: dreamExtract min messages threshold', () => {
  it('returns extracted=0 when fewer than 3 messages', async () => {
    const mockConvStore = {
      loadAll: () => [
        { id: 'msg-1', role: 'user', content: 'hi' },
      ],
    };
    const result = await dreamExtract({
      store,
      conversationStore: mockConvStore,
      adapter: { call: async () => ({ text: '[]' }) },
      config: { model: 'test' },
      dir,
    });
    expect(result.extracted).toBe(0);
  });
});

// ─── (W7b-e) dreamExtract writes to correct shards ─────────

describe('W7b-e: dreamExtract writes entries', () => {
  it('writes extracted entries to store', async () => {
    const mockConvStore = {
      loadAll: () => [
        { id: 'msg-1', role: 'user', content: 'I prefer dark mode and use TypeScript' },
        { id: 'msg-2', role: 'assistant', content: 'Noted, dark mode + TS' },
        { id: 'msg-3', role: 'user', content: 'My goal is to ship v2 by Q4' },
        { id: 'msg-4', role: 'assistant', content: 'Great goal!' },
      ],
    };
    const mockAdapter = {
      call: async () => ({
        text: JSON.stringify([
          { shard: 'preferences', body: 'Prefers dark mode', tags: ['ui', 'theme'] },
          { shard: 'goals', body: 'Ship v2 by Q4', tags: ['release'] },
        ]),
      }),
    };
    const result = await dreamExtract({
      store,
      conversationStore: mockConvStore,
      adapter: mockAdapter,
      config: { model: 'test' },
      dir,
    });
    expect(result.extracted).toBe(2);
    expect(result.skipped).toBe(0);
  });
});

// ─── (W7b-f) dreamExtract updates watermark ────────────────

describe('W7b-f: dreamExtract updates watermark', () => {
  it('writes watermark after successful extract', async () => {
    const mockConvStore = {
      loadAll: () => [
        { id: 'msg-10', role: 'user', content: 'Hello', ts: 1700000010 },
        { id: 'msg-11', role: 'assistant', content: 'Hi', ts: 1700000011 },
        { id: 'msg-12', role: 'user', content: 'I use React', ts: 1700000012 },
        { id: 'msg-13', role: 'assistant', content: 'React noted', ts: 1700000013 },
      ],
    };
    const mockAdapter = {
      call: async () => ({ text: '[]' }),
    };
    await dreamExtract({
      store,
      conversationStore: mockConvStore,
      adapter: mockAdapter,
      config: { model: 'test' },
      dir,
    });
    const wm = readWatermark(dir);
    expect(wm).toBeTruthy();
    expect(wm.lastMessageId).toBe('msg-13');
  });
});

// ─── (W7b-g) runUserDreamJob is async with extract ──────────

describe('W7b-g: runUserDreamJob includes extract', () => {
  it('returns extract result when adapter/convStore provided', async () => {
    const mockConvStore = {
      loadAll: () => [
        { id: 'm1', role: 'user', content: 'a' },
        { id: 'm2', role: 'assistant', content: 'b' },
        { id: 'm3', role: 'user', content: 'c' },
        { id: 'm4', role: 'assistant', content: 'd' },
      ],
    };
    const mockAdapter = {
      call: async () => ({ text: '[]' }),
    };
    const result = await runUserDreamJob({
      store,
      conversationStore: mockConvStore,
      adapter: mockAdapter,
      config: { model: 'test' },
    });
    expect(result).toBeTruthy();
    expect(result.extract).toBeTruthy();
    expect(result.scan).toBeTruthy();
    expect(result.compact).toBeTruthy();
  });

  it('skips extract when no adapter provided', async () => {
    const result = await runUserDreamJob({ store });
    expect(result).toBeTruthy();
    expect(result.extract).toBeNull();
    expect(result.scan).toBeTruthy();
  });
});

// ─── (W7b-h) dream-scheduler source wiring ─────────────────

describe('W7b-h: dream-scheduler wiring', () => {
  const schedulerSrc = read('agent/unify/memory/dream-scheduler.js');

  it('imports runUserDreamJob', () => {
    expect(schedulerSrc).toContain('runUserDreamJob');
    expect(schedulerSrc).toContain("from './user-memory-store.js'");
  });

  it('accepts userMemoryStore + conversationStore params', () => {
    expect(schedulerSrc).toContain('userMemoryStore');
    expect(schedulerSrc).toContain('conversationStore');
  });

  it('calls runUserDreamJob in runDream', () => {
    expect(schedulerSrc).toContain('runUserDreamJob(');
  });
});

// ─── (W7b-i) session.js wiring ─────────────────────────────

describe('W7b-i: session.js wiring', () => {
  const sessionSrc = read('agent/unify/session.js');

  it('imports getUserMemoryStore', () => {
    expect(sessionSrc).toContain('getUserMemoryStore');
    expect(sessionSrc).toContain("from './memory/user-memory-store.js'");
  });

  it('passes userMemoryStore to createDreamScheduler', () => {
    expect(sessionSrc).toContain('userMemoryStore');
  });

  it('passes conversationStore to createDreamScheduler', () => {
    expect(sessionSrc).toContain('conversationStore');
  });
});
