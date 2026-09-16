/**
 * liveness.js — "Is this sub-agent alive or hung?" helpers.
 *
 * Yeaft's original wait_agent payload told the parent essentially nothing
 * mid-flight: just `{ status, result: '' }`. The model couldn't tell
 * "still thinking" from "stuck on a slow tool" from "actually wedged".
 *
 * Liveness is a tiny counter struct we update from the runner whenever a
 * sub-engine event passes through. wait_agent and list_agents include
 * it in their JSON payloads so the parent gets a clear visible signal
 * that the child is doing work, plus a timestamp it can compare against
 * Date.now() to compute "seconds since last activity".
 *
 * The struct lives on the agent record as `agent.liveness`. We never
 * delete the field — even on terminal status the last snapshot is
 * preserved so the parent can see "you ran 7 tools and last spoke 3
 * seconds before completing".
 */

/**
 * Create a fresh liveness record.
 *
 * @returns {{
 *   toolUseCount: number,
 *   usageTokens: number,
 *   outputChars: number,
 *   eventCount: number,
 *   lastEventAt: number,
 *   lastEventType: string|null,
 *   recentTools: string[],
 * }}
 */
export function makeLiveness() {
  return {
    toolUseCount: 0,
    usageTokens: 0,
    outputChars: 0,
    eventCount: 0,
    lastEventAt: 0,
    lastEventType: null,
    recentTools: [],
  };
}

const RECENT_TOOLS_MAX = 5;

/**
 * Update a liveness record from a sub-engine event.
 *
 * @param {ReturnType<typeof makeLiveness>} liveness
 * @param {object} evt
 */
export function bumpLivenessFromEvent(liveness, evt) {
  if (!liveness || !evt || typeof evt !== 'object') return;
  liveness.eventCount += 1;
  liveness.lastEventAt = Date.now();
  liveness.lastEventType = evt.type || liveness.lastEventType;
  if (evt.type === 'text_delta' && typeof evt.text === 'string') {
    // This is explicitly output volume, never represented as provider tokens.
    liveness.outputChars += evt.text.length;
  } else if (evt.type === 'usage') {
    const cacheTokens = evt.cacheTokensAreIncludedInInput ? 0
      : (evt.cacheReadTokens || 0) + (evt.cacheWriteTokens || 0);
    liveness.usageTokens += (evt.inputTokens || 0) + (evt.outputTokens || 0) + cacheTokens;
  } else if (evt.type === 'tool_start') {
    // Keep the bounded activity trail here. Actual executions are counted at
    // SubAgentToolRegistry.execute(), then copied into liveness by the runner.
    const name = evt.toolName || evt.name || (evt.tool && evt.tool.name) || null;
    if (name) {
      liveness.recentTools.push(name);
      if (liveness.recentTools.length > RECENT_TOOLS_MAX) {
        liveness.recentTools.splice(0, liveness.recentTools.length - RECENT_TOOLS_MAX);
      }
    }
  }
}

/**
 * Render a small JSON object suitable for embedding inside a wait_agent /
 * list_agents reply. Keeps the public field names stable and bounded.
 *
 * @param {ReturnType<typeof makeLiveness>|null|undefined} liveness
 * @param {number} [now=Date.now()]
 */
export function snapshotLiveness(liveness, now = Date.now()) {
  if (!liveness) {
    return {
      toolUseCount: 0,
      usageTokens: 0,
      outputChars: 0,
      eventCount: 0,
      lastEventAt: null,
      msSinceLastEvent: null,
      lastEventType: null,
      recentTools: [],
    };
  }
  return {
    toolUseCount: liveness.toolUseCount,
    usageTokens: liveness.usageTokens,
    outputChars: liveness.outputChars,
    eventCount: liveness.eventCount,
    lastEventAt: liveness.lastEventAt || null,
    msSinceLastEvent: liveness.lastEventAt ? Math.max(0, now - liveness.lastEventAt) : null,
    lastEventType: liveness.lastEventType,
    recentTools: liveness.recentTools.slice(),
  };
}

export const DEFAULT_STALL_THRESHOLD_MS = 120000;

/**
 * Add a stable "is this likely stuck?" diagnostic to a liveness snapshot.
 * If no event has ever arrived, fall back to createdAt / usage.startedAt so
 * a silent running child can still become stale.
 *
 * @param {object} agent
 * @param {{ now?: number, thresholdMs?: number }} [opts]
 */
export function diagnoseAgentLiveness(agent, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const thresholdMs = typeof opts.thresholdMs === 'number' && opts.thresholdMs > 0
    ? opts.thresholdMs
    : DEFAULT_STALL_THRESHOLD_MS;
  const liveness = snapshotLiveness(agent?.liveness, now);
  const fallbackAt = agent?.createdAt || agent?.usage?.startedAt || null;
  // Queueing a PromptAgent continuation starts a new collection window. Do not
  // diagnose that fresh follow-up as stale merely because the retained child
  // last emitted an event during an older turn.
  const activityAt = Math.max(
    liveness.lastEventAt || 0,
    fallbackAt || 0,
    agent?.promptReplyPendingAt || 0,
  ) || null;
  const msSinceActivity = activityAt ? Math.max(0, now - activityAt) : null;
  const stale = agent?.status === 'running'
    && msSinceActivity !== null
    && msSinceActivity >= thresholdMs;
  return {
    ...liveness,
    execution: agent?.execution ? {
      ...agent.execution,
      recentCalls: agent.execution.recentCalls.map(call => ({ ...call })),
      remainingToolCalls: agent.budget?.max_tool_calls === undefined ? null
        : Math.max(0, agent.budget.max_tool_calls - agent.execution.toolCalls),
      limits: { ...agent.budget },
      llmCalls: agent.usage?.llmCalls || 0,
      reportingLlmCalls: agent.usage?.reportingLlmCalls || 0,
      remainingLlmCalls: agent.budget?.max_llm_calls === undefined ? null
        : Math.max(0, agent.budget.max_llm_calls - (agent.usage?.llmCalls || 0)),
      remainingWallTimeMs: agent.budget?.wall_time_ms === undefined ? null
        : Math.max(0, agent.budget.wall_time_ms - (now - (agent.usage?.startedAt || now))),
      allowTools: [...(agent.allowTools || [])],
      controlRevision: agent.controlRevision || 0,
      progressNote: 'Execution counts and repeated results are diagnostics, not proof of semantic progress or stalling.',
    } : null,
    msSinceLastEvent: liveness.msSinceLastEvent ?? msSinceActivity,
    stale,
    stalled: stale,
    stallThresholdMs: thresholdMs,
    diagnostic: stale
      ? `No observable sub-agent event for ${msSinceActivity}ms. This is diagnostic only: the provider or tool may still be working; inspect the log before deciding whether to cancel.`
      : null,
  };
}
