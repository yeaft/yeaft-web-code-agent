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

  it('copies only source messages up to and including cutoff; other threads ignored', () => {
    const store = new ConversationStore(dir);
    const m1 = store.append({ role: 'user',      content: 'a', threadId: 'src' });   // m0001
    const m2 = store.append({ role: 'assistant', content: 'b', threadId: 'src' });   // m0002
    const m3 = store.append({ role: 'user',      content: 'x', threadId: 'other' }); // m0003
    const m4 = store.append({ role: 'user',      content: 'c', threadId: 'src' });   // m0004 (post-cutoff)

    const n = store.copyThreadUpTo('src', 'tgt', m2.id);
    expect(n).toBe(2);

    const msgDir = join(dir, 'conversation', 'messages');
    const onDisk = readdirSync(msgDir).filter(f => f.endsWith('.md')).sort();
    // Expect originals plus 2 new copies appended with fresh ids.
    expect(onDisk).toEqual(['m0001.md', 'm0002.md', 'm0003.md', 'm0004.md', 'm0005.md', 'm0006.md']);

    // Source files untouched.
    const src1 = parseMessage(readFileSync(join(msgDir, `${m1.id}.md`), 'utf8'));
    const src2 = parseMessage(readFileSync(join(msgDir, `${m2.id}.md`), 'utf8'));
    expect(src1.threadId).toBe('src');
    expect(src1.sourceThreadId).toBeFalsy();
    expect(src2.threadId).toBe('src');
    expect(src2.sourceThreadId).toBeFalsy();

    // The two newest files are the copies → threadId=tgt, sourceThreadId=src.
    const c5 = parseMessage(readFileSync(join(msgDir, 'm0005.md'), 'utf8'));
    const c6 = parseMessage(readFileSync(join(msgDir, 'm0006.md'), 'utf8'));
    expect(c5.threadId).toBe('tgt');
    expect(c5.sourceThreadId).toBe('src');
    expect(c6.threadId).toBe('tgt');
    expect(c6.sourceThreadId).toBe('src');
    // Chronological content preserved.
    expect(c5.content).toBe('a');
    expect(c6.content).toBe('b');

    // m4 (post-cutoff src msg) was NOT copied.
    const m4raw = parseMessage(readFileSync(join(msgDir, `${m4.id}.md`), 'utf8'));
    expect(m4raw.threadId).toBe('src');
  });

  it('chain fork preserves the original sourceThreadId pill', () => {
    const store = new ConversationStore(dir);
    // First, seed a message that itself was sourced from an earlier thread
    // (simulating a message already in a fork of a fork).
    store.append({ role: 'user', content: 'orig', threadId: 'fork-A', sourceThreadId: 'origin' });
    const cutoff = 'm0001';

    const n = store.copyThreadUpTo('fork-A', 'fork-B', cutoff);
    expect(n).toBe(1);

    const msgDir = join(dir, 'conversation', 'messages');
    const copy = parseMessage(readFileSync(join(msgDir, 'm0002.md'), 'utf8'));
    expect(copy.threadId).toBe('fork-B');
    // IMPORTANT: keep the ORIGINAL source, not the immediate one.
    expect(copy.sourceThreadId).toBe('origin');
  });

  it('tolerates numeric-only atMessageId (e.g. "7" for m0007)', () => {
    const store = new ConversationStore(dir);
    store.append({ role: 'user', content: 'a', threadId: 'src' }); // m0001
    store.append({ role: 'user', content: 'b', threadId: 'src' }); // m0002
    expect(store.copyThreadUpTo('src', 'tgt', '1')).toBe(1);
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
