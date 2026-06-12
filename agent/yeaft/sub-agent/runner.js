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
import { ToolRegistry } from '../tools/registry.js';
import { buildSpawnedPreamble } from './spawned-prompt.js';
import { STATUS, isTerminalAgentStatus } from './status.js';
import { createOutputLog } from './output-log.js';
import { makeLiveness, bumpLivenessFromEvent } from './liveness.js';
import { enqueueTerminalNotification } from './notifications.js';
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
export function buildChildToolRegistry(parentRegistry) {
  const child = new ToolRegistry();
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
 *   memoryStore?: object,
 *   memoryShardStore?: object,
 *   parentToolRegistry?: ToolRegistry,
 *   skillManager?: object,
 *   mcpManager?: object,
 *   yeaftDir?: string,
 *   parentName?: string,
 *   parentVpId?: string,
 *   parentSessionId?: string|null,
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

  // Build sub-engine wired to the parent's adapter/stores/config but with
  // a restricted toolset. We DO NOT pass a conversationStore: sub-agent
  // turns must not pollute the user-facing conversation history. The
  // memory stores are shared so memory recall still works for the
  // sub-agent (matches parent VP persona memory).
  const childRegistry = buildChildToolRegistry(deps.parentToolRegistry);
  const subEngine = new Engine({
    adapter: deps.adapter,
    trace: deps.trace,
    config: { ...deps.config, _readOnly: true },
    conversationStore: null,
    memoryStore: deps.memoryStore || null,
    memoryShardStore: deps.memoryShardStore || null,
    toolRegistry: childRegistry,
    skillManager: deps.skillManager || null,
    mcpManager: deps.mcpManager || null,
    yeaftDir: deps.yeaftDir || null,
    toolStats: deps.toolStats || null,
  });

  agent.subEngine = subEngine;
  agent.engineMessages = agent.engineMessages || [];
  agent.liveness = agent.liveness || makeLiveness();
  agent.parentVpId = deps.parentVpId || null;
  agent.parentSessionId = deps.parentSessionId || null;
  agent.parentThreadId = deps.parentThreadId || 'main';
  agent.outputLog = createOutputLog(agent.id, deps.subAgentLogDir);
  agent.outputFile = agent.outputLog.path;
  agent.outputLog.write({ type: 'sub_agent_spawned', agentId: agent.id, agentName: agent.name, mission: agent.mission || agent.task || '' });

  // Compose the system-prompt-overlay we want injected.
  const preamble = buildSpawnedPreamble({
    parentName: deps.parentName || 'parent',
    parentVpId: deps.parentVpId || null,
    agentName: agent.name,
    mission: agent.mission || agent.task || '',
    language: deps.language || deps.config?.language || 'en',
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
async function driveSubAgent(agent, subEngine, vpPersona, deps) {
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null;
  const idleAbandonMs = typeof deps.idleAbandonMs === 'number' && deps.idleAbandonMs > 0
    ? deps.idleAbandonMs : IDLE_ABANDON_MS;

  const wrapEvt = (evt) => ({ ...evt, agentId: agent.id, agentName: agent.name });

  const emit = (evt) => {
    const wrapped = wrapEvt(evt);
    try { agent.outputLog?.write(wrapped); } catch { /* ignore log failures */ }
    if (onEvent) {
      try { onEvent(agent.id, wrapped); } catch { /* ignore listener errors */ }
    }
  };

  const dequeueNextUserPrompt = () => {
    if (!Array.isArray(agent.pendingPrompts)) agent.pendingPrompts = [];
    return agent.pendingPrompts.shift() || null;
  };

  try {
    // Seed: mission becomes the first user prompt.
    if (!agent.pendingPrompts) agent.pendingPrompts = [];
    if (agent.mission && !agent.__missionSeeded) {
      agent.pendingPrompts.push(agent.mission);
      agent.__missionSeeded = true;
    }

    agent.status = STATUS.RUNNING;
    emit({ type: 'sub_agent_status', status: STATUS.RUNNING });

    while (!isTerminalAgentStatus(agent.status)) {
      const prompt = dequeueNextUserPrompt();
      if (!prompt) {
        // No queued work — go idle and wait for PromptAgent / CloseAgent /
        // watchdog.
        agent.status = STATUS.IDLE;
        agent.idleSince = Date.now();
        emit({ type: 'sub_agent_status', status: STATUS.IDLE });

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

      let assistantText = '';
      let endedNormally = false;
      let streamError = null;
      const turnTokenStart = agent.liveness?.tokenCount || 0;
      let turnUsageTokens = 0;
      try {
        const stream = subEngine.query({
          prompt,
          messages: agent.engineMessages,
          signal: agent.abortController?.signal,
          scenario: 'chat',
          vpPersona,
        });
        for await (const evt of stream) {
          // Liveness — update first so even listener throws don't lose
          // the bump.
          bumpLivenessFromEvent(agent.liveness, evt);

          // Mirror to log + UI sink.
          if (agent.outputLog) {
            try { agent.outputLog.write(wrapEvt(evt)); } catch { /* ignore */ }
          }
          if (onEvent) {
            try { onEvent(agent.id, wrapEvt(evt)); } catch { /* ignore listener errors */ }
          }

          if (evt && evt.type === 'text_delta' && typeof evt.text === 'string') {
            assistantText += evt.text;
            // Mid-stream visibility: keep lastResult fresh so a parent
            // calling WaitAgent during a long generation sees what the
            // child is currently saying, not stale text from the prior
            // turn.
            agent.lastResult = capTail(assistantText, LAST_RESULT_MAX_CHARS);
          }
          if (evt && evt.type === 'usage') {
            turnUsageTokens += (evt.inputTokens || 0) + (evt.outputTokens || 0);
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
        transitionTerminal(agent, STATUS.FAILED, {
          error: err && err.message ? err.message : String(err),
          diagnostic: 'query_error',
          deps,
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
      agent.engineMessages.push({ role: 'user', content: prompt });
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

      // Turn complete cleanly. Stash the result for WaitAgent and emit
      // a turn-end event for the UI. Loop re-enters: if more
      // pendingPrompts queued by PromptAgent, run the next; else idle.
      emit({ type: 'sub_agent_turn_end', content: assistantText });
    }
  } finally {
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
  };
  try { agent.outputLog?.write(evt); } catch { /* ignore */ }
  if (deps && typeof deps.onEvent === 'function') {
    try { deps.onEvent(agent.id, evt); } catch { /* ignore */ }
  }

  // Push the re-entry notification so the parent learns about this
  // even if it forgot to call WaitAgent.
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
