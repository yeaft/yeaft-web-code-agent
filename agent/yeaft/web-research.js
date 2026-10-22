/** Query-local web evidence and request lifecycle. Nothing persists across queries. */
const MAX_TRACKED = 64;
export const WEB_REQUEST_TIMEOUT_MS = 15_000;

export function createWebResearchState() {
  return {
    searches: [],
    fetches: new Map(),
    authorizationFailures: new Map(),
    inFlight: new Map(),
    completedCalls: 0,
  };
}

// Search operators, punctuation, case and quoted whitespace may change meaning.
// Only surrounding whitespace is safe to discard for evidence reuse.
export function normalizeSearchQuery(value) {
  return String(value || '').trim();
}

function grams(value) {
  const result = new Set();
  for (let i = 0; i < Math.max(1, value.length - 2); i += 1) result.add(value.slice(i, i + 3));
  return result;
}

export function findPriorSearch(state, query, limit = 5) {
  const normalized = normalizeSearchQuery(query);
  return state?.searches?.findLast(prior => prior.normalized === normalized && prior.limit >= limit) || null;
}

/** Similarity is advisory ONLY; never use this to suppress a semantic variant. */
export function findRelatedSearch(state, query) {
  const normalized = normalizeSearchQuery(query);
  const left = grams(normalized);
  return state?.searches?.findLast(prior => {
    if (prior.normalized === normalized) return false;
    const right = grams(prior.normalized);
    let overlap = 0;
    for (const item of left) if (right.has(item)) overlap += 1;
    return overlap / (left.size + right.size - overlap) >= 0.75;
  }) || null;
}

export function recordSearch(state, query, limit, output) {
  if (!state) return;
  state.searches.push({ query, normalized: normalizeSearchQuery(query), limit, output });
  if (state.searches.length > MAX_TRACKED) state.searches.shift();
}

export function recordWebResearchCall(state) {
  if (state) state.completedCalls += 1;
}

export function setBounded(map, key, value) {
  if (!(map instanceof Map)) return;
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
}

export function canonicalWebUrl(value) {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

export function webFetchKey(url, { raw = false, maxLength = 50000 } = {}) {
  return JSON.stringify([canonicalWebUrl(url), raw, maxLength]);
}

/** Wait for completion OR abort, including non-cooperative fetch/body implementations. */
async function abortable(work, signal) {
  signal?.throwIfAborted();
  if (!signal) return work();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason || new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Bound fetch AND body consumption, retaining the caller's cancellation signal. */
export async function withWebDeadline(signal, work, timeoutMs = WEB_REQUEST_TIMEOUT_MS) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('Web request deadline exceeded', 'TimeoutError')), timeoutMs);
  timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try { return await abortable(() => work(combined), combined); }
  finally {
    clearTimeout(timer);
    // Also release an unread error response body instead of leaving a socket open.
    if (!deadline.signal.aborted) deadline.abort();
  }
}

/** Share only active identical calls. Settled errors/cancellation are NEVER cached. */
export async function shareWebRequest(state, key, signal, work) {
  signal?.throwIfAborted();
  if (!state) return work();
  let entry = state.inFlight.get(key);
  if (!entry || entry.signal?.aborted) {
    entry = { signal, promise: null };
    entry.promise = Promise.resolve().then(work).finally(() => {
      if (state.inFlight.get(key) === entry) state.inFlight.delete(key);
    });
    state.inFlight.set(key, entry);
  }
  return abortable(() => entry.promise, signal);
}

export function webHttpFailure(status, statusText = '') {
  let hint = 'Inspect the HTTP status and use another authoritative URL if this endpoint remains unavailable.';
  if (status === 401 || status === 403) hint = 'This URL denied access; use a publicly accessible official page or an authorized access path. Other URLs on this host may still work.';
  else if (status === 404 || status === 410) hint = 'Verify the exact URL against the official site index; this page may have moved or been removed.';
  else if (status === 429 || status >= 500) hint = 'The endpoint may be temporarily unavailable; retry later or use another authoritative source. Avoid rapid retries.';
  return { error: `HTTP ${status}: ${statusText}`, code: 'http_error', status, errorEffect: 'none', hint };
}

export function webRequestFailure(error, signal) {
  const cancelled = signal?.aborted || error?.name === 'AbortError';
  const timeout = !cancelled && error?.name === 'TimeoutError';
  return {
    error: cancelled ? 'Web request cancelled' : timeout ? 'Web request timed out' : `Web request failed: ${error?.message || String(error)}`,
    code: cancelled ? 'cancelled' : timeout ? 'timeout' : error?.name === 'SyntaxError' ? 'invalid_response' : 'network_error',
    errorEffect: 'none',
    hint: cancelled ? 'Stop research for this cancelled call. A later explicit call can retry.'
      : timeout ? 'The request exceeded its deadline; retry later or use a smaller, more targeted official endpoint.'
        : 'Verify the endpoint and network access; retry later or use another authoritative source.',
  };
}

export function attachResearchGuidance(output, state, extra = {}) {
  const value = typeof output === 'string' ? JSON.parse(output) : output;
  const count = state?.completedCalls || 0;
  return JSON.stringify({
    ...value, ...extra,
    ...(count >= 4 ? { researchGuidance: `This turn has completed ${count} web research calls. Before another request, identify the specific unresolved fact. Prefer answering with stated uncertainty when existing evidence is sufficient.` } : {}),
  });
}
