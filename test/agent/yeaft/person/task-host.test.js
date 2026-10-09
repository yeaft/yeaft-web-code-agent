import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonTaskHost, createPersonTaskHost, PERSON_TASK_TOOL_IDS } from '../../../../agent/yeaft/person/task-host.js';
import { TaskStore } from '../../../../agent/yeaft/tasks/store.js';
import { createFullRegistry } from '../../../../agent/yeaft/tools/index.js';
import { getAgentRegistry, _resetAgentRegistry } from '../../../../agent/yeaft/tools/agent.js';
import { _resetNotifications } from '../../../../agent/yeaft/sub-agent/notifications.js';

const config = { model: 'test/model', primaryModel: 'test/model', maxOutputTokens: 1024, language: 'en', _readOnly: true };
const command = script => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

class ParallelAdapter {
  constructor(gate) { this.gate = gate; this.calls = []; this.aborted = 0; }
  async *stream(params) {
    this.calls.push(params);
    if (this.gate) await Promise.race([this.gate.promise, new Promise(resolve => {
      if (params.signal?.aborted) resolve();
      else params.signal?.addEventListener('abort', resolve, { once: true });
    })]);
    if (params.signal?.aborted) { this.aborted++; throw new Error('aborted'); }
    yield { type: 'text_delta', text: `result-${this.calls.indexOf(params)}` };
    yield { type: 'usage', inputTokens: 2, outputTokens: 1 };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: 'ok', usage: {} }; }
}

let root, hosts;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'person-task-host-'));
  hosts = [];
  _resetAgentRegistry(); _resetNotifications();
});
afterEach(async () => {
  for (const host of hosts) await host.close();
  vi.restoreAllMocks(); _resetAgentRegistry(); _resetNotifications();
  rmSync(root, { recursive: true, force: true });
});
function host(options = {}) {
  const instance = createPersonTaskHost({ yeaftDir: join(root, 'instance'), ownerId: 'owner', personId: 'person',
    namespace: 'deployment', workDir: root, config, cancelEscalationMs: 20, ...options });
  if (!hosts.includes(instance)) hosts.push(instance);
  return instance;
}
function withProvider(adapter) {
  const provider = { adapter, catalog: [{ id: 'test/model', maxOutput: 1024, contextWindow: 32000 }],
    availableModels: [{ id: 'forbidden/model' }], defaultSelection: { model: 'test/model', effort: null } };
  const childProviderFactory = vi.fn(async provider => ({ adapter: provider.adapter, config }));
  return { provider, childProviderFactory };
}
async function invoke(attached, name, input = {}) {
  return attached.nativeRegistry.execute(name, input, attached);
}
async function json(attached, name, input = {}) { return JSON.parse(await invoke(attached, name, input)); }
async function background(attached, script) {
  const output = await invoke(attached, 'Bash', { command: command(script), background: true });
  return output.match(/Started background task (\S+)\./)[1];
}

describe('Person task host', () => {
  it('provides runtime owner/episode context and snapshots without replacing parent ToolDef references', async () => {
    const h = new PersonTaskHost({ yeaftDir: join(root, 'runtime-instance'), namespace: 'deployment', workDir: root, config });
    hosts.push(h);
    const parentToolRegistry = createFullRegistry();
    const episode = { id: 'episode-one', ownerId: 'one', personId: 'person-one', namespace: 'deployment', budget: { timeoutMs: 1 } };
    const options = withProvider(new ParallelAdapter());
    const attached = await h.context({ episode, ...options, effortDecision: { effective: 'low' }, parentToolRegistry });
    expect(attached.parentEngineDeps.childVpId).toBe(attached.currentVpId);
    expect(attached.parentEngineDeps.effortDecision.effective).toBe('low');
    for (const tool of attached.nativeRegistry.getAllTools()) expect(tool).toBe(parentToolRegistry.get(tool.name));
    const task = await background(attached, 'setInterval(()=>{},1000)');
    const next = await h.context({ episode: { ...episode, id: 'episode-two' }, parentToolRegistry });
    const laterTask = await background(next, 'setInterval(()=>{},1000)');
    expect(h.snapshot('one').tasks.map(item => item.id)).toEqual(expect.arrayContaining([task, laterTask]));
    expect(h.snapshot('two').tasks).toEqual([]);
    await expect(h.context({ episode: { ...episode, namespace: 'foreign' } })).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
    await h.cancel({ ownerId: 'two', episodeId: episode.id });
    expect(attached.taskManager.getTask(attached.sessionId, task).status).toBe('running');
    await h.cancel({ ownerId: 'one', episodeId: episode.id });
    expect(attached.taskManager.getTask(attached.sessionId, task).status).toBe('cancelled');
    expect(attached.taskManager.getTask(attached.sessionId, laterTask).status).toBe('running');
    const child = await json(await h.context({ episode: { ...episode, id: 'child-episode' }, ...options, parentToolRegistry }), 'SpawnAgent', { name: 'independent', task: 'independent', budget: { wall_time_ms: 2000 } });
    expect(getAgentRegistry().get(child.agentId).budget.wall_time_ms).toBe(2000);
  });

  it('joins timed-out real child tool promises and the driver promise, preserving canonical ToolDefs', async () => {
    const toolGate = deferred(), started = deferred(), driverGate = deferred();
    let calls = 0, signal;
    const adapter = { async *stream() {
      if (calls++ === 0) {
        yield { type: 'tool_call', id: 'slow-child-tool', name: 'Bash', input: { command: 'slow' } };
        yield { type: 'stop', stopReason: 'tool_use' };
      } else { yield { type: 'stop', stopReason: 'end_turn' }; }
    } };
    const tool = { ...createFullRegistry().get('Bash'), timeoutMs: 10, execute: async (_input, ctx) => {
      signal = ctx.signal; started.resolve(); await toolGate.promise; return 'late tool evidence';
    } };
    const parentToolRegistry = createFullRegistry().register(tool);
    const h = host(withProvider(adapter));
    const attached = await h.context({ episode: { id: 'slow-episode', ...h.scope }, provider: withProvider(adapter).provider, parentToolRegistry });
    const child = await json(attached, 'SpawnAgent', { name: 'slow-tool', task: 'use Bash' });
    await started.promise;
    const agent = getAgentRegistry().get(child.agentId);
    expect(agent.subEngine.toolRegistry.get('Bash')).toBe(tool);
    await vi.waitFor(() => expect(agent.__driverStarted).toBe(false));
    expect(JSON.parse(readFileSync(join(h.dataRoot, 'agents.json'), 'utf8')).agents.find(record => record.id === agent.id).executionPending).toBe(true);
    // A join must also honor the driver's exposed promise rather than status alone.
    agent.driverPromise = driverGate.promise;
    const finished = vi.fn();
    const cancelling = h.cancel({ ownerId: 'owner', episodeId: 'slow-episode' }).then(finished);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(signal.aborted).toBe(true);
    expect(finished).not.toHaveBeenCalled();
    driverGate.resolve();
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(finished).not.toHaveBeenCalled();
    toolGate.resolve();
    await cancelling;
    expect(finished).toHaveBeenCalledOnce();
    expect(attached.nativeRegistry.get('Bash')).toBe(tool);
    expect(h.evidence().toolResults.some(result => result.output === 'late tool evidence')).toBe(true);
  });

  it('fences delayed task launches and fully closes after an episode-scoped cancel races shutdown', async () => {
    const gate = deferred(), started = deferred();
    const h = host();
    const tool = { ...createFullRegistry().get('Bash'), execute: async (_args, ctx) => {
      started.resolve(); await gate.promise;
      return JSON.stringify(ctx.taskManager.startShellTask({ command: command('setInterval(()=>{},1000)'), cwd: root }));
    } };
    const first = await h.context({ episode: { id: 'first', ...h.scope }, parentToolRegistry: createFullRegistry().register(tool) });
    const second = await h.context({ episode: { id: 'second', ...h.scope } });
    const existing = await background(second, 'setInterval(()=>{},1000)');
    const delayed = invoke(first, 'Bash', { command: 'delayed' });
    const refused = expect(delayed).rejects.toMatchObject({ code: 'TASK_HOST_CLOSED' });
    await started.promise;
    const cancellation = h.cancel({ ownerId: 'owner', episodeId: 'first' });
    const closing = h.close();
    gate.resolve();
    await refused;
    await Promise.all([cancellation, closing]);
    expect(h.taskManager.getTask(h.sessionId, existing).status).toBe('cancelled');
  });

  it('keeps cancelled episode launch fences after join without pausing another episode', async () => {
    const gate = deferred(), started = deferred();
    const h = host();
    const delayedTool = { ...createFullRegistry().get('Bash'), execute: async (_args, ctx) => {
      started.resolve(); await gate.promise;
      return JSON.stringify(ctx.taskManager.startShellTask({ command: command('setInterval(()=>{},1000)'), cwd: root }));
    } };
    const first = await h.context({ episode: { id: 'cancelled', ...h.scope }, parentToolRegistry: createFullRegistry().register(delayedTool) });
    const second = await h.context({ episode: { id: 'continues', ...h.scope } });
    const delayed = invoke(first, 'Bash', { command: 'delayed' });
    const refused = expect(delayed).rejects.toMatchObject({ code: 'TASK_EPISODE_CANCELLED' });
    await started.promise;
    const cancelling = h.cancel({ ownerId: 'owner', episodeId: 'cancelled' });
    await Promise.resolve();
    const unrelated = await background(second, 'setInterval(()=>{},1000)');
    gate.resolve();
    await refused;
    await cancelling;
    expect(h.taskManager.getTask(h.sessionId, unrelated).status).toBe('running');
    expect(() => first.taskManager.startShellTask({ command: 'true', cwd: root })).toThrow('episode is cancelled');
    await expect(invoke(first, 'Bash', { command: 'true' })).rejects.toMatchObject({ code: 'TASK_EPISODE_CANCELLED' });
    await expect(h.context({ episode: { id: 'cancelled', ...h.scope } })).rejects.toMatchObject({ code: 'TASK_EPISODE_CANCELLED' });
    await h.cancel({ ownerId: 'owner' });
    expect(h.taskManager.getTask(h.sessionId, unrelated).status).toBe('cancelled');
    expect(() => second.taskManager.startShellTask({ command: 'true', cwd: root })).toThrow('episode is cancelled');
    expect(await background(await h.context({ episode: { id: 'new', ...h.scope } }), 'setInterval(()=>{},1000)')).toBeTruthy();
  });

  it('cancels child startup before the spawning tool promise has returned', async () => {
    const gate = deferred(), adapter = new ParallelAdapter(gate);
    const h = host(withProvider(adapter));
    const first = await h.context({ episode: { id: 'startup-cancel', ...h.scope } });
    const started = invoke(first, 'SpawnAgent', { name: 'startup', task: 'wait' });
    // Spawn executes synchronously up to the native TaskManager admission;
    // cancellation races the host continuation which records the child handle.
    await Promise.resolve();
    const cancelling = h.cancel({ ownerId: 'owner', episodeId: 'startup-cancel' });
    const child = JSON.parse(await started);
    await cancelling;
    expect(getAgentRegistry().get(child.agentId).__driverStarted).toBe(false);
    expect(getAgentRegistry().get(child.agentId).abortController.signal.aborted).toBe(true);
    expect(h.evidence().tasks[0].status).toBe('cancelled');
  });

  it('rejects symlinked task roots and log paths instead of sharing private storage', async () => {
    const h = host(), dataRoot = h.dataRoot;
    await h.close();
    rmSync(dataRoot, { recursive: true });
    const foreign = join(root, 'foreign');
    mkdirSync(foreign);
    symlinkSync(foreign, dataRoot);
    expect(() => host()).toThrow('access denied');
    rmSync(dataRoot);
    const reopened = host();
    symlinkSync(foreign, join(reopened.dataRoot, 'logs-link'));
    expect(() => reopened.taskManager.startTask({ logPath: join(reopened.dataRoot, 'logs-link', 'foreign.log') })).toThrow('access denied');
  });

  it('keeps a background command alive across calls and episode abort/commit, with durable completion evidence', async () => {
    const completed = deferred();
    const h = host({ onCompletion: value => completed.resolve(value) });
    const controller = new AbortController();
    const first = await h.attach({ ownerId: 'owner', personId: 'person', signal: controller.signal });
    const id = await background(first, "console.log('first');setTimeout(()=>console.log('later'),180)");
    expect((await json(first, 'ListTasks')).tasks.map(task => task.id)).toContain(id);
    controller.abort('episode committed');
    // A later explicit episode uses the same host and namespace, no new Session.
    const second = await h.attach();
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.taskManager).toBe(first.taskManager);
    const waited = await json(second, 'WaitTask', { taskId: id, timeout_ms: 3000 });
    expect(waited.status).toBe('succeeded');
    expect(waited.timedOut).toBe(false);
    const log = await json(second, 'ReadTaskLog', { taskId: id, offset: 0 });
    expect(log.text).toContain('first'); expect(log.text).toContain('later');
    const completion = await completed.promise;
    expect(completion.task.id).toBe(id);
    expect(completion.task.resultDelivery).toBe('status_only');
    expect(h.evidence().completions[0].sourceRef).toBe(completion.sourceRef);
    expect(first.registerAsyncTask).toBeUndefined();
    expect(first.conversationStore).toBeNull();
    expect(existsSync(join(h.yeaftDir, 'sessions'))).toBe(false);
    expect(existsSync(join(h.yeaftDir, 'sessions-manifest.json'))).toBe(false);
    await h.close();
    const reopened = host();
    expect((await json(await reopened.attach(), 'ReadTaskLog', { taskId: id, offset: 0 })).text).toContain('later');
    expect(reopened.evidence().completions[0].task.status).toBe('succeeded');
  });

  it('starts two real child runners in parallel and waits for their results across explicit episodes', async () => {
    const gate = deferred(), adapter = new ParallelAdapter(gate), threads = [];
    const { Engine } = await import('../../../../agent/yeaft/engine.js');
    const originalQuery = Engine.prototype.query;
    const querySpy = vi.spyOn(Engine.prototype, 'query').mockImplementation(async function* (input) {
      threads.push({ threadId: input.threadId, engine: this });
      yield* originalQuery.call(this, input);
    });
    const options = withProvider(adapter), notifications = [];
    const h = host({ ...options, onCompletion: value => notifications.push(value) });
    const attached = await h.attach({ personName: 'Person', registerAsyncTask: () => { throw new Error('must not reenter'); } });
    const [one, two] = await Promise.all([
      json(attached, 'SpawnAgent', { name: 'one', task: 'one mission' }),
      json(attached, 'SpawnAgent', { name: 'two', task: 'two mission' }),
    ]);
    expect(one.success).toBe(true); expect(two.success).toBe(true);
    await vi.waitFor(() => expect(adapter.calls).toHaveLength(2));
    expect(getAgentRegistry().get(one.agentId).budget).toEqual({});
    expect((await json(attached, 'ListAgents')).agents).toHaveLength(2);
    // Each native runner has its own query thread and transcript, not a shared
    // parent conversation with two labels attached.
    const runners = [one, two].map(child => getAgentRegistry().get(child.agentId));
    expect(runners[0].subEngine).not.toBe(runners[1].subEngine);
    expect(runners.every(agent => agent.parentThreadId === h.threadId)).toBe(true);
    expect(threads.map(call => call.threadId)).toEqual([one.agentId, two.agentId]);
    expect(threads.map(call => call.engine)).toEqual(runners.map(agent => agent.subEngine));
    querySpy.mockRestore();
    expect(options.childProviderFactory.mock.calls[0][0].catalog.map(model => model.id)).toEqual(['test/model']);
    expect(attached.parentEngineDeps.subAgentLogDir.startsWith(h.dataRoot)).toBe(true);
    expect(attached.parentEngineDeps.parentToolRegistry.has('HistorySearch')).toBe(false);
    expect(attached.parentEngineDeps.parentToolRegistry.has('AskUser')).toBe(false);
    const next = await h.attach();
    const prompted = await json(next, 'PromptAgent', { agent_id: one.agentId, message: 'also report follow-up' });
    expect(prompted.success).toBe(true);
    const updated = await json(next, 'UpdateAgent', { agent_id: two.agentId, reason: 'Grant read access for remaining verification', allow_tools: ['FileRead'] });
    expect(updated.success).toBe(true);
    expect(updated.allow_tools).toEqual(['FileRead']);
    gate.resolve();
    const results = await Promise.all([one, two].map(child => json(next, 'WaitAgent', { agent_id: child.agentId, timeout_ms: 3000 })));
    expect(results.map(result => result.status)).toEqual(['completed', 'completed']);
    expect(results.map(result => result.result).sort()).toEqual(['result-1', 'result-2']);
    expect(notifications).toHaveLength(2);
    expect(h.evidence().completions).toHaveLength(2);
    expect(readFileSync(results[0].outputFile, 'utf8')).toContain('text_delta');
    expect(h.evidence().agents).toHaveLength(2);
    const alreadyCompleted = await json(next, 'CancelTask', { taskId: one.taskId });
    expect(alreadyCompleted.ok).toBe(true);
    expect(alreadyCompleted.pending).toBe(false);
    expect(alreadyCompleted.task.status).toBe('succeeded');
    expect(getAgentRegistry().get(one.agentId).result).toBe(results[0].result);
    await h.close();
    const reopened = host(options);
    expect((await json(await reopened.attach(), 'WaitAgent', { agent_id: one.agentId })).result).toBe(results[0].result);
  });

  it('lets a real child use allowlisted tools and launch a Person-owned background command through the catalog adapter', async () => {
    const requests = [];
    const adapter = {
      async *stream(params) {
        requests.push(params);
        if (requests.length === 1) {
          yield { type: 'tool_call', id: 'child-shell', name: 'Bash', input: {
            command: command("console.log('child evidence');setTimeout(()=>console.log('continued'),250)"), background: true,
          } };
          yield { type: 'stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: 'child tool finished' };
          yield { type: 'stop', stopReason: 'end_turn' };
        }
      },
    };
    const { provider } = withProvider(adapter);
    const h = host({ provider }); // exercise real createPersonChildProvider, not an injected factory
    const attached = await h.attach();
    expect(attached.parentEngineDeps.config.availableModels.map(model => model.ref)).toEqual(['test/model']);
    const child = await json(attached, 'SpawnAgent', { name: 'tool-user', task: 'launch a background command' });
    const result = await json(attached, 'WaitAgent', { agent_id: child.agentId, timeout_ms: 3000 });
    expect(result.status).toBe('completed');
    expect(result.result).toBe('child tool finished');
    expect(requests.length).toBe(2);
    expect(requests.every(request => request.model === 'test/model')).toBe(true);
    const task = h.evidence().tasks.find(task => task.kind === 'shell');
    expect(task).toBeDefined();
    expect(task.ownerVpId).toBe(h.parentVpId);
    expect(task.resultDelivery).toBe('status_only');
    const next = await h.attach();
    expect((await json(next, 'WaitTask', { taskId: task.id, timeout_ms: 3000 })).status).toBe('succeeded');
    expect((await json(next, 'ReadTaskLog', { taskId: task.id, offset: 0 })).text).toContain('continued');
  });

  it('rejects synchronous child self-cancellation without hanging the driver or shutdown', async () => {
    const outputs = [];
    let calls = 0;
    const adapter = { async *stream(params) {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', id: 'own-tasks', name: 'ListTasks', input: {} };
        yield { type: 'stop', stopReason: 'tool_use' };
      } else if (calls === 2) {
        const text = JSON.stringify(params.messages);
        const ownId = text.match(/task_[a-z0-9_]+/i)?.[0];
        expect(ownId).toBeTruthy();
        yield { type: 'tool_call', id: 'self-cancel', name: 'CancelTask', input: { taskId: ownId } };
        yield { type: 'stop', stopReason: 'tool_use' };
      } else {
        outputs.push(JSON.stringify(params.messages));
        yield { type: 'text_delta', text: 'Ask parent to cancel instead' };
        yield { type: 'stop', stopReason: 'end_turn' };
      }
    } };
    const h = host(withProvider(adapter));
    const attached = await h.attach();
    const child = await json(attached, 'SpawnAgent', { name: 'self-cancel', task: 'ListTasks then CancelTask your own task' });
    const result = await json(attached, 'WaitAgent', { agent_id: child.agentId, timeout_ms: 3000 });
    expect(result.status).toBe('completed');
    expect(outputs.join('')).toContain('cannot synchronously cancel its own task');
    await h.close();
    expect(getAgentRegistry().get(child.agentId).__driverStarted).toBe(false);
  });

  it('separates owner, Person, deployment namespace and canonical instance roots, including overriding arguments', async () => {
    const a = host();
    const otherOwner = host({ ownerId: 'owner/other' });
    const otherPerson = host({ personId: 'person/other' });
    const otherNamespace = host({ namespace: 'other' });
    const otherInstance = host({ yeaftDir: join(root, 'instance2') });
    const all = [a, otherOwner, otherPerson, otherNamespace, otherInstance];
    expect(new Set(all.map(host => host.sessionId)).size).toBe(5);
    expect(new Set(all.map(host => host.dataRoot)).size).toBe(5);
    const aContext = await a.attach();
    const id = await background(aContext, 'setInterval(()=>{},1000)');
    const childOptions = withProvider(new ParallelAdapter());
    const child = await json(await a.attach({}, childOptions), 'SpawnAgent', { name: 'private', task: 'private' });
    for (const other of all.slice(1)) {
      const context = await other.attach();
      expect((await json(context, 'ListTasks')).tasks).toHaveLength(0);
      expect((await json(context, 'ReadTaskLog', { taskId: id })).error).toBeTruthy();
      expect((await json(context, 'WaitAgent', { agent_id: child.agentId })).error).toContain('not found');
      await expect(json(context, 'ListTasks', { sessionId: a.sessionId })).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
      expect(() => context.taskManager.getTask(a.sessionId, id)).toThrow('access denied');
      await expect(other.attach(aContext)).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
      for (const name of ['CancelTask', 'ReadTaskLog', 'WaitTask']) {
        await expect(invoke(context, name, { sessionId: a.sessionId, taskId: id })).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
      }
    }
    await expect(a.attach({ ownerId: 'foreign' })).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
    for (const override of [{ currentVpId: otherOwner.parentVpId }, { senderVpId: 'foreign' }, { threadId: otherPerson.threadId }]) {
      await expect(a.attach(override)).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
      await expect(aContext.nativeRegistry.execute('ListTasks', {}, { ...aContext, ...override })).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
    }
    expect(() => aContext.taskManager.startShellTask({ command: 'true', ownerVpId: 'foreign' })).toThrow('access denied');
    mkdirSync(join(root, 'alias-parent'));
    symlinkSync(a.yeaftDir, join(root, 'alias-parent', 'instance'));
    expect(host({ yeaftDir: join(root, 'alias-parent', 'instance') })).toBe(a);
    expect(() => new PersonTaskHost({ yeaftDir: a.yeaftDir, ownerId: 'owner', personId: 'person', namespace: 'deployment' })).toThrow('already live');
  });

  it('registers only supported plugin-allowed native tools and denies disabled tools/grants', async () => {
    const options = withProvider(new ParallelAdapter());
    const limitedConfig = { ...config, plugins: { tools: ['SpawnAgent', 'ListAgents', 'UpdateAgent', 'FileRead'] } };
    const h = host({ ...options, config: limitedConfig });
    const attached = await h.attach();
    expect(attached.nativeRegistry.getAllTools().map(tool => tool.name)).toEqual(['FileRead', 'SpawnAgent', 'ListAgents', 'UpdateAgent']);
    expect(attached.nativeRegistry.has('Agent')).toBe(true);
    expect(attached.nativeRegistry.has('Bash')).toBe(false);
    expect(PERSON_TASK_TOOL_IDS).not.toContain('HistorySearch');
    expect((await json(attached, 'SpawnAgent', { name: 'bad', task: 'bad', allow_tools: ['Bash'] })).error).toContain('not available');
    const spawned = await json(attached, 'SpawnAgent', { name: 'allowed', task: 'read', persona: 'explorer' });
    const updated = await json(attached, 'UpdateAgent', { agent_id: spawned.agentId, allow_tools: ['Bash'] });
    expect(updated.error).toBeTruthy();
    limitedConfig.plugins.tools = ['FileRead'];
    expect((await json(attached, 'ListAgents')).error).toContain('disabled');
  });

  it('CancelTask and CloseAgent join actual execution; owner cancellation and close stop only their own work', async () => {
    const gate = deferred(), adapter = new ParallelAdapter(gate);
    const h = host(withProvider(adapter)), other = host({ ownerId: 'other' });
    const attached = await h.attach(), unrelated = await other.attach();
    const shell = await background(attached, 'setInterval(()=>{},1000)');
    const otherShell = await background(unrelated, 'setInterval(()=>{},1000)');
    const cancelled = await json(attached, 'CancelTask', { taskId: shell });
    expect(cancelled.ok).toBe(true);
    expect(h.taskManager.getTask(h.sessionId, shell).status).toBe('cancelled');
    expect(cancelled.task.status).toBe('cancelled');
    expect(cancelled.pending).toBe(false);
    const cancelledAgain = await json(attached, 'CancelTask', { taskId: shell });
    expect(cancelledAgain.task.status).toBe('cancelled');
    expect(cancelledAgain.pending).toBe(false);
    const child = await json(attached, 'SpawnAgent', { name: 'child', task: 'waiting' });
    await vi.waitFor(() => expect(adapter.calls).toHaveLength(1));
    await json(attached, 'CloseAgent', { agent_id: child.agentId });
    expect(getAgentRegistry().get(child.agentId).__driverStarted).toBe(false);
    expect(getAgentRegistry().get(child.agentId).subEngine).toBeNull();
    expect(adapter.aborted).toBe(1);
    const cancelledChild = await json(attached, 'SpawnAgent', { name: 'cancel-by-task', task: 'waiting' });
    await vi.waitFor(() => expect(adapter.calls).toHaveLength(2));
    const cancelledAgentTask = await json(attached, 'CancelTask', { taskId: cancelledChild.taskId });
    expect(cancelledAgentTask.ok).toBe(true);
    expect(cancelledAgentTask.task.status).toBe('cancelled');
    expect(getAgentRegistry().get(cancelledChild.agentId).__driverStarted).toBe(false);
    const shell2 = await background(attached, 'setInterval(()=>{},1000)');
    const child2 = await json(attached, 'SpawnAgent', { name: 'another', task: 'waiting' });
    await vi.waitFor(() => expect(adapter.calls).toHaveLength(3));
    await h.cancel();
    expect(h.taskManager.getTask(h.sessionId, shell2).status).toBe('cancelled');
    expect(getAgentRegistry().get(child2.agentId).__driverStarted).toBe(false);
    expect(other.taskManager.getTask(other.sessionId, otherShell).status).toBe('running');
    const finalShell = await background(await h.attach(), 'setInterval(()=>{},1000)');
    await h.close();
    expect(h.taskManager.getTask(h.sessionId, finalShell).status).toBe('cancelled');
    await expect(h.attach()).rejects.toMatchObject({ code: 'TASK_HOST_CLOSED' });
    expect(h.evidence().completions.length).toBeGreaterThan(0);
  });

  it('marks persisted uncontrolled work orphaned after restart, retaining shell and child logs', async () => {
    const h = host();
    const root = h.dataRoot, sessionId = h.sessionId, ownerVpId = h.parentVpId;
    await h.close();
    const store = new TaskStore({ yeaftDir: root });
    const startedAt = new Date().toISOString();
    const shell = { id: 'shell-before-restart', sessionId, ownerVpId, kind: 'shell', status: 'running',
      createdAt: startedAt, startedAt, updatedAt: startedAt, log: { path: store.logPath(sessionId, 'shell-before-restart') }, runtime: {}, result: {} };
    store.writeTask(shell); store.appendLog(sessionId, shell.id, 'previous shell evidence');
    const childContext = await h.attach().catch(() => null);
    expect(childContext).toBeNull();
    // Simulate pre-restart child metadata without launching uncontrolled real processes.
    const { writeFileSync } = await import('node:fs');
    const agent = { id: 'agent-before-restart', name: 'lost child', status: 'running', taskId: 'child-before-restart',
      parentSessionId: h.sessionId, parentVpId: h.parentVpId, parentThreadId: h.threadId, result: '', lastResult: 'partial', usage: { turns: 0 } };
    writeFileSync(join(root, 'agents.json'), JSON.stringify({ scope: h.scope, agents: [agent] }));
    store.writeTask({ ...shell, id: agent.taskId, kind: 'sub_agent', runtime: { subAgentId: agent.id }, log: { path: store.logPath(sessionId, agent.taskId) } });
    store.appendLog(sessionId, agent.taskId, 'previous child evidence');
    const recovered = host(), context = await recovered.attach();
    expect((await json(context, 'WaitTask', { taskId: shell.id })).status).toBe('orphaned');
    expect((await json(context, 'ReadTaskLog', { taskId: shell.id })).text).toContain('previous shell evidence');
    const result = await json(context, 'WaitAgent', { agent_id: agent.id });
    expect(result.status).toBe('failed'); expect(result.error).toContain('control was lost');
    expect(recovered.evidence().agents[0].recoveryStatus).toBe('orphaned');
    expect(recovered.evidence().completions.map(item => item.task.status)).toEqual(['orphaned', 'orphaned']);
    expect((await json(context, 'ReadTaskLog', { taskId: agent.taskId })).text).toContain('previous child evidence');
    expect((await json(context, 'ListTasks')).tasks).toHaveLength(0);
  });
});
