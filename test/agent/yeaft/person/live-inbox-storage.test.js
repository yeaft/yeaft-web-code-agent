import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { LIMITS } from '../../../../agent/yeaft/person/contracts.js';

const selection = { model: 'test/first', effort: null };
const input = (id, more = {}) => ({ kind: 'send', text: `message ${id}`, clientMessageId: id, workerId: 'worker-a', budget: { calls: null }, ...more });

const start = (r, episode, callId) => r.startCall(episode, { callId, requested: selection, effective: selection });
const complete = (r, episode, callId, output = {}) => r.finalizeCall(episode, { callId, output: { text: 'reply', protocol: 'native-tools', stopReason: 'end_turn', toolCalls: [], ...output } });

describe('durable live Person inbox', () => {
  let yeaftDir, repositories;
  const repo = (namespace = 'default') => {
    const r = new SqlitePersonRepository({ yeaftDir, namespace, leaseMs: 10000 });
    repositories.push(r); return r;
  };

  beforeEach(async () => { yeaftDir = await mkdtemp(join(tmpdir(), 'person-live-inbox-')); repositories = []; });
  afterEach(async () => { await Promise.all(repositories.map(r => r.close())); await rm(yeaftDir, { recursive: true, force: true }); });

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
