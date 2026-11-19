import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from '../../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../../agent/yeaft/conversation/history-index.js';
import { createSessionFromSpec, mergeSessions } from '../../../../agent/yeaft/sessions/session-crud.js';
import { persistYeaftAttachments } from '../../../../agent/yeaft/attachments.js';

const roots = [];
function root() {
  const dir = mkdtempSync(join(tmpdir(), 'yeaft-session-history-'));
  roots.push(dir);
  return dir;
}
function raw(dir, sessionId) {
  const segments = join(dir, 'sessions', sessionId, 'conversation', 'segments');
  if (!existsSync(segments)) return [];
  return readdirSync(segments).filter(name => name.endsWith('.jsonl')).sort()
    .flatMap(name => readFileSync(join(segments, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}

const at = seconds => `2026-10-27T00:00:${String(seconds).padStart(2, '0')}.000Z`;
function request(store, sessionId, label, seconds, extra = {}) {
  const user = store.append({ role: 'user', content: label, time: at(seconds), sessionId, ...extra });
  const answer = store.append({ role: 'assistant', content: `${label} answer`, time: at(seconds), sessionId,
    causalRootId: user.id, turnId: `turn-${label}-${seconds}`, speakerVpId: 'omni' });
  return { user, answer };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await closeConversationHistoryIndexes();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable native Session fork and merge', () => {
  it('keeps explicit concurrent roots and supplements atomic through forks, colliding streams and nested merges', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    const append = (sessionId, row) => store.append({ sessionId, ...row });
    const human = (content, clientMessageId, userTurnId, seconds, relation = 'new') =>
      append('source', { role: 'user', content, clientMessageId, userTurnId, relation, time: at(seconds) });
    const answer = (content, userTurnId, causalRootId, turnId) => append('source', {
      role: 'assistant', content, userTurnId, causalRootId, turnId, speakerVpId: 'omni',
    });
    human('A', 'client-A', 'client-A', 1);
    answer('A start', 'client-A', 'client-A', 'vp-A');
    human('B', 'client-B', 'client-B', 3);
    answer('B start', 'client-B', 'client-B', 'vp-B');
    const supplement = human('A supplement', 'client-A-extra', 'client-A', 4, 'supplement');
    // The active engine retains its original causal root, while a later query
    // can use the supplement as causal root. Both executions belong to A.
    answer('A continued', 'client-A', 'client-A', 'vp-A');
    human('A supplement 2', 'client-A-extra-2', 'client-A', 5, 'supplement');
    answer('A final', 'client-A', supplement.clientMessageId, 'vp-A-followup');
    answer('B final', 'client-B', 'client-B', 'vp-B');
    append('other', { role: 'user', content: 'unrelated A', clientMessageId: 'client-A',
      userTurnId: 'client-A', relation: 'new', time: at(2) });
    append('other', { role: 'assistant', content: 'unrelated answer', userTurnId: 'client-A',
      causalRootId: 'client-A', speakerVpId: 'omni', turnId: 'vp-A' });
    const before = raw(dir, 'source');
    const otherBefore = raw(dir, 'other');
    store.copySession('source', 'branch');
    const fork = raw(dir, 'branch');
    expect(fork[0].clientMessageId).toBe(fork[0].id);
    expect(fork.filter(row => row.userTurnId === fork[0].id).map(row => row.content))
      .toEqual(['A', 'A start', 'A supplement', 'A continued', 'A supplement 2', 'A final']);
    expect(fork.find(row => row.content === 'A final').causalRootId)
      .toBe(fork.find(row => row.content === 'A supplement').clientMessageId);
    expect(store.mergeSessions('source', 'branch', 'shared').sharedTurnCount).toBe(2);
    expect(store.mergeSessions('source', 'other', 'merged').sharedTurnCount).toBe(0);
    const merged = raw(dir, 'merged');
    expect(merged.map(row => row.content)).toEqual([
      'A', 'A start', 'A supplement', 'A continued', 'A supplement 2', 'A final',
      'unrelated A', 'unrelated answer', 'B', 'B start', 'B final',
    ]);
    const users = merged.filter(row => row.role === 'user' && row.relation === 'new');
    expect(new Set(users.map(row => row.userTurnId)).size).toBe(3);
    expect(users.every(row => row.userTurnId === row.clientMessageId && row.userTurnId === row.id)).toBe(true);
    expect(merged.slice(0, 6).every(row => row.userTurnId === users[0].id)).toBe(true);
    store.copySession('merged', 'nested');
    expect(store.mergeSessions('merged', 'nested', 'joined').sharedTurnCount).toBe(3);
    expect(raw(dir, 'joined').map(row => row.content)).toEqual(merged.map(row => row.content));
    expect(raw(dir, 'source')).toEqual(before);
    expect(raw(dir, 'other')).toEqual(otherBefore);
    expect(raw(dir, 'branch')).toEqual(fork);
    // Explicit ownership must not turn a reused client identity into a valid
    // alias, even when both human rows claim the same root.
    append('source', { role: 'user', content: 'reused supplement identity', clientMessageId: supplement.clientMessageId,
      userTurnId: 'client-A', relation: 'supplement', time: at(6) });
    expect(() => store.mergeSessions('source', 'other', 'ambiguous-client'))
      .toThrow(expect.objectContaining({ code: 'ambiguous_merge_history' }));
    expect(existsSync(join(dir, 'sessions', 'ambiguous-client'))).toBe(false);
  });

  it('refuses incomplete tool history instead of silently sanitizing away source messages', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    request(store, 'left', 'valid', 1);
    store.append({ role: 'user', content: 'partial', sessionId: 'right' });
    store.append({ role: 'assistant', content: '', sessionId: 'right', toolCalls: [{ id: 'missing', name: 'Read', input: {} }] });
    const source = raw(dir, 'right');
    expect(() => store.mergeSessions('left', 'right', 'rejected')).toThrow(expect.objectContaining({ code: 'ambiguous_merge_history' }));
    expect(raw(dir, 'right')).toEqual(source);
    expect(existsSync(join(dir, 'sessions', 'rejected'))).toBe(false);
  });

  it('rolls back newly-created metadata, manifest, transcript and attachments on merge write failure', () => {
    const dir = root();
    const options = { libDir: join(dir, 'no-vp-library') };
    const source = createSessionFromSpec(dir, { name: 'source', roster: [] }, options);
    const other = createSessionFromSpec(dir, { name: 'other', roster: [] }, options);
    const store = new ConversationStore(dir);
    const asset = persistYeaftAttachments([{ name: 'asset.txt', data: Buffer.from('asset').toString('base64') }],
      { yeaftDir: dir, sessionId: source.id }).promptAttachments[0];
    request(store, source.id, 'source', 1, { attachments: [asset] });
    request(store, other.id, 'other', 2);
    const before = readdirSync(join(dir, 'sessions')).sort();
    // Fail after target-owned assets and transcript have been published.
    const original = ConversationStore.prototype.mergeSessions;
    vi.spyOn(ConversationStore.prototype, 'mergeSessions').mockImplementation(function (...args) {
      original.apply(this, args);
      throw new Error('injected finalization failure');
    });
    expect(() => mergeSessions(dir, source.id, other.id, options)).toThrow('injected finalization failure');
    expect(readdirSync(join(dir, 'sessions')).sort()).toEqual(before);
    expect(JSON.parse(readFileSync(join(dir, 'sessions-manifest.json'), 'utf8')).sessions.map(row => row.id).sort()).toEqual(before);
    expect(readFileSync(asset.path, 'utf8')).toBe('asset');
    expect(raw(dir, source.id)).toHaveLength(2);
    expect(raw(dir, other.id)).toHaveLength(2);
  });
});
