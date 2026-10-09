import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../../../agent/yeaft/person/provider.js', async importOriginal => ({
  ...await importOriginal(), createPersonProvider: vi.fn(() => { throw new Error('Provider must not initialize for task APIs'); }),
}));
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { createPersonTaskHost } from '../../../../agent/yeaft/person/task-host.js';
import { PERSON_TASK_LIMITS, PROPOSAL_INSTRUCTIONS } from '../../../../agent/yeaft/person/contracts.js';
import { TaskStore } from '../../../../agent/yeaft/tasks/store.js';
import { getAgentRegistry, _resetAgentRegistry } from '../../../../agent/yeaft/tools/agent.js';
import { _resetNotifications } from '../../../../agent/yeaft/sub-agent/notifications.js';

let root, services, hosts;
const config = { model: 'test/model', primaryModel: 'test/model', maxOutputTokens: 1024, language: 'en', _readOnly: true };
const command = script => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
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
    const child = JSON.parse(await ctx.nativeRegistry.execute('SpawnAgent', { name: 'child', mission: `Inspect ${root}/private password=private-secret token=private-token`, budget: { wall_time_ms: 5000 } }, ctx));
    await vi.waitFor(() => expect(started).toBe(true));
    const list = await call(s, 'tasks');
    expect(list.agents[0]).toMatchObject({ id: child.agentId, sourceEpisodeId: 'child-source', recoveryStatus: null });
    expect(list.tasks[0]).toMatchObject({ id: child.taskId, kind: 'sub_agent', agentId: child.agentId });
    expect(JSON.stringify(list)).not.toContain(root);
    expect(JSON.stringify(list)).not.toContain('private-secret');
    expect(JSON.stringify(list)).not.toContain('private-token');
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
    writeFileSync(join(dataRoot, 'agents.json'), JSON.stringify({ scope, agents: [{ id: 'agent-orphan', name: 'Recovered child', mission: 'Inspect recovery', status: 'running', parentSessionId: sessionId, parentVpId, parentThreadId, personEpisodeId: 'lost-episode' }] }));
    const restarted = service();
    const list = await call(restarted, 'tasks');
    expect(list.tasks.find(task => task.id === done.id).status).toBe('succeeded');
    expect(list.tasks.find(task => task.id === 'orphan-shell')).toMatchObject({ status: 'orphaned', recoveryStatus: 'orphaned', sourceEpisodeId: 'lost-episode' });
    expect(list.agents[0]).toMatchObject({ id: 'agent-orphan', status: 'failed', recoveryStatus: 'orphaned' });
    expect(await call(restarted, 'task_log', { taskId: done.id })).toMatchObject({ text: 'durable log\n' });
    await expect(call(restarted, 'task_cancel', { taskId: 'orphan-shell' })).rejects.toMatchObject({ code: 'TASK_CONTROL_UNAVAILABLE' });
    await expect(call(restarted, 'agent_close', { agentId: 'agent-orphan' })).rejects.toMatchObject({ code: 'TASK_CONTROL_UNAVAILABLE' });
    expect(createPersonProvider).not.toHaveBeenCalled();
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
