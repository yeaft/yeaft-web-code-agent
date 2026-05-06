/**
 * quick-response.js — Track A of the Unify dual-track turn.
 *
 * Purpose
 * -------
 * Run a single, non-looping LLM call against the user prompt that:
 *   1. classifies the turn as `quick` (one-shot reply) vs `feature`
 *      (heavy multi-step work that should be surfaced as a feature pill);
 *   2. emits a short `preview` sentence telling the user what the VP is
 *      about to do (e.g. "I'll grep the auth code, give me a sec").
 *
 * The result feeds the dual-track UI:
 *   - `intent === 'feature'` is one of the three signals that auto-create
 *     a Feature record, collapsing all subsequent VP output into a pill.
 *   - `preview` is rendered as an instant bubble under the user's message
 *     so the user sees something within ~1s, even if the main engine
 *     loop (Track B) takes longer.
 *
 * Properties
 * ----------
 * - **One LLM call**, no tools, no loop. The whole point is to be cheap
 *   and predictable. Uses the same `primaryModel` as the main engine
 *   per design ruling — there is no separate `fastModel` channel.
 * - **Retries once on parse/transport failure** then gives up silently.
 *   A failed Track A is fine: signals 2 (≥3 turns) and 3 (key tool)
 *   still pick up real heavy turns.
 * - **Hard timeout** of 8s wall-clock. Track B must not be held back
 *   waiting on Track A.
 *
 * Wire shape — what we emit to the frontend
 * -----------------------------------------
 * On success:
 *     { type: 'quick_preview', vpId, turnId, intent, preview }
 *
 * The preview is plain text, ≤ 140 chars, in the user's language.
 *
 * Failure mode
 * ------------
 * Returns `null`. Caller MUST tolerate this and not block on the result.
 */

const QUICK_TIMEOUT_MS = 8000;
const PREVIEW_MAX_CHARS = 140;
const QUICK_MAX_TOKENS = 300;

/**
 * Compose the system prompt that asks the LLM for a structured
 * intent + preview. Bilingual to match the rest of Unify.
 *
 * @param {{ language?: string, vpDisplayName?: string }} opts
 * @returns {string}
 */
function buildQuickSystem({ language = 'en', vpDisplayName = 'assistant' } = {}) {
  const isZh = String(language || '').toLowerCase().startsWith('zh');
  if (isZh) {
    return [
      `你正在以「${vpDisplayName}」的身份做一次极简的"先回声"判断。这不是真正的回答，主回答会由另一条线并发产出。`,
      '',
      '只输出一行 JSON，不要 markdown、不要 ```、不要前后空行：',
      '{"intent":"quick"|"feature","preview":"<不超过 80 个字符的中文，告诉用户你打算做什么>"}',
      '',
      'intent 规则：',
      '- "quick"：用户是寒暄、问事实、要一句话答案，预计一次回复就够。',
      '- "feature"：需要查代码 / 改文件 / 调 bash / 跑测试 / 多步推理，预计要折腾若干轮。',
      '',
      'preview 规则：',
      '- 用第一人称简短陈述「我去做什么」，例如：「我去看看 auth 模块再回你」。',
      '- 不要承诺结果，不要复述用户的话。',
      '- 不要带表情、不要带 markdown。',
    ].join('\n');
  }
  return [
    `You are "${vpDisplayName}" giving a one-shot pre-reply. This is NOT the real answer; the real answer is being produced concurrently on another track.`,
    '',
    'Output ONE line of strict JSON, no markdown, no fences, no leading/trailing whitespace:',
    '{"intent":"quick"|"feature","preview":"<at most 80 chars telling the user what you are about to do>"}',
    '',
    'intent rules:',
    '- "quick": small talk / factual lookup / single-sentence answer.',
    '- "feature": needs code reading, file edits, bash, tests, or multi-step reasoning.',
    '',
    'preview rules:',
    '- First-person, short. Example: "Let me grep the auth module and get back to you."',
    '- Do NOT promise outcomes. Do NOT echo the user.',
    '- No emoji, no markdown.',
  ].join('\n');
}

/**
 * Robust JSON extraction. Models occasionally wrap output in fences or
 * leading prose despite instructions; we accept any single JSON object
 * we can find.
 *
 * @param {string} raw
 * @returns {{intent:string, preview:string}|null}
 */
function parseQuickJson(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  // Strip ``` fences if present.
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // First-pass direct parse.
  let obj = null;
  try { obj = JSON.parse(s); } catch { /* fall through */ }
  // Second-pass: locate first `{` and last `}`.
  if (!obj) {
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try { obj = JSON.parse(s.slice(i, j + 1)); } catch { /* nope */ }
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const intent = obj.intent === 'feature' ? 'feature' : 'quick';
  const previewRaw = typeof obj.preview === 'string' ? obj.preview : '';
  const preview = previewRaw.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX_CHARS);
  if (!preview) return null; // a preview-less response is useless
  return { intent, preview };
}

/**
 * Drive the adapter once. Collects text deltas, returns the assembled
 * raw string. Throws on adapter error / abort / timeout.
 *
 * @param {object} adapter — LLMAdapter instance with .stream()
 * @param {object} args    — { model, system, messages, signal }
 * @returns {Promise<string>}
 */
async function callOnce(adapter, args) {
  const parts = [];
  for await (const event of adapter.stream(args)) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'text_delta' && typeof event.text === 'string') {
      parts.push(event.text);
    } else if (event.type === 'error') {
      throw event.error || new Error('adapter stream error');
    }
    // tool_call / thinking_delta / usage / stop are ignored; we
    // explicitly do not pass any tools to the adapter.
  }
  return parts.join('');
}

/**
 * Run Track A. One adapter call, retry-once on failure, hard 8s deadline.
 *
 * @param {{
 *   adapter: object,
 *   model: string,
 *   prompt: string,
 *   language?: string,
 *   vpDisplayName?: string,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<{intent:'quick'|'feature', preview:string}|null>}
 */
export async function runQuickResponse({
  adapter,
  model,
  prompt,
  language,
  vpDisplayName,
  signal,
} = {}) {
  if (!adapter || typeof adapter.stream !== 'function') return null;
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  if (!model) return null;

  // Composite signal: caller's abort OR our timeout, whichever fires first.
  const ctrl = new AbortController();
  const onCallerAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) return null;
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), QUICK_TIMEOUT_MS);

  const system = buildQuickSystem({ language, vpDisplayName });
  const messages = [{ role: 'user', content: prompt }];
  const callArgs = {
    model,
    system,
    messages,
    maxTokens: QUICK_MAX_TOKENS,
    signal: ctrl.signal,
  };

  try {
    // Attempt 1.
    let raw = '';
    try {
      raw = await callOnce(adapter, callArgs);
    } catch (err) {
      // Abort or external error — exit silently. Don't retry on abort.
      if (err && (err.name === 'AbortError' || err.name === 'LLMAbortError')) return null;
      // Otherwise fall through to retry.
      raw = '';
    }
    let parsed = raw ? parseQuickJson(raw) : null;

    if (!parsed) {
      // Attempt 2 (retry once). Reuse the same args; adapter is stateless.
      if (ctrl.signal.aborted) return null;
      try {
        const raw2 = await callOnce(adapter, callArgs);
        parsed = raw2 ? parseQuickJson(raw2) : null;
      } catch {
        parsed = null;
      }
    }

    return parsed;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }
}

// Test seams — exported so tests can exercise pure helpers without
// spinning up an adapter.
export const __test = {
  parseQuickJson,
  buildQuickSystem,
  QUICK_TIMEOUT_MS,
  PREVIEW_MAX_CHARS,
};
