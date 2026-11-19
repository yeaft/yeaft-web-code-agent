import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from './fixture-adapter.js';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';

import { config, finalProposal } from './fixtures.js';

const files = (value = 'Private UTF-8 notes: 好奇心', name = 'notes.md', mimeType = 'text/markdown') => [{ name, mimeType, data: Buffer.from(value).toString('base64') }];

const services = [], repos = [], directories = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-files-')); directories.push(dir); return dir; }
const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
function service(yeaftDir, more = {}) {
  const s = createPersonService({ yeaftDir, config, embedding: { enabled: false }, ...more }); services.push(s); return s;
}
async function idle(s) {
  for (let i = 0; i < 200; i++) {
    const snapshot = await call(s, 'snapshot');
    if (!snapshot.busy) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Person did not finish');
}
function adapter(seen) { return { async *stream(params) {
  seen.push(params);
  const content = params.messages[0].content;
  const context = JSON.parse(Array.isArray(content) ? content[0].text : content);
  const proposal = finalProposal(context.state.version);
  proposal.concepts = [];
  proposal.state.focusConceptIds = [];
  yield { type: 'text_delta', text: JSON.stringify(proposal) };
  yield { type: 'stop', stopReason: 'end_turn' };
} }; }
afterEach(async () => {
  await Promise.all(services.splice(0).map(s => s.close()));
  await Promise.all(repos.splice(0).map(r => r.close()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person durable attachment admission', () => {
  it('send accepts attachment-only input, stores bytes and metadata atomically, retries once after restart', async () => {
    const op = 'send';
    const dir = await directory(), seen = [];
    const s = service(dir, { adapter: adapter(seen) });
    await call(s, 'open');
    const request = { text: '', files: files(), clientMessageId: 'with-files' };
    const accepted = await call(s, op, request);
    expect(await call(s, op, request)).toMatchObject({ duplicate: true, episodeId: accepted.episodeId });
    const snapshot = await idle(s);
    expect(snapshot.latestEpisode.status).toBe('completed');
    expect(seen).toHaveLength(1);
    const message = snapshot.messages.find(m => m.role === 'user');
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({ name: 'notes.md', kind: 'text', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(message.attachments[0]).not.toHaveProperty('data');
    const input = JSON.parse(seen[0].messages[0].content);
    expect(input.trigger.attachments[0]).toMatchObject({ content: 'Private UTF-8 notes: 好奇心', trust: 'untrusted-user-content' });
    expect(input.trigger.messageRef).toBe(`message:${message.id}:1`);
    expect(JSON.stringify(await call(s, 'traces', { limit: 50 }))).not.toContain(request.files[0].data);
    await s.close();
    const restarted = service(dir, { adapter: adapter(seen) });
    const receipt = await call(restarted, 'receipt', { clientMessageId: request.clientMessageId });
    expect(receipt).toMatchObject({ found: true, episodeId: accepted.episodeId, status: 'completed', kind: op, text: '', messageId: message.id, attachments: message.attachments });
    expect(receipt.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain(request.files[0].data);
    await expect(call(restarted, 'receipt', { clientMessageId: request.clientMessageId, requestHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await call(restarted, op, request)).toMatchObject({ duplicate: true, episodeId: accepted.episodeId });
    await expect(call(restarted, op, { ...request, files: files('different') })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(seen).toHaveLength(1);
    const db = new DatabaseSync(join(dir, 'person/person.db'), { readOnly: true });
    try {
      const record = JSON.parse(db.prepare('SELECT record FROM attachments WHERE ownerId = ?').get('alice').record);
      expect(record.data).toBe(request.files[0].data);
      expect(db.prepare('SELECT count(*) n FROM attachments').get().n).toBe(1);
    } finally { db.close(); }
    await call(restarted, 'open', {}, 'bob');
    expect((await call(restarted, 'messages', {}, 'bob')).items).toEqual([]);
  });

  it('does not persist any partial batch or expose bytes through forged episode ownership', async () => {
    const dir = await directory();
    const r = new SqlitePersonRepository({ yeaftDir: dir }); repos.push(r);
    await r.open('alice'); await r.open('bob');
    const request = { kind: 'send', text: '', clientMessageId: 'm', workerId: 'w', budget: { calls: 1, timeoutMs: 1000 }, files: files() };
    await expect(r.admit('alice', { ...request, files: [...files(), ...files('%PDF-', 'a.pdf')] })).rejects.toMatchObject({ code: 'UNSUPPORTED_ATTACHMENT' });
    expect((await r.list('alice', 'messages')).items).toEqual([]);
    const { episode } = await r.admit('alice', request);
    expect((await r.episodeAttachments(episode))[0].data).toBe(request.files[0].data);
    await expect(r.episodeAttachments({ ...episode, ownerId: 'bob' })).rejects.toMatchObject({ code: 'STALE' });
    await expect(r.episodeAttachments({ ...episode, namespace: 'other' })).rejects.toMatchObject({ code: 'STALE' });
    await r.finish(episode, 'completed');
    await expect(r.episodeAttachments(episode)).rejects.toMatchObject({ code: 'STALE' });
  });
});
