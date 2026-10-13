import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonTaskHost, createPersonTaskHost } from '../../../../agent/yeaft/person/task-host.js';
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
