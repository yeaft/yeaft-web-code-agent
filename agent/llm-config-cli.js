import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import {
  discoverGitHubCopilotModels,
  discoverOpenAICompatibleModels,
  GITHUB_COPILOT_PROVIDER,
  modelIdsFromProviderModels,
} from './llm-model-discovery.js';

export const DEFAULT_GITHUB_COPILOT_MODEL = 'gpt-5.5';

const VALID_PROTOCOLS = new Set(['anthropic', 'openai-responses']);
const VALID_CREDENTIAL_PROVIDERS = new Set(['github-copilot']);

export function getDefaultYeaftConfigPath() {
  return join(homedir(), '.yeaft', 'config.json');
}

export function readLocalLlmConfig(configPath = getDefaultYeaftConfigPath()) {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, 'utf8');
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config file: expected JSON object at ${configPath}`);
  }
  return parsed;
}

export function writeLocalLlmConfig(config, configPath = getDefaultYeaftConfigPath()) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function parseModelsCsv(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('--models is required and must be a comma-separated list');
  }
  const models = value.split(',').map(s => s.trim()).filter(Boolean);
  if (models.length === 0) {
    throw new Error('--models must include at least one model id');
  }
  return models;
}

export function maskApiKey(value) {
  if (!value) return value;
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function formatLlmConfig(config, { reveal = false } = {}) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const lines = [];
  lines.push(`Config: ${config.__configPath || getDefaultYeaftConfigPath()}`);
  lines.push(`Primary model: ${config.primaryModel || '(not set)'}`);
  lines.push(`Fast model: ${config.fastModel || '(not set)'}`);
  lines.push('Providers:');

  if (providers.length === 0) {
    lines.push('  (none)');
    return lines.join('\n');
  }

  for (const provider of providers) {
    lines.push(`  - ${provider.name}`);
    lines.push(`    baseUrl: ${provider.baseUrl || '(not set)'}`);
    if (provider.protocol) lines.push(`    protocol: ${provider.protocol}`);
    if (provider.credentialProvider) {
      lines.push(`    credentialProvider: ${provider.credentialProvider}`);
    } else if (provider.apiKey) {
      lines.push(`    apiKey: ${reveal ? provider.apiKey : maskApiKey(provider.apiKey)}`);
    } else {
      lines.push('    apiKey: (not set)');
    }
    const models = Array.isArray(provider.models) ? provider.models.map(formatModelEntry) : [];
    lines.push(`    models: ${models.length ? models.join(', ') : '(none)'}`);
  }

  return lines.join('\n');
}

function formatModelEntry(model) {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object' && model.id) {
    return model.protocol ? `${model.id} (${model.protocol})` : model.id;
  }
  return String(model);
}

export function addOrUpdateProvider(config, options, env = process.env) {
  const name = requireNonEmpty(options.name, '--name');
  const baseUrl = requireNonEmpty(options.baseUrl, '--base-url');
  const models = parseModelsCsv(options.models);
  validateProtocol(options.protocol);
  validateCredentials(options, env);

  const next = { ...config };
  const providers = Array.isArray(config.providers) ? [...config.providers] : [];
  const provider = {
    name,
    baseUrl,
    models,
  };
  if (options.protocol) provider.protocol = options.protocol;
  if (options.credentialProvider) provider.credentialProvider = options.credentialProvider;
  if (options.apiKey) provider.apiKey = options.apiKey;
  if (options.apiKeyEnv) provider.apiKey = env[options.apiKeyEnv];

  const index = providers.findIndex(p => p && p.name === name);
  if (index >= 0) providers[index] = provider;
  else providers.push(provider);
  next.providers = providers;

  if (options.setPrimary) next.primaryModel = qualifyModelRef(options.setPrimary, name);
  if (options.setFast) next.fastModel = qualifyModelRef(options.setFast, name);

  return {
    config: next,
    replaced: index >= 0,
    provider,
  };
}

export function setLocalModels(config, options) {
  const hasPrimary = Boolean(options.primary);
  const hasFast = Boolean(options.fast);
  if (!hasPrimary && !hasFast) {
    throw new Error('set-model requires --primary and/or --fast');
  }
  const next = { ...config };
  if (hasPrimary) next.primaryModel = requireFullModelRef(options.primary, '--primary');
  if (hasFast) next.fastModel = requireFullModelRef(options.fast, '--fast');
  return { config: next };
}

export function removeProvider(config, options) {
  const name = requireNonEmpty(options.name, '--name');
  const next = { ...config };
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const kept = providers.filter(p => !p || p.name !== name);
  const removed = kept.length !== providers.length;
  next.providers = kept;

  const cleared = [];
  if (pointsAtProvider(next.primaryModel, name)) {
    delete next.primaryModel;
    cleared.push('primaryModel');
  }
  if (pointsAtProvider(next.fastModel, name)) {
    delete next.fastModel;
    cleared.push('fastModel');
  }

  return { config: next, removed, cleared };
}

export function qualifyModelRef(model, providerName) {
  const value = requireNonEmpty(model, 'model');
  return value.includes('/') ? value : `${providerName}/${value}`;
}

function requireFullModelRef(model, flagName) {
  const value = requireNonEmpty(model, flagName);
  if (!value.includes('/')) {
    throw new Error(`${flagName} must be a full provider/model reference`);
  }
  return value;
}

function pointsAtProvider(modelRef, providerName) {
  return typeof modelRef === 'string' && modelRef.startsWith(`${providerName}/`);
}

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function validateProtocol(protocol) {
  if (protocol && !VALID_PROTOCOLS.has(protocol)) {
    throw new Error(`--protocol must be one of: ${Array.from(VALID_PROTOCOLS).join(', ')}`);
  }
}

function validateCredentials(options, env) {
  const credentialCount = [options.apiKey, options.apiKeyEnv, options.credentialProvider]
    .filter(Boolean).length;
  if (credentialCount > 1) {
    throw new Error('--api-key, --api-key-env, and --credential-provider are mutually exclusive');
  }
  if (options.credentialProvider && !VALID_CREDENTIAL_PROVIDERS.has(options.credentialProvider)) {
    throw new Error(`--credential-provider must be one of: ${Array.from(VALID_CREDENTIAL_PROVIDERS).join(', ')}`);
  }
  if (options.apiKeyEnv) {
    const envName = options.apiKeyEnv;
    if (!env[envName]) {
      throw new Error(`Environment variable ${envName} is not set`);
    }
  }
}


export async function useGitHubCopilot(config, options = {}) {
  const primaryModel = requireNonEmpty(options.model, '--model');
  const fastModel = options.fast ? String(options.fast).trim() : null;
  const discovery = await discoverGitHubCopilotModels(options);
  const discoveredIds = modelIdsFromProviderModels(discovery.providerModels);
  const allowUnknown = Boolean(options.allowUnknownModel);

  for (const model of [primaryModel, fastModel].filter(Boolean)) {
    if (!allowUnknown && !discoveredIds.includes(model)) {
      throw new Error(`Model "${model}" was not found in the GitHub Copilot model catalog. Use --allow-unknown-model to save it anyway.`);
    }
  }

  const next = { ...config };
  const providers = Array.isArray(config.providers) ? [...config.providers] : [];
  const provider = { ...GITHUB_COPILOT_PROVIDER };
  const index = providers.findIndex(p => p && p.name === provider.name);
  if (index >= 0) providers[index] = provider;
  else providers.push(provider);

  next.providers = providers;
  next.primaryModel = `${provider.name}/${primaryModel}`;
  if (fastModel) next.fastModel = `${provider.name}/${fastModel}`;
  else delete next.fastModel;

  return { config: next, provider, discovery };
}

export function hasLocalLlmConfig(config = {}) {
  const providers = Array.isArray(config.providers) ? config.providers.filter(Boolean) : [];
  return providers.length > 0 || Boolean(config.primaryModel) || Boolean(config.fastModel);
}

export function isDefaultSeedLlmConfig(config = {}) {
  const providers = Array.isArray(config.providers) ? config.providers.filter(Boolean) : [];
  if (providers.length !== 1) return false;
  const provider = providers[0];
  return provider?.name === 'my-proxy'
    && provider?.baseUrl === 'http://localhost:6628/v1'
    && provider?.apiKey === 'proxy'
    && typeof config.primaryModel === 'string'
    && config.primaryModel.startsWith('my-proxy/');
}

export async function tryAutoConfigureGitHubCopilot(configPath = getDefaultYeaftConfigPath(), options = {}) {
  let current;
  try {
    current = readLocalLlmConfig(configPath);
  } catch (error) {
    return { configured: false, reason: 'invalid-config', error, config: null };
  }

  const allowConfigured = Boolean(options.allowConfigured) || isDefaultSeedLlmConfig(current);
  if (!allowConfigured && hasLocalLlmConfig(current)) {
    return { configured: false, reason: 'already-configured', config: current };
  }

  try {
    const result = await useGitHubCopilot(current, {
      ...options,
      model: options.model || DEFAULT_GITHUB_COPILOT_MODEL,
    });
    writeLocalLlmConfig(result.config, configPath);
    return { configured: true, reason: 'configured', ...result };
  } catch (error) {
    return {
      configured: false,
      reason: error?.code === 'COPILOT_CREDENTIAL_MISSING' ? 'credential-missing' : 'unavailable',
      error,
      config: current,
    };
  }
}


export async function useOpenAICompatible(config, options = {}, env = process.env) {
  const name = options.name ? String(options.name).trim() : 'openai';
  const baseUrl = requireNonEmpty(options.baseUrl, '--base-url');
  const primaryModel = requireNonEmpty(options.model, '--model');
  const fastModel = options.fast ? String(options.fast).trim() : null;
  validateCredentials(options, env);
  const apiKey = options.apiKey || env[options.apiKeyEnv];
  const discovery = await discoverOpenAICompatibleModels({ ...options, apiKey });
  const discoveredIds = modelIdsFromProviderModels(discovery.providerModels);
  const allowUnknown = Boolean(options.allowUnknownModel);

  for (const model of [primaryModel, fastModel].filter(Boolean)) {
    if (!allowUnknown && !discoveredIds.includes(model)) {
      throw new Error(`Model "${model}" was not found in the provider model catalog. Use --allow-unknown-model to save it anyway.`);
    }
  }

  const providerModels = [...discovery.providerModels];
  if (allowUnknown) {
    const known = new Set(discoveredIds);
    for (const model of [primaryModel, fastModel].filter(Boolean)) {
      if (!known.has(model)) {
        providerModels.push(model);
        known.add(model);
      }
    }
  }

  const next = { ...config };
  const providers = Array.isArray(config.providers) ? [...config.providers] : [];
  const provider = { name, baseUrl, apiKey, protocol: 'openai-responses', models: providerModels };
  const index = providers.findIndex(p => p && p.name === provider.name);
  if (index >= 0) providers[index] = provider;
  else providers.push(provider);
  next.providers = providers;
  next.primaryModel = `${provider.name}/${primaryModel}`;
  if (fastModel) next.fastModel = `${provider.name}/${fastModel}`;
  return { config: next, provider, discovery };
}
