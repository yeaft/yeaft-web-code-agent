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
 *   tokenCount: number,
 *   eventCount: number,
 *   lastEventAt: number,
 *   lastEventType: string|null,
 *   recentTools: string[],
 * }}
 */
export function makeLiveness() {
  return {
    toolUseCount: 0,
    tokenCount: 0,
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
    // Coarse "have we produced output" signal. Token count is not exact —
    // it's character-based — but it lets the parent see "yes, the model
    // is generating".
    liveness.tokenCount += evt.text.length;
  } else if (evt.type === 'tool_start' || evt.type === 'tool_call') {
    liveness.toolUseCount += 1;
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
      tokenCount: 0,
      eventCount: 0,
      lastEventAt: null,
      msSinceLastEvent: null,
      lastEventType: null,
      recentTools: [],
    };
  }
  return {
    toolUseCount: liveness.toolUseCount,
    tokenCount: liveness.tokenCount,
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
  const activityAt = liveness.lastEventAt || fallbackAt;
  const msSinceActivity = activityAt ? Math.max(0, now - activityAt) : null;
  const stale = agent?.status === 'running'
    && msSinceActivity !== null
    && msSinceActivity >= thresholdMs;
  return {
    ...liveness,
    msSinceLastEvent: liveness.msSinceLastEvent ?? msSinceActivity,
    stale,
    stalled: stale,
    stallThresholdMs: thresholdMs,
    diagnostic: stale
      ? `No sub-agent activity for ${msSinceActivity}ms; treat it as stalled instead of waiting in a loop.`
      : null,
  };
}
