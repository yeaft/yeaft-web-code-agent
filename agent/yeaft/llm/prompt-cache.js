import { classifyFetchError, LLMAbortError, LLMRequestTooLargeError, serializeModelRequestBody, fetchWithHeadersTimeout } from './adapter.js';

// A retry is only safe on pre-generation validation that names a field we
// supplied. Never infer that from a generic 400 or a mention in prompt data.
function rejectsCacheField(status, raw, field) {
  if (status !== 400 && status !== 422) return false;
  const path = field === 'cache_control'
    ? '(?:(?:tools\\.\\d+(?:\\.custom)?|system\\.\\d+(?:\\.text)?|messages\\.\\d+\\.content\\.\\d+(?:\\.(?:text|tool_result))?)\\.)?cache_control'
    : 'prompt_cache_key';
  const cachePath = new RegExp(`^(?:body\\.)?${path}$`, 'i');
  const cacheParam = `['"\x60]?(?:body\\.)?${path}['"\x60]?`;
  const unsupported = '(?:unknown|unrecogni[sz]ed|unsupported|unexpected)';
  const extra = '(?:extra (?:inputs|fields) (?:are )?not permitted|unknown field|not supported)';
  const messageMatch = new RegExp(`^(?:${unsupported} (?:request )?(?:parameter|field|argument|name)(?: supplied)?\\s*:?\\s*${cacheParam}(?: is not supported(?: (?:with|by|for) this model)?)?|${cacheParam}\\s*:\\s*${extra})\\.?$`, 'i');
  const matchesMessage = message => typeof message === 'string' && messageMatch.test(message.trim());
  let response;
  try { response = JSON.parse(raw); } catch { return matchesMessage(raw); }
  if (Array.isArray(response?.detail)) {
    return !response.error && !response.message && response.detail.length > 0
      && response.detail.every(entry => ['extra_forbidden', 'value_error.extra'].includes(entry?.type)
        && Array.isArray(entry.loc) && entry.loc.every(part => typeof part === 'string' || Number.isInteger(part))
        && cachePath.test(entry.loc.join('.')));
  }
  const error = response?.error ?? response;
  if (typeof error?.param === 'string' && !cachePath.test(error.param)) return false;
  const message = typeof error === 'string' ? error : error?.message ?? response?.detail;
  if (message != null) return matchesMessage(message);
  return typeof error?.param === 'string'
    && /^(?:unknown_parameter|unsupported_parameter|unrecognized_parameter|extra_forbidden)$/.test(error.code ?? error.type ?? '');
}

/** Dispatch once normally, and at most once without the optional cache hint. */
export async function fetchWithPromptCacheFallback({ url, headers, body, signal, providerLabel, field, withoutCache, onCacheFallback, onRequestStart, maxRequestBodyBytes, getHeadersTimeoutMs, onResponseHeaders }) {
  const dispatch = async payload => {
    if (signal?.aborted) throw new LLMAbortError();
    const { body: serialized, requestBytes } = serializeModelRequestBody(payload, maxRequestBodyBytes);
    try {
      // Re-run the caller's admission hook on every HTTP dispatch: an owned
      // Work Center lease or a request allowance may have expired meanwhile.
      const timeoutMs = getHeadersTimeoutMs?.();
      if (timeoutMs !== 0) onRequestStart?.(timeoutMs);
      const response = await fetchWithHeadersTimeout(url, { method: 'POST', headers, body: serialized, signal }, timeoutMs);
      onResponseHeaders?.();
      if (response.status === 413) {
        await response.body?.cancel().catch(() => {});
        throw new LLMRequestTooLargeError(requestBytes, { limitBytes: maxRequestBodyBytes, received413: true });
      }
      return response;
    } catch (error) {
      throw classifyFetchError(error, { providerLabel, signal });
    }
  };
  let response = await dispatch(body);
  let errorBody = response.ok ? null : await response.text();
  if (withoutCache && rejectsCacheField(response.status, errorBody, field)) {
    if (signal?.aborted) throw new LLMAbortError();
    body = withoutCache(body);
    onCacheFallback?.();
    response = await dispatch(body);
    errorBody = response.ok ? null : await response.text();
  }
  return { response, errorBody, body };
}
