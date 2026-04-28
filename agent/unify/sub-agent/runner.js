/**
 * runner.js — Sub-agent execution driver.
 *
 * Lifecycle (per agent record in the global registry from `tools/agent.js`):
 *
 *   created → running → idle (mission turn finished, awaiting parent feedback)
 *           ↘                ↘
 *            failed          → running again (on SendMessage)
 *           ↘                ↘
 *            closed          completed (terminal — set by CloseAgent or last end_turn)
 *
 * Each sub-agent owns:
 *   - its own Engine instance (shares parent adapter/trace/config/stores)
 *   - its own ToolRegistry: parent's minus [Agent, SendMessage, WaitAgent,
 *     CloseAgent, ListAgents, RouteForward, AskUser]
 *   - its own messages buffer (`agent.engineMessages`) so a turn can resume
 *     after SendMessage
 *
 * The runner is fire-and-forget: `startSubAgent(agent, deps)` schedules a
 * microtask that drives the loop and returns immediately. Parents observe
 * via `WaitAgent` (polls status) or via `deps.onEvent(agentId, evt)`
 * which is invoked for every sub-engine event for live UI streaming.
 *
 * Errors are caught; the agent is marked `failed` with `error` set, and
 * resolved through `WaitAgent` per the option-A protocol (parent decides
 * how to react).
 */

import { Engine } from '../engine.js';
import { ToolRegistry } from '../tools/registry.js';
import { buildSpawnedPreamble } from './spawned-prompt.js';

const RESTRICTED_TOOLS = new Set([
  'Agent',
  'SendMessage',
  'WaitAgent',
  'CloseAgent',
  'ListAgents',
  'RouteForward',
  'AskUser',
]);

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
 * (status, result, error, engineMessages, abortController).
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
 *   parentVpPersona?: object,
 *   onEvent?: (agentId: string, evt: object) => void,
 *   language?: 'en'|'zh',
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
  });

  agent.subEngine = subEngine;
  agent.engineMessages = agent.engineMessages || [];

  // Compose the system-prompt-overlay we want injected. We piggyback on
  // the existing `vpPersona` parameter that #buildSystemPrompt threads
  // through to buildWorkerPrompt — appending our spawned-preamble at the
  // end of the persona block guarantees it lands inside Layer A and is
  // subject to the same persona caching guarantees.
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
  // Append the preamble onto whatever the parent persona body looked
  // like. If the parent had no persona, we still hand the LLM a clean
  // sub-agent identity block so it knows the scope.
  baseVpPersona.persona =
    [(baseVpPersona.persona || '').trim(), preamble.trim()]
      .filter(Boolean)
      .join('\n\n');
  // renderVpPersona requires a displayName to emit the persona block.
  // If the parent did not provide one, synthesize one from agent name
  // so the spawned-preamble actually surfaces in the system prompt.
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
  // turn by turn until status flips to closed/completed/failed.
  driveSubAgent(agent, subEngine, baseVpPersona, deps).catch((err) => {
    if (agent.status === 'closed' || agent.status === 'completed') return;
    agent.status = 'failed';
    agent.error = err && err.message ? err.message : String(err);
    agent.diagnostics.push({ type: 'driver_error', error: agent.error, at: Date.now() });
    if (typeof deps.onEvent === 'function') {
      try { deps.onEvent(agent.id, { type: 'sub_agent_status', agentId: agent.id, status: 'failed', error: agent.error }); } catch { /* ignore */ }
    }
  });
}

/**
 * Drive one mission turn at a time. Each iteration:
 *   1. Pull the next pending user message from the queue (or, on first
 *      turn, the mission itself).
 *   2. Run engine.query, forwarding every event to deps.onEvent (tagged
 *      with agentId).
 *   3. Capture the final assistant text → agent.lastResult, mark idle.
 *   4. Wait for either a new SendMessage (status=='running' again) OR
 *      CloseAgent (status=='closed') OR the mission to be marked
 *      completed by parent.
 */
async function driveSubAgent(agent, subEngine, vpPersona, deps) {
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null;

  // Helper: append a user message and either start or resume.
  const dequeueNextUserPrompt = () => {
    if (!Array.isArray(agent.pendingPrompts)) agent.pendingPrompts = [];
    return agent.pendingPrompts.shift() || null;
  };

  // Seed: mission becomes the first user prompt.
  if (!agent.pendingPrompts) agent.pendingPrompts = [];
  if (agent.mission && !agent.__missionSeeded) {
    agent.pendingPrompts.push(agent.mission);
    agent.__missionSeeded = true;
  }

  agent.status = 'running';
  if (onEvent) {
    try { onEvent(agent.id, { type: 'sub_agent_status', agentId: agent.id, agentName: agent.name, status: 'running' }); } catch { /* ignore */ }
  }

  while (agent.status !== 'closed' && agent.status !== 'completed' && agent.status !== 'failed') {
    const prompt = dequeueNextUserPrompt();
    if (!prompt) {
      // Nothing to do — go idle and wait for SendMessage / CloseAgent.
      agent.status = 'idle';
      if (onEvent) {
        try { onEvent(agent.id, { type: 'sub_agent_status', agentId: agent.id, status: 'idle' }); } catch { /* ignore */ }
      }
      await waitUntilResumed(agent);
      // Either we have a new prompt now (back to running) or status is closed.
      if (agent.status === 'closed') break;
      agent.status = 'running';
      continue;
    }

    let assistantText = '';
    let endedNormally = false;
    let streamError = null;
    try {
      const stream = subEngine.query({
        prompt,
        messages: agent.engineMessages,
        signal: agent.abortController?.signal,
        scenario: 'chat',
        vpPersona,
      });
      for await (const evt of stream) {
        // Forward every sub-engine event to the parent observer with
        // the agent identity attached. Frontend renders these inside
        // the sub-agent's collapsed card.
        if (onEvent) {
          try { onEvent(agent.id, { ...evt, agentId: agent.id, agentName: agent.name }); } catch { /* ignore listener errors */ }
        }
        if (evt && evt.type === 'text_delta' && typeof evt.text === 'string') {
          assistantText += evt.text;
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
      agent.status = 'failed';
      agent.error = err && err.message ? err.message : String(err);
      agent.diagnostics.push({ type: 'query_error', error: agent.error, at: Date.now() });
      if (onEvent) {
        try { onEvent(agent.id, { type: 'sub_agent_status', agentId: agent.id, status: 'failed', error: agent.error }); } catch { /* ignore */ }
      }
      return;
    }

    if (streamError) {
      // Engine surfaced an error event (e.g. adapter failure) instead of
      // throwing — treat the same as a thrown error.
      agent.status = 'failed';
      agent.error = streamError;
      agent.diagnostics.push({ type: 'stream_error', error: streamError, at: Date.now() });
      if (onEvent) {
        try { onEvent(agent.id, { type: 'sub_agent_status', agentId: agent.id, status: 'failed', error: streamError }); } catch { /* ignore */ }
      }
      return;
    }

    // Persist the turn into the local message buffer so subsequent
    // SendMessage continuations see context.
    agent.engineMessages.push({ role: 'user', content: prompt });
    if (assistantText) {
      agent.engineMessages.push({ role: 'assistant', content: assistantText });
    }
    agent.lastResult = assistantText;
    agent.usage.turns = (agent.usage.turns || 0) + 1;

    if (!endedNormally) {
      // Adapter aborted/errored without end_turn — mark failed.
      agent.status = 'failed';
      agent.error = agent.error || 'sub-agent stream ended without end_turn';
      if (onEvent) {
        try { onEvent(agent.id, { type: 'sub_agent_status', agentId: agent.id, status: 'failed', error: agent.error }); } catch { /* ignore */ }
      }
      return;
    }

    // Turn complete. Stash the result for WaitAgent and emit a turn-end
    // event for the UI. Loop re-enters: if more pendingPrompts queued
    // by SendMessage, run the next; else go idle.
    agent.result = assistantText;
    if (onEvent) {
      try { onEvent(agent.id, { type: 'sub_agent_turn_end', agentId: agent.id, agentName: agent.name, content: assistantText }); } catch { /* ignore */ }
    }
  }
}

/**
 * Resume signal — resolves when:
 *   - a new prompt was pushed onto agent.pendingPrompts (SendMessage), OR
 *   - the agent was closed (CloseAgent / abort)
 *
 * This is a tight poll because sub-agent I/O is interactive and there
 * are at most a handful of these alive in a session.
 */
function waitUntilResumed(agent) {
  return new Promise((resolve) => {
    const tick = () => {
      if (agent.status === 'closed' || agent.status === 'completed' || agent.status === 'failed') {
        return resolve();
      }
      if (Array.isArray(agent.pendingPrompts) && agent.pendingPrompts.length > 0) {
        return resolve();
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}
