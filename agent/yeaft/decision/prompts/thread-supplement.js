import {
  boundedText,
  composeDecisionSystemPrompt,
  fallbackShortTitle,
} from './shared.js';

const VALID_DECISIONS = new Set(['related', 'unrelated']);

export const THREAD_SUPPLEMENT_SCENARIO_ID = 'thread-supplement';

export const THREAD_SUPPLEMENT_PROMPT = composeDecisionSystemPrompt(`You classify whether a new user message inside one Session supplements an already-running execution thread or starts a new parallel turn.
Running threads are active executions in the same Session; the user may either clarify/correct/append to one of them or ask an unrelated parallel question.

Return JSON only:
{"decision":"related|unrelated","targetThreadId":"string|null","title":"short title","reason":"brief debug reason"}

Decision rules:
- Choose "related" when the new query continues, clarifies, corrects, answers a question from, or adds constraints to an existing running thread.
- If multiple running threads match, choose the single most directly relevant threadId from runningThreads.
- Choose "unrelated" when the new query introduces an independent topic or task that should run in parallel without disturbing active work.
- targetThreadId must be an exact threadId from runningThreads when decision is "related", or null when "unrelated".
- title must be 5-20 Chinese characters or 3-8 English words matching the user's language.`);

export function buildThreadSupplementUserPrompt({ vp = {}, runningThreads = [], newQuery = '' } = {}) {
  const payload = {
    vp: {
      vpId: boundedText(vp.vpId || '', 120),
      displayName: boundedText(vp.displayName || vp.displayNameZh || vp.vpId || '', 120),
      role: boundedText(vp.role || vp.roleZh || '', 200),
      persona: boundedText(vp.persona || '', 600),
    },
    runningThreads: (runningThreads || []).slice(0, 16).map(t => ({
      threadId: boundedText(t?.threadId || '', 160),
      ...(t?.userTurnId ? { userTurnId: boundedText(t.userTurnId, 160) } : {}),
      ...(t?.vpId ? { vpId: boundedText(t.vpId, 120) } : {}),
      title: boundedText(t?.title || '', 160),
      status: boundedText(t?.status || '', 40),
      updatedAt: t?.updatedAt || null,
      recentMessages: Array.isArray(t?.recentMessages)
        ? t.recentMessages.slice(-6).map(m => (typeof m === 'string'
          ? boundedText(m, 800)
          : {
            role: boundedText(m?.role || '', 24),
            text: boundedText(m?.text ?? m?.content ?? '', 800),
          }))
        : [],
      summary: boundedText(t?.summary || '', 2000),
    })),
    newQuery: boundedText(newQuery, 4000),
  };
  return JSON.stringify(payload, null, 2);
}

export function fallbackThreadSupplement({ runningThreads = [], newQuery = '' } = {}, reason = 'fallback') {
  const live = (runningThreads || [])
    .map(t => (t && typeof t.threadId === 'string' ? { ...t, threadId: boundedText(t.threadId, 160) } : null))
    .filter(t => t && t.threadId);
  if (live.length === 1) {
    return {
      decision: 'related',
      targetThreadId: live[0].threadId,
      title: live[0].title || fallbackShortTitle(newQuery),
      reason,
    };
  }
  return {
    decision: 'unrelated',
    targetThreadId: null,
    title: fallbackShortTitle(newQuery),
    reason,
  };
}

export function validateThreadSupplementOutput(parsed, { runningThreads = [], newQuery = '' } = {}) {
  if (!parsed) return null;
  const known = new Set((runningThreads || [])
    .map(t => boundedText(t?.threadId || '', 160))
    .filter(Boolean));
  const decision = VALID_DECISIONS.has(parsed.decision) ? parsed.decision : null;
  if (!decision) return null;

  const title = typeof parsed.title === 'string' && parsed.title.trim()
    ? boundedText(parsed.title, 80)
    : fallbackShortTitle(newQuery);
  const reason = boundedText(parsed.reason || '', 500);

  if (decision === 'related') {
    const targetThreadId = boundedText(parsed.targetThreadId || '', 160);
    if (targetThreadId && known.has(targetThreadId)) {
      return { decision: 'related', targetThreadId, title, reason };
    }
    return {
      decision: 'unrelated',
      targetThreadId: null,
      title,
      reason: reason || 'invalid_target_thread',
    };
  }

  return {
    decision: 'unrelated',
    targetThreadId: null,
    title,
    reason,
  };
}

export const threadSupplementScenario = Object.freeze({
  id: THREAD_SUPPLEMENT_SCENARIO_ID,
  maxTokens: 256,
  defaultTimeoutMs: 5_000,
  buildSystemPrompt: () => THREAD_SUPPLEMENT_PROMPT,
  buildUserPrompt: buildThreadSupplementUserPrompt,
  validate: validateThreadSupplementOutput,
  fallback: fallbackThreadSupplement,
});
