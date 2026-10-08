import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENT_LIMITS, validateFiles } from '../../../../agent/yeaft/person/attachments.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { assembleContext } from '../../../../agent/yeaft/person/runtime.js';
import { config, finalProposal } from './fixtures.js';

const files = (value = 'Private UTF-8 notes: 好奇心', name = 'notes.md', mimeType = 'text/markdown') => [{ name, mimeType, data: Buffer.from(value).toString('base64') }];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=';
const image = { name: 'pixel.png', mimeType: 'image/png', data: png };
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

describe('Person attachment validation', () => {
  it('accepts only canonical byte envelopes and bounds complete text without truncation', () => {
    expect(validateFiles(files(), '', 'send')[0]).toMatchObject({ kind: 'text', content: 'Private UTF-8 notes: 好奇心', size: 30 });
    for (const bad of [null, {}, [{ ...image, path: '/tmp/secret' }], [{ ...image, name: '../secret' }], [{ ...image, data: 'AA=A' }], [{ ...image, data: 'AAAA' }]]) {
      expect(() => validateFiles(bad)).toThrow();
    }
    for (const input of [files('%PDF-1.7', 'file.pdf', 'application/pdf'), files(Buffer.from([0xff, 0xfe]), 'file.txt'), files('a\0b', 'file.js'), files('MZ binary', 'app.exe', 'application/octet-stream')]) {
      expect(() => validateFiles(input)).toThrow(/Unsupported/);
    }
    expect(() => validateFiles(Array(5).fill(image))).toThrow();
    expect(() => validateFiles(files('x'.repeat(24 * 1024)), 'x')).toThrow(/exceed/);
    expect(() => validateFiles([], '你'.repeat(2731))).toThrow();
    expect(validateFiles(files('x'.repeat(24 * 1024)), '')[0].content).toHaveLength(24 * 1024);
    expect(() => validateFiles([{ ...image, data: Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1).toString('base64') }])).toThrow();
    expect(() => validateFiles(Array(3).fill({ ...image, data: Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(4 * 1024 * 1024)]).toString('base64') }))).toThrow(/exceed/);
  });

  it.each([
    ['image/png', png], ['image/jpeg', Buffer.from('ffd8ffe000104a464946', 'hex').toString('base64')],
    ['image/gif', Buffer.from('GIF89a012345').toString('base64')], ['image/webp', Buffer.from('RIFF0123WEBPVP8 ').toString('base64')],
  ])('builds actual %s multimodal blocks and metadata-only archive', async (mimeType, data) => {
    const provider = await createPersonProvider({ config: { ...config, availableModels: [{ ...config.availableModels[0], supportsImages: true }] }, adapter: {} });
    const attachments = validateFiles([{ name: 'image', mimeType, data }]);
    const context = assembleContext({ snapshot: { person: { id: 'p', soul: 's' }, state: {}, messages: [], concepts: [] },
      episode: { id: 'e', kind: 'send', text: '', messageId: 'user-message' }, provider, selection: provider.defaultSelection, remainingCalls: 1, attachments });
    expect(context.messages[0].content.find(part => part.type === 'image').source).toEqual({ type: 'base64', media_type: mimeType, data });
    expect(JSON.stringify(context.archiveMessages)).not.toContain(data);
    expect(context.sources.get('message:user-message:1').reportedSourceRefs).toEqual(['message:user-message:1']);
    expect(context.sources.get('trigger:e').reportedSourceRefs).toEqual(['trigger:e']);
    expect(context.manifest.imageTokensReserved).toBe(8192);
    provider.catalog[0].supportsImages = false;
    expect(() => assembleContext({ snapshot: { person: { soul: '' }, state: {}, messages: [], concepts: [] }, episode: {}, provider,
      selection: provider.defaultSelection, remainingCalls: 1, attachments })).toThrow(/image/);
  });
});

describe('Person durable attachment admission', () => {
  it.each(['send', 'think'])('%s accepts attachment-only input, stores bytes and metadata atomically, retries once after restart', async op => {
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

  it('keeps image base64 out of history/traces and fails explicitly if no owner candidate permits images', async () => {
    const dir = await directory(), seen = [];
    const s = service(dir, { config: { ...config, availableModels: config.availableModels.map(m => ({ ...m, supportsImages: true })) }, adapter: adapter(seen) });
    await call(s, 'open');
    await call(s, 'send', { files: [image], clientMessageId: 'picture' });
    expect((await idle(s)).latestEpisode.status).toBe('completed');
    expect(seen[0].messages[0].content.find(p => p.type === 'image').source.data).toBe(png);
    expect(JSON.stringify(await call(s, 'traces', { limit: 50 }))).not.toContain(png);
    expect(JSON.stringify(await call(s, 'messages'))).not.toContain(png);
    await s.close();
    const textOnly = service(dir, { adapter: adapter(seen) });
    await call(textOnly, 'send', { files: [image], clientMessageId: 'picture-2' });
    expect((await idle(textOnly)).latestEpisode).toMatchObject({ status: 'failed', terminalCode: 'IMAGE_MODEL' });
    expect(seen).toHaveLength(1);
  });

  it('receipt reads are owner/namespace-scoped and never recover an expired lease or start work', async () => {
    const dir = await directory();
    const r = new SqlitePersonRepository({ yeaftDir: dir, leaseMs: 300 }); repos.push(r);
    await r.open('alice');
    const { episode } = await r.admit('alice', { kind: 'send', text: '', clientMessageId: 'receipt', workerId: 'crashed', budget: { calls: 1, timeoutMs: 1000 }, files: files() });
    const before = await r.getPerson('alice');
    await r.close();
    await new Promise(resolve => setTimeout(resolve, 350));
    let starts = 0;
    const s = service(dir, { adapter: { async *stream() { starts++; } } });
    expect(await call(s, 'receipt', { clientMessageId: 'receipt', requestHash: episode.requestHash })).toMatchObject({ found: true, status: 'running', episodeId: episode.id });
    expect(await call(s, 'receipt', { clientMessageId: 'receipt' }, 'bob')).toEqual({ found: false, clientMessageId: 'receipt' });
    const other = service(dir, { namespace: 'other', adapter: {} });
    expect(await call(other, 'receipt', { clientMessageId: 'receipt' })).toEqual({ found: false, clientMessageId: 'receipt' });
    for (const payload of [{}, { clientMessageId: '$bad' }, { clientMessageId: 'receipt', requestHash: 'bad' }, { clientMessageId: 'receipt', files: files() }]) {
      await expect(call(s, 'receipt', payload)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    const inspector = new SqlitePersonRepository({ yeaftDir: dir }); repos.push(inspector);
    expect(await inspector.getPerson('alice')).toEqual(before);
    expect((await inspector.list('alice', 'traces')).items).toHaveLength(1);
    expect(starts).toBe(0);
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
