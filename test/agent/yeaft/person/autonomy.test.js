import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PersonAutonomy } from '../../../../agent/yeaft/person/autonomy.js';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { assembleContext } from '../../../../agent/yeaft/person/runtime.js';
import { createPersonService } from './fixture-adapter.js';
import { config, finalProposal } from './fixtures.js';

let root, repos, schedulers, services;
const admission = { workerId: 'autonomy-test', budget: { calls: null } };
const selection = { model: 'test/first', effort: null };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function repo() { const r = new SqlitePersonRepository({ yeaftDir: root }); repos.push(r); return r; }
function edit(r, update) {
  const db = new DatabaseSync(r.dbPath);
  try {
    const record = JSON.parse(db.prepare("SELECT record FROM persons WHERE ownerId = 'alice'").get().record);
    update(record);
    db.prepare("UPDATE persons SET record = ? WHERE ownerId = 'alice'").run(JSON.stringify(record));
  } finally { db.close(); }
}
const due = r => edit(r, p => { p.autonomy.nextAt = 0; });
const event = (episode, taskId = 'task-one') => ({ episodeId: episode.id, taskId, status: 'succeeded', sourceRef: `person-task:scoped:${taskId}:succeeded:now` });
async function complete(r, episode, continuation, renderedSourceRefs = []) {
  const p = finalProposal(episode.baseStateVersion);
  p.state.continuation = continuation; p.concepts = []; p.state.focusConceptIds = [];
  await r.startCall(episode, { callId: 'final', requested: selection, effective: selection, request: {}, manifest: { sourceRefs: renderedSourceRefs, renderedSourceRefs } });
  await r.finalizeCall(episode, { callId: 'final', output: { text: 'final', complete: true } });
  return r.commit(episode, p, selection, 'final');
}
function scheduler(r, runtime) {
  const s = new PersonAutonomy({ repository: r, runtime, intervalMs: 60_000 }); schedulers.push(s); return s;
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'person-autonomy-')); repos = []; schedulers = []; services = []; });
afterEach(async () => {
  await Promise.all(schedulers.map(s => s.close()));
  await Promise.all(services.map(s => s.close()));
  await Promise.all(repos.map(r => r.close()));
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('requires new explicit consent after upgrade and serializes autonomous admissions across workers without a user message', async () => {
  const a = repo(), b = repo();
  expect((await a.open('alice')).person.settings.autonomyEnabled).toBe(false);
  edit(a, p => { p.settings.autonomyEnabled = true; }); // pre-feature durable setting is not consent
  expect((await a.open('alice')).person.settings.autonomyEnabled).toBe(false);
  expect((await a.autonomyOwners()).owners).toEqual([]);
  expect(await a.autonomyAdmit('alice', admission)).toBeNull();
  await a.settings('alice', { autonomyEnabled: true }); due(a);
  const results = await Promise.all([a.autonomyAdmit('alice', admission), b.autonomyAdmit('alice', admission)]);
  const admitted = results.find(Boolean);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(admitted.episode).toMatchObject({ ownerId: 'alice', namespace: 'default', kind: 'autonomous', messageId: null,
    scheduling: { origin: 'autonomous', observationOnly: true, authorization: false, reason: 'idle' } });
  expect((await a.list('alice', 'messages')).items).toHaveLength(0);
  await a.executionControl(admitted.episode, { status: 'paused' });
  due(a);
  expect(await b.autonomyAdmit('alice', admission)).toBeNull();
  await expect(a.heartbeat(admitted.episode)).resolves.toBeUndefined();
});

it('rests quietly after ready, blocked or empty continuation, coalesces new task observations, and suppresses repeated replies', async () => {
  const r = repo(); await r.open('alice'); await r.settings('alice', { autonomyEnabled: true });
  const ready = { goal: 'finish', nextStep: 'check', status: 'ready', condition: 'new evidence' };
  due(r); const first = (await r.autonomyAdmit('alice', admission)).episode;
  await complete(r, first, ready);
  due(r); expect(await r.autonomyAdmit('alice', admission)).toBeNull();
  expect((await r.getPerson('alice')).autonomy.backoffMs).toBeGreaterThan(60_000);
  expect(await r.autonomyObserve('alice', event(first))).toBe(true);
  expect(await r.autonomyObserve('alice', { ...event(first), sourceRef: 'another-timestamp' })).toBe(false);
  for (let i = 0; i < 20; i++) await r.autonomyObserve('alice', event(first, `task-${i}`));
  due(r); const second = (await r.autonomyAdmit('alice', admission)).episode;
  expect(second.scheduling.reason).toBe('task-completion');
  expect(second.scheduling.observations).toHaveLength(8);
  expect(Buffer.byteLength(second.text)).toBeLessThan(8192);
  await complete(r, second, { ...ready, status: 'blocked' }, second.scheduling.observations.map(item => item.sourceRef));
  expect((await r.list('alice', 'messages')).items.filter(m => m.role === 'assistant')).toHaveLength(1);
  due(r); expect(await r.autonomyAdmit('alice', admission)).toBeNull();
  await r.settings('alice', { autonomyEnabled: true }); due(r);
  // Explicit enable doesn't manufacture evidence that resolves a blocker.
  expect(await r.autonomyAdmit('alice', admission)).toBeNull();
  await r.autonomyObserve('alice', event(second)); // previous consent generation is stale
  expect((await r.getPerson('alice')).autonomy.pending).toHaveLength(0);
});

it('cancel fences queued admissions and stale completion generations until explicit reenable, while toggling never bypasses a paused job', async () => {
  const r = repo(); await r.open('alice'); await r.settings('alice', { autonomyEnabled: true }); due(r);
  const first = (await r.autonomyAdmit('alice', admission)).episode;
  await r.executionControl(first, { status: 'paused' });
  await r.settings('alice', { autonomyEnabled: false });
  await r.settings('alice', { autonomyEnabled: true }); due(r);
  expect(await r.autonomyAdmit('alice', admission)).toBeNull();
  await r.heartbeat(first); // autonomy-only settings do not invalidate active execution
  await r.finish(first, 'completed', null); due(r);
  const queued = (await r.autonomyAdmit('alice', admission)).episode;
  const generation = (await r.getPerson('alice')).autonomy.generation;
  expect(await r.autonomyObserve('alice', event(queued))).toBe(true); // completion queued before cancel
  expect(await r.cancel('alice', first.id)).toEqual({ cancelled: true, episodeId: queued.id });
  expect((await r.getPerson('alice')).autonomy.pending).toEqual([]);
  expect(await r.autonomyObserve('alice', { ...event(first), taskId: 'late-result' })).toBe(false);
  await expect(r.settings('alice', { autonomyEnabled: true }, undefined, generation)).rejects.toMatchObject({ code: 'STALE' });
  await expect(r.heartbeat(queued)).rejects.toMatchObject({ code: 'STALE' });
  expect(await r.autonomyObserve('alice', event(queued))).toBe(false);
  expect(await r.autonomyAdmit('alice', admission)).toBeNull();
  await r.settings('alice', { autonomyEnabled: true }); due(r);
  expect(await r.autonomyObserve('alice', event(queued))).toBe(false);
  const next = await r.autonomyAdmit('alice', admission);
  expect(next.episodeId).not.toBe(queued.id);
});

it('keeps disabled consent durable across waiting and idle commits, late completions and storage reopen', async () => {
  const r = repo(); await r.open('alice'); await r.settings('alice', { autonomyEnabled: true }); due(r);
  const active = (await r.autonomyAdmit('alice', admission)).episode;
  expect(await r.autonomyObserve('alice', event(active))).toBe(true);
  await r.settings('alice', { autonomyEnabled: false });
  await complete(r, active, { goal: 'finish', nextStep: 'wait', status: 'waiting', condition: 'task result' });
  expect(await r.autonomyObserve('alice', { ...event(active), taskId: 'late-result' })).toBe(false);
  const reopened = repo();
  expect((await reopened.open('alice')).person.settings.autonomyEnabled).toBe(false);
  expect((await reopened.getPerson('alice')).autonomy.pending).toEqual([]);
  due(reopened); expect(await reopened.autonomyAdmit('alice', admission)).toBeNull();
  // Completing later manual work does not implicitly restore an old opt-in.
  const manual = (await reopened.admit('alice', { ...admission, kind: 'think', text: 'check', clientMessageId: 'while-disabled' })).episode;
  await complete(reopened, manual, null);
  expect(await reopened.autonomyObserve('alice', event(manual))).toBe(false);
  const start = vi.fn();
  const s = scheduler(reopened, { ...admission, isOwnerRunning: () => false, start });
  due(reopened); await s.tick();
  expect(start).not.toHaveBeenCalled();
  expect((await reopened.getPerson('alice')).settings.autonomyEnabled).toBe(false);
  expect((await reopened.autonomyOwners()).owners).toEqual([]);
});

it('does not retry failed no-progress cognition from an older ready state, including after reopen or consent changes', async () => {
  const r = repo(); await r.open('alice'); await r.settings('alice', { autonomyEnabled: true });
  const ready = { goal: 'finish', nextStep: 'check', status: 'ready', condition: 'new evidence' };
  const seed = (await r.admit('alice', { ...admission, kind: 'think', text: 'seed', clientMessageId: 'seed' })).episode;
  await complete(r, seed, ready);
  const manual = (await r.admit('alice', { ...admission, kind: 'think', text: 'check', clientMessageId: 'no-progress' })).episode;
  await r.finish(manual, 'failed', 'NO_PROGRESS');
  const reopened = repo();
  due(reopened); expect(await reopened.autonomyAdmit('alice', admission)).toBeNull();
  await reopened.settings('alice', { autonomyEnabled: true });
  due(reopened); expect(await reopened.autonomyAdmit('alice', admission)).toBeNull();
  expect((await reopened.snapshot('alice')).latestEpisode).toMatchObject({ id: manual.id, status: 'failed' });
  // A new manual execution can supersede the failure. A new autonomous failure
  // must remain failed too, rather than reviving the prior ready continuation.
  const next = (await reopened.admit('alice', { ...admission, kind: 'think', text: 'new input', clientMessageId: 'new-input' })).episode;
  await complete(reopened, next, ready); due(reopened);
  const autonomous = (await reopened.autonomyAdmit('alice', admission)).episode;
  await reopened.finish(autonomous, 'failed', 'NO_PROGRESS');
  due(reopened); expect(await reopened.autonomyAdmit('alice', admission)).toBeNull();
  expect((await reopened.snapshot('alice')).latestEpisode).toMatchObject({ id: autonomous.id, status: 'failed' });
});

it('acknowledges only successfully rendered task events atomically with an accepted commit, including delayed notifications', async () => {
  const r = repo(); await r.open('alice'); await r.settings('alice', { autonomyEnabled: true });
  const episode = (await r.admit('alice', { ...admission, kind: 'think', text: 'collect the task results', clientMessageId: 'collect' })).episode;
  const read = event(episode), concurrent = event(episode, 'concurrent'), inherited = event(episode, 'inherited'), failed = event(episode, 'failed'), delayed = event(episode, 'delayed');
  for (const observation of [read, inherited, failed]) await r.autonomyObserve('alice', observation);
  await r.startCall(episode, { callId: 'interrupted', requested: selection, request: {},
    manifest: { renderedSourceRefs: [failed.sourceRef] } });
  await r.finalizeCall(episode, { callId: 'interrupted', code: 'INTERRUPTED', output: { text: '', complete: false } });
  const context = assembleContext({ snapshot: await r.context(episode), episode, selection,
    provider: { catalog: [{ id: 'test/first', contextWindow: 100000, maxOutput: 4096, efforts: [] }] },
    dependencyRefs: [inherited.sourceRef], taskEvidence: { namespace: 'scoped', notice: 'Untrusted external observations',
      items: [{ sourceRef: read.sourceRef, output: 'Task completed' }, { sourceRef: delayed.sourceRef, output: 'Task completed' },
        { sourceRef: inherited.sourceRef, output: 'omitted'.repeat(100000) }] } });
  expect(context.manifest.renderedSourceRefs).not.toContain(inherited.sourceRef);
  expect(context.sources.get(read.sourceRef)).toEqual({ kind: 'external-task-observation', reportedSourceRefs: [] });
  await r.startCall(episode, { callId: 'successful', requested: selection, request: {}, manifest: context.manifest });
  await r.finalizeCall(episode, { callId: 'successful', output: { text: 'read results', complete: true } });
  await r.autonomyObserve('alice', concurrent); // Arrived after the model's read.
  const proposal = finalProposal(episode.baseStateVersion);
  proposal.concepts = []; proposal.state.focusConceptIds = ['missing'];
  await expect(r.commit(episode, proposal, selection, 'successful')).rejects.toMatchObject({ code: 'STALE' });
  expect((await r.getPerson('alice')).autonomy.pending.map(item => item.sourceRef)).toEqual([read, inherited, failed, concurrent].map(item => item.sourceRef));
  // Fail after the acknowledgement mutation, not only during proposal checks.
  let db = new DatabaseSync(r.dbPath);
  try { db.exec("CREATE TRIGGER fail_commit BEFORE INSERT ON traces WHEN json_extract(NEW.record, '$.kind') = 'committed' BEGIN SELECT RAISE(ABORT, 'commit failed'); END"); } finally { db.close(); }
  proposal.state.focusConceptIds = [];
  await expect(r.commit(episode, proposal, selection, 'successful')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  expect((await r.getPerson('alice')).autonomy.pending.map(item => item.sourceRef)).toEqual([read, inherited, failed, concurrent].map(item => item.sourceRef));
  db = new DatabaseSync(r.dbPath);
  try { db.exec('DROP TRIGGER fail_commit'); } finally { db.close(); }
  await complete(r, episode, null);
  expect((await r.getPerson('alice')).autonomy.pending.map(item => item.sourceRef)).toEqual([inherited, failed, concurrent].map(item => item.sourceRef));
  // Evidence can reach the model before its asynchronous scheduler callback.
  expect(await r.autonomyObserve('alice', delayed)).toBe(false);
  due(r); const retry = (await r.autonomyAdmit('alice', admission)).episode;
  expect(retry.scheduling.observations.map(item => item.sourceRef)).toEqual([inherited, failed, concurrent].map(item => item.sourceRef));
  expect((await r.getPerson('alice')).autonomy.pending).toHaveLength(3); // Admission is not consumption.
  await r.finish(retry, 'failed', 'INTERRUPTED');
  due(r); expect((await r.autonomyAdmit('alice', admission)).episode.scheduling.observations).toHaveLength(3);
});

it('keeps failed text-only Think prohibitions as mandatory latest user input across restart and scheduler reentry', async () => {
  const r = repo(); await r.open('alice'); await r.settings('alice', { autonomyEnabled: true });
  const send = (await r.admit('alice', { ...admission, kind: 'send', text: 'Investigate the repository', clientMessageId: 'send' })).episode;
  await complete(r, send, null);
  const think = (await r.admit('alice', { ...admission, kind: 'think', text: 'Do not write files or run commands.', clientMessageId: 'think-stop' })).episode;
  const instruction = (await r.context(think)).latestUserInstruction;
  expect(instruction).toMatchObject({ id: think.messageId, episodeId: think.id, role: 'user', text: think.text });
  expect(think.messageId).not.toBeNull();
  await r.startCall(think, { callId: 'failed-think', requested: selection, request: {} });
  await r.finalizeCall(think, { callId: 'failed-think', code: 'INTERRUPTED', output: { text: '', complete: false } });
  await r.finish(think, 'failed', 'INTERRUPTED');
  const reopened = repo(); await reopened.open('alice');
  const provider = { catalog: [{ id: 'test/first', contextWindow: 100000, maxOutput: 4096, efforts: [] }] };
  for (const kind of ['think', 'dream', 'autonomous']) {
    let next;
    if (kind === 'autonomous') {
      await reopened.autonomyObserve('alice', event(think)); due(reopened);
      next = (await reopened.autonomyAdmit('alice', admission)).episode;
    } else next = (await reopened.admit('alice', { ...admission, kind, text: '', clientMessageId: `empty-${kind}` })).episode;
    const snapshot = await reopened.context(next);
    expect(snapshot.latestUserInstruction).toEqual(instruction);
    const assembled = assembleContext({ snapshot: { ...snapshot, messages: [] }, episode: next, selection, provider });
    const input = JSON.parse(assembled.messages[0].content), ref = `message:${think.messageId}:1`;
    expect(input.latestUserInstruction).toEqual(JSON.parse(JSON.stringify(instruction)));
    expect(assembled.manifest.renderedSourceRefs).toContain(ref);
    expect(assembled.sources.get(ref)).toMatchObject({ role: 'user', reportedSourceRefs: [ref] });
    expect(assembled.sources.get(`trigger:${next.id}`).reportedSourceRefs).toEqual([]);
    // The latest instruction is mandatory even when nothing else fits.
    const tinyProvider = { catalog: [{ ...provider.catalog[0], contextWindow: 100 }] };
    expect(() => assembleContext({ snapshot, episode: next, selection, provider: tinyProvider })).toThrow();
    await reopened.finish(next, 'failed', 'INTERRUPTED');
  }
  expect((await reopened.list('alice', 'messages')).items.filter(m => m.role === 'user').map(m => m.text)).toEqual([think.text, send.text]);
});

it('joins shutdown/admission races without starting queued models or replaying effects', async () => {
  const r = repo(); await r.open('alice'); await r.settings('alice', { autonomyEnabled: true }); due(r);
  const entered = deferred(), release = deferred(), start = vi.fn(), snapshot = vi.fn();
  const original = r.autonomyAdmit.bind(r);
  r.autonomyAdmit = async (...args) => { const result = await original(...args); entered.resolve(); await release.promise; return result; };
  const s = scheduler(r, { ...admission, isOwnerRunning: () => false, tasks: () => ({ snapshot }), start });
  const ticking = s.tick(); await entered.promise;
  const closing = s.close(); release.resolve(); await Promise.all([ticking, closing]);
  expect(start).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled();
  expect((await r.snapshot('alice')).latestEpisode.status).toBe('interrupted');
  await s.tick(); expect(snapshot).not.toHaveBeenCalled();
  // Reconciliation after process loss stops consent instead of replaying a leased job.
  await r.settings('alice', { autonomyEnabled: true }); due(r);
  const lost = (await original('alice', admission)).episode;
  edit(r, p => { p.leaseUntil = new Date(0).toISOString(); });
  expect(await original('alice', admission)).toBeNull();
  expect((await r.getPerson('alice')).settings.autonomyEnabled).toBe(false);
  expect((await r.snapshot('alice')).latestEpisode).toMatchObject({ id: lost.id, status: 'interrupted' });
});

it('exposes supported opt-in settings without model calls on status/read, and dispatches native episodes with the same identity', async () => {
  const calls = [], episodes = new Map(), resumedEvidence = [];
  const service = createPersonService({ yeaftDir: root, workDir: root, config, nativeFixture: false, embedding: { enabled: false }, adapter: {
    async *stream(params) {
      const input = JSON.parse(params.messages[0].content), id = params.requestIdentity.threadId;
      const state = episodes.get(id) ?? { stage: 0 }; episodes.set(id, state);
      if (!state.stage) calls.push(input);
      const goal = (status, extra = {}) => ({ objective: 'Collect the authorized test result', acceptance: 'Read the completed task log',
        kind: 'work', status, reason: '', nextStep: 'Collect the task result', sourceRefs: [input.trigger.ref], acceptanceChecks: [], waitFor: [], blocker: null, ...extra });
      const tool = (name, args) => ({ type: 'tool_call', id: `${name}-${state.stage}`, name, input: args });
      if (!params.tools.length) {
        const p = finalProposal(input.state.version); p.activity.sourceRefs = [input.trigger.ref];
        p.concepts = []; p.state.focusConceptIds = []; p.state.continuation = null; p.reply = null;
        yield { type: 'text_delta', text: JSON.stringify(p) };
      } else if (input.trigger.text === 'launch') {
        const lastTool = params.messages.findLast(message => message.role === 'tool');
        if (state.stage === 0) {
          yield tool('Execution__goal', goal('active'));
          yield tool('Bash', { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(()=>console.log('observed result'),300)")}`, background: true });
        } else if (state.stage === 1) {
          state.taskId = JSON.parse(lastTool.content).output.match(/Started background task (\S+)\./)[1];
          yield tool('Execution__goal', goal('waiting', { waitFor: [state.taskId] }));
        } else if (state.stage === 2) {
          const ready = params.messages.findLast(message => message.role === 'user' && message.content?.includes?.('execution-results-ready'));
          resumedEvidence.push(JSON.parse(ready.content).taskEvidence);
          yield tool('ReadTaskLog', { taskId: state.taskId, offset: 0, maxBytes: 4096 });
        } else if (state.stage === 3) {
          const result = JSON.parse(lastTool.content);
          expect(result.output).toContain('observed result');
          yield tool('Execution__goal', goal('completed', { reason: 'The completed log contains the expected result', nextStep: '',
            sourceRefs: [result.sourceRef], acceptanceChecks: [{ check: 'Task log contains observed result', sourceRefs: [result.sourceRef] }] }));
        } else yield { type: 'text_delta', text: 'Observed result collected.' };
      } else if (state.stage === 0) {
        yield tool('Execution__goal', goal('resting', { kind: 'exploration', reason: 'No new authorized work', nextStep: '' }));
      }
      const toolUse = params.tools.length && (input.trigger.text === 'launch' ? state.stage < 4 : state.stage === 0);
      state.stage++;
      yield { type: 'stop', stopReason: toolUse ? 'tool_use' : 'end_turn' };
    },
  } }); services.push(service);
  const request = (op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
  await request('open'); expect(await request('status')).toMatchObject({ autonomySupported: true, autonomyEnabled: false });
  // An enable request already waiting on storage must not undo a later stop.
  const settingsRead = deferred(), releaseSettings = deferred();
  const getPerson = SqlitePersonRepository.prototype.getPerson;
  const delayed = vi.spyOn(SqlitePersonRepository.prototype, 'getPerson').mockImplementationOnce(async function (...args) {
    const result = await getPerson.apply(this, args); settingsRead.resolve(); await releaseSettings.promise; return result;
  });
  const enabling = request('settings', { autonomyEnabled: true });
  const rejectedEnable = expect(enabling).rejects.toMatchObject({ code: 'STALE' });
  await settingsRead.promise; await request('cancel'); releaseSettings.resolve(); await rejectedEnable; delayed.mockRestore();
  expect((await request('status')).autonomyEnabled).toBe(false);
  await request('settings', { autonomyEnabled: true });
  const r = repo(); due(r);
  // Capture the service's scheduler without changing production timer policy.
  const scan = PersonAutonomy.prototype.scan;
  let instance;
  const spy = vi.spyOn(PersonAutonomy.prototype, 'scan').mockImplementation(function () { instance = this; return scan.call(this); });
  expect(await request('status')).toMatchObject({ autonomyEnabled: true });
  await request('snapshot'); await request('messages'); expect(calls).toHaveLength(0);
  await vi.waitFor(() => expect(instance).toBeTruthy(), { timeout: 7000, interval: 20 });
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
  await vi.waitFor(async () => expect((await request('snapshot')).busy).toBe(false));
  expect(calls[0].trigger).toMatchObject({ kind: 'autonomous' });
  expect(JSON.parse(calls[0].trigger.text)).toMatchObject({ authorization: false, observationOnly: true });
  expect((await request('messages')).items.some(m => m.role === 'user')).toBe(false);
  const count = calls.length; due(r); await instance.tick();
  expect(calls).toHaveLength(count); // null continuation does not spin
  await request('think', { text: 'launch', clientMessageId: 'manual-launch' });
  await vi.waitFor(async () => expect((await request('snapshot')).busy).toBe(false), { timeout: 8000 });
  expect((await request('snapshot')).latestEpisode.status).toBe('completed');
  expect(resumedEvidence[0].items.some(item => item.kind === 'completion')).toBe(true);
  expect((await r.getPerson('alice')).autonomy.pending).toHaveLength(0);
  const completedCalls = calls.length;
  due(r); await instance.tick();
  expect(calls).toHaveLength(completedCalls); // Originating episode already integrated this completion.
  await service.close(); spy.mockRestore(); due(r);
  expect(calls).toHaveLength(completedCalls);
}, 12_000);
