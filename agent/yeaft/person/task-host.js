import { mkdirSync, realpathSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskManager } from '../tasks/manager.js';
import { TASK_RESULT_DELIVERY, isTerminalTaskStatus } from '../tasks/store.js';
import { createFullRegistry } from '../tools/index.js';
import { ToolRegistry, normalizeToolOutput } from '../tools/registry.js';
import { SubAgentToolRegistry } from '../sub-agent/execution-control.js';
import { agentBelongsToScope, getAgentRegistry } from '../tools/agent.js';
import closeAgent from '../tools/close-agent.js';
import { consumeNotificationForAgent } from '../sub-agent/notifications.js';
import { isTerminalAgentStatus } from '../sub-agent/status.js';
import { describeAgentOutcome } from '../sub-agent/outcome.js';
import { NullTrace } from '../debug-trace.js';
import { loadConfig } from '../config.js';
import { digest, fail, PERSON_TASK_LIMITS, personTaskRequest } from './contracts.js';

// Deliberately not the full Session registry: no transcript search, routing,
// interactive UI, MCP, Work Center, or nested orchestration authority.
export const PERSON_TASK_TOOL_IDS = Object.freeze([
  'FileRead', 'FileWrite', 'FileEdit', 'Glob', 'Grep', 'ListDir', 'DiskUsage',
  'ApplyPatch', 'GitRead', 'Bash', 'WebSearch', 'WebFetch', 'Skill', 'NotebookEdit',
  'SpawnAgent', 'ListAgents', 'WaitAgent', 'PromptAgent', 'CloseAgent', 'UpdateAgent',
  'ListTasks', 'ReadTaskLog', 'WaitTask', 'CancelTask',
  'DiscoverTools', // child Engine schema activation; Person itself uses its catalog
]);
const nativeRegistry = createFullRegistry();
const liveHosts = new Map();
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
const clone = value => JSON.parse(JSON.stringify(value));
const denied = () => Object.assign(new Error('Person task namespace access denied'), { code: 'TASK_SCOPE_DENIED' });

function identity(options) {
  for (const key of ['yeaftDir', 'ownerId', 'personId']) {
    if (typeof options[key] !== 'string' || !options[key].trim() || options[key].includes('\0')) throw denied();
  }
  const namespace = options.namespace ?? 'default';
  if (typeof namespace !== 'string' || !namespace.trim() || namespace.includes('\0')) throw denied();
  mkdirSync(resolve(options.yeaftDir), { recursive: true });
  const yeaftDir = realpathSync(resolve(options.yeaftDir));
  const scope = { yeaftDir, namespace, ownerId: options.ownerId, personId: options.personId };
  return { ...scope, key: digest(scope) };
}

// Canonical instance aliases are supported; links below that root must never
// turn two scoped task roots into the same storage. Local code is trusted not
// to race filesystem mutations; this is not an OS filesystem sandbox.
function privatePath(root, path) {
  const child = relative(root, resolve(path));
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw denied();
  let current = root;
  for (const part of child.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw denied(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path;
}

// Human-authored summaries can contain incidental credentials/paths. Do not
// expose native command fallbacks; redact common sensitive forms before capping.
function summary(value, maxBytes = 512) {
  const clean = String(value ?? '')
    .replace(/https?:\/\/\S+|mongodb(?:\+srv)?:\/\/\S+/gi, '[url]')
    .replace(/(?:bearer\s+|(?:api[_-]?key|password|secret|token)\s*[:=]\s*)\S+/gi, '[redacted]')
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, '[redacted]')
    .replace(/(?:\/[\w.@~+-]+)+(?:\/[^\s]*)?|(?:~|\.\.?|[A-Za-z]:)[\\/][^\s]+/g, '[path]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
  let out = '';
  for (const char of clean) { if (Buffer.byteLength(out + char) > maxBytes) break; out += char; }
  return out;
}
function projectedTask(task) {
  const commandFallback = task.kind === 'shell' && task.runtime?.command?.startsWith(task.title);
  return { id: task.id, title: commandFallback ? 'Shell task' : summary(task.title), kind: task.kind, status: task.status,
    createdAt: task.createdAt ?? null, updatedAt: task.updatedAt ?? null,
    sourceEpisodeId: task.source?.episodeId ?? null, agentId: task.runtime?.subAgentId ?? null,
    recoveryStatus: task.status === 'orphaned' ? 'orphaned' : null };
}
function projectedAgent(agent, executionPending) {
  const usage = Object.fromEntries(['tokens', 'turns', 'startedAt'].map(key => [key,
    Number.isFinite(agent.usage?.[key]) && agent.usage[key] >= 0 ? agent.usage[key] : 0]));
  // Only the helper's fixed outcome vocabulary crosses this boundary, never the
  // native result, budget reason, final report, or partial output.
  const { status, complete, reason, truncated } = describeAgentOutcome(agent);
  return { id: agent.id, name: summary(agent.name, 160), status: agent.status,
    outcome: { status, complete, reason, truncated }, executionPending,
    mission: summary(agent.mission ?? agent.task, 1024), usage, createdAt: agent.createdAt ?? null,
    sourceEpisodeId: agent.personEpisodeId ?? null, recoveryStatus: agent.recoveryStatus === 'orphaned' ? 'orphaned' : null };
}

function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function jsonFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.json')).flatMap(name => {
    try { return [JSON.parse(readFileSync(join(directory, name), 'utf8'))]; } catch { return []; }
  });
}

/** One live host per canonical instance / deployment namespace / owner / Person.
 * It outlives episodes. Use close() only for explicit shutdown, never on commit.
 * TaskStore's Session-shaped directories are private task storage, not Sessions;
 * neither a conversation store nor a Session manifest is created here.
 */
class ScopedPersonTaskHost {
  #manager;
  #agents = new Map();
  #calls = new Set();
  #stopping = null;
  #stopAll = false;
  #episodes = new Set();
  #cancelledEpisodes = new Set();
  #closed = false;
  #closePromise = null;
  #options;
  #agentEpisodes = new Map();
  #instrumentedAgents = new WeakSet();
  #observedDrivers = new WeakMap();

  constructor(options = {}) {
    this.scope = Object.freeze(identity(options));
    if (liveHosts.has(this.scope.key)) throw Object.assign(new Error('Person task host is already live'), { code: 'TASK_HOST_BUSY' });
    this.#options = options;
    this.yeaftDir = this.scope.yeaftDir;
    this.dataRoot = join(this.yeaftDir, 'person', 'tasks', this.scope.key);
    this.sessionId = `person-task-${this.scope.key}`;
    this.parentVpId = `person-${this.scope.key}`;
    this.threadId = `person-thread-${this.scope.key}`;
    this.agentScope = Object.freeze({ sessionId: this.sessionId, parentVpId: this.parentVpId, parentThreadId: this.threadId });
    for (const directory of [this.dataRoot, join(this.dataRoot, 'completions'),
      join(this.dataRoot, 'tool-results'), join(this.dataRoot, 'sub-agents'),
      join(this.dataRoot, 'tasks', 'sessions', this.sessionId)]) {
      privatePath(this.yeaftDir, directory);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    privatePath(this.yeaftDir, join(this.dataRoot, 'agents.json'));
    this.#restoreAgents();
    this.#manager = new TaskManager({ yeaftDir: this.dataRoot, cancelEscalationMs: options.cancelEscalationMs });
    this.taskManager = this.#scopedManager();
    // Drain startup orphan evidence only after the scoped manager is installed.
    this.#manager.setEventSink(event => this.#taskEvent(event));
    liveHosts.set(this.scope.key, this);
  }

  #assertOpen(episodeId = null) {
    if (this.#closed) throw Object.assign(new Error('Person task host is closed'), { code: 'TASK_HOST_CLOSED' });
    if (episodeId && this.#cancelledEpisodes.has(episodeId)) {
      throw Object.assign(new Error('Person task episode is cancelled'), { code: 'TASK_EPISODE_CANCELLED' });
    }
    if (this.#stopAll) throw Object.assign(new Error('Person task host is cancelling'), { code: 'TASK_HOST_CLOSED' });
  }

  #assertScope(ctx = {}, { child = false } = {}) {
    for (const key of ['ownerId', 'personId', 'namespace']) {
      if (ctx[key] != null && ctx[key] !== this.scope[key]) throw denied();
    }
    if (ctx.yeaftDir != null && realpathSync(resolve(ctx.yeaftDir)) !== this.yeaftDir) throw denied();
    if (ctx.sessionId != null && ctx.sessionId !== this.sessionId) throw denied();
    const agent = child ? getAgentRegistry().get(ctx.threadId) : null;
    const ownChild = agent?.__driverStarted && agentBelongsToScope(agent, this.agentScope);
    if (ctx.threadId != null && ctx.threadId !== this.threadId && !ownChild) throw denied();
    for (const key of ['currentVpId', 'senderVpId', 'parentVpId']) {
      if (ctx[key] != null && ctx[key] !== this.parentVpId && !(ownChild && ctx[key] === agent.id)) throw denied();
    }
    if (ctx.parentThreadId != null && ctx.parentThreadId !== this.threadId) throw denied();
  }

  #session(sessionId) {
    if (sessionId != null && sessionId !== this.sessionId) throw denied();
    return this.sessionId;
  }

  #owner(ownerVpId) {
    if (ownerVpId != null && ownerVpId !== this.parentVpId) throw denied();
    return this.parentVpId;
  }

  #privateLog(path) {
    const child = relative(this.dataRoot, resolve(path));
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw denied();
    return privatePath(this.yeaftDir, path);
  }

  #scopedManager(episodeId = null, signal = null) {
    const manager = this.#manager;
    return Object.freeze({
      startShellTask: (input = {}) => {
        this.#assertOpen(episodeId);
        signal?.throwIfAborted();
        return manager.startShellTask({ ...input, source: { ...input.source, episodeId }, sessionId: this.#session(input.sessionId), ownerVpId: this.#owner(input.ownerVpId), resultDelivery: TASK_RESULT_DELIVERY.STATUS_ONLY });
      },
      startTask: (input = {}) => {
        this.#assertOpen(episodeId);
        signal?.throwIfAborted();
        if (input.logPath) this.#privateLog(input.logPath);
        return manager.startTask({ ...input, source: { ...input.source, episodeId }, sessionId: this.#session(input.sessionId), ownerVpId: this.#owner(input.ownerVpId), resultDelivery: TASK_RESULT_DELIVERY.STATUS_ONLY });
      },
      listActiveTasks: (sessionId, ownerVpId) => manager.listActiveTasks(this.#session(sessionId), this.#owner(ownerVpId)),
      getTask: (sessionId, taskId, ownerVpId) => manager.getTask(this.#session(sessionId), taskId, this.#owner(ownerVpId)),
      readTaskLog: (sessionId, taskId, opts, ownerVpId) => manager.readTaskLog(this.#session(sessionId), taskId, opts, this.#owner(ownerVpId)),
      waitForTask: (sessionId, taskId, opts = {}) => manager.waitForTask(this.#session(sessionId), taskId, { ...opts, ownerVpId: this.#owner(opts.ownerVpId) }),
      cancelTask: (sessionId, taskId, ownerVpId) => manager.cancelTask(this.#session(sessionId), taskId, this.#owner(ownerVpId)),
      completeTask: (sessionId, taskId, opts) => manager.completeTask(this.#session(sessionId), taskId, opts),
      setTaskLogPath: (sessionId, taskId, path) => manager.setTaskLogPath(this.#session(sessionId), taskId, this.#privateLog(path)),
      refreshTaskLog: (sessionId, taskId) => manager.refreshTaskLog(this.#session(sessionId), taskId),
    });
  }

  #executionPending(agent) {
    const live = getAgentRegistry().get(agent.id);
    return Boolean(live && agentBelongsToScope(live, this.agentScope)
      && (live.__driverStarted || [...this.#calls].some(call => call.childId === agent.id)));
  }

  #persistAgents() {
    for (const agent of getAgentRegistry().values()) {
      if (!agentBelongsToScope(agent, this.agentScope)) continue;
      const fields = ['id', 'name', 'task', 'mission', 'persona', 'budget', 'allowTools', 'status', 'result', 'lastResult',
        'partial_output', 'error', 'outputFile', 'taskId', 'usage', 'createdAt', 'liveness', 'diagnostics', 'finalReport',
        'finalizationRequested', 'parentSessionId', 'parentVpId', 'parentThreadId', 'recoveryStatus', 'personEpisodeId'];
      this.#agents.set(agent.id, { ...Object.fromEntries(fields.filter(key => agent[key] !== undefined).map(key => [key, clone(agent[key])])),
        executionPending: this.#executionPending(agent) });
    }
    atomicJSON(join(this.dataRoot, 'agents.json'), { scope: this.scope, agents: [...this.#agents.values()] });
  }

  #restoreAgents() {
    const path = join(this.dataRoot, 'agents.json');
    if (!existsSync(path)) return;
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (digest(saved.scope) !== digest(this.scope)) throw denied();
    for (const record of saved.agents ?? []) {
      if (!agentBelongsToScope(record, this.agentScope)) throw denied();
      if (!isTerminalAgentStatus(record.status) || record.executionPending === true) {
        // A terminal driver can still have detached tool effects. Preserve its
        // outcome, but never claim recovered control of those effects.
        if (!isTerminalAgentStatus(record.status)) record.status = 'failed';
        record.recoveryStatus = 'orphaned';
        record.error = 'Agent restarted while child execution was pending; child control was lost.';
      }
      record.executionPending = false; // Only current live handles prove pending execution.
      const existing = getAgentRegistry().get(record.id);
      if (existing && !agentBelongsToScope(existing, this.agentScope)) throw denied();
      if (existing?.__driverStarted) throw Object.assign(new Error('Child driver is still live'), { code: 'TASK_HOST_BUSY' });
      this.#agents.set(record.id, record);
      this.#agentEpisodes.set(record.id, record.personEpisodeId ?? null);
      getAgentRegistry().set(record.id, { ...record, messages: [], abortController: new AbortController(), __driverStarted: false });
    }
  }

  #taskEvent(event) {
    const task = event.task;
    if (!task || task.sessionId !== this.sessionId || task.ownerVpId !== this.parentVpId) return;
    this.#persistAgents();
    if (event.event === 'completed') {
      const completion = { kind: 'person-task-completion', namespace: this.scope.key, task: clone(task),
        sourceRef: `person-task:${this.scope.key}:${task.id}:${task.status}:${task.updatedAt}`,
        notice: 'External task evidence only. No Person episode was scheduled.' };
      atomicJSON(join(this.dataRoot, 'completions', `${task.id}.json`), completion);
      // Observability only: never register model re-entry or call runtime.start.
      Promise.resolve().then(() => this.#options.onCompletion?.(completion)).catch(() => {});
    }
  }

  allowedToolIds(parentToolRegistry = nativeRegistry) {
    const config = this.#options.config ?? loadConfig({ dir: this.yeaftDir });
    return PERSON_TASK_TOOL_IDS.filter(id => (!this.#options.allowedToolIds || this.#options.allowedToolIds.includes(id)) && parentToolRegistry.isAllowed(id, { plugins: config.plugins }));
  }

  /** Attach to an explicit episode's tool context. Provider.catalog is the
   * permitted episode catalog, not the larger UI availableModels inventory.
   * Returned deps are built afresh, never inherited from arbitrary Session ctx.
   * Existing child drivers keep their own provider snapshot and abort signal.
   */
  async attach(ctx = {}, { provider = this.#options.provider, selection = this.#options.selection } = {}) {
    this.#assertOpen(ctx.episodeId);
    this.#assertScope(ctx);
    if (ctx.episodeId) this.#episodes.add(ctx.episodeId);
    const config = this.#options.config ?? loadConfig({ dir: this.yeaftDir });
    let child;
    if (provider) {
      const factory = this.#options.childProviderFactory ?? (await import('./child-provider.js')).createPersonChildProvider;
      child = await factory(provider, selection ?? provider.defaultSelection, config);
      if (!child?.adapter || !child?.config) throw new Error('Person child provider requires adapter and config');
    }
    this.#assertOpen(ctx.episodeId);
    const registry = new ToolRegistry();
    const dispatch = new ToolRegistry();
    const parentToolRegistry = ctx.parentToolRegistry ?? nativeRegistry;
    const manager = ctx.episodeId ? this.#scopedManager(ctx.episodeId) : this.taskManager;
    const deps = {
      adapter: child?.adapter ?? null, config: child?.config ?? config, trace: new NullTrace(),
      yeaftDir: this.yeaftDir, subAgentLogDir: join(this.dataRoot, 'sub-agents'),
      parentName: ctx.personName ?? this.scope.personId, parentVpId: this.parentVpId, childVpId: this.parentVpId,
      parentSessionId: this.sessionId, parentThreadId: this.threadId,
      parentVpPersona: ctx.vpPersona ?? null, parentToolRegistry: registry, taskManager: manager,
      effortDecision: ctx.effortDecision ?? null, episodeId: ctx.episodeId ?? null,
      skillManager: ctx.skillManager ?? null, language: config.language ?? 'en',
      onEvent: agentId => { this.#instrumentChild(getAgentRegistry().get(agentId), deps); this.#persistAgents(); },
    };
    for (const id of this.allowedToolIds(parentToolRegistry)) {
      const tool = parentToolRegistry.get(id);
      registry.register(tool);
      dispatch.register({ ...tool, execute: (args, caller = {}) => this.#execute(tool, args, caller, deps) });
    }
    // Exposure keeps the parent's exact ToolDefs; dispatch alone is wrapped.
    registry.execute = (name, args, caller) => dispatch.execute(name, args, caller);
    return { ...ctx, config, ownerId: this.scope.ownerId, personId: this.scope.personId, namespace: this.scope.namespace,
      yeaftDir: this.yeaftDir, cwd: ctx.cwd ?? resolve(this.#options.workDir ?? process.cwd()),
      sessionId: this.sessionId, currentVpId: this.parentVpId, senderVpId: this.parentVpId,
      parentVpId: this.parentVpId, threadId: this.threadId, taskManager: manager, parentEngineDeps: deps,
      nativeRegistry: registry, registerAsyncTask: undefined, asyncTaskCoordinator: undefined,
      conversationStore: null, taskHost: this };
  }

  async #execute(tool, args = {}, caller, deps) {
    this.#assertOpen(deps.episodeId);
    this.#assertScope(caller, { child: true });
    if (args.sessionId != null && args.sessionId !== this.sessionId) throw denied();
    if (!this.allowedToolIds().includes(tool.name)) return JSON.stringify({ error: 'Native tool disabled', errorEffect: 'none' });
    if (tool.name === 'SpawnAgent' && !deps.adapter) return JSON.stringify({ error: 'Person child provider unavailable', errorEffect: 'none' });
    const controller = new AbortController();
    const abort = () => controller.abort(caller.signal.reason);
    caller.signal?.addEventListener('abort', abort, { once: true });
    if (caller.signal?.aborted) abort();
    const context = { ...caller, yeaftDir: this.yeaftDir, sessionId: this.sessionId,
      currentVpId: this.parentVpId, senderVpId: this.parentVpId, threadId: caller.threadId ?? this.threadId,
      cwd: caller.cwd ?? resolve(this.#options.workDir ?? process.cwd()),
      taskManager: this.#scopedManager(deps.episodeId, controller.signal), parentEngineDeps: deps, signal: controller.signal,
      registerAsyncTask: undefined, asyncTaskCoordinator: undefined, conversationStore: null };
    const job = { id: randomUUID(), controller, promise: null, episodeId: deps.episodeId,
      childId: getAgentRegistry().has(caller.threadId) ? caller.threadId : null, tool: tool.name };
    job.promise = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      let output;
      const taskToCancel = tool.name === 'CancelTask' && args.taskId
        ? this.taskManager.getTask(this.sessionId, args.taskId) : null;
      if (taskToCancel?.kind === 'sub_agent') {
        const agent = getAgentRegistry().get(taskToCancel.runtime?.subAgentId);
        if (agent?.id === job.childId) {
          // The current tool call belongs to that driver's query. Joining it
          // here would await ourselves forever (even after registry timeout).
          output = JSON.stringify({ ok: false, error: 'A child cannot synchronously cancel its own task; ask the parent to cancel it.', errorEffect: 'none' });
        } else if (!agent || !agentBelongsToScope(agent, this.agentScope)) {
          output = JSON.stringify({ ok: false, error: 'Unable to cancel task: no live child handle.' });
        } else {
          await closeAgent.execute({ agent_id: agent.id }, context);
          await this.#joinAgent(agent);
          output = JSON.stringify({ ok: true, task: this.taskManager.getTask(this.sessionId, args.taskId), pending: false });
        }
      } else {
        output = await tool.execute(args, context);
        if (tool.name === 'SpawnAgent') {
          const result = JSON.parse(output);
          this.#instrumentChild(getAgentRegistry().get(result.agentId), deps);
        }
      }
      this.#persistAgents();
      if (tool.name === 'CloseAgent') await this.#joinAgent(getAgentRegistry().get(args.agent_id));
      if (tool.name === 'CancelTask') {
        const result = JSON.parse(output);
        if (result.ok && result.task) {
          if (!isTerminalTaskStatus(result.task.status)) result.task = await this.#joinShell(result.task.id);
          result.pending = false;
          output = JSON.stringify(result);
        }
      }
      this.#archiveToolResult(job, output);
      return output;
    }).catch(error => { this.#archiveToolResult(job, null, error); throw error; });
    this.#calls.add(job);
    if (job.childId) this.#persistAgents();
    try { return await job.promise; }
    finally {
      this.#calls.delete(job);
      caller.signal?.removeEventListener('abort', abort);
      if (job.childId) this.#persistAgents();
    }
  }

  #archiveToolResult(job, output, error) {
    const text = error ? String(error.message || error) : normalizeToolOutput(output);
    const result = { id: job.id, tool: job.tool, episodeId: job.episodeId, childId: job.childId,
      updatedAt: new Date().toISOString(), ok: !error, aborted: job.controller.signal.aborted,
      output: text, sourceRef: `person-tool:${this.scope.key}:${job.id}` };
    atomicJSON(join(this.dataRoot, 'tool-results', `${job.id}.json`), result);
  }

  #instrumentChild(agent, deps) {
    if (!agent || !agentBelongsToScope(agent, this.agentScope)) return;
    agent.personEpisodeId = deps.episodeId;
    this.#agentEpisodes.set(agent.id, deps.episodeId);
    if (agent.driverPromise && this.#observedDrivers.get(agent) !== agent.driverPromise) {
      this.#observedDrivers.set(agent, agent.driverPromise);
      // Terminal events precede driver cleanup. Persist after cleanup too so a
      // cleanly completed child is not falsely recovered as orphaned.
      agent.driverPromise.then(() => this.#persistAgents(), () => this.#persistAgents()).catch(() => {});
    }
    const registry = agent.subEngine?.toolRegistry;
    if (!registry || this.#instrumentedAgents.has(agent)) return;
    this.#instrumentedAgents.add(agent);
    const wrappers = new WeakMap();
    const dispatch = new SubAgentToolRegistry({ agent, allows: definition => {
      const original = registry.get(definition.name);
      return original && wrappers.get(original) === definition && registry.allows(original);
    } });
    // Never mutate a canonical ToolDef or replace its child exposure. Retain
    // native child authorization/accounting but wrap actual execute promises
    // below its timeout race so shutdown also joins detached after-effects.
    registry.execute = (name, args, caller = {}) => {
      const tool = registry.get(name);
      if (!tool || !registry.allows(tool)) return Promise.reject(new Error(`Unknown or disallowed child tool: ${name}`));
      if (!wrappers.has(tool)) wrappers.set(tool, { ...tool, execute: (input, context) => this.#execute(tool, input, context, deps) });
      dispatch.register(wrappers.get(tool));
      return dispatch.execute(name, args, caller);
    };
  }

  context({ episode, provider, selection, effortDecision, parentToolRegistry, ...ctx } = {}) {
    if (!episode?.id || episode.ownerId !== this.scope.ownerId || episode.personId !== this.scope.personId
        || (episode.namespace != null && episode.namespace !== this.scope.namespace)) throw denied();
    return this.attach({ ...ctx, ownerId: episode.ownerId, personId: episode.personId,
      namespace: episode.namespace, episodeId: episode.id, effortDecision, parentToolRegistry }, { provider, selection });
  }

  snapshot(ownerId) {
    if (ownerId !== this.scope.ownerId) throw denied();
    return this.evidence();
  }

  #ownedTask(taskId) {
    privatePath(this.yeaftDir, this.#manager.store.taskPath(this.sessionId, taskId));
    const task = this.taskManager.getTask(this.sessionId, taskId);
    if (!task || task.id !== taskId || task.sessionId !== this.sessionId) fail('NOT_FOUND');
    return task;
  }

  /** Owner-facing inspection/control: never attach a provider, schedule cognition
   * or cancel unrelated work. Native snapshots remain private to evidence(). */
  async request({ ownerId, personId, namespace = this.scope.namespace, op, payload = {} } = {}) {
    if (ownerId !== this.scope.ownerId || personId !== this.scope.personId || namespace !== this.scope.namespace) throw denied();
    this.#assertOpen();
    const args = personTaskRequest(op, payload);
    switch (op) {
      case 'tasks': {
        this.#persistAgents();
        const tasks = jsonFiles(this.#manager.store.sessionDir(this.sessionId))
          .filter(task => task.sessionId === this.sessionId && task.ownerVpId === this.parentVpId && ['shell', 'sub_agent'].includes(task.kind));
        const agents = [...this.#agents.values()].filter(agent => agentBelongsToScope(agent, this.agentScope));
        const recent = (items, terminal) => items.sort((a, b) => Number(terminal(a.status)) - Number(terminal(b.status))
          || String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? ''))).slice(0, PERSON_TASK_LIMITS.records);
        return { tasks: recent(tasks, isTerminalTaskStatus).map(projectedTask), agents: recent(agents, isTerminalAgentStatus).map(agent => projectedAgent(agent, this.#executionPending(agent))),
          truncated: tasks.length > PERSON_TASK_LIMITS.records || agents.length > PERSON_TASK_LIMITS.records };
      }
      case 'task_log': {
        const task = this.#ownedTask(args.taskId);
        this.#privateLog(task.log?.path || this.#manager.store.logPath(this.sessionId, args.taskId));
        const log = this.taskManager.readTaskLog(this.sessionId, args.taskId, { offset: args.offset, maxBytes: args.maxBytes, tail: false });
        return { taskId: args.taskId, text: log.text, nextOffset: log.nextOffset, totalBytes: log.bytes, truncated: log.truncated === true, status: task.status };
      }
      case 'task_cancel': {
        const task = this.#ownedTask(args.taskId);
        if (task.kind !== 'shell') fail('INVALID_REQUEST');
        // Orphaned is terminal metadata, not proof that external effects stopped.
        if (task.status === 'orphaned') fail('TASK_CONTROL_UNAVAILABLE');
        const result = this.taskManager.cancelTask(this.sessionId, args.taskId);
        if (!result.ok) fail('TASK_CONTROL_UNAVAILABLE');
        return { task: projectedTask(await this.#joinShell(args.taskId)), pending: false };
      }
      case 'agent_close': {
        const agent = getAgentRegistry().get(args.agentId);
        if (!agent || !agentBelongsToScope(agent, this.agentScope)) fail('NOT_FOUND');
        if (agent.recoveryStatus === 'orphaned') fail('TASK_CONTROL_UNAVAILABLE');
        const result = JSON.parse(await closeAgent.execute({ agent_id: agent.id }, { sessionId: this.sessionId,
          parentEngineDeps: this.agentScope, taskManager: this.taskManager }));
        if (!result.success) fail('TASK_CONTROL_UNAVAILABLE');
        await this.#joinAgent(agent);
        return { agent: projectedAgent(agent, this.#executionPending(agent)), pending: false };
      }
      default: fail('INVALID_REQUEST');
    }
  }

  /** Convenience for non-Registry embedding; returns the untruncated native output. */
  async execute(id, args, ctx = {}, options) {
    const attached = await this.attach(ctx, options);
    return attached.nativeRegistry.execute(id, args, attached);
  }

  async #joinAgent(agent) {
    if (!agent || !agentBelongsToScope(agent, this.agentScope)) return;
    const calls = [...this.#calls].filter(call => call.childId === agent.id);
    for (const call of calls) call.controller.abort('Child closed');
    if (agent.driverPromise) await agent.driverPromise;
    else while (agent.__driverStarted) await pause();
    await Promise.all(calls.map(call => call.promise.catch(() => {})));
    consumeNotificationForAgent(agent.id);
    this.#persistAgents();
  }

  async #joinShell(taskId) {
    while (true) {
      const result = await this.taskManager.waitForTask(this.sessionId, taskId, { timeoutMs: 1000 });
      if (!result.ok) throw new Error(result.error);
      if (!result.timedOut) return result.task;
    }
  }

  /** Completion records remain facts, not user messages or automatic triggers. */
  evidence({ limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid evidence limit');
    this.#persistAgents();
    const recent = items => items.sort((a, b) => String(b.updatedAt ?? b.task?.updatedAt ?? '').localeCompare(String(a.updatedAt ?? a.task?.updatedAt ?? ''))).slice(0, limit);
    return { namespace: this.scope.key, sessionId: this.sessionId,
      tasks: recent(jsonFiles(this.#manager.store.sessionDir(this.sessionId))),
      agents: clone([...this.#agents.values()].slice(-limit)), completions: recent(jsonFiles(join(this.dataRoot, 'completions'))),
      toolResults: recent(jsonFiles(join(this.dataRoot, 'tool-results'))).map(result => ({ ...result,
        output: result.output.slice(0, 8192), rawPath: join(this.dataRoot, 'tool-results', `${result.id}.json`) })) };
  }

  /** Explicit cancellation stops and joins this Person's effects; normal episode
   * commit simply discards attach()'s context and never calls this method. */
  cancel(input = 'Person cancelled') {
    const { reason = 'Person cancelled', episodeId = null } = typeof input === 'object' ? input : { reason: input };
    if (typeof input === 'object' && input.ownerId != null && input.ownerId !== this.scope.ownerId) throw denied();
    if (episodeId) this.#cancelledEpisodes.add(episodeId);
    else for (const id of this.#episodes) this.#cancelledEpisodes.add(id);
    if (this.#stopping) return this.#stopping.then(() => this.cancel(input));
    this.#stopAll = !episodeId;
    this.#stopping = Promise.resolve().then(async () => {
      const calls = [...this.#calls].filter(call => !episodeId || call.episodeId === episodeId);
      for (const call of calls) call.controller.abort(reason);
      const agents = [...getAgentRegistry().values()].filter(agent => agentBelongsToScope(agent, this.agentScope) && (!episodeId || this.#agentEpisodes.get(agent.id) === episodeId));
      for (const agent of agents) {
        if (agent.__driverStarted || !isTerminalAgentStatus(agent.status)) await closeAgent.execute({ agent_id: agent.id }, { sessionId: this.sessionId, parentEngineDeps: { parentSessionId: this.sessionId, parentVpId: this.parentVpId, parentThreadId: this.threadId }, taskManager: this.taskManager });
      }
      const shells = this.taskManager.listActiveTasks(this.sessionId).filter(task => task.kind === 'shell' && (!episodeId || task.source?.episodeId === episodeId));
      for (const task of shells) {
        const result = this.taskManager.cancelTask(this.sessionId, task.id);
        if (!result.ok) throw new Error(result.error);
      }
      await Promise.all([...agents.map(agent => this.#joinAgent(agent)), ...shells.map(task => this.#joinShell(task.id)), ...calls.map(call => call.promise.catch(() => {}))]);
      return this.evidence();
    }).finally(() => { this.#stopping = null; this.#stopAll = false; });
    return this.#stopping;
  }

  close(reason = 'Person task host closed') {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const pending = this.#stopping ?? Promise.resolve();
    this.#closePromise = pending.then(() => this.cancel(reason)).then(result => {
      if (liveHosts.get(this.scope.key) === this) liveHosts.delete(this.scope.key);
      return result;
    });
    return this.#closePromise;
  }
}

function scopedHost(options) {
  const scope = identity(options);
  return liveHosts.get(scope.key) ?? new ScopedPersonTaskHost(options);
}

/** Instance/runtime facade. Each admitted owner/Person gets an independently
 * persistent scoped host; contexts have stable task identity across episodes.
 * context({ episode, provider, selection, effortDecision, parentToolRegistry })
 * returns a native ToolContext. snapshot(ownerId) is observational evidence.
 * cancel({ ownerId, episodeId }) only stops that episode's launched effects;
 * omit episodeId for an explicit owner stop. close() stops all this facade owns.
 * A bound { ownerId, personId } constructor also supports attach()/execute().
 */
export class PersonTaskHost {
  #options;
  #bound = null;
  #owners = new Map();
  #closed = false;
  #closePromise = null;

  constructor(options = {}) {
    const base = identity({ ...options, ownerId: options.ownerId ?? '_runtime', personId: options.personId ?? '_runtime' });
    this.#options = { ...options, yeaftDir: base.yeaftDir, namespace: base.namespace };
    if (options.ownerId != null) this.#bound = new ScopedPersonTaskHost(this.#options);
  }

  #host(ownerId, personId) {
    if (this.#closed) throw Object.assign(new Error('Person task host is closed'), { code: 'TASK_HOST_CLOSED' });
    if (this.#bound) {
      if (ownerId !== this.#bound.scope.ownerId || (personId != null && personId !== this.#bound.scope.personId)) throw denied();
      return this.#bound;
    }
    const existing = this.#owners.get(ownerId);
    if (existing) {
      if (personId != null && existing.scope.personId !== personId) throw denied();
      return existing;
    }
    const host = scopedHost({ ...this.#options, ownerId,
      personId: personId ?? `person-${digest([this.#options.namespace, ownerId]).slice(0, 32)}` });
    this.#owners.set(ownerId, host);
    return host;
  }

  async context(input = {}) {
    const episode = input.episode;
    if (!episode?.id || !episode.ownerId || !episode.personId
        || (episode.namespace != null && episode.namespace !== this.#options.namespace)) throw denied();
    return this.#host(episode.ownerId, episode.personId).context(input);
  }

  snapshot(ownerId) { return this.#host(ownerId).snapshot(ownerId); }

  request(input = {}) {
    if (typeof input.ownerId !== 'string' || !input.ownerId || typeof input.personId !== 'string' || !input.personId
        || input.namespace !== this.#options.namespace) throw denied();
    return this.#host(input.ownerId, input.personId).request(input);
  }

  cancel(input = {}) {
    if (this.#bound) return this.#bound.cancel(input);
    if (!input || typeof input.ownerId !== 'string' || !input.ownerId) throw denied();
    const host = this.#owners.get(input.ownerId);
    return host ? host.cancel(input) : Promise.resolve({ tasks: [], agents: [], completions: [] });
  }

  close(reason = 'Person task host closed') {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const hosts = this.#bound ? [this.#bound] : [...this.#owners.values()];
    this.#closePromise = Promise.all(hosts.map(host => host.close(reason)));
    return this.#closePromise;
  }

  // Compatibility for direct owner/Person embedding. The runtime uses context.
  attach(...args) { return this.#bound.attach(...args); }
  execute(...args) { return this.#bound.execute(...args); }
  evidence(...args) { return this.#bound.evidence(...args); }
  allowedToolIds(...args) { return this.#bound.allowedToolIds(...args); }
  get scope() { return this.#bound?.scope; }
  get dataRoot() { return this.#bound?.dataRoot; }
  get yeaftDir() { return this.#options.yeaftDir; }
  get sessionId() { return this.#bound?.sessionId; }
  get parentVpId() { return this.#bound?.parentVpId; }
  get threadId() { return this.#bound?.threadId; }
  get taskManager() { return this.#bound?.taskManager; }
}

export function createPersonTaskHost(options = {}) {
  return options.ownerId != null ? scopedHost(options) : new PersonTaskHost(options);
}
