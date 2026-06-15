export const GITHUB_COPILOT_PROVIDER_NAME = 'github-copilot';
export const GITHUB_COPILOT_BASE_URL = 'https://api.githubcopilot.com';
export const GITHUB_COPILOT_CREDENTIAL_PROVIDER = 'github-copilot';

export const FALLBACK_GITHUB_COPILOT_MODELS = [
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
  const protocol = protocolForKnownModel(value);
  return protocol ? { id: value, protocol } : { id: value };
}

export function githubCopilotModelEntries(ids = FALLBACK_GITHUB_COPILOT_MODELS) {
  return dedupe(ids).map(item => modelEntryForGitHubCopilot(modelId(item))).filter(Boolean);
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
  return {
    name: provider.name || GITHUB_COPILOT_PROVIDER_NAME,
    credentialProvider: GITHUB_COPILOT_CREDENTIAL_PROVIDER,
    managed: provider.managed || GITHUB_COPILOT_CREDENTIAL_PROVIDER,
  };
}
