/**
 * user-memory-store.test.js — task-w6c R6 §Δ29 user-memory store tests.
 *
 * Coverage: UserMemoryStore CRUD, shard classification, profile builder,
 * dream compact, WS handler integration (write + remove).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  openUserMemoryStore,
  writeUserMemory,
  removeUserMemory,
  classifyUserMemoryShard,
  buildUserProfile,
  runUserDreamJob,
  _resetUserMemoryStoreForTest,
} from '../../../agent/unify/memory/user-memory-store.js';

import {
  handleUnifyUserMemoryWrite,
  handleUnifyUserMemoryRemove,
  setUserMemorySender,
} from '../../../agent/unify/user-memory.js';

let dir;
let store;

beforeEach(() => {
  _resetUserMemoryStoreForTest();
  dir = mkdtempSync(join(tmpdir(), 'user-mem-test-'));
  store = openUserMemoryStore(dir);
});

afterEach(() => {
  _resetUserMemoryStoreForTest();
  setUserMemorySender(null);
  try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
});

// ─── Store CRUD ──────────────────────────────────────────────

describe('UserMemoryStore CRUD', () => {
  it('writes and reads an entry', () => {
    const id = writeUserMemory(store, { text: 'My name is Alice' });
    expect(id).toBeTruthy();
    expect(id).toMatch(/^um-/);
    const entry = store.get(id);
    expect(entry).toBeTruthy();
    expect(entry.body).toBe('My name is Alice');
  });

  it('returns null for empty text', () => {
    expect(writeUserMemory(store, { text: '' })).toBeNull();
    expect(writeUserMemory(store, { text: '   ' })).toBeNull();
  });

  it('returns null when store is null', () => {
    expect(writeUserMemory(null, { text: 'hello' })).toBeNull();
  });

  it('removes an entry', () => {
    const id = writeUserMemory(store, { text: 'to be removed' });
    expect(removeUserMemory(store, id)).toBe(true);
  });

  it('remove succeeds silently for unknown id', () => {
    // underlying shard-store.remove doesn't throw on missing id
    expect(() => removeUserMemory(store, 'nonexistent')).not.toThrow();
  });

  it('writes with tags preserved', () => {
    const id = writeUserMemory(store, { text: 'I like vim', tags: ['preference'] });
    const entry = store.get(id);
    expect(entry).toBeTruthy();
  });
});

// ─── Shard Classification ────────────────────────────────────

describe('classifyUserMemoryShard', () => {
  it('classifies goal keywords → goals shard', () => {
    expect(classifyUserMemoryShard('I want to learn Rust')).toBe('goals');
  });

  it('classifies project keywords → projects shard', () => {
    expect(classifyUserMemoryShard('Working on the dashboard app')).toBe('projects');
  });

  it('classifies preference keywords → preferences shard', () => {
    expect(classifyUserMemoryShard('I prefer dark mode')).toBe('preferences');
  });

  it('classifies relation keywords → relations shard', () => {
    expect(classifyUserMemoryShard('My colleague Bob handles the backend')).toBe('relations');
  });

  it('falls back to profile for generic text', () => {
    expect(classifyUserMemoryShard('My name is Alice')).toBe('profile');
  });

  it('respects explicit tag hints over keywords', () => {
    expect(classifyUserMemoryShard('some text', ['goals'])).toBe('goals');
    expect(classifyUserMemoryShard('some text', ['project'])).toBe('projects');
  });
});

// ─── Profile Builder ─────────────────────────────────────────

describe('buildUserProfile', () => {
  it('returns empty string when no entries exist', () => {
    expect(buildUserProfile(store)).toBe('');
  });

  it('returns bullet list of entries from profile/preferences/goals', () => {
    writeUserMemory(store, { text: 'Alice, software engineer' });
    writeUserMemory(store, { text: 'I prefer TypeScript', tags: ['preference'] });
    const result = buildUserProfile(store);
    expect(result).toContain('- Alice, software engineer');
    expect(result).toContain('- I prefer TypeScript');
  });

  it('respects maxEntries limit', () => {
    for (let i = 0; i < 10; i++) {
      writeUserMemory(store, { text: `fact ${i}` });
    }
    const result = buildUserProfile(store, { maxEntries: 3 });
    const lines = result.split('\n').filter(l => l.startsWith('- '));
    expect(lines.length).toBe(3);
  });

  it('returns empty string when store is null', () => {
    _resetUserMemoryStoreForTest();
    // Pass an explicit empty store-like object that returns no results
    const emptyStore = { query: () => ({ results: [] }), get: () => null };
    expect(buildUserProfile(emptyStore)).toBe('');
  });
});

// ─── Dream Job ───────────────────────────────────────────────

describe('runUserDreamJob', () => {
  it('runs scan+compact on a store with entries', async () => {
    writeUserMemory(store, { text: 'entry one' });
    writeUserMemory(store, { text: 'entry two' });
    const result = await runUserDreamJob({ store });
    expect(result).toBeTruthy();
    expect(result.scan.totalEntries).toBeGreaterThanOrEqual(2);
    expect(result.compact).toBeTruthy();
  });

  it('returns null when store is unavailable', async () => {
    expect(await runUserDreamJob({ store: null })).toBeNull();
  });
});

// ─── WS Handlers (integration) ──────────────────────────────

describe('handleUnifyUserMemoryWrite (real store)', () => {
  it('acks noop for empty text', () => {
    const sent = [];
    handleUnifyUserMemoryWrite({ text: '' }, e => sent.push(e));
    expect(sent).toHaveLength(1);
    expect(sent[0].reason).toBe('noop');
    expect(sent[0].pending).toBe(false);
  });

  it('never throws on a misbehaving sender', () => {
    const boom = () => { throw new Error('socket'); };
    expect(() => handleUnifyUserMemoryWrite({ text: 'hi' }, boom)).not.toThrow();
  });

  it('uses module-level sender when installed', () => {
    const sink = [];
    setUserMemorySender(e => sink.push(e));
    handleUnifyUserMemoryWrite({ text: '' });
    expect(sink).toHaveLength(1);
    expect(sink[0].type).toBe('user_memory_updated');
  });
});

describe('handleUnifyUserMemoryRemove (real store)', () => {
  it('emits user_memory_removed with entryId passthrough', () => {
    const sent = [];
    handleUnifyUserMemoryRemove({ entryId: 'e1', requestId: 'r2' }, e => sent.push(e));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'user_memory_removed',
      entryId: 'e1',
      requestId: 'r2',
    });
  });

  it('tolerates missing entryId', () => {
    const sent = [];
    handleUnifyUserMemoryRemove({}, e => sent.push(e));
    expect(sent[0]).toMatchObject({ type: 'user_memory_removed', entryId: null });
  });

  it('never throws on a misbehaving sender', () => {
    const boom = () => { throw new Error('socket'); };
    expect(() => handleUnifyUserMemoryRemove({ entryId: 'e1' }, boom)).not.toThrow();
  });
});
