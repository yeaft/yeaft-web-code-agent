import { getApiToken, copilotRequestHeaders } from './yeaft/llm/credentials/github-copilot.js';
import {
  FALLBACK_GITHUB_COPILOT_MODELS,
  GITHUB_COPILOT_PROVIDER,
  modelEntryForGitHubCopilot,
} from './yeaft/llm/known-providers.js';

export { FALLBACK_GITHUB_COPILOT_MODELS, GITHUB_COPILOT_PROVIDER };

function modelId(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') return String(item.id || '').trim();
  return '';
}

function uniqueIds(items) {
  const seen = new Set();
  const ids = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = modelId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function modelEntryForProvider(id) {
  const value = String(id || '').trim();
  if (!value) return null;
  return value.toLowerCase().startsWith('claude-')
    ? { id: value, protocol: 'anthropic' }
    : value;
}

export function modelEntryForGitHubCopilotProvider(id) {
  return modelEntryForGitHubCopilot(id);
}

export function modelIdsFromProviderModels(models) {
  return uniqueIds(models);
}

export function providerModelsFromIds(ids, { githubCopilot = false } = {}) {
  const mapper = githubCopilot ? modelEntryForGitHubCopilotProvider : modelEntryForProvider;
  return uniqueIds(ids).map(mapper).filter(Boolean);
}

function parseModelPayload(payload) {
  if (Array.isArray(payload)) return uniqueIds(payload);
  if (payload && Array.isArray(payload.data)) return uniqueIds(payload.data);
  if (payload && Array.isArray(payload.models)) return uniqueIds(payload.models);
  return [];
}

async function readJson(res) {
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON model catalog: ${e.message}`);
  }
}

function fallbackResult(provider, reason) {
  return {
    provider,
    models: [...FALLBACK_GITHUB_COPILOT_MODELS],
    providerModels: providerModelsFromIds(FALLBACK_GITHUB_COPILOT_MODELS, { githubCopilot: true }),
    source: 'fallback',
    warning: `Live model catalog unavailable (${reason}); using fallback Copilot model list.`,
  };
}

export async function discoverGitHubCopilotModels({ fetchFn = fetch, getTokenFn = getApiToken } = {}) {
  const tokenInfo = await getTokenFn({ fetchFn });
  if (!tokenInfo?.token) {
    const err = new Error('GitHub Copilot credential not found. Run `gh auth login` or complete the Copilot device login first.');
    err.code = 'COPILOT_CREDENTIAL_MISSING';
    throw err;
  }

  try {
    const res = await fetchFn('https://api.githubcopilot.com/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokenInfo.token}`,
        Accept: 'application/json',
        ...copilotRequestHeaders({ isAgentTurn: true }),
      },
    });
    if (res.status === 401 || res.status === 403) {
      const err = new Error('GitHub Copilot credential is invalid or lacks Copilot access. Re-authenticate with `gh auth login` or complete the Copilot device login again.');
      err.code = 'COPILOT_AUTH_INVALID';
      throw err;
    }
    if (!res.ok) return fallbackResult(GITHUB_COPILOT_PROVIDER, `HTTP ${res.status}`);
    const payload = await readJson(res);
    const models = parseModelPayload(payload);
    if (models.length === 0) return fallbackResult(GITHUB_COPILOT_PROVIDER, 'empty catalog');
    return {
      provider: GITHUB_COPILOT_PROVIDER,
      models,
      providerModels: providerModelsFromIds(models, { githubCopilot: true }),
      source: 'live',
      warning: null,
    };
  } catch (e) {
    if (e?.code === 'COPILOT_AUTH_INVALID') throw e;
    return fallbackResult(GITHUB_COPILOT_PROVIDER, e.message || String(e));
  }
}

export function openAIModelsUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) throw new Error('OpenAI-compatible discovery requires a base URL.');
  const url = new URL(raw);
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/models')) {
    url.pathname = pathname;
  } else if (pathname.endsWith('/v1')) {
    url.pathname = `${pathname}/models`;
  } else {
    url.pathname = `${pathname}/v1/models`;
  }
  return url.toString();
}

export async function discoverOpenAICompatibleModels({ baseUrl, apiKey, fetchFn = fetch } = {}) {
  if (!apiKey) throw new Error('OpenAI-compatible discovery requires an API key.');
  const url = openAIModelsUrl(baseUrl);
  const res = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Model discovery failed: HTTP ${res.status}`);
  const payload = await readJson(res);
  const models = parseModelPayload(payload);
  if (models.length === 0) throw new Error('Model discovery returned no models.');
  return {
    provider: { baseUrl, protocol: 'openai-responses' },
    models,
    providerModels: providerModelsFromIds(models),
    source: 'live',
    warning: null,
  };
}

export async function discoverLlmModels(options = {}) {
  const providerType = options.providerType || options.provider || options.preset;
  if (providerType === 'github-copilot') return discoverGitHubCopilotModels(options);
  if (providerType === 'openai-compatible') return discoverOpenAICompatibleModels(options);
  throw new Error(`Unsupported provider preset: ${providerType || '(missing)'}`);
}
