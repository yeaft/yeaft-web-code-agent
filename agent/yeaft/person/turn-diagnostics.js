import { fail, object } from './contracts.js';

export const TOKEN_FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']);
const numeric = value => Number.isSafeInteger(value) && value >= 0;
const token = value => numeric(value) ? value : null;
const string = value => typeof value === 'string' ? value : null;

/** Turn cursor is an exclusive numeric episode watermark, never a trace offset. */
export function turnsPage(payload = {}) {
  object(payload, ['cursor', 'limit'], []);
  const { cursor = null, limit = 20 } = payload;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 ||
      (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1))) fail('INVALID_REQUEST');
  return { cursor, limit };
}

/** Adapter usage events are additive. Keep unknown fields unknown, including cache semantics. */
export function addUsage(usage, event, inclusion) {
  const result = { ...usage };
  for (const key of TOKEN_FIELDS) if (numeric(event[key])) result[key] = (result[key] ?? 0) + event[key];
  const flag = typeof event.cacheTokensAreIncludedInInput === 'boolean' ? event.cacheTokensAreIncludedInInput : inclusion;
  if (typeof flag === 'boolean') {
    if (typeof result.cacheTokensAreIncludedInInput === 'boolean' && result.cacheTokensAreIncludedInInput !== flag) result.cacheTokensAreIncludedInInput = null;
    else if (result.cacheTokensAreIncludedInInput !== null) result.cacheTokensAreIncludedInInput = flag;
  }
  return result;
}

export function callUsage(raw, completed) {
  const usage = Object.fromEntries(TOKEN_FIELDS.map(key => [key, token(raw?.[key])]));
  const reported = TOKEN_FIELDS.some(key => usage[key] !== null);
  const caches = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  // Historical traces dropped the flag. Nonzero cache counts without it are ambiguous.
  usage.inputTotalTokens = usage.inputTokens === null || (caches > 0 && typeof raw?.cacheTokensAreIncludedInInput !== 'boolean') ? null
    : usage.inputTokens + (raw?.cacheTokensAreIncludedInInput === false ? caches : 0);
  usage.totalTokens = usage.inputTotalTokens === null || usage.outputTokens === null ? null : usage.inputTotalTokens + usage.outputTokens;
  // Reasoning is a subset of output, not an additional billable output quantity.
  return { ...usage, reportedCalls: Number(reported), missingCalls: Number(!reported), complete: completed && usage.totalTokens !== null };
}

function sumUsage(calls, terminal) {
  const fields = [...TOKEN_FIELDS, 'inputTotalTokens', 'totalTokens'];
  const usage = Object.fromEntries(fields.map(key => {
    const known = calls.map(call => call.usage[key]).filter(value => value !== null);
    // Raw metrics sum reported values even for partial calls. Exact totals require every call.
    return [key, !calls.length ? 0 : (key.endsWith('TotalTokens') || key === 'totalTokens') && known.length !== calls.length ? null
      : known.length ? known.reduce((sum, value) => sum + value, 0) : null];
  }));
  return { ...usage, reportedCalls: calls.reduce((sum, call) => sum + call.usage.reportedCalls, 0),
    missingCalls: calls.reduce((sum, call) => sum + call.usage.missingCalls, 0), complete: terminal && calls.every(call => call.usage.complete) };
}

/** Only metadata supplied by SQLite's explicit projection enters this view. */
export function turnView(episode, events) {
  const calls = new Map();
  for (const event of events) {
    if (event.kind === 'call_started') {
      calls.set(event.callId, { callId: event.callId, index: numeric(event.callIndex) ? event.callIndex + 1 : calls.size + 1,
        status: 'running', requested: { model: string(event.requestedModel), effort: string(event.requestedEffort) },
        // Native router dispatches the configured ref (only credential refresh can retry).
        // It does not expose the response model: do not label configured intent as observed reality.
        dispatched: { model: string(event.requestedModel) }, effective: { model: null, effort: null },
        selectionOrigin: string(event.selectionOrigin), reason: string(event.reason), createdAt: event.createdAt, endedAt: null, code: null,
        contextBytes: token(event.contextBytes), contextBudgetBytes: token(event.contextBudgetBytes), outputTokensReserved: token(event.outputTokensReserved),
        usage: callUsage(null, false) });
      continue;
    }
    const call = calls.get(event.callId);
    if (!call) continue;
    if (event.kind === 'call_output' || event.kind === 'call_failed') {
      call.status = event.kind === 'call_output' ? 'completed' : ['CANCELLED', 'INTERRUPTED'].includes(event.code) ? event.code.toLowerCase() : 'failed';
      call.endedAt = event.createdAt; call.code = string(event.code);
      call.effective.effort = event.effortObserved === true ? string(event.effectiveEffort) : null;
      call.usage = callUsage(event.usage, event.kind === 'call_output');
    } else if (event.kind === 'proposal_rejected') {
      call.status = 'rejected'; call.code = string(event.code);
    } else if (event.kind === 'capability_started') {
      call.capability = { id: string(event.capabilityId), status: 'running', code: null };
    } else if (['capability_result', 'capability_failed', 'capability_finalized'].includes(event.kind)) {
      call.capability = { id: string(event.capabilityId) ?? call.capability?.id ?? null,
        status: (event.outcome ?? event.kind) === 'capability_failed' ? 'failed' : 'completed', code: string(event.code) ?? string(event.terminalCode) };
    }
  }
  const items = [...calls.values()].sort((a, b) => a.index - b.index);
  return { id: episode.id, seq: episode.seq, kind: episode.kind, status: episode.status, createdAt: episode.createdAt,
    endedAt: episode.endedAt, terminalCode: episode.terminalCode, budget: { calls: token(episode.calls), timeoutMs: token(episode.timeoutMs) },
    models: [...new Set(items.map(call => call.dispatched.model).filter(Boolean))], usage: sumUsage(items, episode.status !== 'running'), calls: items };
}
