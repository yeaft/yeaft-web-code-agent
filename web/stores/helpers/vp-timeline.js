/** Bounded, plain-text diagnostics only; never retain raw Error/provider payloads. */
export function normalizeTimelineErrorDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const [key, limit] of Object.entries({ message: 2000, code: 128, reason: 128,
    errorName: 128, reasonCode: 128, provider: 128, model: 256, turnId: 256, threadId: 256 })) {
    if (typeof detail[key] === 'string' && detail[key].trim()) out[key] = detail[key].slice(0, limit);
  }
  for (const key of ['retryAttempts', 'maxRetries', 'at']) {
    if (Number.isSafeInteger(detail[key]) && detail[key] >= 0) out[key] = detail[key];
  }
  if (Number.isInteger(detail.statusCode) && detail.statusCode >= 100 && detail.statusCode <= 599) out.statusCode = detail.statusCode;
  return Object.keys(out).length ? out : null;
}

const errorTime = (detail, since) => detail?.at ?? (Number.isSafeInteger(since) && since > 0 ? since : null);

export function timelineErrors(entry) {
  if (!entry) return [];
  const threads = Array.isArray(entry.threads) ? entry.threads : [];
  const errors = threads.filter(thread => thread && (thread.state || thread.status) === 'error').map(thread => {
    const detail = normalizeTimelineErrorDetail(thread.errorDetail);
    return { ...detail, at: errorTime(detail, thread.since),
      turnId: thread.turnId || detail?.turnId || null, threadId: thread.threadId || 'main' };
  });
  // When the last live sibling settles, the aggregate can say 'error' while
  // still naming that sibling. The failed threads, when available, own the errors.
  if (!errors.length && entry.state === 'error') {
    const detail = normalizeTimelineErrorDetail(entry.errorDetail);
    errors.push({ ...detail, at: errorTime(detail, entry.since),
      turnId: detail?.turnId || entry.turnId || null, threadId: detail?.threadId || entry.threadId || 'main' });
  }
  return errors;
}
