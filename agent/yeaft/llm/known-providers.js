import { normalizeEffortOptions } from '../models.js';
import { MAX_STREAM_IDLE_TIMEOUT_MS } from './adapter.js';

export const GITHUB_COPILOT_PROVIDER_NAME = 'github-copilot';
export const GITHUB_COPILOT_BASE_URL = 'https://api.githubcopilot.com';
export const GITHUB_COPILOT_CREDENTIAL_PROVIDER = 'github-copilot';

export const FALLBACK_GITHUB_COPILOT_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5-mini',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-4.1',
  'gpt-4o',
  'gpt-4o-mini',
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-haiku-4.5',
  'gemini-2.5-pro',
];

export const GITHUB_COPILOT_PROVIDER = {
  name: GITHUB_COPILOT_PROVIDER_NAME,
  baseUrl: GITHUB_COPILOT_BASE_URL,
  credentialProvider: GITHUB_COPILOT_CREDENTIAL_PROVIDER,
  managed: GITHUB_COPILOT_CREDENTIAL_PROVIDER,
};

function modelId(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') return String(item.id || '').trim();
  return '';
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = modelId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

export function isGitHubCopilotProvider(provider) {
  if (!provider || typeof provider !== 'object') return false;
  return provider.managed === GITHUB_COPILOT_CREDENTIAL_PROVIDER
    || provider.credentialProvider === GITHUB_COPILOT_CREDENTIAL_PROVIDER
    || provider.name === GITHUB_COPILOT_PROVIDER_NAME;
}

/** Quick Send requires unique model ownership, even when managed routing
 * normally deduplicates entries. Inspect configured IDs before normalization. */
export function collectAmbiguousModelRefs(providers) {
  const seen = new Set();
  const ambiguous = new Set();
  for (const provider of Array.isArray(providers) ? providers : []) {
    const managed = isGitHubCopilotProvider(provider);
    const name = provider?.name || (managed ? GITHUB_COPILOT_PROVIDER_NAME : '');
    const models = Array.isArray(provider?.models) && provider.models.length ? provider.models
      : managed ? FALLBACK_GITHUB_COPILOT_MODELS : [];
    for (const entry of models) {
      const id = typeof entry === 'string' || managed || typeof entry?.id === 'string' ? modelId(entry) : '';
      if (!id) continue;
      const ref = name ? `${name}/${id}` : id;
      if (seen.has(ref)) ambiguous.add(ref);
      else seen.add(ref);
    }
  }
  return ambiguous;
}

export function protocolForKnownModel(id) {
  const value = String(id || '').toLowerCase();
  if (!value) return null;
  if (value.startsWith('claude') || value.includes('/claude') || value.includes('.claude')) {
    return 'anthropic';
  }
  if (/^(gpt-|o1|o3|o4|chatgpt-|codex-|omni-)/.test(value)) {
    return 'openai-responses';
  }
  return null;
}

export function modelEntryForGitHubCopilot(id) {
  const value = String(id || '').trim();
  if (!value) return null;
  // Copilot serves Gemini over Responses, not Google's native endpoint.
  const protocol = /(?:^|[/.])gemini(?:-|$)/i.test(value) ? 'openai-responses' : protocolForKnownModel(value);
  return protocol ? { id: value, protocol } : { id: value };
}

// Managed catalogs still own model protocols and credentials. Preserve only
// supported, non-secret request-policy overrides across normalization and save.
function requestPolicyOverrides(entry) {
  const out = {};
  if (entry?.capabilities && typeof entry.capabilities === 'object' && !Array.isArray(entry.capabilities)) {
    out.capabilities = { ...entry.capabilities };
  }
  if (Number.isFinite(entry?.streamIdleTimeoutMs) && entry.streamIdleTimeoutMs >= 0) {
    out.streamIdleTimeoutMs = Math.min(MAX_STREAM_IDLE_TIMEOUT_MS, Math.floor(entry.streamIdleTimeoutMs));
  }
  if (typeof entry?.supportsEffort === 'boolean') out.supportsEffort = entry.supportsEffort;
  if (['anthropic', 'anthropic-adaptive', 'openai-reasoning', 'none'].includes(entry?.thinkingProtocol)) {
    out.thinkingProtocol = entry.thinkingProtocol;
  }
  const effortOptions = normalizeEffortOptions(entry?.effortOptions);
  if (effortOptions) out.effortOptions = effortOptions;
  if (Number.isFinite(entry?.maxBudgetTokens) && entry.maxBudgetTokens > 0) {
    out.maxBudgetTokens = Math.floor(entry.maxBudgetTokens);
  }
  return out;
}

export function githubCopilotModelEntries(ids = FALLBACK_GITHUB_COPILOT_MODELS) {
  return dedupe(ids).map(item => ({
    ...modelEntryForGitHubCopilot(modelId(item)),
    ...requestPolicyOverrides(item),
  }));
}

export function normalizeKnownProviderForRuntime(provider) {
  if (!isGitHubCopilotProvider(provider)) return provider;
  const configuredModels = Array.isArray(provider.models) && provider.models.length
    ? provider.models
    : FALLBACK_GITHUB_COPILOT_MODELS;
  return {
    ...provider,
    name: provider.name || GITHUB_COPILOT_PROVIDER_NAME,
    baseUrl: provider.baseUrl || GITHUB_COPILOT_BASE_URL,
    credentialProvider: GITHUB_COPILOT_CREDENTIAL_PROVIDER,
    managed: provider.managed || GITHUB_COPILOT_CREDENTIAL_PROVIDER,
    models: githubCopilotModelEntries(configuredModels),
  };
}

export function serializeKnownProviderForPersistence(provider) {
  if (!isGitHubCopilotProvider(provider)) return null;
  const models = Array.isArray(provider.models) && provider.models.length
    ? githubCopilotModelEntries(provider.models)
    : [];
  return {
    name: provider.name || GITHUB_COPILOT_PROVIDER_NAME,
    credentialProvider: GITHUB_COPILOT_CREDENTIAL_PROVIDER,
    managed: provider.managed || GITHUB_COPILOT_CREDENTIAL_PROVIDER,
    ...requestPolicyOverrides(provider),
    ...(models.length ? { models } : {}),
  };
}
