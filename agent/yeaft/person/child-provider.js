import { EFFORT_LEVELS } from '../effort.js';
import { applyAnthropicThinking } from '../llm/anthropic.js';
import { normalizeEffort, parseModelRef } from '../models.js';
import { fail } from './contracts.js';

const rank = effort => EFFORT_LEVELS.indexOf(normalizeEffort(effort));
const pinModels = (models, model) => Object.fromEntries(Object.keys(models || {}).map(key => [key, model]));

/**
 * Adapt an admitted Person provider to the native sub-agent Engine driver.
 * This is NOT the Person proposal/JSON collector: tools, messages, callbacks,
 * cancellation and all unified stream events pass through unchanged.
 *
 * @param {{ adapter: object, catalog: Array<{ id: string, contextWindow: number,
 *   maxOutput: number, efforts: string[] }>, defaultSelection: { model: string,
 *   effort: string|null } }} provider Already-created, candidate-bounded provider.
 * @param {{ model: string, effort?: string|null }|null} selection Exact catalog
 *   reference; null/undefined uses provider.defaultSelection. Invalid explicit
 *   selections fail closed (MODEL_SELECTION), never fall back to another model.
 * @param {object} [instanceConfig={}] Loaded native instance config. Deep-cloned;
 *   neither it, the provider/catalog nor stream parameters are mutated.
 * @returns {{ adapter: object, config: object }} Pass both fields to
 *   startSubAgent(agent, { ...deps, ...result }). config.model/primaryModel and
 *   fast/secondary/persona role mappings are pinned to the selected reference;
 *   fallback is disabled and availableModels/providers contain only that model.
 *   modelInfo/maxContextTokens/maxOutputTokens carry the catalog's token limits
 *   (a smaller positive instance output ceiling is retained).
 *
 * stream/captureStream/captured requests/call all enforce the same immutable
 * selection, rejecting missing, bare aliases and other catalog models before
 * dispatch. Output maxTokens is floored and capped; invalid/nonpositive values
 * use the configured cap. Engine scenario/prefix effort cannot override the
 * selection. An inherited native child ceiling may only LOWER it to a catalog
 * effort; no representable safe effort means omission, not escalation. Manual
 * thinking that would expand maxTokens is likewise omitted. The admitted effort
 * is sent as an explicit user selection (even with YEAFT_THINKING_V1 off); effort
 * capability context is copied from bounded model metadata, not caller overrides.
 * Native effortConstraint synthesis and extraBody overrides are removed after
 * this boundary enforces their budgets. Optional adapter methods retain their
 * original receiver (class private fields work); captureRequest preserves native
 * routing snapshots without
 * exposing an unguarded captureStream. The supplied adapter owns its transport
 * and must honor unified maxTokens/effort; this helper does not meter generated
 * tokens or validate provider wire bodies.
 * @throws {import('./contracts.js').PersonError} MODEL_UNAVAILABLE for a missing
 *   adapter/empty or unusable catalog; MODEL_SELECTION for an unpermitted route
 *   or effort. The helper is synchronous; adapter.stream must return an async iterable.
 */
export function createPersonChildProvider(provider, selection, instanceConfig = {}) {
  if (typeof provider?.adapter?.stream !== 'function' || !Array.isArray(provider.catalog) || !provider.catalog.length) {
    fail('MODEL_UNAVAILABLE');
  }
  const selected = selection ?? provider.defaultSelection;
  const entry = provider.catalog.find(model => typeof selected?.model === 'string' && model.id === selected.model);
  if (!entry) fail('MODEL_SELECTION');
  if (!Number.isFinite(entry.contextWindow) || !Number.isFinite(entry.maxOutput)
      || Math.floor(entry.maxOutput) < 1 || Math.floor(entry.contextWindow) <= Math.floor(entry.maxOutput)) {
    fail('MODEL_UNAVAILABLE');
  }
  const model = entry.id;
  const efforts = (entry.efforts || []).filter(effort => normalizeEffort(effort));
  const effort = selected.effort ?? null;
  if (effort !== null && !efforts.includes(effort)) fail('MODEL_SELECTION');
  const config = structuredClone(instanceConfig);
  const { modelId, providerName } = parseModelRef(model);
  const metadata = config.availableModels?.find(item => (item.ref || item.id) === model) || {};
  const outputCeiling = Number.isFinite(config.maxOutputTokens) && config.maxOutputTokens >= 1
    ? Math.floor(config.maxOutputTokens) : Math.floor(entry.maxOutput);
  const maxOutputTokens = Math.min(Math.floor(entry.maxOutput), outputCeiling);
  const modelInfo = { ...metadata, id: modelId, ref: model,
    contextWindow: Math.floor(entry.contextWindow), maxOutput: maxOutputTokens,
    effortOptions: [...efforts], thinkingProtocol: metadata.effortProtocol || metadata.thinkingProtocol };
  // Keep preflight independent of the returned config and request overrides.
  const effortContext = { ...modelInfo, effortOptions: [...efforts] };

  Object.assign(config, {
    model, primaryModel: model, fastModel: model, fastModelId: modelId, secondaryModel: model,
    fallbackModel: null, modelEffort: effort,
    models: { ...pinModels(config.models, model), primary: model, secondary: model, fast: model },
    personaModels: pinModels(config.personaModels, model),
    modelInfo, availableModels: [{ ...modelInfo, effortOptions: [...efforts] }],
    maxContextTokens: modelInfo.contextWindow, maxOutputTokens,
  });
  // Config does not construct the adapter here, but must not advertise any
  // broader choices to child/nested-child consumers of the native config.
  config.providers = (config.providers || []).flatMap(row => {
    if (providerName && row.name !== providerName) return [];
    const models = (row.models || []).filter(item => (typeof item === 'string' ? item : item.id) === modelId);
    return models.length ? [{ ...row, models }] : [];
  });

  function guard(params) {
    // Pin more tightly than the catalog: a child never gets another candidate,
    // even if future Engine/persona/fallback routing attempts to select it.
    if (params?.model !== model) fail('MODEL_SELECTION');
    const maxTokens = Number.isFinite(params.maxTokens) && params.maxTokens >= 1
      ? Math.min(Math.floor(params.maxTokens), maxOutputTokens) : maxOutputTokens;
    let effectiveEffort = effort;
    if (effectiveEffort && params.effortConstraint) {
      const parent = params.effortConstraint.parentDecision;
      const inherited = normalizeEffort(parent?.effective) || 'medium';
      const cap = normalizeEffort(parent?.cap);
      const ceiling = Math.min(rank(effectiveEffort), rank(inherited), rank('high'), cap ? rank(cap) : Infinity);
      effectiveEffort = EFFORT_LEVELS.filter(value => efforts.includes(value) && rank(value) <= ceiling).at(-1) || null;
    }
    if (effectiveEffort) {
      const body = { max_tokens: maxTokens };
      applyAnthropicThinking(body, modelId, effectiveEffort, effortContext);
      if (body.max_tokens !== maxTokens) effectiveEffort = null;
    }
    return { ...params, model, maxTokens, effort: effectiveEffort ?? undefined,
      effortContext: { ...effortContext, effortOptions: [...efforts] },
      effortSource: effectiveEffort ? 'user' : undefined, effortConstraint: null, extraBody: undefined };
  }

  function wrap(source, captured = false) {
    const stream = params => {
      const guarded = guard(params);
      // Captured native Router requests only expose captureStream; plain
      // adapters may expose only stream. Do not inherit either unguarded.
      return captured && typeof source.captureStream === 'function'
        ? source.captureStream(guarded) : source.stream(guarded);
    };
    const methods = {
      stream,
      // Keep legacy dispatch semantics: Engine only defers its dispatch hook
      // for adapters which implement native capture/onRequestStart themselves.
      captureStream: typeof source.captureStream === 'function' ? stream : undefined,
      captureRequest: () => typeof source.captureRequest === 'function'
        ? wrap(source.captureRequest(), true) : wrap(source, true),
      async call(params) {
        // Side calls also cross the guarded stream; an inherited call() could
        // otherwise route around the allowlist or use its own output defaults.
        let text = '', stopReason, usage = {};
        for await (const event of stream({ ...params, tools: undefined })) {
          if (event.type === 'text_delta') text += event.text;
          else if (event.type === 'stop') stopReason = event.stopReason;
          else if (event.type === 'usage') {
            const { type, ...tokens } = event;
            usage = { ...usage, ...tokens };
          } else if (event.type === 'error') throw event.error;
        }
        return { text, stopReason, usage };
      },
    };
    return new Proxy(methods, {
      get(target, key, receiver) {
        if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
        const value = Reflect.get(source, key, source);
        return typeof value === 'function' ? value.bind(source) : value;
      },
    });
  }

  return { adapter: wrap(provider.adapter), config };
}
