import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCreationContext, buildCreationToolRegistry, createCreationService } from '../../../../agent/yeaft/creations/index.js';

let dir;
let service;
let events;
const setup = engineFactory => (service = createCreationService({ yeaftDir: dir, bootId: 'test-boot', engineFactory,
  emitEvent: event => events.push(event), mediaUrlFor: (id, kind, mediaId) => `/mock/${id}/${kind}/${mediaId}` }));
const tool = async (registry, name, input) => JSON.parse(await registry.execute(`creation_${name}`, input));
const terminal = { type: 'turn_end', stopReason: 'end_turn', terminal: true };
const req = (op, payload) => service.request({ op, payload });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yeaft-creation-runner-')); events = []; });
afterEach(async () => { await service?.close(); rmSync(dir, { recursive: true, force: true }); });

it('builds deterministic five-layer context and filters excluded chips', () => {
  const { store } = setup();
  store.createCreation({ id: 'book', title: 'Epic', mission: 'Find the court' });
  store.upsertCanon('book', { id: 'pinned', pinned: true, title: 'Never travel alone' });
  store.upsertCanon('book', { id: 'recall', title: 'Ash Court', contentMd: 'A hidden palace' });
  store.upsertCanon('book', { id: 'exclude', title: 'Ash exiles' });
  store.upsertCanon('book', { id: 'ref', title: 'Named reference' });
  const [source, ignored] = store.addSources('book', { textSources: [{ name: 'Palace notes', text: 'Ash Court architecture' }, 'Ash Court other notes'] });
  store.createNode('book', { id: 'volume', type: 'folder' });
  for (let i = 1; i <= 6; i++) store.createNode('book', { id: `c${i}`, parentId: 'volume', title: `Chapter ${i}`,
    content: `Prior prose ${i}`, summaryMd: `Continuity ${i}` });
  store.createNode('book', { id: 'active', parentId: 'volume', title: 'Ash Court', outlineMd: 'Meeting the court', canonRefs: ['ref'] });
  const thread = store.getThread('book', { scopeType: 'node', scopeId: 'active' });
  store.addMessage('book', thread.id, { role: 'user', text: 'Thread-only comment' });
  store.addMessage('book', store.getThread('book').id, { role: 'user', text: 'Global-only comment' });
  const args = { store, creationId: 'book', threadId: thread.id, prompt: 'Explore Ash', anchor: { quote: 'Selected prose' }, excludedContextIds: ['exclude', ignored.id, 'c5'] };
  const context = buildCreationContext(args);
  expect(buildCreationContext(args)).toEqual(context);
  expect(context.contextMeta.pinnedCanon.map(item => item.id)).toEqual(['pinned']);
  expect(context.contextMeta.recalledCanon.map(item => item.id)).toEqual(['ref', 'recall']);
  expect(context.contextMeta.continuityNodes.map(item => item.id)).toEqual(['c6', 'c4', 'c3', 'c2']);
  expect(context.contextMeta.sources.map(item => item.sourceId)).toEqual([source.id]);
  for (const value of ['Find the court', 'Prior prose 6', 'Continuity 3', 'Selected prose', 'Thread-only comment', 'Ash Court architecture']) expect(context.promptContext).toContain(value);
  for (const value of ['Prior prose 5', 'Continuity 1', 'Global-only comment']) expect(context.promptContext).not.toContain(value);
});

it('exposes only scoped Creation tools, preserves reviewed work, and validates asset bytes', async () => {
  const { store } = setup();
  store.createCreation({ id: 'book' });
  store.createCreation({ id: 'other' });
  const [source] = store.addSources('book', { textSources: ['Comet notes'] });
  const [foreign] = store.addSources('other', { textSources: ['Foreign'] });
  store.upsertCanon('book', { id: 'fixed', title: 'Comet', lockedByUser: true });
  const registry = buildCreationToolRegistry({ store, creationId: 'book', emitEvent: event => events.push(event), mediaUrlFor: (id, kind, mediaId) => `/${id}/${kind}/${mediaId}` });
  expect(registry.names).toHaveLength(10);
  expect(registry.names.every(name => name.startsWith('creation_'))).toBe(true);
  expect(await tool(registry, 'read_source', { sourceId: source.id })).toMatchObject({ chunks: [{ text: 'Comet notes' }] });
  await expect(tool(registry, 'read_source', { sourceId: foreign.id, creationId: 'other' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await tool(registry, 'search_sources', { query: 'comet' })).toMatchObject([{ sourceId: source.id }]);
  expect(await tool(registry, 'read_canon', { canonId: 'fixed' })).toMatchObject({ lockedByUser: true });
  expect(await tool(registry, 'propose_canon_patch', { canonId: 'fixed', contentMd: 'Change', autoApplyUnlocked: true })).toMatchObject({ proposal: { status: 'pending', type: 'canon_patch' } });
  expect(store.getCanon('book', 'fixed').contentMd).toBe('');
  expect(await tool(registry, 'propose_canon_patch', { title: 'Brand new', autoApplyUnlocked: true })).toMatchObject({ canon: { lockedByUser: false } });
  await tool(registry, 'upsert_outlines', { nodes: [{ id: 'volume', type: 'folder', title: 'Volume' },
    { id: 'unit', parentId: 'volume', outlineMd: 'Introduction' }, { id: 'edited', parentId: 'volume' }] });
  expect(await tool(registry, 'list_structure', {})).toMatchObject([{ id: 'volume', children: [{ id: 'unit' }, { id: 'edited' }] }]);
  expect(await tool(registry, 'write_unit', { nodeId: 'unit', content: 'First\nSecond' })).toMatchObject({ node: { status: 'draft', userEdited: false } });
  await tool(registry, 'upsert_outlines', { nodes: [{ id: 'unit', outlineMd: 'Revised outline', content: 'Must not overwrite' }] });
  expect(store.getNode('book', 'unit')).toMatchObject({ content: 'First\nSecond', outlineMd: 'Revised outline' });
  await tool(registry, 'update_unit_summary', { nodeId: 'unit', summaryMd: 'Continuity stored' });
  store.updateNode('book', 'unit', { status: 'final' });
  store.updateNode('book', 'edited', { content: 'User prose' });
  expect(await tool(registry, 'write_unit', { nodeId: 'unit', content: 'First\nThird' })).toMatchObject({ proposal: { status: 'pending', diffStats: { addedLines: 1, removedLines: 1 } } });
  expect(await tool(registry, 'write_unit', { nodeId: 'edited', content: 'AI prose' })).toMatchObject({ proposal: { nodeId: 'edited' } });
  expect(await tool(registry, 'propose_unit_edit', { nodeId: 'unit', proposedContent: 'Replacement', summary: 'Edit', anchor: { quote: 'First' } })).toMatchObject({ proposal: { baseRevId: store.getNode('book', 'unit').currentRevId, anchor: { quote: 'First' }, summary: 'Edit' } });
  expect(store.getNode('book', 'unit')).toMatchObject({ content: 'First\nSecond', summaryMd: 'Continuity stored' });
  const { asset } = await tool(registry, 'save_asset', { ext: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
  expect(asset.url).toBe(`/book/asset/${asset.id}`);
  expect(store.readMediaRange('book', 'asset', asset.id, 0, 3).bytes.toString()).toBe('<svg');
  await expect(tool(registry, 'save_asset', { ext: 'png', base64: 'Zm9v' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(events.map(event => event.type)).toEqual(expect.arrayContaining(['proposal_created', 'node_content_updated', 'asset_saved']));
});

it('immediately starts planning, streams a turn, and persists the scoped transcript', async () => {
  setup(({ toolRegistry }) => ({ async *query(params) {
    expect(params.scenario).toBe('creation');
    expect(params.prompt).toContain('Plan a comet tale');
    expect(params.turnConfig).toEqual({ model: 'model', effort: 'low' });
    yield { type: 'text_delta', text: 'Plan: ' };
    yield { type: 'tool_start', id: 't', name: 'creation_upsert_outlines' };
    await tool(toolRegistry, 'upsert_outlines', { nodes: [{ id: 'act', title: 'Opening' }] });
    yield { type: 'tool_end', id: 't', name: 'creation_upsert_outlines' };
    yield { type: 'turn_end', stopReason: 'tool_use', terminal: false };
    yield { type: 'text_delta', text: 'Opening' };
    yield terminal;
  } }));
  const { creation, thread, initialTurn } = req('create_creation', { id: 'book', prompt: 'Plan a comet tale', model: 'model', effort: 'low' });
  expect(creation.activeRunStatus).toBe('running');
  await service.runner.waitForRun(initialTurn.run.id);
  expect(req('get_thread', { creationId: 'book', threadId: thread.id }).messages).toMatchObject([{ role: 'user', text: 'Plan a comet tale' }, { role: 'assistant', text: 'Plan: Opening', status: 'complete' }]);
  expect(events.filter(event => event.type === 'thread_message_delta').map(event => event.delta)).toEqual(['Plan: ', 'Opening']);
  expect(events.filter(event => event.type === 'thread_tool_status').map(event => event.status)).toEqual(['running', 'complete']);
  expect(service.store.getRun('book', initialTurn.run.id).status).toBe('completed');
});

it('runs ordered chapters, checkpoints, resumes, preserves committed drafts on failure, and cancels safely', async () => {
  const order = [];
  let failedOnce = false;
  let block = false;
  let inFlight;
  let signal;
  let oldTools;
  setup(({ toolRegistry }) => ({ async *query(params) {
    const nodeId = /Draft the full unit (\w+)/.exec(params.prompt)[1];
    order.push(nodeId);
    yield { type: 'text_delta', text: 'Drafting' };
    await tool(toolRegistry, 'write_unit', { nodeId, content: `Complete prose for ${nodeId}` });
    await tool(toolRegistry, 'update_unit_summary', { nodeId, summaryMd: `Summary ${nodeId}` });
    if (nodeId === 'b' && !failedOnce) { failedOnce = true; yield { type: 'error', error: new Error('provider disconnected') }; return; }
    if (nodeId === 'c' && block) {
      signal = params.signal;
      oldTools = toolRegistry;
      inFlight();
      await new Promise(() => {});
    }
    yield terminal;
  } }));
  req('create_creation', { id: 'book' });
  for (const id of ['a', 'b', 'c']) service.store.createNode('book', { id });
  const { run } = req('start_batch_run', { creationId: 'book', nodeIds: ['a', 'b', 'c'], checkpointEvery: 1 });
  const control = action => req('control_run', { creationId: 'book', runId: run.id, action }).run;
  const current = () => service.store.getRun('book', run.id);
  const wait = () => service.runner.waitForRun(run.id);
  await wait();
  expect(current()).toMatchObject({ status: 'paused', reason: 'checkpoint', completedNodeIds: ['a'] });
  expect(service.store.getNode('book', 'a').summaryMd).toBe('Summary a');
  const revA = service.store.getNode('book', 'a').currentRevId;
  expect(control('resume').leaseEpoch).toBe(2);
  await wait();
  expect(current()).toMatchObject({ status: 'paused', reason: 'unit_failed', failedNodeId: 'b', completedNodeIds: ['a'] });
  expect(service.store.getNode('book', 'b').content).toBe('');
  control('resume');
  await wait();
  expect(current()).toMatchObject({ status: 'paused', completedNodeIds: ['a', 'b'] });
  const reached = new Promise(resolve => { inFlight = resolve; });
  block = true;
  control('resume');
  await reached;
  expect(control('cancel').status).toBe('cancelled');
  await wait();
  expect(signal.aborted).toBe(true);
  await expect(tool(oldTools, 'write_unit', { nodeId: 'c', content: 'late' })).rejects.toBeDefined();
  expect(service.store.getNode('book', 'a').currentRevId).toBe(revA);
  expect(service.store.getNode('book', 'c').content).toBe('');
  expect(order).toEqual(['a', 'b', 'b', 'c']);
  expect(events.filter(event => event.type === 'node_content_updated').map(event => event.nodeId)).toEqual(['a', 'b']);
  expect(events.some(event => event.type === 'node_content_delta')).toBe(true);
});

it('commits all batch units before completed, without pausing at the final checkpoint', async () => {
  setup(({ toolRegistry }) => ({ async *query({ prompt }) {
    const nodeId = /Draft the full unit (\w+)/.exec(prompt)[1];
    await tool(toolRegistry, 'write_unit', { nodeId, content: `Draft ${nodeId}` });
    yield terminal;
  } }));
  req('create_creation', { id: 'book' });
  for (const id of ['a', 'b']) service.store.createNode('book', { id });
  const { run } = req('start_batch_run', { creationId: 'book', nodeIds: ['a', 'b'], checkpointEvery: 2 });
  await service.runner.waitForRun(run.id);
  expect(service.store.getRun('book', run.id)).toMatchObject({ status: 'completed', progress: { completed: 2, total: 2 } });
  expect(service.store.getCreation('book')).toMatchObject({ activeRunStatus: null, readableUnitCount: 2 });
  expect(events.findLast(event => event.type === 'creation_upserted')?.creation).toMatchObject({ activeRunStatus: null, readableUnitCount: 2 });
});

it('pauses an in-flight unit and fences its old tools across immediate resume', async () => {
  let entered;
  let staleRegistry;
  const running = new Promise(resolve => { entered = resolve; });
  setup(({ toolRegistry, run }) => ({ async *query() {
    if (run.leaseEpoch === 1) {
      staleRegistry = toolRegistry;
      entered();
      await new Promise(() => {});
    }
    await tool(toolRegistry, 'write_unit', { nodeId: 'unit', content: 'Resumed draft' });
    yield terminal;
  } }));
  req('create_creation', { id: 'book' });
  service.store.createNode('book', { id: 'unit' });
  const { run } = req('start_batch_run', { creationId: 'book', nodeIds: ['unit'] });
  const control = action => req('control_run', { creationId: 'book', runId: run.id, action }).run;
  await running;
  expect(control('pause')).toMatchObject({ status: 'paused', reason: 'user_paused' });
  expect(control('resume').status).toBe('running');
  await expect(tool(staleRegistry, 'write_unit', { nodeId: 'unit', content: 'Stale draft' })).rejects.toBeDefined();
  await service.runner.waitForRun(run.id);
  expect(service.store.getNode('book', 'unit').content).toBe('Resumed draft');
  expect(service.store.listRevisions('book', 'unit')).toHaveLength(1);
});

it('includes explicit attachments before lexical hits, even with no matching filename or text', async () => {
  let prompt;
  const { store } = setup(() => ({ async *query(params) { prompt = params.prompt; yield terminal; } }));
  store.createCreation({ id: 'book' });
  const [attached, relevant] = store.addSources('book', { textSources: [
    { name: 'input.txt', text: 'Unique first excerpt. ' + 'z'.repeat(4500) },
    { name: 'reference.txt', text: 'Review the comet' },
  ] });
  const context = buildCreationContext({ store, creationId: 'book', prompt: 'Review the comet', attachedSourceIds: [attached.id, attached.id] });
  expect(context.promptContext).toContain('Unique first excerpt.');
  expect(context.contextMeta.sources.map(item => item.id)).toEqual([attached.id, attached.id, relevant.id]);
  const turn = req('send_message', { creationId: 'book', text: 'Review the comet', attachedSourceIds: [attached.id],
    textSources: [{ name: 'input2.txt', text: 'Newly uploaded exhibit' }] });
  await service.runner.waitForRun(turn.run.id);
  expect(prompt).toContain('Newly uploaded exhibit');
  expect(prompt).toContain('Unique first excerpt.');
  expect(turn.message.sourceIds).toEqual([turn.sources[0].id, attached.id]);
  expect(turn.contextMeta.sources.map(item => item.id)).toEqual([turn.sources[0].id, attached.id, attached.id, relevant.id]);
  expect(events.findLast(e => e.type === 'creation_upserted').creation.sourceCount).toBe(3);
});

it('atomically persists partial cancelled turns and emits exactly one matching terminal message', async () => {
  let arrived;
  const streamed = new Promise(resolve => { arrived = resolve; });
  setup(() => ({ async *query() {
    yield { type: 'text_delta', text: 'Partial prose' };
    arrived();
    await new Promise(() => {});
  } }));
  req('create_creation', { id: 'book' });
  const { run, thread } = req('send_message', { creationId: 'book', text: 'Draft a scene' });
  const control = action => req('control_run', { creationId: 'book', runId: run.id, action });
  await streamed;
  for (const action of ['pause', 'resume']) expect(() => control(action)).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  expect(control('cancel').run).toMatchObject({ status: 'cancelled', reason: 'user_cancelled' });
  const persisted = req('get_thread', { creationId: 'book', threadId: thread.id }).messages.at(-1);
  expect(persisted).toMatchObject({ id: run.assistantMessageId, role: 'assistant', status: 'cancelled', text: 'Partial prose', content: 'Partial prose', runId: run.id });
  expect(events.slice(-2)).toMatchObject([{ type: 'thread_message_complete', message: persisted }, { type: 'run_updated', run: { status: 'cancelled' } }]);
  await service.runner.waitForRun(run.id);
  control('cancel');
  expect(events.filter(e => e.type === 'thread_message_complete' && e.message.id === run.assistantMessageId)).toHaveLength(1);
});

it('projects canonical eligibility and refreshes L1 summaries on service and AI mutations', async () => {
  const { store } = setup();
  const creationId = 'book';
  req('create_creation', { id: creationId });
  const summary = () => events.findLast(event => event.type === 'creation_upserted').creation;
  const sameAsStore = () => expect(summary()).toEqual(store.getCreation(creationId));
  const folder = req('create_node', { creationId, node: { type: 'folder' } }).node;
  const node = req('create_node', { creationId }).node;
  expect(folder.batchEligible).toBe(false);
  expect(node.batchEligible).toBe(true);
  expect(summary().unitCount).toBe(1);
  const registry = buildCreationToolRegistry({ store, creationId, emitEvent: e => events.push(e) });
  await tool(registry, 'write_unit', { nodeId: node.id, content: 'Three little words' });
  expect(summary()).toMatchObject({ readableUnitCount: 1, wordCount: 3, hasReadableContent: true });
  const updated = req('update_node', { creationId, nodeId: node.id, patch: { status: 'final' } }).node;
  expect(updated.batchEligible).toBe(false);
  expect(store.getNode(creationId, node.id).batchEligible).toBe(false);
  expect(store.listNodes(creationId).every(n => !n.batchEligible)).toBe(true);
  const { proposal } = await tool(registry, 'write_unit', { nodeId: node.id, content: 'Review' });
  expect(summary().pendingProposalCount).toBe(1);
  req('resolve_proposal', { creationId, proposalId: proposal.id, action: 'reject' });
  expect(summary().pendingProposalCount).toBe(0);
  const [source] = req('add_sources', { creationId, textSources: ['Source'] }).sources;
  expect(summary().sourceCount).toBe(1);
  req('delete_source', { creationId, sourceId: source.id });
  expect(summary().sourceCount).toBe(0);
  req('upsert_canon', { creationId, canon: { id: 'canon', title: 'Canon' } });
  expect(events.at(-1).type).toBe('creation_upserted');
  sameAsStore();
  req('delete_node', { creationId, nodeId: node.id });
  expect(summary()).toMatchObject({ unitCount: 0, readableUnitCount: 0, wordCount: 0, hasReadableContent: false });
  sameAsStore();
});
