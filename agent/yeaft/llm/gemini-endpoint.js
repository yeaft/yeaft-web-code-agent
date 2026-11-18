const DEFAULT_API_PATH = '/v1';
export const GEMINI_BASE_URL = `https://generativelanguage.googleapis.com${DEFAULT_API_PATH}`;

/** Fill omitted native provider configuration without rewriting explicit URLs. */
export function withGeminiDefault(provider) {
  return provider?.protocol === 'gemini' && !provider.baseUrl
    ? { ...provider, baseUrl: GEMINI_BASE_URL }
    : provider;
}

/** Resolve omitted and host-only Gemini endpoints without changing explicit paths. */
export function normalizeGeminiEndpoint(baseUrl) {
  const url = new URL(baseUrl || GEMINI_BASE_URL);
  url.pathname = url.pathname.replace(/\/+$/, '') || DEFAULT_API_PATH;
  return url;
}

/** Use the same model collection for discovery and generation, including custom routes. */
export function geminiModelsUrl(baseUrl) {
  const url = normalizeGeminiEndpoint(baseUrl);
  const path = url.pathname.replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/, '/models');
  url.pathname = path.endsWith('/models') ? path : `${path}/models`;
  return url;
}
