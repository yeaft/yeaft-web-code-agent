import {
  boundedText,
  clampConfidence,
  composeDecisionSystemPrompt,
} from './shared.js';

const VALID_DECISIONS = new Set(['match', 'create']);
export const ROUTE_RECENT_SESSION_SCENARIO_ID = 'route-recent-session';
export const DEFAULT_RECENT_MATCH_MIN_CONFIDENCE = 0.75;

export const ROUTE_RECENT_SESSION_PROMPT = composeDecisionSystemPrompt(`You decide whether a new Sessionless user message should continue one of the user's recent idle Sessions (active within the last 5 days) or start a brand-new Session.

Wrongly merging an unrelated topic into an old Session pollutes the context with stale history and the wrong working directory. Starting a new Session when uncertain is cheap because cross-Session history search can still retrieve prior facts.

Return JSON only:
{"decision":"match|create","sessionId":"string|null","confidence":0.0,"searchKeywords":["kw1","kw2"],"reason":"brief debug reason"}

Decision rules:
- Choose "match" ONLY when the message clearly continues the same ongoing task, thread of thought, or explicit pronoun/follow-up reference ("that PR", "the bug we just fixed", "make it shorter") of one candidate Session.
- Sharing only a broad domain (e.g. two separate Python questions or two unrelated coding tasks in the same repo) is NOT enough to merge into a long finished Session — choose "create" unless the user is continuing the specific conversation/task.
- When decision is "create", provide up to 3 concise searchKeywords (nouns, project/module names, or topic terms from newQuery) so older history outside the 5-day window can be looked up if helpful; use [] if none apply.
- sessionId must be an exact sessionId from candidateSessions when decision is "match", or null when "create".
- confidence must be a number between 0 and 1.`);

export function buildRouteRecentSessionUserPrompt({ candidateSessions = [], newQuery = '' } = {}) {
  const payload = {
    candidateSessions: (candidateSessions || []).slice(0, 12).map(item => ({
      sessionId: boundedText(item?.sessionId || '', 160),
      title: boundedText(item?.title || '', 200),
      sceneId: boundedText(item?.sceneId || '', 64),
      workDir: boundedText(item?.workDir || '', 320),
      activeAt: item?.activeAt || null,
      preview: boundedText(item?.preview || '', 400),
      recentMessages: Array.isArray(item?.recentMessages)
        ? item.recentMessages.slice(-4).map(m => ({
          role: boundedText(m?.role || '', 24),
          text: boundedText(m?.text ?? m?.content ?? '', 500),
        }))
        : undefined,
    })),
    newQuery: boundedText(newQuery, 2000),
  };
  return JSON.stringify(payload, null, 2);
}

function sanitizeKeywords(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const kw = boundedText(typeof entry === 'string' ? entry : '', 48);
    if (!kw) continue;
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= 3) break;
  }
  return out;
}

export function fallbackRouteRecentSession(_input = {}, reason = 'fallback') {
  return {
    decision: 'create',
    sessionId: null,
    confidence: 0,
    searchKeywords: [],
    reason,
  };
}

export function validateRouteRecentSessionOutput(parsed, {
  candidateSessions = [],
  minConfidence = DEFAULT_RECENT_MATCH_MIN_CONFIDENCE,
} = {}) {
  if (!parsed) return null;
  const decision = VALID_DECISIONS.has(parsed.decision) ? parsed.decision : null;
  if (!decision) return null;

  const allowed = new Set((candidateSessions || []).map(s => s?.sessionId).filter(Boolean));
  const confidence = clampConfidence(parsed.confidence, decision === 'match' ? 0.8 : 0);
  const searchKeywords = sanitizeKeywords(parsed.searchKeywords);
  const reason = boundedText(parsed.reason || '', 400);

  if (decision === 'match') {
    const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '';
    if (!sessionId || !allowed.has(sessionId)) {
      return {
        decision: 'create',
        sessionId: null,
        confidence: 0,
        searchKeywords,
        reason: reason || 'invalid_session_id',
      };
    }
    if (confidence < minConfidence) {
      return {
        decision: 'create',
        sessionId: null,
        confidence,
        searchKeywords,
        reason: reason || 'low_confidence',
      };
    }
    return {
      decision: 'match',
      sessionId,
      confidence,
      searchKeywords: [],
      reason,
    };
  }

  return {
    decision: 'create',
    sessionId: null,
    confidence,
    searchKeywords,
    reason,
  };
}

export const routeRecentSessionScenario = Object.freeze({
  id: ROUTE_RECENT_SESSION_SCENARIO_ID,
  maxTokens: 256,
  defaultTimeoutMs: 3_500,
  buildSystemPrompt: () => ROUTE_RECENT_SESSION_PROMPT,
  buildUserPrompt: buildRouteRecentSessionUserPrompt,
  validate: validateRouteRecentSessionOutput,
  fallback: fallbackRouteRecentSession,
});
