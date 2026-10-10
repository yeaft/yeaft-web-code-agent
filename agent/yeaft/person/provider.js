import { loadConfig } from '../config.js';
import { createLLMAdapter } from '../llm/adapter.js';
import { applyAnthropicThinking } from '../llm/anthropic.js';
import { inferProtocolFromModelId, normalizeModelEntry } from '../llm/router.js';
import { normalizeKnownProviderForRuntime } from '../llm/known-providers.js';
import { normalizeEffort, resolveContextWindow, resolveMaxOutputTokens } from '../models.js';
import { utf8PrefixWithinBytes } from '../utf8.js';
import { bytes, digest, fail, LIMITS, PersonError } from './contracts.js';
import { addUsage } from './turn-diagnostics.js';

export const MODEL_LIMITS = Object.freeze({ candidates: 8, available: 100 });
export function validateModelCandidates(refs) {
  if (!Array.isArray(refs) || refs.length > MODEL_LIMITS.candidates ||
      refs.some(ref => typeof ref !== 'string' || !/^[^/\s]+\/[^\s]+$/u.test(ref) || ref.length > 256) ||
      new Set(refs).size !== refs.length) fail('MODEL_SELECTION');
}

export function validateDefaultModel(ref) {
  if (ref !== null) validateModelCandidates([ref]);
}

/** Resolve router ownership before allowlisting or bounding the Person catalog. */
export function resolveAgentDefaultModel(config) {
  const models = config.availableModels || [], requested = config.primaryModel || config.model;
  const model = models.find(m => (m.ref || m.id) === requested) || models.find(m => m.id === requested);
  return model?.ref || (model?.id?.includes('/') ? model.id : null);
}

/** Shared validation for settings, status and runtime; never broaden an explicit subset. */
export function selectPersonModels({ availableModels, modelCandidates = [], defaultModel = null }) {
  validateModelCandidates(modelCandidates);
  validateDefaultModel(defaultModel);
  if (modelCandidates.some(ref => !availableModels.some(model => model.id === ref))) fail('MODEL_SELECTION');
  const catalog = modelCandidates.length ? availableModels.filter(model => modelCandidates.includes(model.id))
    : availableModels.slice(0, MODEL_LIMITS.candidates);
  if (defaultModel !== null && !catalog.some(model => model.id === defaultModel)) fail('MODEL_SELECTION');
  if (!catalog.length) fail('MODEL_UNAVAILABLE');
  return { catalog, defaultSelection: { model: defaultModel ?? catalog[0].id, effort: null } };
}

// Bounds apply to the actual wire protocol, not a vision flag or compressed file size.
// OpenAI tile models (including 2833 base tokens for gpt-4o-mini) have a fixed
// cost only at explicit low detail. Known patch models below fit <=6144 patches
// with multipliers <=1.62; reserve 16384, not the tile-model allowance.
// Claude 3/4 resize to <=4784 visual tokens. Keep headroom for image overhead.
// Sources and supported-model policy: docs/person-backend-files.md.
function imageInputBudget(modelId, protocol) {
  if (protocol === 'openai-responses') {
    if (/^(?:gpt-(?:4o(?:-mini)?|4\.1|5(?:\.1)?)|o1(?:-pro)?|o3)(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) {
      return { detail: 'low', tokensPerImage: 8192 };
    }
    if (/^gpt-(?:4\.1-mini|5\.(?:2|4|5))(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) {
      return { detail: 'low', tokensPerImage: 16384 };
    }
  }
  if (protocol === 'anthropic' && /^claude-(?:3-(?:haiku|sonnet|opus)|3-5-(?:haiku|sonnet)|3-7-sonnet|sonnet-4(?:[.-][56])?|opus-4(?:[.-][15678])?|haiku-4[.-]5)(?:-\d{8}|-latest)?$/.test(modelId)) {
    return { tokensPerImage: 8192 };
  }
  // Unknown aliases/future variants need a reviewed bound, even with an explicit
  // supportsImages:true. The adapter accepting an image is not token accounting.
  return null;
}

/** Only configured native API models; no Session initialization or implicit credential fallback. */
export async function createPersonProvider({ yeaftDir, config: suppliedConfig, adapter: suppliedAdapter, allowedModels, effortEnabled = process.env.YEAFT_THINKING_V1 === '1', modelCandidates = [], defaultModel = null }) {
  const config = structuredClone(suppliedConfig || loadConfig({ dir: yeaftDir }));
  if (!config.providers?.length && !suppliedAdapter) fail('MODEL_UNAVAILABLE');
  const models = config.availableModels || [];
  const agentDefaultModel = resolveAgentDefaultModel(config);
  validateModelCandidates(modelCandidates);
  validateDefaultModel(defaultModel);
  const available = models.filter(m => !allowedModels || allowedModels.includes(m.ref || m.id));
  const routingProviders = (config.providers || []).map(normalizeKnownProviderForRuntime);
  const safeModels = available.map(m => {
    // Use the same model/config resolution as the native Engine, without a Person-only token ceiling.
    const maxOutput = Math.floor(resolveMaxOutputTokens(m.id, { ...config, modelInfo: m }));
    const effortContext = { ...m, thinkingProtocol: m.effortProtocol || m.thinkingProtocol };
    const efforts = effortEnabled ? (m.effortOptions || []).filter(e => {
      if (!normalizeEffort(e)) return false;
      // Manual thinking can silently expand native max_tokens. Use the exact
      // adapter rules to admit only combinations that fit this model's reserve;
      // adaptive and Responses effort do not require a larger output budget.
      const body = { max_tokens: maxOutput };
      applyAnthropicThinking(body, m.id, e, effortContext);
      return body.max_tokens === maxOutput;
    }) : [];
    // Match the router's first owning row and managed-provider protocol normalization.
    const routeIndex = routingProviders.findIndex(p => (!m.ref?.includes('/') || m.ref === `${p.name}/${m.id}`) &&
      p.models?.some(item => normalizeModelEntry(item)?.id === m.id));
    const routedProvider = routingProviders[routeIndex];
    const routedModel = normalizeModelEntry(routedProvider?.models?.find(item => normalizeModelEntry(item)?.id === m.id));
    const rawProvider = config.providers?.[routeIndex];
    const rawModel = rawProvider?.models?.find(item => item && typeof item === 'object' && item.id === m.id);
    const explicitImages = m.supportsImages ?? rawModel?.supportsImages ?? rawProvider?.supportsImages;
    const protocol = routedModel?.protocol || routedProvider?.protocol || inferProtocolFromModelId(m.id) || 'openai-responses';
    const imageBudget = !routedProvider || explicitImages === false ? null : imageInputBudget(m.id, protocol);
    return { id: m.ref || m.id, efforts, maxOutput, usageCacheIncluded: protocol === 'anthropic' ? false : undefined, supportsImages: imageBudget !== null, imageBudget,
      contextWindow: Math.floor(resolveContextWindow(m.id, { ...config, modelInfo: m })) };
  }).filter(m => typeof m.id === 'string' && m.id.length <= 256 && m.contextWindow > m.maxOutput + 1024 && m.maxOutput >= 256);
  safeModels.sort((a, b) => Number(b.id === agentDefaultModel) - Number(a.id === agentDefaultModel));
  const seen = new Set();
  const uniqueModels = safeModels.filter(model => !seen.has(model.id) && seen.add(model.id));
  const availableModels = uniqueModels.slice(0, MODEL_LIMITS.available);
  // A UI catalog must not be the bounded episode choice set: model 9+ remains selectable.
  // Explicit lists are validated, never silently truncated or broadened on stale config.
  const { catalog, defaultSelection } = selectPersonModels({ availableModels, modelCandidates, defaultModel });
  const adapter = suppliedAdapter || await createLLMAdapter(config);
  return { adapter, catalog, availableModels, availableModelsTruncated: uniqueModels.length > MODEL_LIMITS.available,
    catalogRevision: digest(catalog), defaultSelection, agentDefaultModel, effortEnabled };
}

export function abortable(promise, signal) {
  if (signal.aborted) {
    // The operation may already have started while the signal was being aborted.
    // Observe its eventual rejection even though the caller has already cancelled.
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason || new PersonError('CANCELLED'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new PersonError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Consume only public text and usage. Bound accumulation before accepting any proposal. */
export async function collectOutput(adapter, params, onEffort) {
  const iterator = adapter.stream({ ...params, tools: [], onEffortDecision: decision => onEffort({
    effective: typeof decision.effective === 'string' ? decision.effective : null,
    wireMode: typeof decision.wireMode === 'string' ? decision.wireMode : null,
    thinkingEnabled: decision.thinkingEnabled === true,
  }) })[Symbol.asyncIterator]();
  let output = '', size = 0, stopReason = null, usage = null;
  try {
    while (true) {
      const item = await abortable(iterator.next(), params.signal);
      if (item.done) break;
      const event = item.value;
      if (event.type === 'text_delta') {
        size += bytes(event.text);
        if (size > LIMITS.outputBytes) {
          const room = LIMITS.outputBytes - bytes(output);
          // Keep a valid UTF-8 prefix, explicitly marked incomplete in the error below.
          output += utf8PrefixWithinBytes(event.text, room).text;
          fail('OUTPUT_LIMIT');
        }
        output += event.text;
      } else if (event.type === 'stop') stopReason = event.stopReason;
      else if (event.type === 'error') fail('PROVIDER_FAILED');
      else if (event.type === 'tool_call') fail('INVALID_PROPOSAL');
      else if (event.type === 'usage') {
        usage = addUsage(usage, event, params.usageCacheIncluded);
      }
      // Hidden thinking, signatures, opaque provider state and raw HTTP exchanges are deliberately not archived.
    }
    if (stopReason === 'max_tokens') fail('OUTPUT_TRUNCATED');
    if (stopReason !== 'end_turn') fail('INVALID_PROPOSAL');
    return { text: output, bytes: size, usage, stopReason };
  } catch (error) {
    const safe = error instanceof PersonError ? error : new PersonError('PROVIDER_FAILED');
    // This prefix is explicitly incomplete/rejected, never a full accepted record.
    safe.partialOutput = { text: output, retainedBytes: bytes(output), observedBytes: size, complete: false, accepted: false, usage, stopReason };
    throw safe;
  } finally {
    // Do not let a provider ignoring AbortSignal indefinitely block cancellation/close.
    try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* No raw provider errors. */ }
  }
}
