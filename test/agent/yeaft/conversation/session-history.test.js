import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from '../../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../../agent/yeaft/conversation/history-index.js';
import { createSessionFromSpec, copySession, mergeSessions } from '../../../../agent/yeaft/sessions/session-crud.js';
import { loadSessionConfig, saveSessionConfig } from '../../../../agent/yeaft/sessions/session-config.js';
import { openSession } from '../../../../agent/yeaft/sessions/session-store.js';
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
function seed(dir, sessionId, rows) {
  const segments = join(dir, 'sessions', sessionId, 'conversation', 'segments');
  mkdirSync(segments, { recursive: true });
  writeFileSync(join(segments, '000001.jsonl'), rows.map(row => JSON.stringify({ ...row, sessionId })).join('\n') + '\n');
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
  await closeConversationHistoryIndexes();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable native Session fork and merge', () => {
  it('fences exclusively at the durable human request, including multi-VP variants, and validates both cutoffs', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    const first = request(store, 'source', 'first', 1);
    request(store, 'source', 'second', 2);
    const running = store.append({ sessionId: 'source', role: 'user', content: 'running', clientMessageId: 'running-client' });
    store.append({ sessionId: 'source', role: 'assistant', content: 'partial', causalRootId: running.id, turnId: 'running-turn' });
    const variant = store.append({ sessionId: 'source', role: 'user', content: 'running', clientMessageId: 'running-client' });
    const internal = store.append({ sessionId: 'source', role: 'user', content: 'control', userAuthored: false });
    new ConversationStore(dir).copySession('source', 'fenced', { beforeMessageId: variant.id });
    expect(raw(dir, 'fenced').map(row => row.content)).toEqual(['first', 'first answer', 'second', 'second answer']);
    store.copySession('source', 'earlier', { beforeMessageId: running.id, throughTurnId: first.answer.turnId });
    expect(raw(dir, 'earlier').map(row => row.content)).toEqual(['first', 'first answer']);
    store.copySession('source', 'before-first', { beforeMessageId: first.user.id, throughTurnId: first.answer.turnId });
    expect(raw(dir, 'before-first')).toEqual([]);
    for (const [beforeMessageId, code] of [[null, 'invalid_fork_boundary'], ['missing', 'fork_boundary_not_found'],
      [internal.id, 'invalid_fork_boundary'], [first.answer.id, 'invalid_fork_boundary']]) {
      expect(() => store.copySession('source', 'invalid', { beforeMessageId })).toThrow(expect.objectContaining({ code }));
      expect(existsSync(join(dir, 'sessions', 'invalid'))).toBe(false);
    }
    expect(() => store.copySession('source', 'invalid', { beforeMessageId: first.user.id, throughTurnId: 'missing' }))
      .toThrow(expect.objectContaining({ code: 'fork_boundary_not_found' }));
  });

  it('captures an inclusive raw snapshot before async input persistence, including cold, internal and folded rows', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    expect(store.getSessionCopyFence('source')).toBeNull();
    const emptyBoundary = JSON.parse(JSON.stringify(store.captureSessionCopyBoundary('source')));
    expect(existsSync(join(dir, 'sessions', 'source'))).toBe(false);
    const first = request(store, 'source', 'first', 1);
    const internal = store.append({ sessionId: 'source', role: 'user', content: 'control', userAuthored: false, cold: true });
    const folded = store.foldMessages([first.answer, internal], {
      sessionId: 'source', role: 'user', content: 'cold reflection', _reflection: true, cold: true,
    });
    const legacy = join(dir, 'sessions', 'source', 'conversation', 'cold');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, `${first.answer.id}.md`), `---\nid: ${first.answer.id}\nrole: assistant\nsessionId: source\n---\nstale duplicate`);
    // Legacy-only rows (including cold rows) must use exactly the same capture
    // and copy set, not just the segmented head or the visible projection.
    writeFileSync(join(legacy, 'm0000.md'), '---\nid: m0000\nrole: user\nsessionId: source\n---\nlegacy-only');
    const fence = new ConversationStore(dir).getSessionCopyFence('source');
    const boundary = JSON.parse(JSON.stringify(store.captureSessionCopyBoundary('source')));
    expect(fence).toEqual({ messageId: folded.id, seq: Number(folded.id.slice(1)) });
    const expected = ['legacy-only', ...raw(dir, 'source').map(row => row.content)];
    // Routing awaits can delay the next prompt's durable write; the captured
    // raw head remains a safe snapshot even after later outputs and tombstones.
    request(store, 'source', 'running', 2);
    const later = store.foldMessages([folded], { sessionId: 'source', role: 'user', content: 'later fold', _reflection: true });
    expect(store.getSessionCopyFence('source').messageId).toBe(later.id);
    const restarted = new ConversationStore(dir);
    expect(restarted.copySession('source', 'snapshot', { throughBoundary: boundary }).copiedCount).toBe(expected.length);
    expect(raw(dir, 'snapshot').map(row => row.content)).toEqual(expected);
    expect(raw(dir, 'snapshot')[3].cold).toBe(true);
    expect(raw(dir, 'snapshot')[4].foldedMessageIds).toEqual(raw(dir, 'snapshot').slice(2, 4).map(row => row.id));
    restarted.copySession('source', 'old-snapshot', { throughMessageId: fence.messageId });
    expect(raw(dir, 'old-snapshot').map(row => row.content)).toEqual(expected);
    restarted.copySession('source', 'empty', { throughBoundary: emptyBoundary });
    expect(raw(dir, 'empty')).toEqual([]);
    expect(raw(dir, 'source').at(-1).id).toBe(later.id);
  });

  it('validates every raw snapshot fence and clamps inclusive, exclusive and assistant-turn cutoffs to the earliest', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    const first = request(store, 'source', 'first', 1);
    const second = request(store, 'source', 'second', 2);
    const third = request(store, 'source', 'third', 3);
    const boundaries = [
      { throughMessageId: second.answer.id, throughTurnId: first.answer.turnId },
      { throughMessageId: first.answer.id, throughTurnId: third.answer.turnId, beforeMessageId: third.user.id },
      { throughMessageId: third.answer.id, beforeMessageId: second.user.id },
    ];
    for (const [index, options] of boundaries.entries()) {
      store.copySession('source', `earlier-${index}`, options);
      expect(raw(dir, `earlier-${index}`).map(row => row.content)).toEqual(['first', 'first answer']);
    }
    store.copySession('source', 'empty', { throughMessageId: null, throughTurnId: third.answer.turnId, beforeMessageId: second.user.id });
    expect(raw(dir, 'empty')).toEqual([]);
    for (const [throughMessageId, code] of [[undefined, 'invalid_fork_boundary'], ['', 'invalid_fork_boundary'],
      [3, 'invalid_fork_boundary'], ['missing', 'fork_boundary_not_found']]) {
      expect(() => store.copySession('source', 'invalid', { throughMessageId, beforeMessageId: first.user.id }))
        .toThrow(expect.objectContaining({ code }));
      expect(existsSync(join(dir, 'sessions', 'invalid'))).toBe(false);
    }
    expect(() => store.copySession('source', 'invalid', { throughMessageId: null, throughTurnId: 'missing' }))
      .toThrow(expect.objectContaining({ code: 'fork_boundary_not_found' }));
  });

  it('rejects invalid or changed opaque prefixes and never truncates an active requested turn to the captured boundary', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    const first = request(store, 'source', 'first', 1);
    const active = request(store, 'source', 'active', 2);
    const boundary = JSON.parse(JSON.stringify(store.captureSessionCopyBoundary('source')));
    store.append({ sessionId: 'source', role: 'assistant', content: 'late active output', turnId: active.answer.turnId });
    const reject = (options, code = 'invalid_fork_boundary') => {
      expect(() => new ConversationStore(dir).copySession('source', 'invalid', options))
        .toThrow(expect.objectContaining({ code }));
      expect(existsSync(join(dir, 'sessions', 'invalid'))).toBe(false);
    };
    reject({ throughBoundary: boundary, throughTurnId: active.answer.turnId }, 'incomplete_fork_boundary');
    store.copySession('source', 'historical', { throughBoundary: boundary, throughTurnId: first.answer.turnId });
    expect(raw(dir, 'historical').map(row => row.content)).toEqual(['first', 'first answer']);
    for (const token of [null, undefined, {}, { ...boundary, sessionId: 'other' }, { ...boundary, streamId: 'other' },
      { ...boundary, rowCount: -1 }, { ...boundary, rowCount: 100 }, { ...boundary, digest: 'bad' }]) {
      reject({ throughBoundary: token });
    }
    // A row inserted behind the captured head is not part of that snapshot.
    const legacy = join(dir, 'sessions', 'source', 'conversation', 'messages');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'm0000.md'), '---\nid: m0000\nrole: user\nsessionId: source\n---\ninserted');
    reject({ throughBoundary: boundary });
    rmSync(join(legacy, 'm0000.md'));
    const segment = join(dir, 'sessions', 'source', 'conversation', 'segments', '000001.jsonl');
    const original = readFileSync(segment, 'utf8');
    writeFileSync(segment, original.replace('active answer', 'rewritten answer'));
    reject({ throughBoundary: boundary });
    writeFileSync(segment, original.split('\n').filter(line => !line.includes('active answer')).join('\n'));
    reject({ throughBoundary: boundary });
  });

  it('deduplicates fork lineage once and preserves atomic interleaved multi-VP requests, references and attachment ownership', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    const uploaded = persistYeaftAttachments([{ name: 'note.txt', mimeType: 'text/plain', data: Buffer.from('asset').toString('base64') }],
      { yeaftDir: dir, sessionId: 'source' }).promptAttachments[0];
    const serverAsset = { name: 'server', fileId: 'server-owned', ownerSessionId: 'original' };
    const shared = request(store, 'source', 'shared', 1, { clientMessageId: 'shared-client', attachments: [uploaded, serverAsset] });
    const toolOwner = store.append({ sessionId: 'source', role: 'assistant', content: '', turnId: 'other-vp', speakerVpId: 'reviewer',
      causalRootId: shared.user.id, toolCalls: [{ id: 'tool', name: 'Read', input: {} }] });
    const result = store.append({ sessionId: 'source', role: 'tool', content: 'tool result', toolCallId: 'tool',
      turnId: 'other-vp', speakerVpId: 'reviewer', causalRootId: shared.user.id });
    const reflection = store.foldMessages([toolOwner, result], { sessionId: 'source', role: 'user', content: 'fold', _reflection: true,
      causalRootId: shared.user.id, sourceMessageIds: [shared.answer.id, 'external'] });
    store.copySession('source', 'branch');
    const left = request(store, 'source', 'same question', 5);
    // Late output still belongs to the first user request, not the next one.
    const late = store.append({ sessionId: 'source', role: 'assistant', content: 'late first answer', speakerVpId: 'omni',
      turnId: shared.answer.turnId, causalRootId: shared.user.id });
    const branchShared = raw(dir, 'branch')[0];
    store.append({ ...late, sessionId: 'branch', causalRootId: branchShared.id });
    request(store, 'branch', 'same question', 3);
    const sourceBefore = raw(dir, 'source');
    const branchBefore = raw(dir, 'branch');
    const merged = new ConversationStore(dir).mergeSessions('source', 'branch', 'merged');
    const rows = raw(dir, 'merged');
    expect(merged.sharedTurnCount).toBe(1);
    expect(rows.filter(row => row.role === 'user' && !row._reflection).map(row => row.content)).toEqual(['shared', 'same question', 'same question']);
    expect(rows.findIndex(row => row.content === 'late first answer')).toBeLessThan(rows.findIndex(row => row.content === left.user.content));
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    const mergedUser = rows[0];
    expect(mergedUser.origin).toEqual(shared.user.origin);
    expect(mergedUser.attachments[0].path).not.toBe(uploaded.path);
    expect(readFileSync(mergedUser.attachments[0].path, 'utf8')).toBe('asset');
    expect(mergedUser.attachments[1]).toEqual(serverAsset);
    const mergedOwner = rows.find(row => row.origin.messageId === toolOwner.id);
    expect(rows.find(row => row.role === 'tool').toolCallId).toBe(mergedOwner.toolCalls[0].id);
    expect(rows.find(row => row.origin.messageId === reflection.id)).toMatchObject({
      foldedMessageIds: [mergedOwner.id, rows.find(row => row.role === 'tool').id],
      sourceMessageIds: [rows.find(row => row.origin.messageId === shared.answer.id).id, 'external'], causalRootId: mergedUser.id,
    });
    expect(raw(dir, 'source')).toEqual(sourceBefore);
    expect(raw(dir, 'branch')).toEqual(branchBefore);
    store.copySession('merged', 'nested');
    expect(store.mergeSessions('merged', 'nested', 'nested-merge').sharedTurnCount).toBe(3);
    rmSync(uploaded.path);
    expect(readFileSync(mergedUser.attachments[0].path, 'utf8')).toBe('asset');
  });

  it('supports old forks by guarded client/VP-turn identity and rejects partial shared-request divergence', () => {
    const dir = root();
    const old = [
      { id: 'm0001', role: 'user', content: 'legacy', time: at(1), clientMessageId: 'legacy-client' },
      { id: 'm0002', role: 'assistant', content: 'one', time: at(1), speakerVpId: 'a', turnId: 'legacy-a', causalRootId: 'm0001' },
      { id: 'm0003', role: 'assistant', content: 'two', time: at(1), speakerVpId: 'b', turnId: 'legacy-b', causalRootId: 'm0001' },
    ];
    seed(dir, 'old', old);
    seed(dir, 'fork', old.map((row, i) => ({ ...row, id: `m00${i + 11}`, ...(row.causalRootId ? { causalRootId: 'm0011' } : {}) })));
    const store = new ConversationStore(dir);
    expect(store.mergeSessions('old', 'fork', 'legacy-merge')).toMatchObject({ copiedCount: 3, sharedTurnCount: 1 });
    // Legacy copies without client IDs can still be recognized by preserved VP turns and sent time.
    seed(dir, 'turn-only', old.map(row => ({ ...row, clientMessageId: undefined })));
    seed(dir, 'turn-fork', old.map((row, i) => ({ ...row, clientMessageId: undefined, id: `m00${i + 21}`,
      ...(row.causalRootId ? { causalRootId: 'm0021' } : {}) })));
    expect(store.mergeSessions('turn-only', 'turn-fork', 'turn-merge').sharedTurnCount).toBe(1);
    seed(dir, 'partial', old.slice(0, 2));
    expect(() => store.mergeSessions('old', 'partial', 'rejected')).toThrow(expect.objectContaining({ code: 'ambiguous_merge_history' }));
    expect(existsSync(join(dir, 'sessions', 'rejected'))).toBe(false);
    const forkUser = raw(dir, 'legacy-merge')[0];
    store.append({ role: 'assistant', content: 'changed answer', sessionId: 'legacy-merge', causalRootId: forkUser.id });
    expect(() => store.mergeSessions('legacy-merge', 'old', 'divergent')).toThrow(expect.objectContaining({ code: 'ambiguous_merge_history' }));
  });

  it('namespaces colliding message, turn and tool IDs and timestamp-sorts whole unrelated requests with stable ties', () => {
    const dir = root();
    const rows = label => [
      { id: 'm0001', role: 'user', content: 'same question', time: at(2), clientMessageId: label },
      { id: 'm0002', role: 'assistant', content: label, time: at(2), turnId: 'collision', speakerVpId: 'vp', causalRootId: 'm0001',
        toolCalls: [{ id: 'collision', name: 'Read', input: {} }] },
      { id: 'm0003', role: 'tool', content: label, time: at(2), turnId: 'collision', speakerVpId: 'vp', toolCallId: 'collision' },
    ];
    seed(dir, 'left', rows('left'));
    seed(dir, 'right', rows('right'));
    const store = new ConversationStore(dir);
    const out = store.mergeSessions('left', 'right', 'merged');
    expect(out).toMatchObject({ copiedCount: 6, sharedTurnCount: 0 });
    const merged = raw(dir, 'merged');
    expect(merged.map(row => row.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant', 'tool']);
    expect(merged[1].content).toBe('left');
    expect(merged[4].content).toBe('right');
    expect(merged[1].turnId).not.toBe(merged[4].turnId);
    expect(merged[1].toolCalls[0].id).not.toBe(merged[4].toolCalls[0].id);
    for (const offset of [0, 3]) {
      expect(merged[offset + 1].causalRootId).toBe(merged[offset].id);
      expect(merged[offset + 2].toolCallId).toBe(merged[offset + 1].toolCalls[0].id);
    }
    expect(out.idMaps.get('left').get('m0001')).not.toBe(out.idMaps.get('right').get('m0001'));
    store.copySession('merged', 'fork');
    expect(store.mergeSessions('merged', 'fork', 'again').sharedTurnCount).toBe(2);
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

  it('creates a new CRUD Session with source config/workdir/default VP, roster union, and durable-fence forwarding', () => {
    const dir = root();
    const options = { libDir: join(dir, 'no-vp-library') };
    const workDir = join(dir, 'workspace');
    mkdirSync(workDir);
    const source = createSessionFromSpec(dir, { name: 'source', roster: ['omni'], defaultVpId: 'omni', workDir }, options);
    const other = createSessionFromSpec(dir, { name: 'other', roster: ['reviewer', 'omni'] }, options);
    saveSessionConfig(dir, source.id, { model: 'source-model', modelEffort: 'high' });
    const handle = openSession(join(dir, 'sessions'), source.id);
    handle.saveMeta({ ...handle.getMeta(), announcement: 'source announcement' });
    handle.close();
    const store = new ConversationStore(dir);
    const emptyBoundary = store.captureSessionCopyBoundary(source.id);
    const earlier = request(store, source.id, 'source', 3);
    const throughBoundary = JSON.parse(JSON.stringify(store.captureSessionCopyBoundary(source.id)));
    const running = request(store, source.id, 'running', 5);
    request(store, other.id, 'other', 1);
    const copied = copySession(dir, source.id, { ...options, beforeMessageId: running.user.id });
    expect(copied.copiedMessageCount).toBe(2);
    expect(raw(dir, copied.id)[0].origin).toEqual(earlier.user.origin);
    const snapshot = copySession(dir, source.id, { ...options, throughBoundary });
    expect(raw(dir, snapshot.id).map(row => row.content)).toEqual(['source', 'source answer']);
    const empty = copySession(dir, source.id, { ...options, throughBoundary: emptyBoundary });
    expect(empty.copiedMessageCount).toBe(0);
    expect(raw(dir, empty.id)).toEqual([]);
    const sessionsBeforeInvalid = readdirSync(join(dir, 'sessions')).sort();
    expect(() => copySession(dir, source.id, { ...options, throughBoundary, throughTurnId: running.answer.turnId }))
      .toThrow(expect.objectContaining({ code: 'incomplete_fork_boundary' }));
    expect(readdirSync(join(dir, 'sessions')).sort()).toEqual(sessionsBeforeInvalid);
    const sourceBefore = readFileSync(join(dir, 'sessions', source.id, 'session.json'), 'utf8');
    const otherBefore = raw(dir, other.id);
    const merged = mergeSessions(dir, source.id, other.id, { ...options, name: 'new merged' });
    expect(merged).toMatchObject({ name: 'new merged', roster: ['omni', 'reviewer'], defaultVpId: 'omni', workDir,
      announcement: 'source announcement', copiedMessageCount: 6, sharedTurnCount: 0 });
    expect([source.id, other.id]).not.toContain(merged.id);
    expect(loadSessionConfig(dir, merged.id)).toEqual(loadSessionConfig(dir, source.id));
    expect(raw(dir, merged.id).filter(row => row.role === 'user').map(row => row.content)).toEqual(['other', 'source', 'running']);
    expect(readFileSync(join(dir, 'sessions', source.id, 'session.json'), 'utf8')).toBe(sourceBefore);
    expect(raw(dir, other.id)).toEqual(otherBefore);
    expect(JSON.parse(readFileSync(join(dir, 'sessions-manifest.json'), 'utf8')).sessions.some(row => row.id === merged.id)).toBe(true);
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
