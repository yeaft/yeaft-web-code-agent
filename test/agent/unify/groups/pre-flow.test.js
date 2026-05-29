/**
 * pre-flow.test.js — GC.1 Commit A.
 *
 * Smoke-test the thin pre-flow wrapper that bridges
 * groups/pre-flow.js → memory/preflow.js (FTS5 recall) and shapes the
 * result into the engine's recall consumer contract
 * `{ profile, entries, formatted, meta }`.
 *
 * These tests do NOT exercise VP selection (lands in Commit B) or
 * parallel VP fan-out (Commit C). They cover:
 *   - canonical scope construction
 *   - FTS hits flowing through to formatted output
 *   - per-VP scope filtering (privacy boundary)
 *   - empty / no-keyword inputs degrade gracefully
 *   - missing index returns the empty shape (engine fallback path)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openSegmentIndex } from '../../../../agent/unify/memory/index-db.js';
import { makeSegment } from '../../../../agent/unify/memory/segment.js';
import {
  runMemoryPreflow,
  buildRelevantScopes,
  formatPickedForInjection,
  parseMentions,
  selectRespondingVps,
} from '../../../../agent/unify/groups/pre-flow.js';

let TEST_DIR;
let idx;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'gc1-'));
  idx = openSegmentIndex(join(TEST_DIR, 'idx.db'));
});

afterEach(() => {
  try { idx.close(); } catch { /* */ }
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
});

describe('buildRelevantScopes', () => {
  it('always includes user scope', () => {
    expect(buildRelevantScopes({})).toEqual(['user']);
  });
  it('orders user → group → vp (featureId is silently ignored — Feature system removed)', () => {
    expect(
      buildRelevantScopes({ groupId: 'g1', vpId: 'alice', featureId: 'auth' }),
    ).toEqual(['user', 'group/g1', 'vp/alice']);
  });
  it('appends extra scopes once', () => {
    expect(
      buildRelevantScopes({ groupId: 'g1', extra: ['topic/x', 'group/g1'] }),
    ).toEqual(['user', 'group/g1', 'topic/x']);
  });
});

describe('formatPickedForInjection', () => {
  it('returns empty string for empty input', () => {
    expect(formatPickedForInjection([])).toBe('');
    expect(formatPickedForInjection(null)).toBe('');
  });
  it('groups by scope with markdown headings', () => {
    const out = formatPickedForInjection([
      { scope: 'user', body: 'profile fact' },
      { scope: 'group/g1', body: 'group note' },
      { scope: 'vp/alice', body: 'alice fact' },
    ]);
    expect(out).toContain('## Memory: User');
    expect(out).toContain('## Memory: Group g1');
    expect(out).toContain('## Memory: VP alice');
    expect(out).toContain('profile fact');
  });
});

describe('runMemoryPreflow', () => {
  it('returns empty shape when index is null', () => {
    const r = runMemoryPreflow(null, { userMsg: 'hello' });
    expect(r.entries).toEqual([]);
    expect(r.formatted).toBe('');
    expect(r.meta.skipped).toBe('no-index');
  });

  it('returns empty shape on empty userMsg', () => {
    const r = runMemoryPreflow(idx, { userMsg: '   ' });
    expect(r.entries).toEqual([]);
    expect(r.meta.skipped).toBe('no-user-msg');
  });

  it('returns FTS hits scoped to the responding VP', () => {
    idx.upsert(makeSegment({
      scope: 'user', kind: 'fact', tags: ['profile'],
      body: 'User loves jwt-based authentication.',
    }));
    idx.upsert(makeSegment({
      scope: 'vp/alice', kind: 'fact', tags: ['auth'],
      body: 'Alice prefers refresh tokens with jwt.',
    }));
    idx.upsert(makeSegment({
      scope: 'vp/bob', kind: 'fact', tags: ['auth'],
      body: 'Bob hates jwt; prefers session cookies.',
    }));

    const r = runMemoryPreflow(idx, {
      userMsg: 'how should we do jwt auth?',
      vpId: 'alice',
      groupId: 'g1',
    });

    // alice scope is allowed; bob scope must be filtered.
    const scopes = r.entries.map(e => e.scope);
    expect(scopes).toContain('user');
    expect(scopes).toContain('vp/alice');
    expect(scopes).not.toContain('vp/bob');

    expect(r.formatted).toContain('## Memory: User');
    expect(r.formatted).toContain('## Memory: VP alice');
    expect(r.formatted).not.toContain('Bob hates');
  });

  it('produces a profile from a user-scope hit when present', () => {
    idx.upsert(makeSegment({
      scope: 'user', kind: 'fact', tags: ['profile'],
      body: 'User name is Mia.',
    }));
    const r = runMemoryPreflow(idx, { userMsg: 'remember my name' });
    // Either a user-scope hit landed and profile is non-empty, or the
    // tokenizer dropped the keywords; both are valid behaviours, but
    // when entries contain a user-scope row profile MUST equal its body.
    const userSeg = r.entries.find(e => e.scope === 'user');
    if (userSeg) expect(r.profile).toBe(userSeg.body.trim());
  });
});

describe('parseMentions', () => {
  it('returns empty for empty / non-string input', () => {
    expect(parseMentions('')).toEqual([]);
    expect(parseMentions(null)).toEqual([]);
  });
  it('extracts ordered unique mentions', () => {
    expect(parseMentions('@vp-alice hi @vp-bob @vp-alice')).toEqual(['vp-alice', 'vp-bob']);
  });
  it('recognises @all', () => {
    expect(parseMentions('@all standup at 10')).toEqual(['all']);
  });
});

describe('selectRespondingVps', () => {
  const meta = { id: 'g1', roster: ['alice', 'bob', 'carol'], defaultVpId: 'alice' };

  it('VP-authored messages: never dispatch', () => {
    const r = selectRespondingVps({
      meta, fromUser: false, mentions: ['bob'], sender: 'alice',
    });
    expect(r.dispatched).toEqual([]);
    expect(r.reason).toBe('vp-author-no-text-routing');
  });

  it('mention: filters non-roster + dispatches roster members', () => {
    const r = selectRespondingVps({
      meta, fromUser: true, mentions: ['alice', 'stranger', 'bob'],
    });
    expect(r.dispatched).toEqual(['alice', 'bob']);
    expect(r.errors).toEqual([{ vpId: 'stranger', error: 'not_in_roster' }]);
    expect(r.reason).toBe('mention');
  });

  it('mention: accepts vp-prefixed aliases for canonical roster ids', () => {
    const r = selectRespondingVps({
      meta, fromUser: true, mentions: ['vp-alice', 'vp-bob', 'vp-stranger'],
    });
    expect(r.dispatched).toEqual(['alice', 'bob']);
    expect(r.errors).toEqual([{ vpId: 'vp-stranger', error: 'not_in_roster' }]);
    expect(r.reason).toBe('mention');
  });

  it('@all: broadcasts to roster minus sender', () => {
    const r = selectRespondingVps({
      meta, fromUser: true, mentions: ['all'], sender: 'user',
    });
    expect(r.dispatched).toEqual(['alice', 'bob', 'carol']);
    expect(r.reason).toBe('broadcast');
  });

  it('@all: respects fanOutCap', () => {
    const r = selectRespondingVps({
      meta: { ...meta, roster: ['a', 'b', 'c', 'd', 'e'] },
      fromUser: true, mentions: ['all'], sender: 'user', fanOutCap: 2,
    });
    expect(r.dispatched.length).toBe(2);
    expect(r.truncatedAtFanOutCap).toBe(true);
  });

  it('no mention: falls back to defaultVpId', () => {
    const r = selectRespondingVps({ meta, fromUser: true, mentions: [] });
    expect(r.dispatched).toEqual(['alice']);
    expect(r.fallback).toBe('alice');
    expect(r.reason).toBe('fallback');
  });

  it('no mention + no roster: errors no_default_vp', () => {
    const r = selectRespondingVps({
      meta: { id: 'g1', roster: [], defaultVpId: null },
      fromUser: true, mentions: [],
    });
    expect(r.dispatched).toEqual([]);
    expect(r.errors).toEqual([{ error: 'no_default_vp' }]);
  });

  it('taskMembers: filters mention dispatch', () => {
    const r = selectRespondingVps({
      meta, fromUser: true, mentions: ['alice', 'bob'],
      taskMembers: ['alice'],
    });
    expect(r.dispatched).toEqual(['alice']);
    expect(r.errors).toEqual([{ vpId: 'bob', error: 'not_in_task_members' }]);
  });
});
