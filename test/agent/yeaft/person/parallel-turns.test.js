import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { PersonTaskHost } from '../../../../agent/yeaft/person/task-host.js';
import { routePersonTurn } from '../../../../agent/yeaft/person/turn-routing.js';
import { config, finalProposal } from './fixtures.js';

const resources = [];
afterEach(async () => { for (const { service, repository, dir } of resources.splice(0)) {
  await service?.close(); await repository?.close(); await rm(dir, { recursive: true, force: true });
} vi.restoreAllMocks(); });
const input = (id, routing) => ({ kind: 'send', text: id, clientMessageId: id, workerId: 'worker', budget: { calls: null }, routing });
const selection = { model: 'test/first', effort: null };
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'person-parallel-'));
  const repository = new SqlitePersonRepository({ yeaftDir: dir, leaseMs: 10000 });
  resources.push({ repository, dir }); await repository.open('alice'); return repository;
}
const text = value => [{ type: 'text_delta', text: value }, { type: 'stop', stopReason: 'end_turn' }];

it('isolates sibling leases, targeted inbox/attachments and cleanup across concurrent admissions and commits', async () => {
  const r = await setup();
  const a = (await r.admit('alice', input('first'))).episode;
  const b = (await r.admit('alice', input('second', { decision: 'unrelated' }))).episode;
  const supplement = await r.admit('alice', { ...input('more', { decision: 'related', targetThreadId: a.id }),
    files: [{ name: 'one.txt', mimeType: 'text/plain', data: Buffer.from('only-first').toString('base64') }] });
  expect(supplement).toMatchObject({ appended: true, episodeId: a.id, rootMessageId: a.messageId });
  expect(await r.pendingInputs(b)).toBe(false);
  expect(await r.receiveInputs(b)).toMatchObject({ messages: [], attachments: [] });
  const received = await r.receiveInputs(a); a.inboxVersion = received.inboxVersion;
  expect(received.attachments[0].content).toBe('only-first');
  expect(received.messages[0]).toMatchObject({ episodeId: a.id, rootMessageId: a.messageId });
  await expect(r.heartbeat(a)).resolves.toBeUndefined(); await expect(r.heartbeat(b)).resolves.toBeUndefined();
  const proposal = finalProposal(); proposal.concepts = []; proposal.state.focusConceptIds = [];
  expect((await r.commit(a, proposal, selection, 'first-final')).state.version).toBe(1);
  expect((await r.snapshot('alice')).activeEpisodes).toEqual([expect.objectContaining({
    id: b.id, episodeId: b.id, rootMessageId: b.messageId, status: 'running', createdAt: expect.any(Date),
  })]);
  await expect(r.heartbeat(b)).resolves.toBeUndefined();
  const conflict = await r.commit(b, proposal, selection, 'second-final');
  expect(conflict).toMatchObject({ stateConflict: true, snapshot: { state: { version: 1 } } });
  b.baseStateVersion = 1; proposal.baseStateVersion = 1;
  expect((await r.commit(b, proposal, selection, 'second-final')).state.version).toBe(2);
  expect((await r.snapshot('alice')).busy).toBe(false);
  expect((await r.list('alice', 'messages')).items.filter(m => m.role === 'assistant').every(m => m.rootMessageId)).toBe(true);
});

it('handles ended routing targets, independent cancellation, owner scope and legacy stop-all without losing receipts', async () => {
  const r = await setup(); await r.open('bob');
  const a = (await r.admit('alice', input('a'))).episode;
  const b = (await r.admit('alice', input('b', { decision: 'unrelated' }))).episode;
  await r.cancel('alice', a.id);
  expect((await r.snapshot('alice')).activeEpisodes.map(e => e.episodeId)).toEqual([b.id]);
  await expect(r.heartbeat(b)).resolves.toBeUndefined();
  const c = await r.admit('alice', input('c', { decision: 'related', targetThreadId: a.id }));
  expect(c.episodeId).not.toBe(a.id); expect(c.appended).toBeUndefined();
  const bob = await r.admit('bob', input('bob', { decision: 'related', targetThreadId: b.id }));
  expect(bob.episodeId).not.toBe(b.id);
  expect((await r.context(bob.episode)).messages.every(m => m.episodeId === bob.episodeId)).toBe(true);
  await r.cancel('alice');
  expect((await r.snapshot('alice')).activeEpisodes).toEqual([]);
  expect(await r.receipt('alice', 'c')).toMatchObject({ episodeId: c.episodeId, status: 'cancelled' });
  await expect(r.heartbeat(bob.episode)).resolves.toBeUndefined();
});

it('bounds classification, excludes private stream state and falls back without provider errors', async () => {
  const args = { person: { settings: {} }, activeEpisodes: [{ episodeId: 'active', inputPreview: 'first', status: 'running' }], messages: [], input: 'more' };
  const getProvider = async () => ({ defaultSelection: selection, adapter: { async *stream(params) {
    expect(params).toMatchObject({ model: selection.model, maxTokens: 256, tools: [] });
    yield { type: 'thinking_delta', text: 'private' }; yield { type: 'provider_state', providerState: { signature: 'private' } };
    yield* text('{"decision":"related","targetThreadId":"active","title":"Continue this work"}');
  } } });
  expect(await routePersonTurn({ ...args, getProvider })).toMatchObject({ decision: 'related', targetThreadId: 'active' });
  const never = async () => new Promise(() => {});
  expect(await routePersonTurn({ ...args, getProvider: never, timeoutMs: 10 })).toMatchObject({ decision: 'related', targetThreadId: 'active', reason: 'classifier_unavailable' });
});

it('runs concurrent service turns, routes supplements, shares only public sibling context and controls one without stopping another', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'person-parallel-service-'));
  const requests = [], releases = [];
  const adapter = { async *stream(params) {
    if (params.maxTokens === 256) {
      yield* text(params.messages[0].content.includes('supplement-first')
        ? JSON.stringify({ decision: 'related', targetThreadId: first.episodeId }) : '{"decision":"unrelated"}'); return;
    }
    requests.push(params);
    await new Promise(resolve => releases.push(resolve));
    yield* text('public result');
  } };
  const service = createPersonService({ yeaftDir: dir, workDir: dir, config, adapter, embedding: { enabled: false } });
  resources.push({ service, dir });
  const call = (op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
  const until = async predicate => { for (let i = 0; i < 250; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('not reached'); };
  await call('open');
  const first = await call('send', { text: 'first', clientMessageId: 'one' });
  await until(() => requests.length === 1);
  const second = await call('send', { text: 'second', clientMessageId: 'two' });
  await until(() => requests.length === 2);
  expect(second.episodeId).not.toBe(first.episodeId);
  const more = await call('send', { text: 'supplement-first', clientMessageId: 'three' });
  expect(more).toMatchObject({ episodeId: first.episodeId, rootMessageId: first.messageId, deliveryState: 'queued' });
  expect((await call('snapshot')).activeEpisodes).toHaveLength(2);
  expect((await call('executions')).active).toHaveLength(2);
  await call('pause', { episodeId: first.episodeId });
  expect((await call('snapshot')).activeEpisodes.find(e => e.episodeId === first.episodeId).status).toBe('pausing');
  await call('resume', { episodeId: first.episodeId });
  releases[0](); await until(() => requests.length === 3);
  expect(JSON.stringify(requests[2].messages)).toContain(second.episodeId);
  await call('cancel', { episodeId: first.episodeId });
  expect((await call('snapshot')).activeEpisodes.map(e => e.episodeId)).toEqual([second.episodeId]);
  await call('cancel');
  expect((await call('snapshot')).busy).toBe(false);
  for (const release of releases) release();
});

it('rebases concurrent final cognition without replaying either execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'person-parallel-rebase-'));
  let releaseFirst, entered;
  const firstEntered = new Promise(resolve => { entered = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let cognition = 0, executions = 0;
  const adapter = { async *stream(params) {
    if (params.maxTokens === 256) { yield* text('{"decision":"unrelated"}'); return; }
    if (params.tools.length) {
      if (params.messages.some(message => message.role === 'tool')) { yield* text('Ready.'); return; }
      executions++;
      const trigger = JSON.parse(params.messages[0].content).trigger;
      yield { type: 'tool_call', id: 'goal', name: 'Execution__goal', input: { objective: 'answer', acceptance: 'answer', kind: 'answer',
        status: 'completed', reason: 'ready', nextStep: '', sourceRefs: [trigger.ref], acceptanceChecks: [], waitFor: [], blocker: null } };
      yield { type: 'stop', stopReason: 'tool_use' }; return;
    }
    const count = ++cognition;
    if (count === 1) { entered(); await firstGate; }
    const rebase = params.messages.filter(m => typeof m.content === 'string').map(m => { try { return JSON.parse(m.content); } catch { return {}; } }).findLast(m => m.phase === 'cognition-rebase');
    const proposal = finalProposal(rebase?.baseStateVersion ?? JSON.parse(params.messages[0].content).state.version);
    // Both finalizers update the same concept: exercise real revision rebasing,
    // not only the top-level state version conflict.
    proposal.concepts[0].expectedRevision = rebase?.concepts.find(concept => concept.id === 'curiosity')?.revision ?? 0;
    proposal.reply = null;
    yield* text(JSON.stringify(proposal));
  } };
  const service = createPersonService({ yeaftDir: dir, workDir: dir, config, adapter, embedding: { enabled: false } });
  resources.push({ service, dir });
  const call = (op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
  const until = async predicate => { for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('not reached'); };
  await call('open'); await call('send', { text: 'one', clientMessageId: 'one' }); await firstEntered;
  await call('send', { text: 'two', clientMessageId: 'two' });
  await until(async () => (await call('snapshot')).state.version === 1);
  releaseFirst(); await until(async () => !(await call('snapshot')).busy);
  expect((await call('snapshot')).state.version).toBe(2);
  expect(executions).toBe(2); expect(cognition).toBe(3);
  expect((await call('turns')).items.every(turn => turn.status === 'completed')).toBe(true);
});

it('keeps a live sibling native FileRead private at bootstrap while publishing its public context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'person-parallel-private-'));
  const marker = 'PRIVATE_NATIVE_FILE_CONTENT_7391';
  await writeFile(join(dir, 'private.txt'), marker);
  let first, siblingRequest, readResult;
  const held = [];
  const adapter = { async *stream(params) {
    if (params.maxTokens === 256) { yield* text('{"decision":"unrelated"}'); return; }
    const trigger = JSON.parse(params.messages[0].content).trigger;
    if (trigger.text === 'read private fixture') {
      const result = params.messages.find(message => message.role === 'tool' && message.toolCallId === 'read');
      if (!result) {
        yield { type: 'tool_call', id: 'read', name: 'FileRead', input: { file_path: 'private.txt' } };
        yield { type: 'stop', stopReason: 'tool_use' }; return;
      }
      readResult = JSON.parse(result.content);
    } else siblingRequest = params;
    await new Promise(resolve => held.push(resolve));
  } };
  const service = createPersonService({ yeaftDir: dir, workDir: dir, config, adapter, embedding: { enabled: false } });
  resources.push({ service, dir });
  const call = (op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
  try {
    await call('open'); first = await call('send', { text: 'read private fixture', clientMessageId: 'private' });
    await vi.waitFor(() => expect(readResult?.output).toContain(marker));
    await call('send', { text: 'independent public question', clientMessageId: 'public' });
    await vi.waitFor(() => expect(siblingRequest).toBeDefined());
    const rendered = JSON.stringify(siblingRequest);
    expect(rendered).not.toContain(marker);
    expect(rendered).toContain(first.episodeId);
    expect(rendered).toContain('read private fixture');
    expect((await call('snapshot')).activeEpisodes).toHaveLength(2);
  } finally { for (const release of held) release(); }
});

it('filters waiting-resume evidence by refreshed live lineage while retaining current and terminal historical records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'person-parallel-resume-'));
  let siblingId, currentId, resumed, pending = true;
  const held = [];
  const evidence = () => {
    const records = (make) => ['current', 'history', 'sibling', 'unknown', 'ambiguous'].map(label => {
      const id = { current: currentId, history: 'terminal-history', sibling: siblingId }[label];
      return { ...make(id, label), ...(label === 'ambiguous' ? { episodeId: currentId, source: { episodeId: siblingId } } : {}) };
    });
    return { namespace: 'test',
      tasks: records((id, label) => ({ id: label, source: { episodeId: id } })),
      agents: records((id, label) => ({ id: label, personEpisodeId: id })),
      completions: records((id, label) => ({ id: label, task: { source: { episodeId: id } } })),
      toolResults: records((id, label) => ({ episodeId: id, output: label })) };
  };
  vi.spyOn(PersonTaskHost.prototype, 'snapshot').mockImplementation(evidence);
  vi.spyOn(PersonTaskHost.prototype, 'goalState').mockImplementation(() => ({
    tasks: [{ id: 'wait-fixture', status: pending ? 'running' : 'succeeded', currentEpisode: true }], agents: [],
  }));
  const adapter = { async *stream(params) {
    if (params.maxTokens === 256) { yield* text('{"decision":"unrelated"}'); return; }
    const trigger = JSON.parse(params.messages[0].content).trigger;
    if (trigger.text === 'sibling public input') {
      siblingId = params.requestIdentity.threadId;
      await new Promise(resolve => held.push(resolve)); return;
    }
    currentId = params.requestIdentity.threadId;
    const instruction = params.messages.find(message => typeof message.content === 'string' && message.content.includes('execution-results-ready'));
    if (instruction) {
      resumed = JSON.parse(instruction.content);
      await new Promise(resolve => held.push(resolve)); return;
    }
    yield { type: 'tool_call', id: 'wait', name: 'Execution__goal', input: {
      objective: 'Collect fixture', acceptance: 'Fixture collected', kind: 'work', status: 'waiting',
      reason: '', nextStep: 'Collect', sourceRefs: [], acceptanceChecks: [], waitFor: ['wait-fixture'], blocker: null,
    } };
    yield { type: 'stop', stopReason: 'tool_use' };
  } };
  const service = createPersonService({ yeaftDir: dir, workDir: dir, config, adapter, embedding: { enabled: false } });
  resources.push({ service, dir });
  const call = (op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
  try {
    await call('open'); await call('send', { text: 'wait for fixture', clientMessageId: 'current' });
    await vi.waitFor(async () => expect((await call('executions')).main?.phase).toBe('waiting'));
    // Admit the sibling only AFTER bootstrap: resume must refresh the live set.
    await call('send', { text: 'sibling public input', clientMessageId: 'sibling' });
    await vi.waitFor(() => expect(siblingId).toBeDefined());
    pending = false;
    await vi.waitFor(() => expect(resumed).toBeDefined(), { timeout: 5000 });
    expect(resumed.taskEvidence.items).toHaveLength(8);
    for (const kind of ['task', 'agent', 'completion', 'tool-result']) {
      const items = resumed.taskEvidence.items.filter(item => item.kind === kind);
      expect(items).toHaveLength(2);
      expect(JSON.stringify(items)).toContain('current');
      expect(JSON.stringify(items)).toContain('history');
    }
    expect(JSON.stringify(resumed)).not.toMatch(/sibling|unknown|ambiguous/);
  } finally { for (const release of held) release(); }
});
