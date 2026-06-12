function cloneProvider(provider, scope) {
  return {
    ...provider,
    scope,
    source: scope,
    originalName: provider.name,
    models: Array.isArray(provider.models)
      ? provider.models.map(m => (m && typeof m === 'object' ? { ...m } : m))
      : [],
  };
}

function modelId(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof entry.id === 'string') return entry.id;
  return '';
}

export function buildModelRef(provider, entry) {
  const id = modelId(entry);
  return provider?.name && id ? `${provider.name}/${id}` : id;
}

export function mergeLlmConfigs(globalConfig = {}, agentConfig = {}) {
  const agentProviders = Array.isArray(agentConfig.providers)
    ? agentConfig.providers.map(p => cloneProvider(p, 'agent'))
    : [];
  const localNames = new Set(agentProviders.map(p => p.name).filter(Boolean));
  const usedNames = new Set(localNames);
  const globalProviders = [];

  for (const raw of Array.isArray(globalConfig.providers) ? globalConfig.providers : []) {
    if (!raw?.name) continue;
    const provider = cloneProvider(raw, 'global');
    if (usedNames.has(provider.name)) {
      let candidate = `global:${provider.name}`;
      let i = 2;
      while (usedNames.has(candidate)) candidate = `global:${provider.name}:${i++}`;
      provider.name = candidate;
    }
    usedNames.add(provider.name);
    globalProviders.push(provider);
  }

  const providers = [...globalProviders, ...agentProviders];
  return {
    providers,
    primaryModel: agentConfig.primaryModel || null,
    fastModel: agentConfig.fastModel || null,
    language: agentConfig.language || 'en',
    needsSetup: providers.length === 0 || providers.every(p => (!p.apiKey || p.apiKey === 'proxy') && !p.credentialProvider && !p.githubToken),
  };
}
