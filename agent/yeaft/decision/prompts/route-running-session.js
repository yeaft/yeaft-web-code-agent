import {
  boundedText,
  clampConfidence,
  composeDecisionSystemPrompt,
} from './shared.js';

const VALID_DECISIONS = new Set(['match', 'none']);
export const ROUTE_RUNNING_SESSION_SCENARIO_ID = 'route-running-session';
export const DEFAULT_RUNNING_MATCH_MIN_CONFIDENCE = 0.7;

export const ROUTE_RUNNING_SESSION_PROMPT = composeDecisionSystemPrompt(`You decide whether a new Sessionless user message belongs to one of the user's CURRENTLY RUNNING Sessions (including Sessions waiting on an AskUser prompt), or to NONE of them.

Running Sessions have highest contextual priority, but users frequently ask a brand-new or unrelated question while a long task is running in the background. Wrongly injecting an unrelated message into a running Session contaminates active work, so be conservative.

Return JSON only:
{"decision":"match|none","sessionId":"string|null","answeredRequestId":"string|null","confidence":0.0,"reason":"brief debug reason"}

Decision rules:
- Choose "match" ONLY when the user message clearly answers a pending question, provides follow-up instructions, corrects, or directly refers to one specific running Session's recent messages or active task.
- If a running Session has pendingQuestions and the user message directly answers one specific pending question (e.g. choosing an option, confirming yes/no, supplying the requested value), set answeredRequestId to that question's exact requestId; if the message is a side instruction, correction, or supplement that does NOT directly answer a pending question, set answeredRequestId to null.
- Choose "none" when the message is about a different project, a separate question, general chat, or when it is ambiguous which Session is meant.
- Never force a match just because only one Session is running.
- sessionId must be an exact sessionId from runningSessions when decision is "match", or null when "none".
- confidence must be a number between 0 and 1.`);

export function buildRouteRunningSessionUserPrompt({ runningSessions = [], newQuery = '' } = {}) {
  const payload = {
    runningSessions: (runningSessions || []).slice(0, 12).map(item => {
      const rawQuestions = Array.isArray(item?.pendingQuestions)
        ? item.pendingQuestions
        : (item?.pendingQuestion ? [item.pendingQuestion] : []);
      const pendingQuestions = rawQuestions.slice(0, 6).map(pq => ({
        ...(pq?.requestId ? { requestId: boundedText(pq.requestId, 160) } : {}),
        question: boundedText(pq?.question || '', 600),
        options: Array.isArray(pq?.options)
          ? pq.options.slice(0, 8).map(opt => boundedText(String(opt), 160))
          : [],
      })).filter(pq => pq.question);
      return {
        sessionId: boundedText(item?.sessionId || '', 160),
        title: boundedText(item?.title || '', 200),
        sceneId: boundedText(item?.sceneId || '', 64),
        workDir: boundedText(item?.workDir || '', 320),
        state: boundedText(item?.state || 'running', 40),
        ...(pendingQuestions.length ? { pendingQuestions } : {}),
        recentMessages: Array.isArray(item?.recentMessages)
          ? item.recentMessages.slice(-6).map(m => ({
            role: boundedText(m?.role || '', 24),
            text: boundedText(m?.text ?? m?.content ?? '', 600),
          }))
          : [],
      };
    }),
    newQuery: boundedText(newQuery, 2000),
  };
  return JSON.stringify(payload, null, 2);
}

export function fallbackRouteRunningSession(_input = {}, reason = 'fallback') {
  // Never blindly inject into a running cross-Session turn when uncertain.
  return {
    decision: 'none',
    sessionId: null,
    answeredRequestId: null,
    confidence: 0,
    reason,
  };
}

export function validateRouteRunningSessionOutput(parsed, {
  runningSessions = [],
  minConfidence = DEFAULT_RUNNING_MATCH_MIN_CONFIDENCE,
} = {}) {
  if (!parsed) return null;
  const decision = VALID_DECISIONS.has(parsed.decision) ? parsed.decision : null;
  if (!decision) return null;

  const sessionMap = new Map();
  for (const s of runningSessions || []) {
    const sid = boundedText(s?.sessionId || '', 160);
    if (!sid) continue;
    const rawQs = Array.isArray(s?.pendingQuestions)
      ? s.pendingQuestions
      : (s?.pendingQuestion ? [s.pendingQuestion] : []);
    const reqIds = new Set(rawQs.map(q => boundedText(q?.requestId || '', 160)).filter(Boolean));
    sessionMap.set(sid, reqIds);
  }
  const confidence = clampConfidence(parsed.confidence, decision === 'match' ? 0.8 : 0);
  const reason = boundedText(parsed.reason || '', 400);

  if (decision === 'match') {
    const sessionId = boundedText(parsed.sessionId || '', 160);
    if (!sessionId || !sessionMap.has(sessionId)) {
      return { decision: 'none', sessionId: null, answeredRequestId: null, confidence: 0, reason: reason || 'invalid_session_id' };
    }
    if (confidence < minConfidence) {
      return { decision: 'none', sessionId: null, answeredRequestId: null, confidence, reason: reason || 'low_confidence' };
    }
    const rawReqId = boundedText(parsed.answeredRequestId || '', 160);
    const validReqIds = sessionMap.get(sessionId);
    const answeredRequestId = rawReqId && validReqIds.has(rawReqId) ? rawReqId : null;
    return { decision: 'match', sessionId, answeredRequestId, confidence, reason };
  }

  return {
    decision: 'none',
    sessionId: null,
    answeredRequestId: null,
    confidence,
    reason,
  };
}

export const routeRunningSessionScenario = Object.freeze({
  id: ROUTE_RUNNING_SESSION_SCENARIO_ID,
  maxTokens: 240,
  defaultTimeoutMs: 3_500,
  buildSystemPrompt: () => ROUTE_RUNNING_SESSION_PROMPT,
  buildUserPrompt: buildRouteRunningSessionUserPrompt,
  validate: validateRouteRunningSessionOutput,
  fallback: fallbackRouteRunningSession,
});
