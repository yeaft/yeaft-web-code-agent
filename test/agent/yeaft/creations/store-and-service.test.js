import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { BUFFERABLE_TYPES } from '../../../../agent/connection/buffer.js';
import { createCreationBridge, createCreationService, createCreationStore, parseSource } from '../../../../agent/yeaft/creations/index.js';

let dir;
let service;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yeaft-creation-'));
  service = createCreationService({ yeaftDir: dir, bootId: 'boot-a', mediaUrlFor: (id, kind, mediaId) => `/mock/${id}/${kind}/${mediaId}` });
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
    const bridge = createCreationBridge({ context: { CONFIG: { yeaftDir: dir, serverUrl: 'wss://one.example' }, agentId: 'agent:1' }, send: msg => sent.push(msg),
      createService: options => { loaded++; return createCreationService(options); } });
    try {
      await bridge.request({ type: 'creation_request', requestId: 'unauth', op: 'list_creations' });
      expect(loaded).toBe(0);
      await bridge.request({ type: 'creation_request', ownerId: 'owner', requestId: 'req', op: 'create_creation', payload: { id: 'relay', textSources: [''] } });
      const response = sent.find(msg => msg.requestId === 'req');
      expect(response).toMatchObject({ ok: true, data: { sources: [{ url: expect.stringContaining('/agent%3A1/relay/media/source/') }] } });
      await bridge.mediaRead({ type: 'creation_media_read', ownerId: 'owner', requestId: 'media', creationId: 'relay', mediaKind: 'source', mediaId: response.data.sources[0].id, start: 0, end: 0 });
      expect(sent.at(-1)).toMatchObject({ type: 'creation_media_chunk', requestId: 'media', ok: true, totalSize: 0, end: -1, data: '' });
      expect(sent.filter(msg => msg.type === 'creation_event')).toMatchObject([{ ownerId: 'owner' }]);
      expect(loaded).toBe(1);
    } finally { await bridge.close(); }
  });
});

it('binds runtime storage to all three authenticated identity fields and fences media and retired events', async () => {
  const sent = [], runtimes = [], eventGuards = [];
  const context = { CONFIG: { yeaftDir: dir, serverUrl: 'wss://one.example' }, agentId: 'agent:1' };
  const bridge = createCreationBridge({ context, send: (msg, delivery) => {
    sent.push(msg);
    if (delivery) eventGuards.push(delivery.isCurrent);
  }, createService: options => {
    const runtime = createCreationService(options);
    const record = { ownerId: options.namespaceBinding.ownerId, closed: false, emit: options.emitEvent };
    runtimes.push(record);
    return { ...runtime, async close() { await runtime.close(); record.closed = true; } };
  } });
  const request = async (ownerId, op, payload) => {
    await bridge.request({ type: 'creation_request', ownerId, requestId: 'req', op, payload });
    return sent.at(-1);
  };
  const create = owner => request(owner, 'create_creation', { id: 'same', title: owner, textSources: ['scoped'] });
  try {
    store.createCreation({ id: 'standalone' });
    const first = await create('owner');
    expect(first).toMatchObject({ ok: true, data: { creation: { title: 'owner' } } });
    const oldEvent = eventGuards.at(-1);
    expect(oldEvent()).toBe(true);
    const media = { type: 'creation_media_read', requestId: 'chunk', creationId: 'same', mediaKind: 'source', mediaId: first.data.sources[0].id };
    await bridge.mediaRead(media);
    expect(sent.at(-1)).toMatchObject({ ok: false, errorCode: 'invalid_request' });
    expect(runtimes).toHaveLength(1);
    await bridge.mediaRead({ ...media, ownerId: 'other' });
    expect(sent.at(-1)).toMatchObject({ ok: false, errorCode: 'not_found' });
    expect((await request('other', 'list_creations')).data.creations).toEqual([]);
    expect(oldEvent()).toBe(true);
    expect((await create('other')).ok).toBe(true);
    await bridge.mediaRead({ ...media, ownerId: 'owner' });
    expect(sent.at(-1)).toMatchObject({ ok: true, data: b64('scoped') });
    runtimes[0].emit({ type: 'creation_upserted' });
    expect(sent.at(-1)).toMatchObject({ type: 'creation_event', ownerId: 'owner' });
    expect(sent.filter(msg => msg.type === 'creation_event').some(msg => msg.ownerId === 'other')).toBe(true);

    for (const ownerId of ['third', 'fourth', 'fifth']) await request(ownerId, 'list_creations');
    expect(runtimes.filter(r => r.closed).map(r => r.ownerId)).toEqual(['other']);
    expect(oldEvent()).toBe(true);
    const count = sent.length;
    runtimes[1].emit({ type: 'creation_upserted' });
    expect(sent).toHaveLength(count);
    context.CONFIG.serverUrl = 'wss://two.example';
    expect(oldEvent()).toBe(false);
    expect((await request('other', 'list_creations')).data.creations).toEqual([]);
    expect(runtimes.slice(0, 5).every(r => r.closed)).toBe(true);
    await create('other');
    context.agentId = 'agent:2';
    expect((await request('other', 'list_creations')).data.creations).toEqual([]);
    expect(runtimes[5].closed).toBe(true);
    await bridge.mediaRead({ ...media, ownerId: 'owner' });
    expect(sent.at(-1).ok).toBe(false);
    context.CONFIG.serverUrl = 'wss://one.example';
    context.agentId = 'agent:1';
    expect((await request('owner', 'list_creations')).data.creations).toMatchObject([{ id: 'same', title: 'owner' }]);
    await bridge.mediaRead({ ...media, ownerId: 'owner' });
    expect(sent.at(-1)).toMatchObject({ ok: true, data: b64('scoped') });
    expect(BUFFERABLE_TYPES.has('creation_event')).toBe(false);
    const binding = { serverUrl: context.CONFIG.serverUrl, agentId: context.agentId, ownerId: 'owner' };
    const key = createHash('sha256').update(Object.values(binding).join('\0')).digest('hex').slice(0, 24);
    const marker = join(dir, 'creations', `ns-${key}`, '.namespace.json');
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(binding);
    for (const ownerId of ['other', 'third', 'fourth', 'fifth']) await request(ownerId, 'list_creations');
    writeFileSync(marker, JSON.stringify({ ...binding, ownerId: 'other' }));
    expect(await request('owner', 'list_creations')).toMatchObject({ ok: false, errorCode: 'invalid_path' });
  } finally { await bridge.close(); }
  expect(runtimes.every(r => r.closed)).toBe(true);
});

it('compacts large snapshot proposals and returns byte-budgeted, node-filtered full pages', () => {
  store.createCreation({ id: 'book' });
  store.createNode('book', { id: 'chapter' });
  store.createNode('book', { id: 'other' });
  const prose = 'é'.repeat(200 * 1024);
  const proposals = Array.from({ length: 15 }, () => store.proposeUnitEdit('book', 'chapter', { proposedContent: prose }));
  store.proposeUnitEdit('book', 'other', { proposedContent: 'Other chapter' });
  store.proposeCanonPatch('book', { title: 'Canon title', contentMd: 'Canon body' });
  const detail = req('get_creation', { creationId: 'book' });
  expect(detail.proposals).toHaveLength(17);
  expect(detail.proposals[0].patch).toMatchObject({ title: 'Canon title' });
  const compact = detail.proposals.at(-1);
  expect(compact.proposedContent).toBeUndefined();
  expect(Buffer.byteLength(compact.preview)).toBe(2048);
  expect(compact.diffStats.addedLines).toBe(1);
  const params = { creationId: 'book', nodeId: 'chapter' };
  const full = req('get_node', params).pendingProposals;
  expect(full).toHaveLength(3);
  for (const item of full) {
    expect(item.proposedContent).toBe(prose);
    expect(item.contentTruncated).toBeUndefined();
  }
  const page = req('list_proposals', params);
  expect(page).toEqual({ proposals: full, hasMore: true, nextOffset: 3 });
  expect(req('list_proposals', { ...params, offset: page.nextOffset, limit: 1 })).toEqual({
    proposals: [proposals[11]], hasMore: true, nextOffset: 4,
  });
  expect(req('list_proposals', { ...params, offset: 14, limit: 1 })).toEqual({
    proposals: [proposals[0]], hasMore: false, nextOffset: null,
  });
  const escaped = store.proposeUnitEdit('book', 'chapter', { proposedContent: '\x00'.repeat(400 * 1024) });
  const [oversized] = req('get_node', params).pendingProposals;
  expect(oversized).toMatchObject({ id: escaped.id, contentTruncated: true });
  expect(oversized.proposedContent).toBeUndefined();
  expect(req('get_proposal', { creationId: 'book', proposalId: escaped.id }).proposal).toEqual(escaped);
  expect(() => req('get_proposal', { creationId: 'missing', proposalId: escaped.id })).toThrow(err('NOT_FOUND'));
});

it('pages large folder thread histories newest-first without exceeding the byte budget', () => {
  store.createCreation({ id: 'book' });
  store.createNode('book', { id: 'folder', type: 'folder' });
  const thread = store.getThread('book', { scopeType: 'node', scopeId: 'folder' });
  const scope = { threadId: thread.id, scopeType: 'node', scopeId: 'folder' };
  expect(store.getThread('book', scope)).toEqual(thread);
  const text = 'x'.repeat(256 * 1024);
  for (let i = 0; i < 15; i++) store.addMessage('book', thread.id, { id: `msg${i}`, role: 'assistant', text, content: text });
  store.addMessage('book', thread.id, { id: 'escaped', role: 'assistant', text: '\x00'.repeat(256 * 1024), content: '\x00'.repeat(256 * 1024) });
  let params = { creationId: 'book', ...scope };
  const seen = [];
  do {
    const page = req('get_thread', params);
    expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(1.5 * 1024 * 1024);
    expect(page.hasMore).toBe(page.nextBeforeId !== null);
    if (!seen.length) expect(page.messages.at(-1)).toMatchObject({ id: 'escaped', contentTruncated: true });
    seen.unshift(...page.messages.map(m => m.id));
    params = { ...params, beforeId: page.nextBeforeId };
  } while (params.beforeId);
  expect(seen).toEqual([...Array.from({ length: 15 }, (_, i) => `msg${i}`), 'escaped']);
});

it('serves large Markdown and JSON exports as downloadable ranged assets', () => {
  store.createCreation({ id: 'book' });
  for (let i = 0; i < 18; i++) store.createNode('book', { content: 'x'.repeat(480 * 1024) });
  for (const [format, ext, mimeType] of [['markdown', 'md', 'text/markdown'], ['json', 'json', 'application/json']]) {
    const result = req('export_creation', { creationId: 'book', format });
    expect(result).toMatchObject({ format, filename: `book.${ext}`, mimeType, streamed: true, downloadUrl: `/mock/book/asset/${result.assetId}` });
    expect(result.assetId).toBe(`export-${format}`);
    expect(result.byteLength).toBeGreaterThan(8 * 1024 * 1024);
    expect(result.content).toBeUndefined();
    expect(store.readMediaRange('book', 'asset', result.assetId, result.byteLength - 2)).toMatchObject({
      totalSize: result.byteLength, end: result.byteLength - 1, mimeType, filename: result.filename, disposition: 'attachment',
    });
  }
});

it('replaces a streamed export without accumulating assets or files', () => {
  store.createCreation({ id: 'book' });
  const outlineMd = 'x'.repeat(32 * 1024);
  for (let i = 0; i < 100; i++) store.createNode('book', { id: `node${i}`, outlineMd });
  const exportAgain = format => req('export_creation', { creationId: 'book', format });
  const first = exportAgain('markdown');
  const regular = store.saveAsset('book', { ext: 'md', content: 'Separate asset' });
  store.updateNode('book', 'node0', { title: 'New title' });
  expect(() => store.transaction(() => {
    exportAgain('markdown');
    throw new Error('roll back export');
  })).toThrow('roll back export');
  expect(store.readMediaRange('book', 'asset', first.assetId, 0, 100).bytes.toString()).not.toContain('New title');
  for (let i = 0; i < 3; i++) expect(exportAgain('md').assetId).toBe(first.assetId);
  expect(store.listAssets('book').map(asset => asset.id)).toEqual([first.assetId, regular.id]);
  expect(readdirSync(join(dir, 'creations', 'book', 'assets'))).toHaveLength(2);
  expect(store.readMediaRange('book', 'asset', first.assetId, 0, 100).bytes.toString()).toContain('New title');
});

it('reads persisted namespace media after restart without a prior Creation RPC', async () => {
  const context = { CONFIG: { yeaftDir: dir, serverUrl: 'wss://one.example' }, agentId: 'agent:1' };
  const sent = [];
  const open = () => createCreationBridge({ context, send: msg => sent.push(msg) });
  const ownerId = 'owner';
  const writer = open();
  let mediaId;
  try {
    await writer.request({ type: 'creation_request', requestId: 'create', ownerId,
      op: 'create_creation', payload: { id: 'book', textSources: ['persisted'] } });
    mediaId = sent.at(-1).data.sources[0].id;
  } finally { await writer.close(); }
  const reader = open();
  try {
    await reader.mediaRead({ type: 'creation_media_read', ownerId, requestId: 'read', creationId: 'book', mediaKind: 'source', mediaId });
    expect(sent.at(-1)).toMatchObject({ type: 'creation_media_chunk', requestId: 'read', ok: true, data: b64('persisted') });
  } finally { await reader.close(); }
});

it('bounds large creation snapshots without losing the full node or Canon bodies', () => {
  const creationId = 'book';
  store.createCreation({ id: creationId });
  const body = 'x'.repeat(32 * 1024);
  store.transaction(() => {
    for (let i = 0; i < 250; i++) store.createNode(creationId, { id: `node${i}`, outlineMd: body });
    for (let i = 0; i < 500; i++) store.upsertCanon(creationId, { id: `canon${i}`, contentMd: body });
  });
  const detail = req('get_creation', { creationId });
  expect(detail.nodes).toHaveLength(250);
  expect(detail.canon).toHaveLength(500);
  expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(5 * 1024 * 1024);
  expect(detail.nodes[0]).toMatchObject({ outlineMd: body.slice(0, 512), outlineTruncated: true });
  expect(detail.canon[0]).toMatchObject({ contentMd: body.slice(0, 512), contentTruncated: true });
  expect(req('get_node', { creationId, nodeId: 'node0' }).node.outlineMd).toBe(body);
  expect(req('get_canon', { creationId, canonId: 'canon0' }).canon.contentMd).toBe(body);
  expect(() => req('get_canon', { creationId, canonId: 'missing' })).toThrow(err('NOT_FOUND'));
});

it('returns canonical node fields after mutations, including emitted node events', async () => {
  await service.close();
  const events = [];
  service = createCreationService({ yeaftDir: dir, emitEvent: event => events.push(event) });
  store = service.store;
  req('create_creation', { id: 'book' });
  const assertNode = (node, isFolder) => expect(node).toMatchObject({ sortOrder: node.position, isFolder });
  assertNode(store.createNode('book', { id: 'folder', type: 'folder' }), true);
  assertNode(store.updateNode('book', 'folder', { title: 'Revised' }), true);
  assertNode(req('create_node', { creationId: 'book', id: 'unit' }).node, false);
  assertNode(req('update_node', { creationId: 'book', nodeId: 'unit', content: 'Prose' }).node, false);
  const nodeEvents = events.filter(event => ['node_upserted', 'node_content_updated'].includes(event.type));
  expect(nodeEvents.map(event => event.type)).toEqual(['node_upserted', 'node_content_updated']);
  for (const { node } of nodeEvents) assertNode(node, false);
  const [unit, folder] = store.reorderNodes('book', null, ['unit', 'folder']);
  assertNode(unit, false);
  assertNode(folder, true);
  expect(store.getNode('book', 'folder').sortOrder).toBe(1);
  expect(store.listNodes('book').map(node => node.sortOrder)).toEqual([0, 1]);
});

it('deduplicates imports across restarts without replaying sources, starter nodes, or planning', async () => {
  const importKey = 'upload:original';
  expect(() => req('create_creation', { importKey, starterNode: { parentId: 'missing' } })).toThrow(err('NOT_FOUND'));
  const first = req('create_creation', { importKey, starterNode: true, textSources: ['note'] });
  await service.close();
  const events = [];
  service = createCreationService({ yeaftDir: dir, emitEvent: event => events.push(event) });
  const retry = req('create_creation', { importKey, id: 'new-id', prompt: 'Do not plan again', textSources: ['duplicate'] });
  expect(retry).toEqual({ ...req('get_creation', { creationId: first.creation.id }), deduplicated: true });
  expect(retry.sources.map(source => source.id)).toEqual(first.sources.map(source => source.id));
  expect(retry.nodes).toHaveLength(1);
  expect(retry.runs).toEqual([]);
  expect(events).toEqual([]);
  expect(req('list_creations').creations).toHaveLength(1);
  expect(() => req('create_creation', { importKey: 'x'.repeat(129) })).toThrow(err('INVALID_REQUEST'));
});

it('keeps only the latest 50 revision metadata entries on reads and mutations', () => {
  store.createCreation({ id: 'book' });
  const initial = store.createNode('book', { id: 'chapter', content: 'Original' });
  const scope = { creationId: 'book', nodeId: initial.id };
  for (let i = 0; i < 55; i++) store.updateNode('book', initial.id, { content: `Revision ${i}` });
  const update = req('update_node', { ...scope, content: 'Updated' });
  expect(update.revisions).toHaveLength(50);
  expect(update.revisions[0]).toMatchObject({ id: update.node.currentRevId });
  expect(update.revisions[0].content).toBeUndefined();
  expect(req('get_node', scope).revisions).toEqual(update.revisions);
  expect(req('restore_revision', { ...scope, revId: initial.currentRevId }).revisions).toHaveLength(50);
  const proposal = store.proposeUnitEdit('book', initial.id, { proposedContent: 'Accepted' });
  expect(req('resolve_proposal', { ...scope, proposalId: proposal.id, action: 'accept' }).revisions).toHaveLength(50);
});

it('fails interrupted thread runs on service boot and persists one terminal assistant message', async () => {
  store.createCreation({ id: 'book' });
  const thread = store.getThread('book');
  const run = store.createRun('book', { type: 'thread', threadId: thread.id, assistantMessageId: 'assistant', bootId: 'boot-a' });
  await service.close();
  service = createCreationService({ yeaftDir: dir, bootId: 'boot-b' });
  expect(service.store.getRun('book', run.id)).toMatchObject({ status: 'failed', reason: 'agent_restarted' });
  expect(service.store.recoverInterruptedRuns('boot-c')).toEqual([]);
  expect(req('get_thread', { creationId: 'book', threadId: thread.id }).messages).toMatchObject([{
    id: 'assistant', role: 'assistant', status: 'failed', runId: run.id,
    text: 'Turn interrupted by Agent restart.', content: 'Turn interrupted by Agent restart.',
  }]);
});

it('bounds PDF scanning on malformed input and ignores bytes beyond 2 MiB', () => {
  const prefix = Buffer.from('%PDF-1.4\nBT [(escaped\\) literal) <');
  const input = Buffer.concat([prefix, Buffer.alloc(12 * 1024 * 1024, 'a'), Buffer.from('> ] TJ ET\nBT (outside) Tj ET')]);
  const start = performance.now();
  const parsed = parseSource(input, { name: 'huge.pdf' });
  expect(performance.now() - start).toBeLessThan(500); // CI scheduling margin around the parser's 250ms budget.
  expect(parsed).toMatchObject({ kind: 'pdf', truncated: true, chunks: [] });
});
