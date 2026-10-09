import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { assembleContext, PersonRuntime, projectTaskEvidence } from '../../../../agent/yeaft/person/runtime.js';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { createPersonNativeRegistry, createPersonToolHost, NATIVE_TOOL_IDS, NATIVE_TOOL_MANIFESTS } from '../../../../agent/yeaft/person/native-tools.js';
import { getAgentRegistry, _resetAgentRegistry } from '../../../../agent/yeaft/tools/agent.js';
import { _resetNotifications } from '../../../../agent/yeaft/sub-agent/notifications.js';
import { PersonTaskHost } from '../../../../agent/yeaft/person/task-host.js';
import { bytes, validateProposal } from '../../../../agent/yeaft/person/contracts.js';
import { config, finalProposal } from './fixtures.js';

const services = [], directories = [];
const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const command = script => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-async-service-')); directories.push(dir); return dir; }
async function idle(service) {
  for (let i = 0; i < 400; i++) {
    const snapshot = await call(service, 'snapshot');
    if (!snapshot.busy) return snapshot;
    await pause(10);
  }
  throw new Error('Person cognition did not finish');
}
function proposal(input) {
  const p = finalProposal(input.state.version);
  p.concepts = []; p.state.focusConceptIds = []; p.activity.sourceRefs = [input.trigger.ref];
  return p;
}
function use(p, id, args, model = 'test/first', effort = null) {
  p.next = { model, effort, reason: 'Execute the scoped native operation.', capability: { id, args } };
}
function service(dir, adapter, extra = {}) {
  const s = createPersonService({ yeaftDir: dir, workDir: dir, config, adapter, embedding: { enabled: false }, ...extra });
  services.push(s); return s;
}
function parentAdapter(fn, child) {
  return { async *stream(params) {
    if (params.tools?.length) { yield* child(params); return; }
    const input = JSON.parse(params.messages[0].content), p = proposal(input);
    await fn(input, p, params);
    yield { type: 'text_delta', text: JSON.stringify(p) };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
}
beforeEach(() => { _resetAgentRegistry(); _resetNotifications(); });
afterEach(async () => {
  await Promise.all(services.splice(0).map(s => s.close()));
  vi.restoreAllMocks(); _resetAgentRegistry(); _resetNotifications();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person async native service integration', () => {
  it('drives two concurrent real child Engines, waits and commits their result summary using the producing provider effort', async () => {
    const dir = await directory(), gate = deferred(), childRequests = [], childEngines = [], inputs = [], children = [], results = [];
    const adapter = parentAdapter((input, p, params) => {
      inputs.push(input);
      params.onEffortDecision?.({ requested: params.effort ?? null, effective: 'low', model: params.model,
        source: 'wire-test', cap: 'low', wireMode: 'reasoning-effort', thinkingEnabled: true });
      if (input.capabilityResult?.id === 'SpawnAgent' && typeof input.capabilityResult.output === 'string') children.push(JSON.parse(input.capabilityResult.output).agentId);
      if (input.capabilityResult?.id === 'WaitAgent' && typeof input.capabilityResult.output === 'string') results.push(JSON.parse(input.capabilityResult.output).result);
      switch (inputs.length) {
        case 1: use(p, 'catalog.view', { id: 'SpawnAgent' }, 'test/first', 'high'); break;
        case 2: use(p, 'SpawnAgent', { name: 'one', task: 'Analyze one.', persona: 'explorer' }, 'test/second', 'high'); break;
        case 3: use(p, 'SpawnAgent', { name: 'two', task: 'Analyze two.', persona: 'explorer' }, 'test/first', 'high'); break;
        case 4: use(p, 'catalog.view', { id: 'WaitAgent' }); break;
        case 5: use(p, 'WaitAgent', { agent_id: children[0], timeout_ms: 3000 }); break;
        case 6: use(p, 'WaitAgent', { agent_id: children[1], timeout_ms: 3000 }); break;
        default: p.reply = results.join('; ');
      }
    }, async function* (params) {
      childRequests.push(params);
      childEngines.push([...getAgentRegistry().values()].find(agent => agent.name === (childRequests.length === 1 ? 'one' : 'two')).subEngine);
      if (childRequests.length === 2) gate.resolve();
      await gate.promise;
      yield { type: 'text_delta', text: `child-result-${childRequests.indexOf(params) + 1}` };
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
      yield { type: 'stop', stopReason: 'end_turn' };
    });
    const s = service(dir, adapter, { effortEnabled: true });
    await call(s, 'open');
    await call(s, 'send', { text: 'Run two analyses concurrently and summarize.', clientMessageId: 'parallel' });
    const terminal = await idle(s);
    expect(terminal.latestEpisode.status, JSON.stringify(terminal.latestEpisode)).toBe('completed');
    expect(childRequests).toHaveLength(2);
    expect(childRequests.map(p => p.model)).toEqual(['test/first', 'test/second']);
    expect(childRequests.every(p => p.effort === 'low')).toBe(true);
    expect(results).toEqual(['child-result-1', 'child-result-2']);
    expect((await call(s, 'messages')).items.find(m => m.role === 'assistant').text).toBe('child-result-1; child-result-2');
    for (const id of children) {
      const agent = getAgentRegistry().get(id);
      expect(agent.parentEffortDecision).toMatchObject({ requested: 'high', effective: 'low', cap: 'low', source: 'wire-test', model: childRequests[children.indexOf(id)].model });
      const engine = childEngines[children.indexOf(id)];
      expect(engine).toBeTruthy();
      const names = engine.toolRegistry.getAllTools().map(tool => tool.name);
      expect(names).toContain('DiscoverTools');
      for (const tool of ['SpawnAgent', 'AskUser', 'HistorySearch', 'RouteForward', 'EnterWorktree']) expect(names).not.toContain(tool);
    }
    await s.close();
    expect(children.every(id => getAgentRegistry().get(id).__driverStarted === false)).toBe(true);
    expect(await readdir(dir)).not.toContain('sessions');
    expect(await readdir(dir)).not.toContain('sessions-manifest.json');
  });

  it('retains background work after normal commit, exposes completion only on the next explicit episode, and preserves raw logs on restart', async () => {
    const dir = await directory(), inputs = []; let taskId;
    const adapter = parentAdapter((input, p) => {
      inputs.push(input);
      if (input.trigger.text === 'launch') {
        if (inputs.length === 1) use(p, 'catalog.view', { id: 'Bash' });
        if (inputs.length === 2) use(p, 'Bash', { command: command("console.log('started');setTimeout(()=>console.log('completed'),300)"), background: true });
        if (inputs.length === 3) taskId = input.capabilityResult.output.match(/Started background task (\S+)\./)[1];
      } else {
        const n = inputs.filter(item => item.trigger.text === 'inspect').length;
        if (n === 1) use(p, 'catalog.view', { id: 'WaitTask' });
        if (n === 2) use(p, 'WaitTask', { taskId, timeout_ms: 3000 });
        if (n === 3) use(p, 'catalog.view', { id: 'ReadTaskLog' });
        if (n === 4) use(p, 'ReadTaskLog', { taskId, offset: 0, maxBytes: 4096 });
        if (n === 5) p.reply = JSON.parse(input.capabilityResult.output).text;
      }
    }, async function* () { throw new Error('no child expected'); });
    const s = service(dir, adapter);
    await call(s, 'open'); await call(s, 'think', { text: 'launch', clientMessageId: 'launch' });
    expect((await idle(s)).latestEpisode.status).toBe('completed');
    expect(inputs[2].taskEvidence.items.some(item => item.output.includes('running'))).toBe(true);
    await pause(550);
    expect(inputs).toHaveLength(3); // Completion must not reenter the provider.
    await call(s, 'think', { text: 'inspect', clientMessageId: 'inspect' });
    expect((await idle(s)).latestEpisode.status).toBe('completed');
    const evidence = inputs[3].taskEvidence;
    expect(evidence.items.some(item => item.kind === 'completion' && item.output.includes(taskId))).toBe(true);
    expect(bytes(evidence)).toBeLessThanOrEqual(8192);
    expect((await call(s, 'messages')).items.some(m => m.text.includes('completed'))).toBe(true);
    await s.close();
    let recovered;
    const next = service(dir, parentAdapter((input, p) => { recovered = input.taskEvidence; p.reply = 'Recovered evidence.'; }, async function* () {}));
    await call(next, 'think', { text: 'recover', clientMessageId: 'recover' });
    expect((await idle(next)).latestEpisode.status).toBe('completed');
    expect(recovered.items.some(item => item.kind === 'completion' && item.output.includes(taskId))).toBe(true);
    const tasksRoot = join(dir, 'person', 'tasks');
    const roots = await readdir(tasksRoot);
    const logs = join(tasksRoot, roots[0], 'tasks', 'sessions');
    const sessionDirs = await readdir(logs);
    expect(await readFile(join(logs, sessionDirs[0], `${taskId}.log`), 'utf8')).toContain('completed');
  });

  it.each(['episode', 'owner', 'close', 'failure', 'budget'])('joins background effects on %s cancellation, including effects of an already completed episode', async mode => {
    const dir = await directory(); let count = 0, taskId;
    const adapter = parentAdapter((input, p) => {
      if (++count === 1) use(p, 'catalog.view', { id: 'Bash' });
      if (count === 2) use(p, 'Bash', { command: command('setInterval(()=>{},1000)'), background: true });
      if (count === 3) {
        taskId = input.capabilityResult.output.match(/Started background task (\S+)\./)[1];
        if (mode === 'failure') throw new Error('provider failed after launch');
        if (mode === 'budget') use(p, 'Think', {});
      }
    }, async function* () {});
    const s = service(dir, adapter, { maxCalls: mode === 'budget' ? 3 : 16 });
    await call(s, 'open'); const admission = await call(s, 'think', { text: 'launch', clientMessageId: 'stop' });
    const state = await idle(s);
    expect(state.latestEpisode.status).toBe(mode === 'failure' ? 'failed' : mode === 'budget' ? 'budget_exhausted' : 'completed');
    if (mode === 'episode') await call(s, 'cancel', { episodeId: admission.episodeId });
    if (mode === 'owner') await call(s, 'cancel');
    if (mode === 'close') await s.close();
    const roots = await readdir(join(dir, 'person', 'tasks'));
    const base = join(dir, 'person', 'tasks', roots[0], 'tasks', 'sessions');
    const taskDirs = await readdir(base);
    expect(JSON.parse(await readFile(join(base, taskDirs[0], `${taskId}.json`), 'utf8')).status).toBe('cancelled');
    expect(count).toBe(3);
  });

  it.each(['episode', 'owner'])('fences owner admission throughout %s cancellation of completed cognition and overlapping joins', async scope => {
    const dir = await directory(), toolStarted = deferred(), toolRelease = deferred(), toolAborted = deferred();
    const durableEntered = [deferred(), deferred()], durableRelease = [deferred(), deferred()];
    let parentCalls = 0, childCalls = 0, runtime;
    const originalStart = PersonRuntime.prototype.start;
    vi.spyOn(PersonRuntime.prototype, 'start').mockImplementation(function (episode) {
      runtime = this;
      if (!parentCalls) {
        const tool = this.parentToolRegistry.get('FileRead');
        this.parentToolRegistry.register({ ...tool, execute: async (_args, ctx) => {
          ctx.signal.addEventListener('abort', () => toolAborted.resolve(), { once: true });
          toolStarted.resolve();
          await toolRelease.promise; // Intentionally ignores abort until the actual effect finishes.
          return 'late read observation';
        } });
      }
      return originalStart.call(this, episode);
    });
    const originalCancel = SqlitePersonRepository.prototype.cancel;
    let cancelCalls = 0;
    vi.spyOn(SqlitePersonRepository.prototype, 'cancel').mockImplementation(async function (...args) {
      const index = cancelCalls++;
      durableEntered[index].resolve(); await durableRelease[index].promise;
      return originalCancel.apply(this, args);
    });
    const adapter = parentAdapter(async (_input, p) => {
      parentCalls++;
      if (parentCalls === 1) use(p, 'catalog.view', { id: 'SpawnAgent' });
      if (parentCalls === 2) use(p, 'SpawnAgent', { name: 'blocked-reader', task: 'Read the workspace.', persona: 'explorer' });
      if (parentCalls === 3) await toolStarted.promise;
    }, async function* () {
      childCalls++;
      yield { type: 'tool_call', id: 'blocked-read', name: 'FileRead', input: { file_path: 'unused' } };
      yield { type: 'stop', stopReason: 'tool_use' };
    });
    const s = service(dir, adapter);
    await call(s, 'open');
    const admission = await call(s, 'think', { text: 'launch', clientMessageId: 'blocked-launch' });
    expect((await idle(s)).latestEpisode.status).toBe('completed');
    const payload = scope === 'episode' ? { episodeId: admission.episodeId } : {};
    let first, second;
    const assertBusy = async suffix => {
      for (const op of ['think', 'send', 'dream']) {
        await expect(call(s, op, { clientMessageId: `${op}-${suffix}`, ...(op === 'dream' ? {} : { text: 'do not start yet' }) })).rejects.toMatchObject({ code: 'BUSY' });
      }
      expect(runtime.isOwnerRunning('alice')).toBe(true);
      expect(parentCalls).toBe(3); expect(childCalls).toBe(1);
    };
    try {
      first = call(s, 'cancel', payload);
      await durableEntered[0].promise;
      await assertBusy('durable'); // Fence must exist before repository.cancel resolves.
      durableRelease[0].resolve();
      await toolAborted.promise;
      await assertBusy('joining'); // Cognition already ended, but its real child effect has not.
      second = call(s, 'cancel', payload);
      await durableEntered[1].promise;
      toolRelease.resolve(); await first;
      await assertBusy('overlapping'); // First release must not clear the second cancellation's fence.
      durableRelease[1].resolve(); await second;
      expect(runtime.isOwnerRunning('alice')).toBe(false);
      await call(s, 'think', { text: 'now allowed', clientMessageId: 'after-cancel' });
      expect((await idle(s)).latestEpisode.status).toBe('completed');
      expect(parentCalls).toBe(4); expect(childCalls).toBe(1);
    } finally {
      toolRelease.resolve(); for (const gate of durableRelease) gate.resolve();
      await Promise.allSettled([first, second].filter(Boolean));
    }
  });

  it('projects large task/child evidence with external-only provenance and does not truncate durable records', async () => {
    const record = { id: 'large', result: '中\\"'.repeat(20000) };
    const evidence = projectTaskEvidence({ namespace: 'private', agents: [record], completions: [], tasks: [], toolResults: [] });
    expect(bytes(evidence)).toBeLessThanOrEqual(8192);
    expect(evidence.items.every(item => bytes(item) <= 2048)).toBe(true);
    expect(evidence.items[0]).toMatchObject({ kind: 'agent', truncated: true });
    expect(evidence.items[0].output).not.toContain('\ufffd');
    expect(record.result.length).toBeGreaterThan(40000);
    const provider = await createPersonProvider({ config, adapter: {} });
    const ctx = assembleContext({ snapshot: { person: { id: 'p', soul: 'Be honest.' }, state: { version: 0 }, messages: [], concepts: [] },
      episode: { id: 'e', kind: 'dream', text: '' }, provider, selection: provider.defaultSelection, taskEvidence: evidence, remainingCalls: 1 });
    const source = evidence.items[0].sourceRef;
    expect(ctx.sources.get(source)).toEqual({ kind: 'external-task-observation', reportedSourceRefs: [] });
    const p = finalProposal(); p.concepts[0].sourceRefs = [source];
    const rules = { stateVersion: 0, sourceRefs: ctx.sourceRefs, concepts: ctx.concepts, sources: ctx.sources, catalog: provider.catalog };
    expect(validateProposal(p, rules)).toBe(p);
    p.concepts[0].epistemicState = 'reported'; expect(() => validateProposal(p, rules)).toThrow();
  });

  it('dispatches foreground tools through scoped registry too, and keeps configuration-only construction lazy', async () => {
    const dir = await directory(), untouched = join(dir, 'not-created');
    const s = service(untouched, {});
    expect(await readdir(dir)).toEqual([]);
    await s.close(); expect(await readdir(dir)).toEqual([]);
    const dispatch = vi.fn(async () => 'scoped observation');
    const host = createPersonToolHost({ workDir: dir, yeaftDir: dir, config,
      getContext: async () => ({ nativeRegistry: { execute: dispatch } }) });
    expect(await host.execute('FileRead', { file_path: 'unused' })).toMatchObject({ output: 'scoped observation' });
    expect(dispatch).toHaveBeenCalledWith('FileRead', { file_path: 'unused' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const orchestration = ['SpawnAgent', 'ListAgents', 'WaitAgent', 'PromptAgent', 'CloseAgent', 'UpdateAgent', 'ListTasks', 'ReadTaskLog', 'WaitTask', 'CancelTask'];
    for (const id of orchestration) expect(NATIVE_TOOL_MANIFESTS.find(m => m.id === id)).toMatchObject({ args: { type: 'object' }, source: { revision: expect.any(String) } });
    expect(NATIVE_TOOL_IDS).not.toContain('DiscoverTools');
    const registry = createPersonNativeRegistry(); expect(registry.has('DiscoverTools')).toBe(true);
    for (const id of ['HistorySearch', 'AskUser', 'RouteForward']) expect(registry.has(id)).toBe(false);
  });

  it('recovers an uncontrolled persisted running task as orphaned without dispatching a provider', async () => {
    const dir = await directory();
    const host = new PersonTaskHost({ yeaftDir: dir, namespace: 'default', workDir: dir, config });
    const episode = { id: 'before-restart', ownerId: 'alice', personId: 'person-recovery' };
    const attached = await host.context({ episode });
    const task = attached.taskManager.startTask({ kind: 'shell', title: 'lost external control', source: { episodeId: episode.id } });
    attached.taskManager.completeTask(attached.sessionId, task.id, { status: 'succeeded', result: {} });
    await host.close();
    const path = join(attached.taskHost.dataRoot, 'tasks', 'sessions', attached.sessionId, `${task.id}.json`);
    const saved = JSON.parse(await readFile(path, 'utf8')); saved.status = 'running'; saved.completedAt = null;
    await writeFile(path, JSON.stringify(saved));
    const recovered = new PersonTaskHost({ yeaftDir: dir, namespace: 'default', workDir: dir, config });
    try {
      const ctx = await recovered.context({ episode: { ...episode, id: 'after-restart' } });
      expect(ctx.taskManager.getTask(ctx.sessionId, task.id).status).toBe('orphaned');
      expect(recovered.snapshot('alice').completions.some(item => item.task.id === task.id && item.task.status === 'orphaned')).toBe(true);
    } finally { await recovered.close(); }
  });
});
