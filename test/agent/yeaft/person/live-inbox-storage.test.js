import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { PersonRuntime } from '../../../../agent/yeaft/person/runtime.js';
import { digest, LIMITS } from '../../../../agent/yeaft/person/contracts.js';
import { finalProposal } from './fixtures.js';

const selection = { model: 'test/first', effort: null };
const input = (id, more = {}) => ({ kind: 'send', text: `message ${id}`, clientMessageId: id, workerId: 'worker-a', budget: { calls: null }, ...more });
const file = content => ({ name: 'note.txt', mimeType: 'text/plain', data: Buffer.from(content).toString('base64') });
const start = (r, episode, callId) => r.startCall(episode, { callId, requested: selection, effective: selection });
const complete = (r, episode, callId, output = {}) => r.finalizeCall(episode, { callId, output: { text: 'reply', protocol: 'native-tools', stopReason: 'end_turn', toolCalls: [], ...output } });

describe('durable live Person inbox', () => {
  let yeaftDir, repositories;
  const repo = (namespace = 'default') => {
    const r = new SqlitePersonRepository({ yeaftDir, namespace, leaseMs: 10000 });
    repositories.push(r); return r;
  };
  const inspect = (r, fn) => { const db = new DatabaseSync(r.dbPath); try { return fn(db); } finally { db.close(); } };
  beforeEach(async () => { yeaftDir = await mkdtemp(join(tmpdir(), 'person-live-inbox-')); repositories = []; });
  afterEach(async () => { await Promise.all(repositories.map(r => r.close())); await rm(yeaftDir, { recursive: true, force: true }); });

  it('serializes initial and appended receipts across workers, hashes text/files and reconciles terminal sends', async () => {
    const a = repo(), b = repo(); await a.open('alice');
    const first = await Promise.all([a.admit('alice', input('initial')), b.admit('alice', input('initial'))]);
    const admitted = first.find(result => !result.duplicate), episode = admitted.episode;
    expect(first.map(result => result.messageId)).toEqual([episode.messageId, episode.messageId]);
    expect(first.every(result => result.deliveryState === 'received')).toBe(true);
    const before = await a.getPerson('alice');
    const requests = await Promise.all([a.admit('alice', input('queued', { files: [file('one')] })), b.admit('alice', input('queued', { files: [file('one')], workerId: 'worker-b' }))]);
    expect(requests.filter(result => !result.duplicate)).toHaveLength(1);
    expect(requests.every(result => result.episodeId === episode.id && result.deliveryState === 'queued')).toBe(true);
    expect(new Set(requests.map(result => result.messageId)).size).toBe(1);
    expect(requests.find(result => !result.duplicate)).toMatchObject({ appended: true });
    const after = await a.getPerson('alice');
    expect(after).toMatchObject({ epoch: before.epoch, leaseOwner: before.leaseOwner, inputWatermark: before.inputWatermark, inboxVersion: before.inboxVersion + 1 });
    for (const patch of [{ text: 'changed' }, { files: [file('two')] }, { kind: 'think' }]) {
      await expect(b.admit('alice', input('queued', { files: [file('one')], ...patch }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
    await expect(a.admit('alice', input('busy', { kind: 'think' }))).rejects.toMatchObject({ code: 'BUSY' });
    await expect(a.admit('alice', input('dream', { kind: 'dream', text: '' }))).rejects.toMatchObject({ code: 'BUSY' });
    const receipt = await b.receipt('alice', 'queued');
    expect(receipt).toMatchObject({ found: true, episodeId: episode.id, messageId: requests[0].messageId, deliveryState: 'queued', kind: 'send' });
    await expect(b.receipt('alice', 'queued', digest('wrong'))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await a.cancel('alice');
    expect(await b.admit('alice', input('queued', { files: [file('one')] }))).toMatchObject({ duplicate: true, episodeId: episode.id, status: 'cancelled', deliveryState: 'stopped' });
    expect((await a.snapshot('alice')).busy).toBe(false);
    expect(inspect(a, db => db.prepare('SELECT count(*) AS n FROM episodes').get().n)).toBe(1);
    expect(JSON.stringify((await a.list('alice', 'messages')).items)).not.toContain('requestHash');
    // Independent initial admissions coalesce instead of dropping either input.
    await a.open('bob');
    const distinct = await Promise.all([a.admit('bob', input('race-a')), b.admit('bob', input('race-b'))]);
    expect(distinct[0].episodeId).toBe(distinct[1].episodeId);
    expect(distinct.filter(result => result.appended)).toHaveLength(1);
    expect((await a.list('bob', 'messages')).items).toHaveLength(2);
    // Pre-inbox episode-only receipts retain their original hash contract.
    inspect(a, db => db.prepare("UPDATE messages SET record = json_remove(record, '$.requestHash') WHERE id = ?").run(episode.messageId));
    expect(await b.receipt('alice', 'initial', digest(['send', 'message initial']))).toMatchObject({ found: true, messageId: episode.messageId });
  });

  it('acknowledges only returned batches and fences stale work without blocking heartbeat or call finalization', async () => {
    const a = repo(), b = repo(); await a.open('alice');
    const { episode } = await a.admit('alice', input('first'));
    const legacy = { ...episode }; delete legacy.inboxVersion;
    await start(a, legacy, 'original');
    for (let i = 0; i < 6; i++) await b.admit('alice', input(`q${i}`, { files: [file('body')] }));
    expect(await a.pendingInputs(episode)).toBe(true);
    await expect(a.heartbeat(episode)).resolves.toBeUndefined();
    expect(await complete(a, episode, 'original')).toBe(true);
    await expect(start(a, episode, 'stale')).rejects.toMatchObject({ code: 'INPUT_PENDING' });
    await expect(a.startCapability(episode, { callId: 'original', capability: { id: 'Recall', args: {} } })).rejects.toMatchObject({ code: 'INPUT_PENDING' });
    // Internal publications have their own transactional effect boundary too.
    await expect(a.request('saveCreatedCapability', [episode, {}])).rejects.toMatchObject({ code: 'INPUT_PENDING' });
    await expect(a.savePresentation(episode, { callId: 'original', args: {} })).rejects.toMatchObject({ code: 'INPUT_PENDING' });
    await expect(a.checkOutputPublication(episode, { callId: 'original', args: {} })).rejects.toMatchObject({ code: 'INPUT_PENDING' });
    await expect(a.saveOutput(episode, { callId: 'original', args: {}, record: {} })).rejects.toMatchObject({ code: 'INPUT_PENDING' });
    expect(await a.publishProgress(episode, { callId: 'original', reply: 'reply', final: true })).toBeNull();
    expect(await a.commit(episode, finalProposal(), selection, 'original')).toEqual({ inputPending: true });
    expect((await a.snapshot('alice')).state.version).toBe(0);
    const first = await a.receiveInputs(episode);
    expect(first.messages).toHaveLength(4);
    expect(first.messages.every(message => message.deliveryState === 'received' && message.receivedAt && !Object.hasOwn(message, 'requestHash'))).toBe(true);
    expect(first.attachments[0]).toMatchObject({ content: 'body', data: file('body').data });
    episode.inboxVersion = first.inboxVersion;
    expect(await a.pendingInputs(episode)).toBe(true);
    const second = await a.receiveInputs(episode); episode.inboxVersion = second.inboxVersion;
    expect(second.messages).toHaveLength(2);
    expect(await a.pendingInputs(episode)).toBe(false);
    await expect(start(a, legacy, 'old-local')).rejects.toMatchObject({ code: 'INPUT_PENDING' });
    await expect(start(a, { ...episode, inboxVersion: first.inboxVersion }, 'old-version')).rejects.toMatchObject({ code: 'INPUT_PENDING' });
    await expect(b.pendingInputs({ ...episode, workerId: 'imposter' })).rejects.toMatchObject({ code: 'STALE' });
    await expect(b.receiveInputs({ ...episode, ownerId: 'bob' })).rejects.toMatchObject({ code: 'STALE' });
    expect(await a.receiveInputs(episode)).toEqual({ messages: [], attachments: [], inboxVersion: episode.inboxVersion });
    await start(a, episode, 'fresh'); await complete(a, episode, 'fresh');
    const published = await a.publishProgress(episode, { callId: 'fresh', reply: 'reply', final: true });
    expect(published.replyToMessageIds).toEqual([episode.messageId, ...first.messages.map(m => m.id), ...second.messages.map(m => m.id)]);
    const committed = await a.commit(episode, finalProposal(), selection, 'fresh');
    expect(committed.state.version).toBe(1);
    expect((await a.list('alice', 'messages')).items.find(m => m.replyKind === 'final').replyToMessageIds).toEqual(published.replyToMessageIds);
  });

  it('accepts active service sends without starting a second runtime and retains the pending-cancellation fence', async () => {
    let runtime;
    const started = vi.spyOn(PersonRuntime.prototype, 'start').mockImplementation(function () { runtime = this; });
    const running = vi.spyOn(PersonRuntime.prototype, 'isOwnerRunning').mockReturnValue(true);
    const service = createPersonService({ yeaftDir, embedding: { enabled: false } });
    const request = (op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
    try {
      await request('open');
      const first = await request('send', { text: 'initial', clientMessageId: 'initial' });
      const appended = await request('send', { text: 'follow-up', clientMessageId: 'follow-up' });
      expect(appended).toMatchObject({ episodeId: first.episodeId, deliveryState: 'queued', duplicate: false });
      expect(appended.messageId).not.toBe(first.messageId);
      expect(await request('send', { text: 'follow-up', clientMessageId: 'follow-up' })).toEqual({ ...appended, duplicate: true });
      expect(started).toHaveBeenCalledTimes(1);
      runtime.pendingCancellations.set('alice', 1);
      for (const op of ['send', 'think', 'dream']) {
        await expect(request(op, { clientMessageId: `blocked-${op}`, ...(op !== 'dream' ? { text: 'blocked' } : {}) })).rejects.toMatchObject({ code: 'BUSY' });
      }
      expect(await request('send', { text: 'follow-up', clientMessageId: 'follow-up' })).toMatchObject({ duplicate: true });
      await expect(request('send', { text: 'different', clientMessageId: 'follow-up' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(started).toHaveBeenCalledTimes(1);
    } finally {
      runtime?.pendingCancellations.clear(); await service.close(); started.mockRestore(); running.mockRestore();
    }
  });

  it('keeps acknowledgement text bounded without dropping unreturned input', async () => {
    const r = repo(); await r.open('alice'); const { episode } = await r.admit('alice', input('first'));
    for (let i = 0; i < 4; i++) await r.admit('alice', input(`large-${i}`, { text: 'x'.repeat(8000), files: [file('y'.repeat(16000))] }));
    const batch = await r.receiveInputs(episode);
    expect(batch.messages.length).toBeGreaterThan(0); expect(batch.messages.length).toBeLessThan(4);
    episode.inboxVersion = batch.inboxVersion;
    const next = await r.receiveInputs(episode); episode.inboxVersion = next.inboxVersion;
    expect(batch.messages.length + next.messages.length).toBe(4);
    expect(await r.pendingInputs(episode)).toBe(false);
  });

  it('stops queued messages on cancellation, failure and recovery without resurrecting receipts', async () => {
    const r = repo(); await r.open('alice');
    for (const terminal of ['cancel', 'finish', 'recover']) {
      const { episode } = await r.admit('alice', input(`${terminal}-initial`));
      const queued = await r.admit('alice', input(`${terminal}-queued`));
      if (terminal === 'cancel') await r.cancel('alice', episode.id);
      if (terminal === 'finish') await r.finish(episode, 'failed', 'PROVIDER_FAILED');
      if (terminal === 'recover') {
        inspect(r, db => db.prepare("UPDATE persons SET record = json_set(record, '$.leaseUntil', ?)").run(new Date(0).toISOString()));
        expect(await r.recover('alice')).toBe(true);
      }
      await expect(r.receiveInputs(episode)).rejects.toMatchObject({ code: 'STALE' });
      expect(await r.receipt('alice', `${terminal}-queued`)).toMatchObject({ messageId: queued.messageId, deliveryState: 'stopped' });
      expect(await r.admit('alice', input(`${terminal}-queued`))).toMatchObject({ duplicate: true, episodeId: episode.id, deliveryState: 'stopped' });
      expect((await r.snapshot('alice')).busy).toBe(false);
    }
  });

  it('publishes exact consumed-user replies once per call, validates targets and preserves owner boundaries', async () => {
    const r = repo(), other = repo('other'); await r.open('alice'); await r.open('bob'); await other.open('alice');
    const old = await r.admit('alice', input('old')); await r.finish(old.episode, 'failed', 'PROVIDER_FAILED');
    const foreign = await r.admit('bob', input('foreign'));
    const { episode } = await r.admit('alice', input('initial'));
    const args = { callId: 'reply-call', messageIds: [episode.messageId], text: 'A direct reply.' };
    await expect(other.publishReply(episode, args)).rejects.toMatchObject({ code: 'STALE' });
    for (const messageIds of [[], [episode.messageId, episode.messageId], Array(25).fill(episode.messageId), ['missing'], [old.messageId], [foreign.messageId]]) {
      await expect(r.publishReply(episode, { ...args, messageIds })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    await expect(r.publishReply(episode, { ...args, text: ' ' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(r.publishReply(episode, { ...args, text: 'x'.repeat(LIMITS.outputBytes + 1) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(r.publishReply(episode, args)).rejects.toMatchObject({ code: 'STALE' });
    const queued = await r.admit('alice', input('new'));
    await expect(r.publishReply(episode, args)).rejects.toMatchObject({ code: 'INPUT_PENDING' });
    expect((await r.list('alice', 'messages')).items.filter(m => m.role === 'assistant')).toEqual([]);
    const received = await r.receiveInputs(episode); episode.inboxVersion = received.inboxVersion;
    const targets = [episode.messageId, queued.messageId];
    await start(r, episode, 'provider');
    await complete(r, episode, 'provider', { toolCalls: [{ id: 'reply-tool', name: 'Conversation__reply', input: { messageIds: targets, text: args.text } }] });
    const capability = { id: 'Conversation.reply', args: { messageIds: targets, text: args.text } };
    await r.startCapability(episode, { callId: args.callId, modelCallId: 'provider', toolUseId: 'reply-tool', toolIndex: 0, capability });
    await expect(r.publishReply(episode, { ...args, text: 'changed before publish', messageIds: targets })).rejects.toMatchObject({ code: 'STALE' });
    const reply = await r.publishReply(episode, { ...args, messageIds: targets });
    expect(reply).toMatchObject({ replyKind: 'message-reply', role: 'assistant', replyToMessageIds: [episode.messageId, queued.messageId] });
    const during = await r.admit('alice', input('during-capability'));
    await expect(r.publishReply(episode, { ...args, messageIds: targets })).rejects.toMatchObject({ code: 'INPUT_PENDING' });
    expect(await r.finalizeCapability(episode, { callId: args.callId, capability, result: { ok: true, messageId: reply.id } })).toBe(true);
    const last = await r.receiveInputs(episode); episode.inboxVersion = last.inboxVersion;
    expect(last.messages.map(message => message.id)).toEqual([during.messageId]);
    expect(await r.publishReply(episode, { ...args, messageIds: [episode.messageId, queued.messageId] })).toEqual(reply);
    await expect(r.publishReply(episode, { ...args, text: 'changed' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(r.publishReply(episode, { ...args, callId: 'assistant-target', messageIds: [reply.id] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect((await r.list('alice', 'messages')).items.filter(m => m.role === 'user').every(m => m.deliveryState === 'received')).toBe(true);
    expect((await r.list('alice', 'traces', { limit: 50 })).items.filter(t => t.kind === 'message_reply')).toHaveLength(1);
    expect((await r.searchChanges('alice')).items.filter(change => change.record.id === reply.id)).toHaveLength(1);
    expect(await r.receipt('bob', 'new')).toEqual({ found: false, clientMessageId: 'new' });
    expect(await other.receipt('alice', 'new')).toEqual({ found: false, clientMessageId: 'new' });
    await r.cancel('alice');
    await expect(r.publishReply(episode, { ...args, callId: 'late' })).rejects.toMatchObject({ code: 'STALE' });
  });
});
