/**
 * fork-thread.test.js — task-314
 *
 * Validates the fork-from-message feature end-to-end:
 *   - ThreadStore.forkThread(): mints a new thread with a `forkedFrom`
 *     triple (threadId/messageId/timestamp), inherits parentThreadId =
 *     source, applies default name ("{src.name}-fork" or "inbox-fork"),
 *     rejects archived sources / missing args.
 *   - ConversationStore.copyThreadUpTo(): copies only messages with
 *     threadId === source and seq ≤ cutoff, stamps sourceThreadId,
 *     preserves chronological order, leaves source files untouched
 *     (critical invariant), supports chain-fork (keeps original pill).
 *   - Persistence round-trip keeps forkedFrom across reopen.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ThreadStore,
  MAIN_THREAD_ID,
  _serializeThread,
  _parseThread,
} from '../../../agent/unify/threads/store.js';
import { ConversationStore, parseMessage } from '../../../agent/unify/conversation/persist.js';

function scratch(prefix = 'yeaft-fork-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('ThreadStore.forkThread (task-314)', () => {
  let dir;
  beforeEach(() => { dir = scratch(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('creates new thread with forkedFrom triple and parentThreadId=source', () => {
    const s = new ThreadStore(dir);
    const src = s.create({ name: 'design' });
    const forked = s.forkThread(src.id, 'm0007');
    expect(forked.id).not.toBe(src.id);
    expect(forked.name).toBe('design-fork');
    expect(forked.parentThreadId).toBe(src.id);
    expect(forked.forkedFrom).toEqual({
      threadId: src.id,
      messageId: 'm0007',
      timestamp: expect.any(Number),
    });
    // Source is untouched.
    expect(s.get(src.id).archived).toBeFalsy();
    expect(s.get(src.id).status).not.toBe('archived');
  });

  it('falls back to "inbox-fork" when source is the main thread', () => {
    const s = new ThreadStore(dir);
    const forked = s.forkThread(MAIN_THREAD_ID, 'm0001');
    expect(forked.name).toBe('inbox-fork');
    expect(forked.parentThreadId).toBe(MAIN_THREAD_ID);
  });

  it('honours opts.name override when provided', () => {
    const s = new ThreadStore(dir);
    const src = s.create({ name: 'src' });
    const forked = s.forkThread(src.id, 'm0001', { name: 'alt-branch' });
    expect(forked.name).toBe('alt-branch');
  });

  it('rejects missing sourceId / missing atMessageId / unknown source / archived source', () => {
    const s = new ThreadStore(dir);
    expect(() => s.forkThread('', 'm0001')).toThrow(/sourceId/);
    const a = s.create({ name: 'a' });
    expect(() => s.forkThread(a.id, '')).toThrow(/atMessageId/);
    expect(() => s.forkThread('nope', 'm0001')).toThrow(/not found/);
    // Archive and verify reject.
    const b = s.create({ name: 'b' });
    s.mergeThread(a.id, b.id); // a is now archived
    expect(() => s.forkThread(a.id, 'm0001')).toThrow(/archived/);
  });

  it('persists forkedFrom across reopen', () => {
    const s1 = new ThreadStore(dir);
    const src = s1.create({ name: 'src' });
    const forked = s1.forkThread(src.id, 'm0003');
    s1.flush();

    const s2 = new ThreadStore(dir);
    const reloaded = s2.get(forked.id);
    expect(reloaded.forkedFrom).toBeTruthy();
    expect(reloaded.forkedFrom.threadId).toBe(src.id);
    expect(reloaded.forkedFrom.messageId).toBe('m0003');
    expect(typeof reloaded.forkedFrom.timestamp).toBe('number');
  });

  it('_serializeThread / _parseThread round-trips forkedFrom', () => {
    const t = {
      id: 'thr-x', name: 'x', goal: '', parentThreadId: 'thr-src',
      status: 'active', archived: false, mergedInto: null,
      forkedFrom: { threadId: 'thr-src', messageId: 'm0042', timestamp: 1_700_000_000_000 },
      messageCount: 0, lastMessageAt: null, lastActivityAt: null,
      unread: 0, preview: '', createdAt: 1, updatedAt: 2,
    };
    const parsed = _parseThread(_serializeThread(t));
    expect(parsed.forkedFrom).toEqual(t.forkedFrom);
  });
});

describe('ConversationStore.copyThreadUpTo (task-314)', () => {
  let dir;
  beforeEach(() => { dir = scratch('yeaft-conv-fork-'); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('copies source messages into target per-thread namespace (m0001..mNNNN restart)', () => {
    const store = new ConversationStore(dir);
    const m1 = store.append({ role: 'user',      content: 'a', threadId: 'src' });   // m0001
    const m2 = store.append({ role: 'assistant', content: 'b', threadId: 'src' });   // m0002
    const m3 = store.append({ role: 'user',      content: 'x', threadId: 'other' }); // m0003
    const m4 = store.append({ role: 'user',      content: 'c', threadId: 'src' });   // m0004 (post-cutoff)

    const n = store.copyThreadUpTo('src', 'tgt', m2.id);
    expect(n).toBe(2);

    // Legacy flat dir is UNCHANGED (source invariant).
    const flatDir = join(dir, 'conversation', 'messages');
    const flat = readdirSync(flatDir).filter(f => f.endsWith('.md')).sort();
    expect(flat).toEqual(['m0001.md', 'm0002.md', 'm0003.md', 'm0004.md']);

    // Target thread owns its own namespace at conversation/threads/tgt/messages/
    const tgtDir = join(dir, 'conversation', 'threads', 'tgt', 'messages');
    const tgtFiles = readdirSync(tgtDir).filter(f => f.endsWith('.md')).sort();
    expect(tgtFiles).toEqual(['m0001.md', 'm0002.md']);

    // Verify content + stamps on the new copies.
    const c1 = parseMessage(readFileSync(join(tgtDir, 'm0001.md'), 'utf8'));
    const c2 = parseMessage(readFileSync(join(tgtDir, 'm0002.md'), 'utf8'));
    expect(c1).toMatchObject({ id: 'm0001', threadId: 'tgt', sourceThreadId: 'src', content: 'a' });
    expect(c2).toMatchObject({ id: 'm0002', threadId: 'tgt', sourceThreadId: 'src', content: 'b' });

    // load(threadId) — returns per-thread scope only.
    const loaded = store.load('tgt');
    expect(loaded.map(m => m.id)).toEqual(['m0001', 'm0002']);
    expect(loaded.every(m => m.threadId === 'tgt')).toBe(true);

    // Source thread load still returns source files unchanged.
    const srcLoaded = store.load('src');
    expect(srcLoaded.map(m => m.id).sort()).toEqual(['m0001', 'm0002', 'm0004']);
    expect(srcLoaded.every(m => m.sourceThreadId == null)).toBe(true);

    // Unrelated 'other' thread untouched.
    expect(store.load('other').map(m => m.id)).toEqual(['m0003']);

    // m4 (post-cutoff src msg) was NOT copied to target.
    const m4raw = parseMessage(readFileSync(join(flatDir, `${m4.id}.md`), 'utf8'));
    expect(m4raw.threadId).toBe('src');
  });

  it('cross-thread m0001 id collision: same basename, different directories, load() per-thread', () => {
    const store = new ConversationStore(dir);
    // Src exists as legacy flat file m0001.md.
    store.append({ role: 'user', content: 'src-first', threadId: 'src' }); // m0001 in flat dir
    // Fork 1: creates tgt-A/messages/m0001.md (same basename, different dir).
    expect(store.copyThreadUpTo('src', 'tgt-A', 'm0001')).toBe(1);
    // Fork 2: creates tgt-B/messages/m0001.md (another same-basename collision).
    expect(store.copyThreadUpTo('src', 'tgt-B', 'm0001')).toBe(1);

    // Every thread scopes cleanly by load(threadId) — no cross-contamination.
    const srcMsgs = store.load('src');
    const aMsgs = store.load('tgt-A');
    const bMsgs = store.load('tgt-B');
    expect(srcMsgs).toHaveLength(1);
    expect(srcMsgs[0]).toMatchObject({ id: 'm0001', threadId: 'src', content: 'src-first' });
    expect(aMsgs).toHaveLength(1);
    expect(aMsgs[0]).toMatchObject({ id: 'm0001', threadId: 'tgt-A', sourceThreadId: 'src' });
    expect(bMsgs).toHaveLength(1);
    expect(bMsgs[0]).toMatchObject({ id: 'm0001', threadId: 'tgt-B', sourceThreadId: 'src' });

    // Round-trip: reopen store, per-thread scope still holds.
    const store2 = new ConversationStore(dir);
    expect(store2.load('src').map(m => m.id)).toEqual(['m0001']);
    expect(store2.load('tgt-A').map(m => m.id)).toEqual(['m0001']);
    expect(store2.load('tgt-B').map(m => m.id)).toEqual(['m0001']);
  });

  it('chain fork preserves the original sourceThreadId pill', () => {
    const store = new ConversationStore(dir);
    // Seed fork-A with a message sourced from 'origin' (simulating a
    // message already in a fork of a fork).
    store.append({ role: 'user', content: 'orig', threadId: 'fork-A', sourceThreadId: 'origin' });

    const n = store.copyThreadUpTo('fork-A', 'fork-B', 'm0001');
    expect(n).toBe(1);

    const copy = store.load('fork-B')[0];
    expect(copy.id).toBe('m0001'); // per-thread restart
    expect(copy.threadId).toBe('fork-B');
    // IMPORTANT: keep the ORIGINAL source, not the immediate one.
    expect(copy.sourceThreadId).toBe('origin');
  });

  it('tolerates numeric-only atMessageId (e.g. "1" for m0001)', () => {
    const store = new ConversationStore(dir);
    store.append({ role: 'user', content: 'a', threadId: 'src' }); // m0001
    store.append({ role: 'user', content: 'b', threadId: 'src' }); // m0002
    expect(store.copyThreadUpTo('src', 'tgt', '1')).toBe(1);
    expect(store.load('tgt').map(m => m.id)).toEqual(['m0001']);
  });

  it('no-op for invalid args (empty / same-id / malformed cutoff)', () => {
    const store = new ConversationStore(dir);
    store.append({ role: 'user', content: 'x', threadId: 'src' });
    expect(store.copyThreadUpTo('', 'tgt', 'm0001')).toBe(0);
    expect(store.copyThreadUpTo('src', '', 'm0001')).toBe(0);
    expect(store.copyThreadUpTo('src', 'src', 'm0001')).toBe(0);
    expect(store.copyThreadUpTo('src', 'tgt', '')).toBe(0);
    expect(store.copyThreadUpTo('src', 'tgt', 'not-a-msg-id')).toBe(0);
  });
});
