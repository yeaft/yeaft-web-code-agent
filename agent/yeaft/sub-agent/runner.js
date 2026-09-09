/**
 * runner.js — Sub-agent execution driver.
 *
 * Lifecycle (per agent record in the global registry from `tools/agent.js`):
 *
 *   created → running ↔ idle (mission turn finished, awaiting parent feedback)
 *                ↘
 *                  → completed (terminal — budget cutoff with partial output)
 *                  → failed    (terminal — adapter/stream error)
 *                  → closed    (terminal — CloseAgent or clean finally{} drain)
 *                  → abandoned (terminal — idle watchdog tripped)
 *
 * Each sub-agent owns:
 *   - its own Engine instance (shares parent adapter/trace/config/stores)
 *   - its own ToolRegistry: parent's minus the orchestration tools
 *   - its own messages buffer (`agent.engineMessages`) so a turn can resume
 *     after PromptAgent
 *   - a durable output log at ~/.yeaft/sub-agents/<agentId>.log mirroring
 *     every onEvent (see output-log.js)
 *   - a liveness snapshot (toolUseCount, tokenCount, lastEventAt, …) the
 *     parent reads through WaitAgent / ListAgents
 *
 * The runner is fire-and-forget: `startSubAgent(agent, deps)` schedules a
 * microtask that drives the loop and returns immediately. Parents observe
 * via `WaitAgent` (which now returns a structured envelope with status,
 * liveness, mid-stream preview, outputFile path) or via `deps.onEvent` for
 * live UI streaming.
 *
 * Terminal transitions ALWAYS:
 *   1. enqueue a sub-agent notification (see notifications.js) so the
 *      parent engine surfaces it on the next user turn even if the
 *      parent forgot to call WaitAgent;
 *   2. close the output log file;
 *   3. emit a `sub_agent_status` event with the terminal status;
 *   4. release the subEngine reference for GC.
 */

import { Engine } from '../engine.js';
import { snapshotEffortDecision } from '../effort.js';
import { SubAgentToolRegistry, resolveSubAgentBudget, createExecutionStats } from './execution-control.js';
import { getPersona } from '../personas.js';
import { buildSpawnedPreamble } from './spawned-prompt.js';
import { STATUS, isTerminalAgentStatus } from './status.js';
import { createOutputLog } from './output-log.js';
import { makeLiveness, bumpLivenessFromEvent } from './liveness.js';
import { consumeNotificationForAgent, enqueueTerminalNotification } from './notifications.js';
// NOTE: tickAgent lives in `../tools/agent.js`, which itself imports this
// module (startSubAgent). To avoid the ES-module circular-import gotcha
// where one side sees an undefined export at module-init time, we import
// tickAgent dynamically inside the driver at first use. The cost is one
// `await import(...)` per sub-agent lifetime — negligible — and the
// benefit is that either module can be loaded first without ordering
// hazards.
let _tickAgent = null;
async function loadTickAgent() {
  if (_tickAgent) return _tickAgent;
  const mod = await import('../tools/agent.js');
  _tickAgent = mod.tickAgent;
  return _tickAgent;
}

const RESTRICTED_TOOLS = new Set([
  'SpawnAgent',
  'Agent',          // legacy alias
  'PromptAgent',
  'SendMessage',    // legacy alias
  'WaitAgent',
  'CloseAgent',
  'ListAgents',
  'RouteForward',
  'AskUser',
  'CreateWorkItem',
]);

/** How long an idle sub-agent may wait for a follow-up before the watchdog reaps it. */
const IDLE_ABANDON_MS = 5 * 60 * 1000; // 5 minutes

/** Cap on agent.lastResult (mid-stream preview) — keeps memory bounded. */
const LAST_RESULT_MAX_CHARS = 8 * 1024;

/**
 * Build a child ToolRegistry by copying every tool from the parent
 * registry except those in RESTRICTED_TOOLS.
 *
 * @param {ToolRegistry|null} parentRegistry
 * @returns {ToolRegistry}
 */
export function buildChildToolRegistry(parentRegistry, { agent = null, stopBudget = null } = {}) {
  const preset = agent?.personaData || getPersona(agent?.persona);
  // Implementers retain work tools; read-only roles are a structural allowlist.
  // Resolve legacy template names (Read) to canonical FileRead before filtering.
  const allowed = preset && preset.id !== 'implementer'
    ? new Set([...preset.tools.map(name => parentRegistry?.get(name)?.name || (name === 'Read' ? 'FileRead' : name)), 'DiscoverTools'])
    : null;
  const child = new SubAgentToolRegistry({
    agent, stopBudget,
    allows: tool => !RESTRICTED_TOOLS.has(tool.name) && (!allowed || allowed.has(tool.name)),
  });
  if (!parentRegistry || typeof parentRegistry.getAllTools !== 'function') {
    return child;
  }
  for (const t of parentRegistry.getAllTools()) {
    if (RESTRICTED_TOOLS.has(t.name)) continue;
    child.register(t);
  }
  return child;
}

/**
 * Public read-only check — used by tests and callers that want to
 * sanity-check the constraint without poking the registry.
 */
export function isRestrictedToolName(name) {
  return RESTRICTED_TOOLS.has(name);
}

/**
 * Fire-and-forget: kick off the sub-agent loop. Mutates `agent` in place
 * (status, result, error, engineMessages, abortController, outputLog,
 * liveness).
 *
 * @param {object} agent — record from getAgentRegistry()
 * @param {{
 *   adapter: object,
 *   trace: object,
 *   config: object,
 *   conversationStore?: object,
 *   memoryIndex?: object,
 *   memoryStore?: object,
 *   memoryShardStore?: object,
 *   parentToolRegistry?: ToolRegistry,
 *   skillManager?: object,
 *   mcpManager?: object,
 *   yeaftDir?: string,
 *   parentName?: string,
 *   parentVpId?: string,
 *   parentSessionId?: string|null,
 *   projectSessionIds?: string[],
 *   projectLabel?: string,
 *   projectInstruction?: string,
 *   parentThreadId?: string|null,
 *   parentVpPersona?: object,
 *   toolStats?: object,
 *   onEvent?: (agentId: string, evt: object) => void,
 *   language?: 'en'|'zh',
 *   subAgentLogDir?: string,
 *   idleAbandonMs?: number,
 * }} deps
 */
export function startSubAgent(agent, deps = {}) {
  if (!agent || typeof agent !== 'object') return;
  if (agent.__driverStarted) return; // idempotent
  agent.__driverStarted = true;
  // Re-freeze restored JSON snapshots; never consult live parent config here.
  agent.parentEffortDecision = snapshotEffortDecision(agent.parentEffortDecision);

  let subEngine = null;
  let outputLog = null;
  try {
    // Build sub-engine wired to the parent's adapter/stores/config but with
    // a restricted toolset. We DO NOT pass a conversationStore: sub-agent
    // turns must not pollute the user-facing conversation history. The
    // memory stores are shared so memory recall still works for the
    // sub-agent (matches parent VP persona memory).
    agent.budget = resolveSubAgentBudget(agent.budget, agent.persona);
    agent.execution = agent.execution || createExecutionStats();
    const childRegistry = buildChildToolRegistry(deps.parentToolRegistry, {
      agent,
      stopBudget: reason => stopForBudget(agent, reason),
    });
    subEngine = new Engine({
      adapter: deps.adapter,
      trace: deps.trace,
      config: { ...deps.config, _readOnly: true },
      conversationStore: null,
      memoryIndex: deps.memoryIndex || null,
      memoryStore: deps.memoryStore || null,
      memoryShardStore: deps.memoryShardStore || null,
      toolRegistry: childRegistry,
      skillManager: deps.skillManager || null,
      mcpManager: deps.mcpManager || null,
      yeaftDir: deps.yeaftDir || null,
      managedCliReady: deps.managedCliReady || null,
      toolStats: deps.toolStats || null,
      taskManager: deps.taskManager || null,
    });
    // Same-turn result plumbing: inherit the parent's coordinator so any
    // result-producing child task launched from this sub-agent uses the shared
    // owner map. Persistent shell tasks remain status-only and do not register.
    if (deps.asyncTaskCoordinator && typeof subEngine.setAsyncTaskCoordinator === 'function') {
      subEngine.setAsyncTaskCoordinator(deps.asyncTaskCoordinator);
    }

    agent.subEngine = subEngine;
    agent.engineMessages = agent.engineMessages || [];
    agent.liveness = agent.liveness || makeLiveness();
    agent.parentVpId = deps.parentVpId || null;
    agent.parentSessionId = deps.parentSessionId || null;
    agent.parentThreadId = deps.parentThreadId || 'main';
    outputLog = createOutputLog(agent.id, deps.subAgentLogDir);
    agent.outputLog = outputLog;
    agent.outputFile = outputLog.path;
    if (agent.taskId && deps.taskManager && agent.parentSessionId) {
      try { deps.taskManager.setTaskLogPath(agent.parentSessionId, agent.taskId, agent.outputFile); } catch { /* ignore */ }
    }
    outputLog.write({ type: 'sub_agent_spawned', agentId: agent.id, agentName: agent.name, mission: agent.mission || agent.task || '', parentEffortDecision: agent.parentEffortDecision });

    // Compose the system-prompt-overlay we want injected.
    const preamble = buildSpawnedPreamble({
      parentName: deps.parentName || 'parent',
      parentVpId: deps.parentVpId || null,
      agentName: agent.name,
      mission: agent.mission || agent.task || '',
      expectedOutput: agent.expected_output,
      presetPrompt: (agent.personaData || getPersona(agent.persona))?.systemPrompt,
      budget: agent.budget,
      language: deps.language ?? deps.config?.language ?? 'en',
    });

    const baseVpPersona =
      deps.parentVpPersona && typeof deps.parentVpPersona === 'object'
        ? { ...deps.parentVpPersona }
        : {};
    baseVpPersona.persona =
      [(baseVpPersona.persona || '').trim(), preamble.trim()]
        .filter(Boolean)
        .join('\n\n');
    if (!baseVpPersona.displayName || !String(baseVpPersona.displayName).trim()) {
      baseVpPersona.displayName = `${deps.parentName || 'Parent'}/${agent.name || 'sub-agent'}`;
    }
    baseVpPersona.subAgent = {
      parentVpId: deps.parentVpId || null,
      agentId: agent.id,
      agentName: agent.name,
    };

    agent.subVpPersona = baseVpPersona;

    // Background driver — pumps queued user messages through engine.query
    // turn by turn until the agent reaches a terminal state.
    driveSubAgent(agent, subEngine, baseVpPersona, deps).catch((err) => {
      // The driver normally handles its own failures (stream try/catch +
      // terminal transition). This .catch covers genuinely unexpected
      // throws between turns (e.g. inside dequeueNextUserPrompt) so we
      // never leave a zombie record without a terminal status.
      if (isTerminalAgentStatus(agent.status)) return;
      transitionTerminal(agent, STATUS.FAILED, {
        error: err && err.message ? err.message : String(err),
        diagnostic: 'driver_error',
        deps,
      });
    });
  } catch (err) {
    // Startup is transactional. Nothing owns these resources until the driver
    // promise has been scheduled; a synchronous failure must leave the record
    // restartable and release every partially-created handle.
    try { outputLog?.close(); } catch { /* best-effort rollback */ }
    try { subEngine?.retireAsyncTasks?.('sub_agent_startup_failed', { rescue: false }); } catch { /* best-effort rollback */ }
    agent.outputLog = null;
    agent.outputFile = null;
    agent.subEngine = null;
    agent.subVpPersona = null;
    agent.__driverStarted = false;
    throw err;
  }
}

/**
 * Drive one mission turn at a time. Each iteration:
 *   1. Pull the next pending user message from the queue (or, on first
 *      turn, the mission itself).
 *   2. Run engine.query, forwarding every event to deps.onEvent (tagged
 *      with agentId) AND mirroring to the output log AND updating
 *      liveness + lastResult.
 *   3. Stash the final assistant text on agent.result, tickAgent for
 *      budget enforcement, mark idle.
 *   4. Wait for either a new PromptAgent (status flips to running) OR
 *      CloseAgent (status=='closed') OR the idle watchdog firing
 *      (status=='abandoned').
 */
function buildWallTimeBudgetResult(agent, reason) {
  return {
    status: 'budget_exceeded',
    partial_output: agent.partial_output || agent.lastResult
      || (typeof agent.result === 'string' ? agent.result : agent.result?.partial_output) || '',
    reason,
    usage: { ...(agent.usage || {}) },
  };
}

function stopForBudget(agent, reason) {
  if (agent.budgetStopReason || isTerminalAgentStatus(agent.status)) return;
  agent.budgetStopReason = reason;
  agent.result = buildWallTimeBudgetResult(agent, reason);
  agent.partial_output = agent.result.partial_output || '';
  agent.abortController?.abort(reason);
}

function armWallTimeWatchdog(agent, deps) {
  const wallTimeMs = agent?.budget?.wall_time_ms;
  if (typeof wallTimeMs !== 'number' || !Number.isFinite(wallTimeMs) || wallTimeMs <= 0) {
    return null;
  }
  const startedAt = agent.usage?.startedAt || Date.now();
  const remainingMs = Math.max(0, startedAt + wallTimeMs - Date.now());
  const timer = setTimeout(() => {
    if (isTerminalAgentStatus(agent.status)) return;
    const reason = `wall_time_ms (${wallTimeMs}) exceeded`;
    agent.result = buildWallTimeBudgetResult(agent, reason);
    agent.partial_output = agent.result.partial_output || '';
    if (agent.abortController && !agent.abortController.signal.aborted) {
      try { agent.abortController.abort(reason); } catch { /* ignore */ }
    }
    transitionTerminal(agent, STATUS.COMPLETED, {
      error: reason,
      diagnostic: 'wall_time_watchdog',
      deps,
    });
  }, remainingMs);
  timer.unref?.();
  return timer;
}

async function driveSubAgent(agent, subEngine, vpPersona, deps) {
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null;
  const wallTimeWatchdog = armWallTimeWatchdog(agent, deps);
  const idleAbandonMs = typeof deps.idleAbandonMs === 'number' && deps.idleAbandonMs > 0
    ? deps.idleAbandonMs : IDLE_ABANDON_MS;

  const wrapEvt = (evt) => ({
    ...evt,
    agentId: agent.id,
    agentName: agent.name,
    parentSessionId: agent.parentSessionId || deps.parentSessionId || null,
    parentVpId: agent.parentVpId || deps.parentVpId || null,
    parentThreadId: agent.parentThreadId || deps.parentThreadId || 'main',
  });
  let lastTaskLogRefreshAt = 0;
  const refreshTaskLog = ({ force = false } = {}) => {
    if (!agent.taskId || !deps.taskManager || !agent.parentSessionId) return;
    const now = Date.now();
    if (!force && now - lastTaskLogRefreshAt < 250) return;
    lastTaskLogRefreshAt = now;
    try { deps.taskManager.refreshTaskLog(agent.parentSessionId, agent.taskId); } catch { /* ignore */ }
  };

  const emit = (evt) => {
    const wrapped = wrapEvt(evt);
    try { agent.outputLog?.write(wrapped); } catch { /* ignore log failures */ }
    refreshTaskLog({ force: true });
    if (onEvent) {
      try { onEvent(agent.id, wrapped); } catch { /* ignore listener errors */ }
    }
  };

  const dequeueNextUserPrompt = () => {
    if (!Array.isArray(agent.pendingPrompts)) agent.pendingPrompts = [];
    const entry = agent.pendingPrompts.shift();
    if (!entry) return null;
    if (typeof entry === 'string') {
      return {
        prompt: entry,
        parentEffortDecision: snapshotEffortDecision(agent.parentEffortDecision),
        projectSessionIds: Array.isArray(deps.projectSessionIds)
          ? deps.projectSessionIds.slice()
          : [],
        projectLabel: typeof deps.projectLabel === 'string'
          ? deps.projectLabel
          : '',
        projectInstruction: typeof deps.projectInstruction === 'string'
          ? deps.projectInstruction
          : '',
      };
    }
    if (!entry || typeof entry !== 'object' || typeof entry.prompt !== 'string') return null;
    return {
      prompt: entry.prompt,
      parentEffortDecision: snapshotEffortDecision(entry.parentEffortDecision ?? agent.parentEffortDecision),
      projectSessionIds: Array.isArray(entry.projectSessionIds)
        ? entry.projectSessionIds.slice()
        : [],
      projectLabel: typeof entry.projectLabel === 'string'
        ? entry.projectLabel
        : '',
      projectInstruction: typeof entry.projectInstruction === 'string'
        ? entry.projectInstruction
        : '',
    };
  };

  try {
    // Seed: mission becomes the first user prompt.
    if (!agent.pendingPrompts) agent.pendingPrompts = [];
    if (agent.mission && !agent.__missionSeeded) {
      agent.pendingPrompts.push({
        prompt: agent.mission,
        parentEffortDecision: agent.parentEffortDecision,
        projectSessionIds: Array.isArray(deps.projectSessionIds)
          ? deps.projectSessionIds.slice()
          : [],
        projectLabel: typeof deps.projectLabel === 'string' ? deps.projectLabel : '',
        projectInstruction: typeof deps.projectInstruction === 'string'
          ? deps.projectInstruction
          : '',
      });
      agent.__missionSeeded = true;
    }

    agent.status = STATUS.RUNNING;
    emit({ type: 'sub_agent_status', status: STATUS.RUNNING });

    while (!isTerminalAgentStatus(agent.status)) {
      const queuedPrompt = dequeueNextUserPrompt();
      if (!queuedPrompt) {
        // No queued work — go idle and wait for PromptAgent / CloseAgent /
        // watchdog.
        agent.status = STATUS.IDLE;
        agent.idleSince = Date.now();
        emit({ type: 'sub_agent_status', status: STATUS.IDLE });
        if (agent.result || agent.lastResult) {
          try {
            enqueueTerminalNotification({
              agentId: agent.id,
              agentName: agent.name,
              status: STATUS.IDLE,
              result: typeof agent.result === 'string' ? agent.result : (agent.lastResult || ''),
              error: null,
              outputFile: agent.outputFile || null,
              turns: agent.usage?.turns || 0,
              parentVpId: agent.parentVpId || deps.parentVpId || null,
              parentSessionId: agent.parentSessionId || deps.parentSessionId || null,
            });
          } catch { /* best-effort notification */ }
        }

        const reason = await waitUntilResumed(agent, idleAbandonMs);
        if (reason === 'abandoned') {
          transitionTerminal(agent, STATUS.ABANDONED, {
            error: `idle for more than ${idleAbandonMs}ms with no follow-up`,
            diagnostic: 'idle_watchdog',
            deps,
          });
          break;
        }
        if (isTerminalAgentStatus(agent.status)) break;
        agent.idleSince = null;
        agent.status = STATUS.RUNNING;
        emit({ type: 'sub_agent_status', status: STATUS.RUNNING });
        continue;
      }

      // Partial evidence belongs to this query, never a previous follow-up.
      agent.partial_output = '';
      agent.lastResult = '';
      agent.result = '';
      let assistantText = '';
      let endedNormally = false;
      let streamError = null;
      const turnTokenStart = agent.liveness?.tokenCount || 0;
      const priorUsageTokens = agent.usage?.tokens || 0;
      let turnUsageTokens = 0;
      try {
        agent.activeParentEffortDecision = queuedPrompt.parentEffortDecision;
        emit({ type: 'sub_agent_effort_snapshot', parentEffortDecision: queuedPrompt.parentEffortDecision });
        const stream = subEngine.query({
          prompt: queuedPrompt.prompt,
          messages: agent.engineMessages,
          signal: agent.abortController?.signal,
          scenario: 'sub_agent',
          isSubAgent: true,
          parentEffortDecision: queuedPrompt.parentEffortDecision,
          vpPersona,
          sessionId: agent.parentSessionId || deps.parentSessionId || null,
          threadId: agent.id,
          // SpawnAgent records the caller-provided cwd on the agent. Thread it
          // into the child Engine just like a parent query's workDir so child
          // file tools resolve relative paths in the requested workspace.
          workDir: agent.cwd,
          projectSessionIds: queuedPrompt.projectSessionIds,
          projectLabel: queuedPrompt.projectLabel,
          projectInstruction: queuedPrompt.projectInstruction,
        });
        for await (const evt of stream) {
          // Liveness — update first so even listener throws don't lose
          // the bump.
          bumpLivenessFromEvent(agent.liveness, evt);

          // Mirror every raw event to the durable log. We still keep
          // `sub_agent_event` text_delta suppressed so the inline transcript
          // card remains result-oriented, but task-backed sub-agents refresh
          // their task log so the Session status pane can show a live stream.
          if (agent.outputLog) {
            try { agent.outputLog.write(wrapEvt(evt)); } catch { /* ignore */ }
          }
          refreshTaskLog({ force: evt?.type !== 'text_delta' });
          if (onEvent && evt?.type !== 'text_delta') {
            try { onEvent(agent.id, wrapEvt(evt)); } catch { /* ignore listener errors */ }
          }

          if (evt && evt.type === 'text_delta' && typeof evt.text === 'string') {
            assistantText += evt.text;
            // Mid-stream visibility: keep lastResult fresh so a parent
            // calling WaitAgent during a long generation sees what the
            // child is currently saying, not stale text from the prior
            // turn.
            agent.lastResult = capTail(assistantText, LAST_RESULT_MAX_CHARS);
            agent.partial_output = agent.lastResult;
          }
          if (evt && evt.type === 'usage') {
            const cacheTokens = evt.cacheTokensAreIncludedInInput ? 0
              : (evt.cacheReadTokens || 0) + (evt.cacheWriteTokens || 0);
            turnUsageTokens += (evt.inputTokens || 0) + (evt.outputTokens || 0) + cacheTokens;
            agent.usage.tokens = priorUsageTokens + turnUsageTokens;
            if (agent.budget?.max_tokens && agent.usage.tokens >= agent.budget.max_tokens) {
              stopForBudget(agent, `max_tokens (${agent.budget.max_tokens}) reached`);
            }
          }
          if (evt && evt.type === 'error' && evt.error) {
            streamError = evt.error.message || String(evt.error);
          }
          if (evt && evt.type === 'stop') {
            if (evt.stopReason === 'end_turn' || evt.stopReason === 'stop_sequence') {
              endedNormally = true;
            }
          }
        }
      } catch (err) {
        if (!agent.budgetStopReason) {
          transitionTerminal(agent, STATUS.FAILED, {
            error: err && err.message ? err.message : String(err),
            diagnostic: 'query_error',
            deps,
          });
          return;
        }
      }

      if (agent.budgetStopReason) {
        agent.result = buildWallTimeBudgetResult(agent, agent.budgetStopReason);
        transitionTerminal(agent, STATUS.COMPLETED, {
          error: agent.budgetStopReason, diagnostic: 'execution_budget', deps,
        });
        return;
      }

      if (streamError) {
        transitionTerminal(agent, STATUS.FAILED, {
          error: streamError,
          diagnostic: 'stream_error',
          deps,
        });
        return;
      }

      if (isTerminalAgentStatus(agent.status)) {
        return;
      }

      // Persist the turn into the local message buffer so subsequent
      // PromptAgent continuations see context.
      agent.engineMessages.push({ role: 'user', content: queuedPrompt.prompt });
      if (assistantText) {
        agent.engineMessages.push({ role: 'assistant', content: assistantText });
      }
      agent.lastResult = capTail(assistantText, LAST_RESULT_MAX_CHARS);
      agent.result = assistantText;
      // NB: agent.usage.turns is incremented by tickAgent below — do NOT
      // bump it here too or every turn would double-count and trip
      // max_turns budgets at half the configured limit.

      if (!endedNormally) {
        transitionTerminal(agent, STATUS.FAILED, {
          error: agent.error || 'sub-agent stream ended without end_turn',
          diagnostic: 'no_end_turn',
          deps,
        });
        return;
      }

      // Budget enforcement: tickAgent will flip the agent to 'completed'
      // with a budget_exceeded envelope if any explicit budget bound was
      // tripped. The driver respects that and exits cleanly. We
      // dynamically import to avoid the agent.js↔runner.js cycle.
      let tickResult = null;
      try {
        const tickAgent = await loadTickAgent();
        if (typeof tickAgent === 'function') {
          const textTokenDelta = Math.max(0, (agent.liveness?.tokenCount || 0) - turnTokenStart);
          const tokenDelta = turnUsageTokens > 0 ? turnUsageTokens : textTokenDelta;
          // Usage events are exposed live; tickAgent adds the turn delta once.
          agent.usage.tokens = priorUsageTokens;
          tickResult = tickAgent(agent.id, {
            turns: 1,
            tokens: tokenDelta,
            partial_output: assistantText,
          });
        }
      } catch { /* budget enforcement is best-effort */ }
      if (tickResult) {
        // tickAgent already flipped status to 'completed' and aborted
        // the signal. Still want a terminal-status event + notification.
        finalizeTerminal(agent, STATUS.COMPLETED, { error: null, deps });
        return;
      }

      // Turn complete cleanly. Task-backed sub-agents are usually one-shot
      // background tasks: once they produce their mission result, complete
      // the agent/task instead of letting the idle watchdog later mark the
      // already-delivered work as abandoned. If the user queued a follow-up
      // while the turn was running, keep the driver alive and immediately
      // continue into the next prompt instead of dropping that input.
      const hasQueuedFollowUp = Array.isArray(agent.pendingPrompts) && agent.pendingPrompts.length > 0;
      if (agent.taskId && deps.taskManager && agent.parentSessionId && !hasQueuedFollowUp) {
        transitionTerminal(agent, STATUS.COMPLETED, {
          diagnostic: 'task_turn_complete',
          deps,
        });
        emit({ type: 'sub_agent_turn_end', content: assistantText, status: STATUS.COMPLETED });
        return;
      }
      emit({ type: 'sub_agent_turn_end', content: assistantText, status: hasQueuedFollowUp ? STATUS.RUNNING : STATUS.IDLE });
    }
  } finally {
    if (wallTimeWatchdog) clearTimeout(wallTimeWatchdog);
    // Always clean up driver-owned resources. We intentionally do NOT
    // unset agent.result / agent.lastResult / agent.liveness / agent.
    // outputFile — those are observable by the parent after termination.
    try { agent.outputLog?.close(); } catch { /* ignore */ }
    agent.subEngine = null;
    agent.__driverStarted = false;
    agent.idleSince = null;
  }
}

/**
 * Flip an agent to a terminal status, emit the matching status event,
 * mirror to the log, and enqueue a re-entry notification for the
 * parent. Idempotent — if status is already terminal we no-op.
 *
 * @param {object} agent
 * @param {string} status
 * @param {{ error?: string|null, diagnostic?: string, deps?: object }} opts
 */
function transitionTerminal(agent, status, opts = {}) {
  if (isTerminalAgentStatus(agent.status)) return;
  agent.status = status;
  if (opts.error) agent.error = opts.error;
  agent.diagnostics = agent.diagnostics || [];
  agent.diagnostics.push({ type: opts.diagnostic || `transition_${status}`, error: opts.error || null, at: Date.now() });
  finalizeTerminal(agent, status, { error: opts.error || null, deps: opts.deps });
}

/**
 * Emit the terminal status event, write it to the log, enqueue a
 * notification for the parent. Split out from transitionTerminal so
 * tickAgent's external status flip (it sets 'completed' itself) can
 * still go through the same notification path.
 */
function finalizeTerminal(agent, status, { error, deps } = {}) {
  // Mark notified-once to avoid double notifications if both tickAgent
  // and the driver loop converge on the same terminal transition.
  if (agent.__terminalNotified) return;
  agent.__terminalNotified = true;

  const evt = {
    type: 'sub_agent_status',
    agentId: agent.id,
    agentName: agent.name,
    status,
    error: error || agent.error || null,
    parentSessionId: agent.parentSessionId || deps?.parentSessionId || null,
    parentVpId: agent.parentVpId || deps?.parentVpId || null,
    parentThreadId: agent.parentThreadId || deps?.parentThreadId || 'main',
  };
  try { agent.outputLog?.write(evt); } catch { /* ignore */ }
  if (agent.taskId && deps?.taskManager && agent.parentSessionId) {
    const budgetExceeded = agent.result?.status === 'budget_exceeded';
    const taskStatus = budgetExceeded ? 'failed' : status === STATUS.COMPLETED ? 'succeeded'
      : status === STATUS.CLOSED ? 'cancelled'
        : 'failed';
    try {
      deps.taskManager.completeTask(agent.parentSessionId, agent.taskId, {
        status: taskStatus,
        error: budgetExceeded ? agent.result.reason : (error || agent.error || null),
        summary: budgetExceeded ? JSON.stringify(agent.result) : status === STATUS.COMPLETED
          ? (typeof agent.result === 'string' ? agent.result : (agent.lastResult || null))
          : null,
      });
    } catch { /* ignore */ }
  }
  if (deps && typeof deps.onEvent === 'function') {
    try { deps.onEvent(agent.id, evt); } catch { /* ignore */ }
  }

  // Push the legacy sub-agent notification so the parent learns about this
  // even if it forgot to call WaitAgent. Task-backed sub-agents use the
  // generic TaskManager async tool-result re-entry instead; queueing both
  // would make the owner VP see duplicate results.
  try { consumeNotificationForAgent(agent.id); } catch { /* ignore */ }
  const taskBacked = !!(agent.taskId && deps?.taskManager && agent.parentSessionId);
  if (!taskBacked) {
    try {
      const budgetResult = agent.result && typeof agent.result === 'object'
        && agent.result.status === 'budget_exceeded'
        ? agent.result
        : null;
      enqueueTerminalNotification({
        agentId: agent.id,
        agentName: agent.name,
        status,
        result: budgetResult
          ? (budgetResult.partial_output || '')
          : (typeof agent.result === 'string' ? agent.result : (agent.lastResult || '')),
        error: error || agent.error || null,
        outputFile: agent.outputFile || null,
        turns: agent.usage?.turns || 0,
        parentVpId: agent.parentVpId || null,
        parentSessionId: agent.parentSessionId || null,
        parentThreadId: agent.parentThreadId || 'main',
        budgetExceeded: !!budgetResult,
        budgetReason: budgetResult?.reason || null,
        budgetUsage: budgetResult?.usage || null,
      });
    } catch { /* never let the notification queue throw kill the driver */ }
  }
}

/**
 * Resume signal — resolves with a string reason:
 *   - 'prompt'     : pendingPrompts non-empty (PromptAgent fired)
 *   - 'terminal'   : agent status flipped to terminal externally
 *   - 'abandoned'  : idle timer expired
 *
 * @param {object} agent
 * @param {number} idleAbandonMs
 * @returns {Promise<'prompt'|'terminal'|'abandoned'>}
 */
function waitUntilResumed(agent, idleAbandonMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (isTerminalAgentStatus(agent.status)) {
        return resolve('terminal');
      }
      if (Array.isArray(agent.pendingPrompts) && agent.pendingPrompts.length > 0) {
        return resolve('prompt');
      }
      if (idleAbandonMs > 0 && Date.now() - start >= idleAbandonMs) {
        return resolve('abandoned');
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * Cap a tailing string to N chars while keeping the most recent content.
 * Used for agent.lastResult so a runaway model can't OOM the registry.
 */
function capTail(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  return '…' + text.slice(text.length - maxChars);
}

export const _internals = { IDLE_ABANDON_MS, LAST_RESULT_MAX_CHARS };
