import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../../../agent/yeaft/person/provider.js', async importOriginal => ({
  ...await importOriginal(), createPersonProvider: vi.fn(() => { throw new Error('Provider must not initialize for task APIs'); }),
}));
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { createPersonTaskHost } from '../../../../agent/yeaft/person/task-host.js';
import { createFullRegistry } from '../../../../agent/yeaft/tools/index.js';
import { PERSON_TASK_LIMITS, PROPOSAL_INSTRUCTIONS } from '../../../../agent/yeaft/person/contracts.js';
import { TaskStore } from '../../../../agent/yeaft/tasks/store.js';
import { getAgentRegistry, _resetAgentRegistry } from '../../../../agent/yeaft/tools/agent.js';
import { _resetNotifications } from '../../../../agent/yeaft/sub-agent/notifications.js';

let root, services, hosts;
const config = { model: 'test/model', primaryModel: 'test/model', maxOutputTokens: 1024, language: 'en', _readOnly: true };
const command = script => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const childProvider = adapter => ({ adapter, catalog: [{ id: 'test/model', maxOutput: 1024, contextWindow: 32000 }], defaultSelection: { model: 'test/model', effort: null } });
const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
const request = (host, op, payload = {}, scope = {}) => host.request({ ...host.scope, ...scope, op, payload });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'person-task-api-')); services = []; hosts = [];
  vi.clearAllMocks(); _resetAgentRegistry(); _resetNotifications();
});
afterEach(async () => {
  for (const service of services) await service.close();
  for (const host of hosts) await host.close();
  _resetAgentRegistry(); _resetNotifications();
  rmSync(root, { recursive: true, force: true });
});
function service(options = {}) {
  const value = createPersonService({ yeaftDir: root, config: {}, embedding: { enabled: false }, ...options });
  services.push(value); return value;
}
function host(options = {}) {
  const value = createPersonTaskHost({ yeaftDir: root, ownerId: 'alice', personId: 'person', namespace: 'default', config,
    workDir: root, cancelEscalationMs: 20, ...options });
  hosts.push(value); return value;
}
async function ownedHost(service) {
  const opened = await call(service, 'open');
  return host({ personId: opened.person.id });
}

// Tests intentionally provide no usable Person model/provider configuration.
describe('Digital Person owner-scoped task API', () => {
  it('lists live and completed shells without command fallbacks, paths, results or provider initialization; reads do not cancel work', async () => {
    const s = service(), h = await ownedHost(s);
    const ctx = await h.attach({ episodeId: 'source-one' });
    const completed = ctx.taskManager.startShellTask({ command: command("console.log('historical output')"), cwd: root, title: 'Historical check' });
    await ctx.taskManager.waitForTask(h.sessionId, completed.id, { timeoutMs: 3000 });
    const live = ctx.taskManager.startShellTask({ command: command('setInterval(()=>{},1000)'), cwd: root });
    const list = await call(s, 'tasks');
    expect(list.truncated).toBe(false);
    expect(list.tasks[0]).toMatchObject({ id: live.id, title: 'Shell task', kind: 'shell', status: 'running', sourceEpisodeId: 'source-one', recoveryStatus: null });
    expect(list.tasks.find(task => task.id === completed.id)).toMatchObject({ status: 'succeeded', title: 'Historical check' });
    expect(Object.keys(list.tasks[0]).sort()).toEqual(['agentId', 'createdAt', 'id', 'kind', 'recoveryStatus', 'sourceEpisodeId', 'status', 'title', 'updatedAt'].sort());
    expect(JSON.stringify(list)).not.toContain(root);
    expect(JSON.stringify(list)).not.toContain('setInterval');
    expect(JSON.stringify(list)).not.toContain('historical output');
    expect(h.taskManager.getTask(h.sessionId, live.id).status).toBe('running');
    expect(createPersonProvider).not.toHaveBeenCalled();
    const cancelled = await call(s, 'task_cancel', { taskId: live.id });
    expect(cancelled).toMatchObject({ task: { id: live.id, status: 'cancelled' }, pending: false });
    expect(await call(s, 'task_cancel', { taskId: live.id })).toEqual(cancelled);
  });

  it('returns bounded raw owner logs with byte cursors and strips native path metadata', async () => {
    const s = service(), h = await ownedHost(s);
    const ctx = await h.attach();
    const task = ctx.taskManager.startShellTask({ command: command("process.stdout.write('abcdefghij')"), cwd: root });
    await ctx.taskManager.waitForTask(h.sessionId, task.id, { timeoutMs: 3000 });
    const first = await call(s, 'task_log', { taskId: task.id, maxBytes: 4 });
    expect(first).toEqual({ taskId: task.id, text: 'abcd', nextOffset: 4, totalBytes: 10, truncated: true, status: 'succeeded' });
    expect(await call(s, 'task_log', { taskId: task.id, offset: first.nextOffset, maxBytes: 6 })).toMatchObject({ text: 'efghij', nextOffset: 10, truncated: false });
    expect(await call(s, 'task_log', { taskId: task.id, offset: 100 })).toMatchObject({ text: '', nextOffset: 10, truncated: false });
    expect(await call(s, 'task_log', { taskId: task.id })).toMatchObject({ text: 'abcdefghij' });
    expect(createPersonProvider).not.toHaveBeenCalled();
  });

  it('isolates owner, Person, namespace and instance in every read/control operation', async () => {
    const h = host(), ctx = await h.attach();
    const task = ctx.taskManager.startShellTask({ command: command('setInterval(()=>{},1000)'), cwd: root });
    for (const options of [{ ownerId: 'bob' }, { personId: 'other' }, { namespace: 'other' }, { yeaftDir: join(root, 'other-instance') }]) {
      const foreign = host(options);
      expect((await request(foreign, 'tasks')).tasks).toEqual([]);
      for (const op of ['task_log', 'task_cancel']) await expect(request(foreign, op, { taskId: task.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(request(foreign, 'agent_close', { agentId: 'agent-foreign' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    for (const override of [{ ownerId: 'bob' }, { personId: 'other' }, { namespace: 'other' }]) {
      for (const op of ['tasks', 'task_log', 'task_cancel', 'agent_close']) {
        await expect(request(h, op, op === 'tasks' ? {} : op === 'agent_close' ? { agentId: 'child' } : { taskId: task.id }, override)).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
      }
    }
    expect(h.taskManager.getTask(h.sessionId, task.id).status).toBe('running');
  });

  it('closes and joins a real child without initializing the Person provider or touching unrelated work', async () => {
    let aborted = false, started = false;
    const adapter = { async *stream(params) {
      started = true;
      await new Promise(resolve => params.signal.addEventListener('abort', resolve, { once: true }));
      aborted = true; throw new Error('aborted');
    } };
    const provider = { adapter, catalog: [{ id: 'test/model', maxOutput: 1024, contextWindow: 32000 }], defaultSelection: { model: 'test/model', effort: null } };
    const s = service(), h = await ownedHost(s);
    const ctx = await h.attach({ episodeId: 'child-source' }, { provider });
    const child = JSON.parse(await ctx.nativeRegistry.execute('SpawnAgent', { name: 'child', mission: `Inspect ${root}/private password=private-secret token=private-token https://host-private/path custom+srv://user:uri-private@host/path`, budget: { wall_time_ms: 5000 } }, ctx));
    await vi.waitFor(() => expect(started).toBe(true));
    const list = await call(s, 'tasks');
    expect(list.agents[0]).toMatchObject({ id: child.agentId, sourceEpisodeId: 'child-source', recoveryStatus: null, executionPending: true,
      outcome: { status: 'pending', complete: false, reason: null, truncated: false } });
    expect(list.tasks[0]).toMatchObject({ id: child.taskId, kind: 'sub_agent', agentId: child.agentId });
    expect(JSON.stringify(list)).not.toContain(root);
    expect(JSON.stringify(list)).not.toContain('private-secret');
    expect(JSON.stringify(list)).not.toContain('private-token');
    expect(JSON.stringify(list)).not.toContain('host-private');
    expect(JSON.stringify(list)).not.toContain('uri-private');
    expect(list.agents[0].mission).toContain('[url]');
    const unrelated = ctx.taskManager.startShellTask({ command: command('setInterval(()=>{},1000)'), cwd: root, title: 'Unrelated work' });
    await call(s, 'open', {}, 'bob');
    await expect(call(s, 'agent_close', { agentId: child.agentId }, 'bob')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(s, 'task_cancel', { taskId: child.taskId })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(aborted).toBe(false);
    const agent = getAgentRegistry().get(child.agentId);
    let releaseJoin, settled = false;
    const delayedJoin = new Promise(resolve => { releaseJoin = resolve; });
    agent.driverPromise = agent.driverPromise.then(() => delayedJoin);
    const closing = call(s, 'agent_close', { agentId: child.agentId }).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(settled).toBe(false); // Terminal status is not a completed driver join.
    releaseJoin();
    const result = await closing;
    expect(result).toMatchObject({ agent: { id: child.agentId, status: 'closed' }, pending: false });
    expect(aborted).toBe(true);
    expect(getAgentRegistry().get(child.agentId).__driverStarted).toBe(false);
    expect(getAgentRegistry().get(child.agentId).subEngine).toBeNull();
    expect(await call(s, 'agent_close', { agentId: child.agentId })).toEqual(result);
    expect(h.taskManager.getTask(h.sessionId, unrelated.id).status).toBe('running');
    expect(createPersonProvider).not.toHaveBeenCalled();
  });

  it('projects a real budget cutoff as incomplete through list/close and preserves its durable outcome without leaking results', async () => {
    const privateOutput = `Raw child result ${root}/private token=private-token ${'好'.repeat(1000)}`;
    const adapter = { async *stream() {
      yield { type: 'text_delta', text: privateOutput };
      yield { type: 'usage', inputTokens: 2, outputTokens: 1 };
      yield { type: 'stop', stopReason: 'end_turn' };
    } };
    const s = service(), h = await ownedHost(s);
    const ctx = await h.attach({ episodeId: 'budget-source' }, { provider: childProvider(adapter) });
    const child = JSON.parse(await ctx.nativeRegistry.execute('SpawnAgent', { name: 'budget-child', mission: 'Check remaining work', budget: { max_turns: 1 } }, ctx));
    const agent = getAgentRegistry().get(child.agentId);
    await agent.driverPromise;
    expect(agent.result).toMatchObject({ status: 'budget_exceeded', partial_output: privateOutput });
    // Inspect disk before a list/close can refresh it: cleanup must clear the
    // durable pending flag, otherwise a clean restart falsely claims an orphan.
    expect(JSON.parse(readFileSync(join(h.dataRoot, 'agents.json'), 'utf8')).agents.find(record => record.id === agent.id))
      .toMatchObject({ executionPending: false, result: { status: 'budget_exceeded', partial_output: privateOutput } });
    const expected = { id: child.agentId, status: 'completed', executionPending: false,
      outcome: { status: 'incomplete', complete: false, reason: 'budget_exceeded', truncated: false } };
    const list = await call(s, 'tasks');
    expect(list.agents[0]).toMatchObject(expected);
    expect(list.tasks[0].status).toBe('failed');
    const closed = await call(s, 'agent_close', { agentId: child.agentId });
    expect(closed).toMatchObject({ agent: expected, pending: false });
    expect(Object.keys(closed.agent.outcome).sort()).toEqual(['complete', 'reason', 'status', 'truncated']);
    for (const projected of [list, closed]) {
      expect(JSON.stringify(projected)).not.toContain('Raw child result');
      expect(JSON.stringify(projected)).not.toContain(root);
      expect(JSON.stringify(projected)).not.toContain('private-token');
      expect(JSON.stringify(projected)).not.toContain('partial_output');
    }
    await s.close(); await h.close(); _resetAgentRegistry();
    const restarted = service();
    expect((await call(restarted, 'tasks')).agents[0]).toMatchObject(expected);
    expect(await call(restarted, 'agent_close', { agentId: child.agentId })).toEqual(closed);
    expect(createPersonProvider).not.toHaveBeenCalled();
  });

  it.each([
    ['Bash', 'failed', { status: 'failed', complete: false, reason: 'execution_failed', truncated: false }],
    ['Glob', 'completed', { status: 'succeeded', complete: true, reason: null, truncated: false }],
  ])('joins a %s actual tool after timeout even when the child driver is %s', async (toolName, status, outcome) => {
    const toolGate = deferred(), started = deferred();
    let calls = 0, signal;
    const adapter = { async *stream() {
      if (calls++ === 0) {
        yield { type: 'tool_call', id: 'slow-child-tool', name: toolName, input: toolName === 'Bash' ? { command: 'slow' } : { pattern: '**/*.js' } };
        yield { type: 'stop', stopReason: 'tool_use' };
      } else {
        yield { type: 'text_delta', text: `private result token=private-token ${root}/private` };
        yield { type: 'stop', stopReason: 'end_turn' };
      }
    } };
    const tool = { ...createFullRegistry().get(toolName), timeoutMs: 10, execute: async (_input, ctx) => {
      signal = ctx.signal; started.resolve(); await toolGate.promise; return 'private late tool evidence';
    } };
    const s = service(), h = await ownedHost(s);
    const ctx = await h.attach({ episodeId: 'timed-out-tool', parentToolRegistry: createFullRegistry().register(tool) }, { provider: childProvider(adapter) });
    const child = JSON.parse(await ctx.nativeRegistry.execute('SpawnAgent', { name: 'slow-child', mission: `Run ${toolName}` }, ctx));
    try {
      await started.promise;
      const agent = getAgentRegistry().get(child.agentId);
      await agent.driverPromise;
      expect(agent.__driverStarted).toBe(false);
      expect(agent.status).toBe(status); // Read-only timeout permits continuation; side effects fail the query.
      expect(agent.execution.failedCalls).toBe(1); // Registry timeout, not actual tool completion.
      // Settled history must not evict an older terminal child whose real tool
      // still needs cleanup from the bounded inventory (and its UI Stop entry).
      agent.createdAt = '2020-01-01';
      for (let i = 0; i < PERSON_TASK_LIMITS.records + 5; i++) {
        getAgentRegistry().set(`agent-settled-${i}`, { id: `agent-settled-${i}`, name: `Settled ${i}`, status: 'completed',
          createdAt: '2026-01-01', parentSessionId: agent.parentSessionId, parentVpId: agent.parentVpId, parentThreadId: agent.parentThreadId });
      }
      const list = await call(s, 'tasks');
      expect(list.truncated).toBe(true);
      expect(list.agents).toHaveLength(PERSON_TASK_LIMITS.records);
      expect(list.agents[0]).toMatchObject({ id: child.agentId, status, executionPending: true, recoveryStatus: null, outcome });
      const page = await call(s, 'tasks', { cursor: null, limit: 20 });
      expect(page.agents).toHaveLength(20);
      expect(page.agents.some(record => record.id === child.agentId)).toBe(false);
      expect(page.active.agents).toEqual([expect.objectContaining({ id: child.agentId, status, executionPending: true, outcome })]);
      expect(page.active.truncated).toBe(false);
      expect(JSON.stringify(page)).not.toMatch(/private result|private-token/);
      expect(JSON.stringify(list)).not.toContain('private result');
      let settled = false;
      const closing = call(s, 'agent_close', { agentId: child.agentId }).then(result => { settled = true; return result; });
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      expect(settled).toBe(false);
      expect((await call(s, 'tasks')).agents[0].executionPending).toBe(true);
      toolGate.resolve();
      const closed = await closing;
      expect(closed).toMatchObject({ agent: { id: child.agentId, status, executionPending: false, outcome }, pending: false });
      expect(JSON.stringify(closed)).not.toContain('private');
      expect(getAgentRegistry().get(child.agentId).__driverStarted).toBe(false);
      expect((await call(s, 'tasks', { cursor: null, limit: 20 })).active.agents).toEqual([]);
      // Once joined it may fall outside the bounded history, but its durable
      // record remains directly addressable and closing again is idempotent.
      expect((await call(s, 'tasks')).agents.some(record => record.id === child.agentId)).toBe(false);
      expect(await call(s, 'agent_close', { agentId: child.agentId })).toEqual(closed);
      expect(h.evidence().toolResults.some(result => result.output === 'private late tool evidence')).toBe(true);
      expect(createPersonProvider).not.toHaveBeenCalled();
    } finally { toolGate.resolve(); }
  });

  it('inspects persisted shell/child history after service restart and exposes orphan recovery facts', async () => {
    const s = service(), h = await ownedHost(s);
    const ctx = await h.attach();
    const done = ctx.taskManager.startShellTask({ command: command("console.log('durable log')"), cwd: root });
    await ctx.taskManager.waitForTask(h.sessionId, done.id, { timeoutMs: 3000 });
    const scope = h.scope, dataRoot = h.dataRoot, sessionId = h.sessionId, parentVpId = h.parentVpId, parentThreadId = h.threadId;
    await s.close(); await h.close(); _resetAgentRegistry();
    const store = new TaskStore({ yeaftDir: dataRoot });
    store.writeTask({ id: 'orphan-shell', sessionId, ownerVpId: parentVpId, kind: 'shell', title: 'Interrupted shell', status: 'running', source: { episodeId: 'lost-episode' }, createdAt: '2026-01-01', updatedAt: '2026-01-01' });
    store.writeTask({ id: 'orphan-child-task', sessionId, ownerVpId: parentVpId, kind: 'sub_agent', title: 'Interrupted child', status: 'running', runtime: { subAgentId: 'agent-orphan' }, createdAt: '2026-01-01', updatedAt: '2026-01-01' });
    writeFileSync(join(dataRoot, 'agents.json'), JSON.stringify({ scope, agents: [
      { id: 'agent-orphan', name: 'Recovered child', mission: 'Inspect recovery', status: 'running', parentSessionId: sessionId, parentVpId, parentThreadId, personEpisodeId: 'lost-episode' },
      { id: 'agent-detached', name: 'Terminal with detached tool', status: 'completed', executionPending: true,
        result: { status: 'budget_exceeded', reason: `private reason ${root} token=private-token`, partial_output: 'private partial output' },
        parentSessionId: sessionId, parentVpId, parentThreadId },
      { id: 'agent-finalized', name: 'Parent wrap-up', status: 'completed', finalizationRequested: true,
        finalReport: { truncated: true, text: 'private final report' }, result: 'private result', parentSessionId: sessionId, parentVpId, parentThreadId },
    ] }));
    const restarted = service();
    const list = await call(restarted, 'tasks');
    expect(list.tasks.find(task => task.id === done.id).status).toBe('succeeded');
    expect(list.tasks.find(task => task.id === 'orphan-shell')).toMatchObject({ status: 'orphaned', recoveryStatus: 'orphaned', sourceEpisodeId: 'lost-episode' });
    expect(list.agents.find(agent => agent.id === 'agent-orphan')).toMatchObject({ status: 'failed', recoveryStatus: 'orphaned', executionPending: false });
    expect(list.agents.find(agent => agent.id === 'agent-detached')).toMatchObject({ status: 'completed', recoveryStatus: 'orphaned', executionPending: false,
      outcome: { status: 'incomplete', complete: false, reason: 'budget_exceeded', truncated: false } });
    expect(list.agents.find(agent => agent.id === 'agent-finalized')).toMatchObject({ status: 'completed', recoveryStatus: null, executionPending: false,
      outcome: { status: 'incomplete', complete: false, reason: 'parent_requested_finalization', truncated: true } });
    expect(JSON.stringify(list)).not.toContain('private');
    expect(JSON.stringify(list)).not.toContain(root);
    expect(await call(restarted, 'task_log', { taskId: done.id })).toMatchObject({ text: 'durable log\n' });
    await expect(call(restarted, 'task_cancel', { taskId: 'orphan-shell' })).rejects.toMatchObject({ code: 'TASK_CONTROL_UNAVAILABLE' });
    await expect(call(restarted, 'agent_close', { agentId: 'agent-orphan' })).rejects.toMatchObject({ code: 'TASK_CONTROL_UNAVAILABLE' });
    await expect(call(restarted, 'agent_close', { agentId: 'agent-detached' })).rejects.toMatchObject({ code: 'TASK_CONTROL_UNAVAILABLE' });
    expect((await call(restarted, 'agent_close', { agentId: 'agent-finalized' })).agent.outcome).toEqual({ status: 'incomplete', complete: false, reason: 'parent_requested_finalization', truncated: true });
    await restarted.close(); _resetAgentRegistry();
    const recoveredAgain = service();
    expect((await call(recoveredAgain, 'tasks')).agents.find(agent => agent.id === 'agent-finalized').outcome.reason).toBe('parent_requested_finalization');
    await expect(call(recoveredAgain, 'agent_close', { agentId: 'agent-detached' })).rejects.toMatchObject({ code: 'TASK_CONTROL_UNAVAILABLE' });
    expect(createPersonProvider).not.toHaveBeenCalled();
  });

  it('pages all scoped tasks and children using stable creation/ID ties, without losing history on polling', async () => {
    const s = service(), h = await ownedHost(s), store = new TaskStore({ yeaftDir: h.dataRoot });
    const writeTask = (id, createdAt, status = 'succeeded', ownerVpId = h.parentVpId) => store.writeTask({ id,
      sessionId: h.sessionId, ownerVpId, kind: 'shell', title: id, status, createdAt, updatedAt: '2029-01-01' });
    for (const [id, date] of [['task-old', '2020-01-01'], ['task-middle', '2021-01-01'], ['task-Z-tie', '2026-01-01'], ['task-a-tie', '2026-01-01']]) writeTask(id, date);
    writeTask('task-foreign', '2030-01-01', 'succeeded', 'another-owner');
    for (let i = 0; i < 5; i++) getAgentRegistry().set(`agent-${i}`, { id: `agent-${i}`, name: `Child ${i}`, status: 'completed',
      createdAt: '2026-01-01', parentSessionId: h.sessionId, parentVpId: h.parentVpId, parentThreadId: h.threadId });
    getAgentRegistry().set('agent-foreign', { id: 'agent-foreign', name: 'Private', status: 'completed', createdAt: '2030-01-01',
      parentSessionId: h.sessionId, parentVpId: 'another-owner', parentThreadId: h.threadId });
    const first = await call(s, 'tasks', { limit: 2 });
    expect(first.tasks.map(item => item.id)).toEqual(['task-Z-tie', 'task-a-tie']);
    expect(first.agents.map(item => item.id)).toEqual(['agent-0', 'agent-1']); expect(first.nextCursor).toMatch(/^t1:/);
    rmSync(store.taskPath(h.sessionId, 'task-a-tie'));
    writeTask('task-new-head', '2030-01-01'); writeTask('task-middle', '2021-01-01', 'failed');
    getAgentRegistry().get('agent-2').status = 'failed';
    const second = await call(s, 'tasks', { limit: 2, cursor: first.nextCursor });
    expect(second.tasks.map(item => item.id)).toEqual(['task-middle', 'task-old']); expect(second.tasks[0].status).toBe('failed');
    expect(second.agents.map(item => item.id)).toEqual(['agent-2', 'agent-3']); expect(second.agents[0].status).toBe('failed');
    const third = await call(s, 'tasks', { limit: 2, cursor: second.nextCursor });
    expect(third.tasks).toEqual([]); expect(third.agents.map(item => item.id)).toEqual(['agent-4']);
    expect(third.nextCursor).toBeNull(); expect(third.truncated).toBe(false);
    const polled = await call(s, 'tasks', { limit: 2 });
    expect(polled.tasks.map(item => item.id)).toEqual(['task-new-head', 'task-Z-tie']);
    // Fresh polls merge by collection+ID; append history using its original cursor.
    const merged = new Map([...first.tasks, ...second.tasks, ...third.tasks, ...polled.tasks].map(item => [item.id, item]));
    expect(merged.get('task-middle').status).toBe('failed'); expect(merged.size).toBe(5);
    const other = host({ ownerId: 'bob' });
    await expect(request(other, 'tasks', { limit: 2, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
    expect(JSON.stringify([first, second, third])).not.toMatch(/task-foreign|agent-foreign|another-owner/);
    expect(createPersonProvider).not.toHaveBeenCalled();
  });

  it('keeps older active shell controls separate from newest-first history with bounded scope-fenced snapshots', async () => {
    const s = service(), h = await ownedHost(s), store = new TaskStore({ yeaftDir: h.dataRoot });
    const write = (id, createdAt, status, ownerVpId = h.parentVpId) => store.writeTask({ id,
      sessionId: h.sessionId, ownerVpId, kind: 'shell', title: `secret=private-token ${root}/private`, status, createdAt });
    write('old-live', '2020-01-01', 'running');
    write('old-orphan', '2020-01-01', 'orphaned');
    write('new-settled', '2026-01-01', 'succeeded');
    write('foreign-live', '2030-01-01', 'running', 'another-owner');
    const first = await call(s, 'tasks', { cursor: null, limit: 1 });
    expect(first.tasks.map(item => item.id)).toEqual(['new-settled']);
    expect(first.active.tasks.map(item => item.id)).toEqual(['old-live']);
    expect(first.active).toMatchObject({ agents: [], truncated: false });
    expect(JSON.stringify(first)).not.toMatch(/private-token|foreign-live|another-owner/);
    expect(JSON.stringify(first)).not.toContain(root);
    const next = await call(s, 'tasks', { cursor: first.nextCursor, limit: 1 });
    expect(next.tasks.map(item => item.id)).toEqual(['old-live']);
    expect(next.active.tasks.map(item => item.id)).toEqual(['old-live']);
    for (let i = 0; i < PERSON_TASK_LIMITS.records; i++) write(`live-${i}`, '2026-01-01', 'running');
    const crowded = await call(s, 'tasks', { cursor: null, limit: 1 });
    expect(crowded.tasks).toHaveLength(1);
    expect(crowded.active.tasks).toHaveLength(PERSON_TASK_LIMITS.records);
    expect(crowded.active.truncated).toBe(true);
    // Active snapshot is only a control aid; all history remains cursor-readable.
    const all = []; let cursor = null;
    do {
      const page = await call(s, 'tasks', { cursor, limit: 20 });
      all.push(...page.tasks); cursor = page.nextCursor;
    } while (cursor);
    expect(all).toHaveLength(103);
    expect(new Set(all.map(item => item.id)).size).toBe(103);
    expect(all.map(item => item.id)).toContain('old-live');
    expect(createPersonProvider).not.toHaveBeenCalled();
  });

  it('rejects malformed task page limits and continuation shapes before exposing inventory', async () => {
    const s = service(); await ownedHost(s);
    const encode = value => `t1:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    for (const payload of [{ limit: 0 }, { limit: 101 }, { limit: null }, { limit: 1.5 }, { cursor: '' }, { cursor: 1 },
      { cursor: 't1:bad-json' }, { cursor: encode({ scope: 'a'.repeat(64), tasks: null, agents: null }) },
      { cursor: encode({ scope: 'a'.repeat(64), tasks: { time: -1, id: 'task' }, agents: null }) },
      { cursor: encode({ scope: 'a'.repeat(64), tasks: { time: 0, id: '../task' }, agents: null }) }]) {
      await expect(call(s, 'tasks', payload)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(await call(s, 'tasks', { cursor: null, limit: 1 })).toEqual({ tasks: [], agents: [], nextCursor: null, truncated: false,
      active: { tasks: [], agents: [], truncated: false } });
  });

  it('bounds inventory summaries and rejects extra fields, native ID aliases and invalid log budgets', async () => {
    const s = service(), h = await ownedHost(s);
    const store = new TaskStore({ yeaftDir: h.dataRoot });
    for (let i = 0; i < 105; i++) store.writeTask({ id: `history-${i}`, sessionId: h.sessionId, ownerVpId: h.parentVpId, kind: 'shell', title: '好'.repeat(1000), status: i === 0 ? 'running' : 'succeeded', createdAt: '2026-01-01', updatedAt: '2026-01-01' });
    const list = await call(s, 'tasks');
    expect(list.tasks).toHaveLength(PERSON_TASK_LIMITS.records);
    expect(list.truncated).toBe(true);
    expect(list.tasks[0].id).toBe('history-0');
    expect(list.tasks.every(task => Buffer.byteLength(task.title) <= 512)).toBe(true);
    const all = []; let cursor = null;
    do {
      const result = await call(s, 'tasks', { limit: 20, cursor });
      expect(result.tasks.length).toBeLessThanOrEqual(20); expect(result.agents).toEqual([]);
      all.push(...result.tasks); cursor = result.nextCursor;
    } while (cursor);
    expect(all).toHaveLength(105); expect(new Set(all.map(task => task.id)).size).toBe(105);
    expect(all.map(task => task.id)).toEqual(all.map(task => task.id).sort());
    for (const payload of [{ taskId: 'history-1', maxBytes: 65537 }, { taskId: 'history-1', maxBytes: 0 }, { taskId: 'history-1', offset: -1 }, { taskId: 'history-1', offset: 0.5 }, { taskId: 'history-1', offset: Number.MAX_SAFE_INTEGER + 1 }, { taskId: 'history-1', tail: true }, { taskId: '../history-1' }, { taskId: 'history:1' }, { taskId: 'history-1', ownerId: 'bob' }]) {
      await expect(call(s, 'task_log', payload)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    await expect(call(s, 'tasks', { namespace: 'other' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(call(s, 'tasks', {}, 'not-open')).rejects.toMatchObject({ code: 'NOT_OPEN' });
    await expect(call(s, 'task_cancel', { taskId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('instructs ongoing-work ownership without enabling autonomous/model re-entry triggers', () => {
    expect(PROPOSAL_INSTRUCTIONS).toContain('Own ongoing authorized work using task/child context');
    expect(PROPOSAL_INSTRUCTIONS).toContain('not only latest user text');
    expect(PROPOSAL_INSTRUCTIONS).toContain('Episode end is not task completion/cancellation');
    expect(PROPOSAL_INSTRUCTIONS).toContain('never enables timers, autonomy or model re-entry');
  });
});
