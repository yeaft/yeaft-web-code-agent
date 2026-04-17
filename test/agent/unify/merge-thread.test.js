/**
 * merge-thread.test.js — task-313
 *
 * Validates the thread-merge feature end-to-end (store + persistence +
 * message re-assignment), covering:
 *   - ThreadStore.mergeThread(): archives source, stamps mergedInto, rolls up
 *     counters onto the target, rejects invalid cases (self-merge, main
 *     thread source, double-merge, unknown ids), transfers attachments,
 *     moves currentId pointer when source was current.
 *   - ConversationStore.reassignThread(): every message with
 *     threadId === source gets threadId === target, sourceThreadId set to
 *     source, non-matching messages untouched, chronological sequence
 *     (m0001…mNNNN) preserved, idempotent on re-run.
 *   - Round-trip through persist/parse keeps sourceThreadId + mergedInto.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ThreadStore,
  MAIN_THREAD_ID,
  _serializeThread,
  _parseThread,
} from '../../../agent/unify/threads/store.js';
import { ConversationStore, parseMessage } from '../../../agent/unify/conversation/persist.js';

function scratch(prefix = 'yeaft-merge-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('ThreadStore.mergeThread (task-313)', () => {
  let dir;
  beforeEach(() => { dir = scratch(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('archives source, stamps mergedInto, rolls counters into target', () => {
    const s = new ThreadStore(dir);
    const src = s.create({ name: 'src' });
    const tgt = s.create({ name: 'tgt' });
    s.noteMessage(src.id, 1_700_000_000_000, { preview: 'a' });
    s.noteMessage(src.id, 1_700_000_001_000, { preview: 'b' });
    s.noteMessage(tgt.id, 1_700_000_002_000, { preview: 'c' });

    s.mergeThread(src.id, tgt.id);

    const source = s.get(src.id);
    const target = s.get(tgt.id);
    expect(source.status).toBe('archived');
    expect(source.archived).toBe(true);
    expect(source.mergedInto).toBe(tgt.id);
    expect(target.messageCount).toBe(3);
    expect(target.lastMessageAt).toBe(1_700_000_002_000);
  });

  it('rejects self-merge, main-thread source, unknown ids, and double-merge', () => {
    const s = new ThreadStore(dir);
    const a = s.create({ name: 'a' });
    const b = s.create({ name: 'b' });
    expect(() => s.mergeThread(a.id, a.id)).toThrow(/itself/);
    expect(() => s.mergeThread(MAIN_THREAD_ID, a.id)).toThrow(/main thread/);
    expect(() => s.mergeThread('missing', a.id)).toThrow(/not found/);
    expect(() => s.mergeThread(a.id, 'missing')).toThrow(/not found/);
    s.mergeThread(a.id, b.id);
    expect(() => s.mergeThread(a.id, b.id)).toThrow(/already merged/);
  });

  it('moves currentId pointer to target when source was current', () => {
    const s = new ThreadStore(dir);
    const src = s.create({ name: 'src' });
    const tgt = s.create({ name: 'tgt' });
    s.switch(src.id);
    expect(s.currentId).toBe(src.id);
    s.mergeThread(src.id, tgt.id);
    expect(s.currentId).toBe(tgt.id);
  });

  it('transfers attachment when target has none; keeps target attachment otherwise', () => {
    // Case 1: only source has task attached → transfers.
    const s1 = new ThreadStore(dir);
    const src = s1.create({ name: 'src' });
    const tgt = s1.create({ name: 'tgt' });
    s1.attachTask(src.id, 'task-X');
    s1.mergeThread(src.id, tgt.id);
    expect(s1.attachedTask(tgt.id)).toBe('task-X');
    expect(s1.attachedTask(src.id)).toBeFalsy();

    // Case 2: target already has its own attachment → target wins.
    const dir2 = scratch();
    try {
      const s2 = new ThreadStore(dir2);
      const src2 = s2.create({ name: 'src2' });
      const tgt2 = s2.create({ name: 'tgt2' });
      s2.attachTask(src2.id, 'task-A');
      s2.attachTask(tgt2.id, 'task-B');
      s2.mergeThread(src2.id, tgt2.id);
      expect(s2.attachedTask(tgt2.id)).toBe('task-B');
    } finally {
      try { rmSync(dir2, { recursive: true, force: true }); } catch {}
    }
  });

  it('persists mergedInto + archived status across reopen', () => {
    const s1 = new ThreadStore(dir);
    const src = s1.create({ name: 'src' });
    const tgt = s1.create({ name: 'tgt' });
    s1.mergeThread(src.id, tgt.id);
    s1.flush();

    const s2 = new ThreadStore(dir);
    const reloaded = s2.get(src.id);
    expect(reloaded.archived).toBe(true);
    expect(reloaded.mergedInto).toBe(tgt.id);
  });

  it('_serializeThread / _parseThread round-trips mergedInto', () => {
    const t = {
      id: 'thr-x', name: 'x', goal: '', parentThreadId: null,
      status: 'archived', archived: true, mergedInto: 'thr-y',
      messageCount: 0, lastMessageAt: null, lastActivityAt: null,
      unread: 0, preview: '', createdAt: 1, updatedAt: 2,
    };
    const parsed = _parseThread(_serializeThread(t));
    expect(parsed.mergedInto).toBe('thr-y');
    expect(parsed.archived).toBe(true);
  });
});

describe('ConversationStore.reassignThread (task-313)', () => {
  let dir;
  beforeEach(() => { dir = scratch('yeaft-conv-'); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('rewrites threadId and stamps sourceThreadId; other threads untouched', () => {
    const store = new ConversationStore(dir);
    const m1 = store.append({ role: 'user', content: 'hi',       threadId: 'src' });
    const m2 = store.append({ role: 'assistant', content: 'yo',  threadId: 'src' });
    const m3 = store.append({ role: 'user', content: 'ignored',  threadId: 'other' });

    const n = store.reassignThread('src', 'tgt');
    expect(n).toBe(2);

    const msgDir = join(dir, 'conversation', 'messages');
    const reload = (id) => parseMessage(readFileSync(join(msgDir, `${id}.md`), 'utf8'));
    expect(reload(m1.id).threadId).toBe('tgt');
    expect(reload(m1.id).sourceThreadId).toBe('src');
    expect(reload(m2.id).threadId).toBe('tgt');
    expect(reload(m2.id).sourceThreadId).toBe('src');
    expect(reload(m3.id).threadId).toBe('other');
    expect(reload(m3.id).sourceThreadId).toBeFalsy();
  });

  it('preserves chronological message order (m0001…mNNNN)', () => {
    const store = new ConversationStore(dir);
    const ids = [];
    ids.push(store.append({ role: 'user', content: 'a', threadId: 'src' }).id);
    ids.push(store.append({ role: 'user', content: 'b', threadId: 'tgt' }).id);
    ids.push(store.append({ role: 'user', content: 'c', threadId: 'src' }).id);
    ids.push(store.append({ role: 'user', content: 'd', threadId: 'tgt' }).id);

    store.reassignThread('src', 'tgt');

    // Files on disk still carry their original m000N id → chronological order intact.
    const msgDir = join(dir, 'conversation', 'messages');
    const onDisk = readdirSync(msgDir).filter(f => f.endsWith('.md')).sort();
    expect(onDisk).toEqual(ids.map(i => `${i}.md`).sort());
    expect(onDisk).toEqual(['m0001.md', 'm0002.md', 'm0003.md', 'm0004.md']);
  });

  it('idempotent — second run does not re-stamp sourceThreadId', () => {
    const store = new ConversationStore(dir);
    const m = store.append({ role: 'user', content: 'hi', threadId: 'src' });
    // First pass rewrites exactly the one matching message.
    expect(store.reassignThread('src', 'tgt')).toBe(1);
    // Second pass: threadId is now 'tgt' so nothing matches source='src'.
    expect(store.reassignThread('src', 'tgt')).toBe(0);
    const msgDir = join(dir, 'conversation', 'messages');
    const reloaded = parseMessage(readFileSync(join(msgDir, `${m.id}.md`), 'utf8'));
    expect(reloaded.sourceThreadId).toBe('src');
    expect(reloaded.threadId).toBe('tgt');
  });

  it('no-op for invalid args (empty / same id)', () => {
    const store = new ConversationStore(dir);
    store.append({ role: 'user', content: 'hi', threadId: 'src' });
    expect(store.reassignThread('', 'tgt')).toBe(0);
    expect(store.reassignThread('src', '')).toBe(0);
    expect(store.reassignThread('src', 'src')).toBe(0);
  });
});
