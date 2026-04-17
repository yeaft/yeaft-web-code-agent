/**
 * unify-phase2-input-queue.test.js — task-307b
 *
 * Covers:
 *   - InputQueueStore state machine (enqueue → claim → markRouted)
 *   - markFailed puts entry back to 'pending' with error recorded
 *   - Crash recovery: 'routing' entries at load time become 'pending'
 *   - Round-trip across reopen
 *   - In-memory mode (no yeaftDir)
 *   - messages threadId migration: adds `threadId: main` to legacy files,
 *     preserves pre-stamped threadIds, idempotent second run via marker
 *   - persist.js serializeMessage now emits threadId; parseMessage reads it
 *     back and defaults legacy absence to 'main'.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  InputQueueStore,
  INPUT_QUEUE_STATUSES,
} from '../../agent/unify/input-queue/store.js';
import { migrateMessagesThreadId } from '../../agent/unify/conversation/migrate-messages-threadid.js';
import { ConversationStore, parseMessage } from '../../agent/unify/conversation/persist.js';

let tmp;
beforeEach(async () => { tmp = await fs.mkdtemp(join(tmpdir(), 'yeaft-307b-')); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('InputQueueStore (task-307b)', () => {
  it('design §5 status enum is pending / routing / dispatched', () => {
    expect(INPUT_QUEUE_STATUSES.sort()).toEqual(['dispatched', 'pending', 'routing']);
  });

  it('enqueue persists a pending entry as <id>.json', () => {
    const q = new InputQueueStore(tmp);
    const e = q.enqueue('hello world');
    expect(e.status).toBe('pending');
    const path = join(tmp, 'input-queue', `${e.id}.json`);
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.text).toBe('hello world');
    expect(raw.status).toBe('pending');
    expect(raw.routedTo).toBeNull();
  });

  it('state machine: enqueue → claim → markRouted', () => {
    const q = new InputQueueStore(tmp);
    const a = q.enqueue('a');
    const b = q.enqueue('b');

    expect(q.peek().id).toBe(a.id);
    expect(q.pendingCount()).toBe(2);

    const claimed = q.claim();
    expect(claimed.id).toBe(a.id);
    expect(claimed.status).toBe('routing');
    expect(q.pendingCount()).toBe(1);
    // Disk reflects transition.
    const raw = JSON.parse(readFileSync(join(tmp, 'input-queue', `${a.id}.json`), 'utf8'));
    expect(raw.status).toBe('routing');

    const done = q.markRouted(a.id, 'thr-xyz');
    expect(done.status).toBe('dispatched');
    expect(done.routedTo).toBe('thr-xyz');
    expect(q.get(a.id)).toBeNull();
    expect(existsSync(join(tmp, 'input-queue', `${a.id}.json`))).toBe(false);
    expect(q.pendingCount()).toBe(1);
    expect(q.peek().id).toBe(b.id);
  });

  it('markFailed returns entry to pending with error recorded', () => {
    const q = new InputQueueStore(tmp);
    const e = q.enqueue('retry-me');
    q.claim();
    q.markFailed(e.id, new Error('boom'));
    const after = q.get(e.id);
    expect(after.status).toBe('pending');
    expect(after.error).toMatch(/boom/);
    // Next claim() picks it up again.
    expect(q.claim().id).toBe(e.id);
  });

  it('crash recovery: routing entries on disk come back as pending', () => {
    const q1 = new InputQueueStore(tmp);
    const e = q1.enqueue('survive-me');
    q1.claim();
    expect(q1.get(e.id).status).toBe('routing');

    // Simulate a crash by opening a fresh store over the same dir.
    const q2 = new InputQueueStore(tmp);
    expect(q2.get(e.id).status).toBe('pending');
    expect(q2.claim().id).toBe(e.id);
  });

  it('round-trips pending entries across reopen', () => {
    const q = new InputQueueStore(tmp);
    const a = q.enqueue('a');
    const b = q.enqueue('b');
    expect(q.size()).toBe(2);

    const q2 = new InputQueueStore(tmp);
    expect(q2.size()).toBe(2);
    const list = q2.list('pending');
    expect(list.map(e => e.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('list(status) filters by status', () => {
    const q = new InputQueueStore(tmp);
    q.enqueue('a');
    const b = q.enqueue('b');
    q.claim(); // a → routing
    expect(q.list('pending').map(e => e.id)).toEqual([b.id]);
    expect(q.list('routing').length).toBe(1);
    expect(q.list('dispatched').length).toBe(0);
    expect(q.list().length).toBe(2); // no filter = all
  });

  it('remove() deletes memory + file', () => {
    const q = new InputQueueStore(tmp);
    const e = q.enqueue('bye');
    const path = join(tmp, 'input-queue', `${e.id}.json`);
    expect(existsSync(path)).toBe(true);
    expect(q.remove(e.id)).toBe(true);
    expect(q.get(e.id)).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(q.remove('iq-nope')).toBe(false);
  });

  it('in-memory mode (no yeaftDir) — no dir created, still functional', () => {
    const q = new InputQueueStore();
    expect(q.persistent).toBe(false);
    const e = q.enqueue('x');
    q.claim();
    q.markRouted(e.id, 'main');
    expect(q.size()).toBe(0);
  });

  it('rejects non-string text / missing routedTo', () => {
    const q = new InputQueueStore(tmp);
    expect(() => q.enqueue(42)).toThrow(/text must be a string/);
    const e = q.enqueue('ok');
    expect(() => q.markRouted(e.id)).toThrow(/routedTo required/);
  });
});

describe('messages threadId migration (task-307b)', () => {
  function seedLegacyMessage(dir, name, extraFm = '') {
    const path = join(dir, name);
    const raw =
      '---\n' +
      'id: m0001\n' +
      'role: user\n' +
      'time: 2026-04-01T00:00:00Z\n' +
      extraFm +
      '---\n' +
      '\n' +
      'legacy body\n';
    writeFileSync(path, raw, 'utf8');
    return path;
  }

  it('adds threadId: main to legacy messages; preserves modern ones; idempotent', () => {
    const convDir = join(tmp, 'conversation');
    const msgDir = join(convDir, 'messages');
    const coldDir = join(convDir, 'cold');
    mkdirSync(msgDir, { recursive: true });
    mkdirSync(coldDir, { recursive: true });

    const legacyHot = seedLegacyMessage(msgDir, 'm0001.md');
    const legacyCold = seedLegacyMessage(coldDir, 'm0002.md');
    const modern = seedLegacyMessage(msgDir, 'm0003.md', 'threadId: thr-already\n');

    const r1 = migrateMessagesThreadId(tmp);
    expect(r1.ran).toBe(true);
    expect(r1.migrated).toBe(2);
    expect(r1.skipped).toBeGreaterThanOrEqual(1);

    expect(readFileSync(legacyHot, 'utf8')).toMatch(/threadId: main/);
    expect(readFileSync(legacyCold, 'utf8')).toMatch(/threadId: main/);
    // Modern message keeps its explicit threadId and is NOT overwritten.
    const modernRaw = readFileSync(modern, 'utf8');
    expect(modernRaw).toMatch(/threadId: thr-already/);
    expect(modernRaw).not.toMatch(/threadId: main/);

    // Marker file written.
    expect(existsSync(join(convDir, '.migrations', 'messagesThreadId'))).toBe(true);

    // Second run — no-op.
    const r2 = migrateMessagesThreadId(tmp);
    expect(r2.ran).toBe(false);

    // Migrated files parse successfully via parseMessage, with threadId='main'.
    const parsed = parseMessage(readFileSync(legacyHot, 'utf8'));
    expect(parsed.threadId).toBe('main');
  });

  it('returns { ran:false } when no conversation dir exists', () => {
    const r = migrateMessagesThreadId(tmp);
    expect(r.ran).toBe(false);
  });
});

describe('ConversationStore persist with threadId (task-307b)', () => {
  it('append() writes threadId frontmatter; parseMessage reads it back', () => {
    const store = new ConversationStore(tmp);
    const m1 = store.append({ role: 'user', content: 'hi', threadId: 'thr-aaa' });
    const m2 = store.append({ role: 'assistant', content: 'yo' }); // default 'main'

    const raw1 = readFileSync(join(tmp, 'conversation', 'messages', `${m1.id}.md`), 'utf8');
    const raw2 = readFileSync(join(tmp, 'conversation', 'messages', `${m2.id}.md`), 'utf8');
    expect(raw1).toMatch(/threadId: thr-aaa/);
    expect(raw2).toMatch(/threadId: main/);

    const all = store.loadAll();
    const byId = Object.fromEntries(all.map(m => [m.id, m]));
    expect(byId[m1.id].threadId).toBe('thr-aaa');
    expect(byId[m2.id].threadId).toBe('main');
  });

  it('parseMessage defaults missing threadId to main', () => {
    const raw = '---\nid: m0001\nrole: user\ntime: 2026-01-01T00:00:00Z\n---\n\nbody\n';
    const parsed = parseMessage(raw);
    expect(parsed.threadId).toBe('main');
  });
});
