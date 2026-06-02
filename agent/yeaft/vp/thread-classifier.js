const VALID_DECISIONS = new Set(['related', 'unrelated']);

export const THREAD_CLASSIFIER_SYSTEM_PROMPT = `You route a new user query for one VP into an existing running thread or a new thread.
Return JSON only:
{"decision":"related|unrelated","targetThreadId":"string|null","title":"short title","reason":"optional debug reason"}
Rules:
- If the query continues, clarifies, corrects, or adds details to an existing thread, choose related.
- If multiple threads match, choose the most relevant thread.
- If none match, choose unrelated.
- title must be 5-20 Chinese characters or 3-8 English words, matching the user language.
- Do not include markdown or extra prose.`;

export function fallbackTitle(query) {
  const text = String(query || '').replace(/\s+/g, ' ').trim();
  if (!text) return '新任务';
  const withoutMentions = text.replace(/@\S+/g, '').trim() || text;
  if (/[^\x00-\x7F]/.test(withoutMentions)) return withoutMentions.slice(0, 20);
  return withoutMentions.split(' ').slice(0, 8).join(' ').slice(0, 80);
}

function stripJsonFence(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('```')) return raw;
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

export function parseThreadClassification(text, runningThreads = [], query = '') {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch {
    return fallbackClassification(runningThreads, query, 'invalid_json');
  }
  return validateThreadClassification(parsed, runningThreads, query);
}

export function validateThreadClassification(value, runningThreads = [], query = '') {
  const known = new Set((runningThreads || []).map(t => t && t.threadId).filter(Boolean));
  const decision = VALID_DECISIONS.has(value && value.decision) ? value.decision : null;
  const title = typeof value?.title === 'string' && value.title.trim()
    ? value.title.trim().slice(0, 80)
    : fallbackTitle(query);
  const reason = typeof value?.reason === 'string' ? value.reason.slice(0, 500) : '';

  if (decision === 'related') {
    const targetThreadId = typeof value?.targetThreadId === 'string' ? value.targetThreadId : '';
    if (targetThreadId && known.has(targetThreadId)) {
      return { decision: 'related', targetThreadId, title, reason };
    }
    return { decision: 'unrelated', targetThreadId: null, title, reason: reason || 'invalid_target_thread' };
  }
  if (decision === 'unrelated') {
    return { decision: 'unrelated', targetThreadId: null, title, reason };
  }
  return fallbackClassification(runningThreads, query, 'invalid_decision');
}

export function fallbackClassification(runningThreads = [], query = '', reason = 'fallback') {
  const live = (runningThreads || []).filter(t => t && t.threadId);
  if (live.length === 1) {
    return {
      decision: 'related',
      targetThreadId: live[0].threadId,
      title: live[0].title || fallbackTitle(query),
      reason,
    };
  }
  return {
    decision: 'unrelated',
    targetThreadId: null,
    title: fallbackTitle(query),
    reason,
  };
}

export function buildThreadClassificationPrompt({ vp = {}, runningThreads = [], newQuery = '' } = {}) {
  const payload = {
    vp: {
      vpId: vp.vpId || '',
      displayName: vp.displayName || vp.displayNameZh || vp.vpId || '',
      role: vp.role || vp.roleZh || '',
      persona: String(vp.persona || '').slice(0, 600),
    },
    runningThreads: (runningThreads || []).map(t => ({
      threadId: t.threadId,
      title: t.title || '',
      status: t.status || '',
      updatedAt: t.updatedAt || null,
      recentMessages: Array.isArray(t.recentMessages) ? t.recentMessages.slice(-6) : [],
      summary: t.summary || '',
    })),
    newQuery: String(newQuery || '').slice(0, 4000),
  };
  return JSON.stringify(payload, null, 2);
}

export async function classifyThread({ adapter, model, vp, runningThreads, newQuery, signal } = {}) {
  if (!adapter || typeof adapter.call !== 'function') {
    return fallbackClassification(runningThreads, newQuery, 'no_adapter');
  }
  try {
    const res = await adapter.call({
      model,
      system: THREAD_CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildThreadClassificationPrompt({ vp, runningThreads, newQuery }) }],
      maxTokens: 256,
      signal,
    });
    return parseThreadClassification(res && res.text, runningThreads, newQuery);
  } catch (err) {
    return fallbackClassification(runningThreads, newQuery, `classifier_error:${err?.message || err}`);
  }
}
