import { classifyFetchError, LLMAbortError } from './adapter.js';

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
  const messageMatch = new RegExp(`^(?:${unsupported} (?:parameter|field|argument|name)\\s*:?\\s*${cacheParam}(?=\\.(?:\\s|$)|[\\s:]|$)|${cacheParam}\\s*:\\s*(?:extra (?:inputs|fields) (?:are )?not permitted|unknown field|not supported)\\b)`, 'i');
  const matchesMessage = message => typeof message === 'string' && messageMatch.test(message.trim());
  let response;
  try { response = JSON.parse(raw); } catch { return matchesMessage(raw); }
  if (Array.isArray(response?.detail)) {
    return response.detail.length > 0 && response.detail.every(entry => ['extra_forbidden', 'value_error.extra'].includes(entry?.type)
      && Array.isArray(entry.loc) && entry.loc.every(part => typeof part === 'string' || Number.isInteger(part))
      && cachePath.test(entry.loc.join('.')));
  }
  const error = response?.error ?? response;
  if (typeof error?.param === 'string') {
    if (!cachePath.test(error.param)) return false;
    if (/^(?:unknown_parameter|unsupported_parameter|unrecognized_parameter|extra_forbidden)$/.test(error.code ?? error.type ?? '')) return true;
  }
  return matchesMessage(typeof error === 'string' ? error : error?.message ?? response?.detail);
}

/** Dispatch once normally, and at most once without the optional cache hint. */
export async function fetchWithPromptCacheFallback({ url, headers, body, signal, providerLabel, field, withoutCache, onCacheFallback, onRequestStart }) {
  const dispatch = async (payload, onStart) => {
    if (signal?.aborted) throw new LLMAbortError();
    try {
      onStart?.();
      return await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
    } catch (error) {
      throw classifyFetchError(error, { providerLabel, signal });
    }
  };
  let response = await dispatch(body, onRequestStart);
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
