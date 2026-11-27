import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { createCreationBridge, createCreationService, createCreationStore, parseSource } from '../../../../agent/yeaft/creations/index.js';

let dir;
let service;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yeaft-creation-'));
  service = createCreationService({ yeaftDir: dir, bootId: 'boot-a' });
  store = service.store;
});
afterEach(async () => {
  await service?.close();
  rmSync(dir, { recursive: true, force: true });
});
const req = (op, payload = {}) => service.request({ op, payload });
const b64 = value => Buffer.from(value).toString('base64');
const err = code => expect.objectContaining({ code });

describe('Creations durable store and operations', () => {
  it('uses WAL/FKs, provides summaries, scopes data, and persists across reopen', async () => {
    expect(store.db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    expect(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    expect(store.db.prepare('PRAGMA busy_timeout').get().timeout).toBe(5000);
    const { creation, thread } = req('create_creation', { id: 'sky', title: 'Sky', prompt: 'Mission', autoPlan: false, starterNode: true });
    expect(creation).toMatchObject({ kind: 'book', modality: 'markdown_doc', mission: 'Mission', unitCount: 1, hasReadableContent: false, placement: { arm: 0 } });
    expect(req('update_creation', { creationId: 'sky', patch: { title: 'Night Sky' } }).creation.title).toBe('Night Sky');
    const other = req('create_creation', { kind: 'video', title: 'Film' });
    expect(other.creation.placement.arm).toBe(3);
    expect(() => req('get_thread', { creationId: other.creation.id, threadId: thread.id })).toThrow(err('NOT_FOUND'));
    expect(() => req('create_creation', { id: 'oops', starterNode: { parentId: 'missing' }, textSources: ['rollback'] })).toThrow(err('NOT_FOUND'));
    expect(() => req('get_creation', { creationId: 'oops' })).toThrow(err('NOT_FOUND'));
    expect(req('create_creation', { id: 'oops' }).creation.id).toBe('oops');
    req('delete_creation', { creationId: 'oops' });
    await service.close();
    service = createCreationService({ yeaftDir: dir });
    expect(req('get_creation', { creationId: 'sky' })).toMatchObject({ creation: { title: 'Night Sky' }, thread: { id: thread.id } });
    expect(req('list_creations').creations).toHaveLength(2);
    expect(req('delete_creation', { creationId: 'sky' })).toMatchObject({ deleted: true });
    expect(req('list_creations').creations).toHaveLength(1);
    expect(() => req('constructor')).toThrow(err('UNSUPPORTED'));
  });

  it('scopes FTS5 and updates/deletes index records; AI cannot write locked Canon', () => {
    store.createCreation({ id: 'a' });
    store.createCreation({ id: 'b' });
    const { canon } = req('upsert_canon', { creationId: 'a', id: 'lore', type: 'rule', title: 'Sentinel', contentMd: 'Maple keep', lockedByUser: true });
    store.upsertCanon('b', { id: 'lore', title: 'Maple foreign' });
    expect(store.recallCanon('a', 'Maple')).toEqual([canon]);
    expect(store.recallCanon('a', '" ) OR *')).toEqual([]);
    expect(() => store.upsertCanon('a', { id: 'lore', lockedByUser: false, contentMd: 'Override' }, { actor: 'ai' })).toThrow(err('LOCKED'));
    req('upsert_canon', { creationId: 'a', canon: { id: 'lore', contentMd: 'Cedar keep' } });
    expect(store.recallCanon('a', 'Maple')).toEqual([]);
    expect(store.recallCanon('a', 'Cedar')).toMatchObject([{ id: 'lore', lockedByUser: true }]);
    req('delete_canon', { creationId: 'a', canonId: 'lore' });
    expect(store.recallCanon('a', 'Cedar')).toEqual([]);
    store.deleteCreation('b');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM creation_canon_fts').get().n).toBe(0);
  });

  it('maintains the node tree, immutable revisions, optimistic conflicts and restores', () => {
    req('create_creation', { id: 'book', kind: 'book', title: 'Epic' });
    const create = node => req('create_node', { creationId: 'book', node }).node;
    create({ id: 'vol1', title: 'Volume One', type: 'folder' });
    create({ id: 'vol2', title: 'Volume Two', type: 'folder' });
    create({ id: 'c1', parentId: 'vol1', title: 'Chapter One' });
    const first = create({ id: 'c2', parentId: 'vol1', title: 'Chapter Two', content: 'One original sentence' });
    create({ id: 'c3', parentId: 'vol2', title: 'Chapter Three', outlineMd: 'Future plot' });
    expect(req('reorder_nodes', { creationId: 'book', parentId: 'vol1', orderedIds: ['c2', 'c1'] }).nodes.filter(n => n.parentId === 'vol1').map(n => n.id)).toEqual(['c2', 'c1']);
    expect(store.getStructure('book').map(n => n.children.map(child => child.id))).toEqual([['c2', 'c1'], ['c3']]);
    expect(() => req('reorder_nodes', { creationId: 'book', parentId: 'vol1', nodeIds: ['c2', 'c2'] })).toThrow(err('INVALID_REQUEST'));
    const second = req('update_node', { creationId: 'book', nodeId: 'c2', baseRevId: first.currentRevId, patch: { content: 'New draft' } }).node;
    expect(req('update_node', { creationId: 'book', nodeId: 'c2', baseRevId: first.currentRevId, content: 'Stale' })).toEqual({ conflict: true, currentRevId: second.currentRevId, currentContent: 'New draft' });
    const path = join(dir, 'creations', 'book', 'artifacts', 'c2', 'revisions', `${first.currentRevId}.snap`);
    expect(readFileSync(path, 'utf8')).toBe('One original sentence');
    const restored = req('restore_revision', { creationId: 'book', nodeId: 'c2', revId: first.currentRevId, baseRevId: second.currentRevId }).node;
    expect(restored.currentRevId).not.toBe(first.currentRevId);
    expect(req('get_node', { creationId: 'book', nodeId: 'c2' })).toMatchObject({ node: { content: 'One original sentence' }, revisions: [{ restoredFromRevId: first.currentRevId }, {}, {}] });
    expect(store.getCreation('book')).toMatchObject({ unitCount: 3, readableUnitCount: 1, wordCount: 3, hasReadableContent: true });
    const md = req('export_creation', { creationId: 'book' }).content;
    expect(md).toContain('## Volume One\n\n### Chapter Two\n\nOne original sentence');
    expect(md).toContain('### Chapter Three\n\nFuture plot');
    expect(JSON.parse(req('export_creation', { creationId: 'book', format: 'json' }).content).nodes[0].children[0].content).toBe('One original sentence');
    expect(req('delete_node', { creationId: 'book', nodeId: 'vol1' }).nodeIds).toEqual(expect.arrayContaining(['vol1', 'c1', 'c2']));
    expect(store.getCreation('book')).toMatchObject({ unitCount: 1, readableUnitCount: 0, wordCount: 0, hasReadableContent: false });
  });

  it.each([['deck', 'slides', 'body'], ['gallery', 'images', 'caption'], ['video', 'scenes', 'storyboard']])('exports %s JSON snapshots and merged Markdown', (kind, field, textField) => {
    req('create_creation', { id: 'media', kind });
    const content = { [field]: [{ title: 'Scene A', [textField]: 'A painting of the sky' }] };
    const node = store.createNode('media', { id: 'scene', content });
    expect(JSON.parse(readFileSync(join(dir, 'creations', 'media', 'artifacts', 'scene', 'revisions', `${node.currentRevId}.json`)))).toEqual(content);
    expect(req('export_creation', { creationId: 'media' }).content).toContain('A painting of the sky');
    expect(JSON.parse(req('export_creation', { creationId: 'media', format: 'json' }).content).nodes[0].content).toEqual(content);
  });

  it('parses uploaded and pasted sources, reads exact inclusive bytes and rejects path traversal/symlinks', () => {
    const { sources } = req('create_creation', { id: 'c', textSources: [{ text: 'Pasted lore' }], files: [{ name: 'story.md', mimeType: 'text/markdown', data: b64('Hello comet') }] });
    const id = sources[0].id;
    expect(req('get_source', { creationId: 'c', sourceId: id }).source.parsed).toMatchObject({ kind: 'text', chunks: [{ index: 0, text: 'Hello comet' }] });
    expect(req('add_sources', { creationId: 'c', textSources: ['Another note'] }).creation.sourceCount).toBe(3);
    expect(service.handleMediaRead({ requestId: 'relay', creationId: 'c', mediaKind: 'source', mediaId: id, start: 6, end: 99 })).toMatchObject({
      type: 'creation_media_chunk', ok: true, requestId: 'relay', start: 6, end: 10, totalSize: 11, filename: 'story.md', data: b64('comet'),
    });
    expect(() => store.readMediaRange('c', 'source', id, 11)).toThrow(err('INVALID_RANGE'));
    expect(() => store.readMediaRange('c', 'source', '../secret')).toThrow(err('INVALID_REQUEST'));
    expect(() => store.readMediaRange('../c', 'source', id)).toThrow(err('INVALID_REQUEST'));
    const raw = join(dir, 'creations', 'c', 'sources', id, 'original');
    const outside = join(dir, 'secret');
    renameSync(raw, `${raw}.old`);
    writeFileSync(outside, 'hidden');
    symlinkSync(outside, raw);
    expect(() => store.readMediaRange('c', 'source', id)).toThrow(err('INVALID_PATH'));
    req('delete_source', { creationId: 'c', sourceId: id });
    expect(readFileSync(outside, 'utf8')).toBe('hidden');
    expect(store.getCreation('c').sourceCount).toBe(2);
  });

  it('extracts simple PDF/Flate text, bounds large text, and emits binary metadata', () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n'),
      deflateSync('BT (Hello\\040PDF) Tj [(A) 20 <42>] TJ ET'), Buffer.from('\nendstream\nendobj')]);
    expect(parseSource(pdf, { name: 'refs.pdf' })).toMatchObject({ kind: 'pdf', chunks: [{ text: 'Hello PDF\nAB' }] });
    expect(parseSource(Buffer.from([0, 255]), { name: 'clip.mp4' })).toMatchObject({ kind: 'video', byteLength: 2, chunks: [] });
    const text = parseSource(Buffer.from('x'.repeat(130_000)), { name: 'large.csv' });
    expect(text.truncated).toBe(true);
    expect(text.chunks.map(chunk => chunk.text).join('')).toHaveLength(120_000);
  });

  it('keeps stale proposals pending, supports force/explicit locked Canon acceptance, and rejects without changing prose', () => {
    store.createCreation({ id: 'c' });
    const node = store.createNode('c', { id: 'chapter', content: 'Original' });
    const edit = store.proposeUnitEdit('c', node.id, { proposedContent: 'Proposed' });
    const rejected = store.proposeUnitEdit('c', node.id, { proposedContent: 'Reject me' });
    const canon = store.upsertCanon('c', { id: 'lore', lockedByUser: true, title: 'Lore', contentMd: 'Immutable until accepted' });
    const patch = store.proposeCanonPatch('c', { id: canon.id, contentMd: 'Approved later' });
    expect(store.getCreation('c').pendingProposalCount).toBe(3);
    const resolve = (id, action, force = false) => req('resolve_proposal', { creationId: 'c', proposalId: id, action, force });
    expect(resolve(rejected.id, 'reject').proposal.status).toBe('rejected');
    store.updateNode('c', node.id, { content: 'User revised' });
    expect(resolve(edit.id, 'accept')).toMatchObject({ conflict: true, currentContent: 'User revised' });
    expect(resolve(edit.id, 'accept', true)).toMatchObject({ node: { content: 'Proposed' }, proposal: { status: 'accepted' } });
    expect(resolve(patch.id, 'accept')).toMatchObject({ canon: { lockedByUser: true, contentMd: 'Approved later' } });
    expect(req('list_proposals', { creationId: 'c', status: 'pending' }).proposals).toEqual([]);
  });

  it('recovers interrupted leases without replay and preserves progress', () => {
    store.createCreation({ id: 'c' });
    const run = store.createRun('c', { bootId: 'boot-a', type: 'batch', progress: { completed: 1, total: 3 }, currentNodeId: 'b' });
    const second = createCreationStore({ yeaftDir: dir });
    try {
      expect(second.recoverInterruptedRuns('boot-a')).toEqual([]);
      expect(second.recoverInterruptedRuns('boot-b')).toMatchObject([{ id: run.id, status: 'paused', reason: 'agent_restarted', leaseEpoch: 2, currentNodeId: null, progress: { completed: 1 } }]);
      expect(store.updateRun('c', run.id, run, { status: 'completed' })).toBeNull();
      expect(second.recoverInterruptedRuns('boot-b')).toEqual([]);
    } finally { second.close(); }
  });

  it('relays lazy authenticated requests and the Server’s media-pull contract', async () => {
    const sent = [];
    let loaded = 0;
    const bridge = createCreationBridge({ context: { CONFIG: { yeaftDir: dir }, agentId: 'agent:1' }, send: msg => sent.push(msg),
      createService: options => { loaded++; return createCreationService(options); } });
    try {
      await bridge.request({ type: 'creation_request', requestId: 'unauth', op: 'list_creations' });
      expect(loaded).toBe(0);
      await bridge.request({ type: 'creation_request', ownerId: 'owner', requestId: 'req', op: 'create_creation', payload: { id: 'relay', textSources: [''] } });
      const response = sent.find(msg => msg.requestId === 'req');
      expect(response).toMatchObject({ ok: true, data: { sources: [{ url: expect.stringContaining('/agent%3A1/relay/media/source/') }] } });
      await bridge.mediaRead({ type: 'creation_media_read', requestId: 'media', creationId: 'relay', mediaKind: 'source', mediaId: response.data.sources[0].id, start: 0, end: 0 });
      expect(sent.at(-1)).toMatchObject({ type: 'creation_media_chunk', requestId: 'media', ok: true, totalSize: 0, end: -1, data: '' });
      expect(sent.some(msg => msg.type === 'creation_event')).toBe(true);
      expect(loaded).toBe(1);
    } finally { await bridge.close(); }
  });
});
