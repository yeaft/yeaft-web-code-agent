import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { CONFIG } from './config.js';
import { agents, webClients } from './context.js';
import { sendToAgent, sendToWebClient } from './ws-utils.js';
import { llmConfigDb } from './db/llm-config-db.js';

const COPILOT_OAUTH_CLIENT_ID = 'Ov23li8tweQw6odWQebz';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEFAULT_GITHUB_PROVIDER = {
  name: 'github-copilot',
  baseUrl: 'https://api.githubcopilot.com',
  protocol: 'openai-responses',
  credentialProvider: 'github-copilot',
  models: [
    { id: 'claude-sonnet-4.5', protocol: 'anthropic' },
    'gpt-5',
  ],
};

const MASK = '********';

function secretKey() {
  return createHash('sha256')
    .update(String(CONFIG.jwtSecret || 'default-secret-change-in-production'))
    .update('\0yeaft-global-llm-config')
    .digest();
}

export function encryptSecret(value) {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptSecret(value) {
  if (!value) return '';
  if (typeof value !== 'string' || !value.startsWith('v1:')) return '';
  const [, ivB64, tagB64, dataB64] = value.split(':');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function cloneConfig(config) {
  return {
    providers: Array.isArray(config?.providers) ? config.providers.map(p => ({ ...p, models: Array.isArray(p.models) ? p.models.map(m => typeof m === 'object' && m ? { ...m } : m) : [] })) : [],
  };
}

function normalizeProvider(provider = {}) {
  const out = {
    type: provider.type === 'github-device' ? 'github-device' : 'api-key',
    scope: 'global',
    name: String(provider.name || '').trim(),
    baseUrl: String(provider.baseUrl || '').trim(),
    protocol: provider.protocol || 'openai-responses',
    models: Array.isArray(provider.models) ? provider.models : [],
  };
  if (provider.credentialProvider) out.credentialProvider = provider.credentialProvider;
  if (provider.apiKeyEncrypted) out.apiKeyEncrypted = provider.apiKeyEncrypted;
  if (provider.githubTokenEncrypted) out.githubTokenEncrypted = provider.githubTokenEncrypted;
  if (provider.apiKey) out.apiKey = provider.apiKey;
  if (provider.githubToken) out.githubToken = provider.githubToken;
  return out;
}

function validateProvider(provider) {
  if (!provider.name) throw new Error('Provider name is required');
  if (!provider.baseUrl) throw new Error(`Provider "${provider.name}" must have a baseUrl`);
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    throw new Error(`Provider "${provider.name}" must have at least one model`);
  }
}

export function readGlobalLlmConfigForAgent(userId) {
  const saved = llmConfigDb.get(userId);
  const config = cloneConfig(saved || { providers: [] });
  config.providers = config.providers.map(provider => {
    const p = normalizeProvider(provider);
    if (p.apiKeyEncrypted) p.apiKey = decryptSecret(p.apiKeyEncrypted);
    if (p.githubTokenEncrypted) p.githubToken = decryptSecret(p.githubTokenEncrypted);
    delete p.apiKeyEncrypted;
    delete p.githubTokenEncrypted;
    return p;
  });
  return config;
}

export function readGlobalLlmConfigForWeb(userId) {
  const saved = llmConfigDb.get(userId);
  const config = cloneConfig(saved || { providers: [] });
  config.providers = config.providers.map(provider => {
    const p = normalizeProvider(provider);
    if (p.apiKeyEncrypted) p.apiKey = MASK;
    if (p.githubTokenEncrypted) p.githubToken = MASK;
    p.hasSecret = !!(provider.apiKeyEncrypted || provider.githubTokenEncrypted);
    delete p.apiKeyEncrypted;
    delete p.githubTokenEncrypted;
    return p;
  });
  return config;
}

export function saveGlobalLlmConfigFromWeb(userId, update = {}) {
  const current = llmConfigDb.get(userId) || { providers: [] };
  const currentByName = new Map((current.providers || []).map(p => [p.name, p]));
  const names = new Set();
  const providers = (Array.isArray(update.providers) ? update.providers : []).map(raw => {
    const p = normalizeProvider(raw);
    validateProvider(p);
    if (names.has(p.name)) throw new Error(`Duplicate global provider name "${p.name}"`);
    names.add(p.name);
    const prev = currentByName.get(p.name);
    if (p.type === 'github-device') {
      p.credentialProvider = 'github-copilot';
      p.apiKeyEncrypted = null;
      if (p.githubToken && p.githubToken !== MASK) p.githubTokenEncrypted = encryptSecret(p.githubToken);
      else if (prev?.githubTokenEncrypted) p.githubTokenEncrypted = prev.githubTokenEncrypted;
      else if (prev?.apiKeyEncrypted) p.githubTokenEncrypted = prev.apiKeyEncrypted;
      delete p.githubToken;
      delete p.apiKey;
    } else {
      p.credentialProvider = p.credentialProvider || null;
      p.githubTokenEncrypted = null;
      if (p.apiKey && p.apiKey !== MASK) p.apiKeyEncrypted = encryptSecret(p.apiKey);
      else if (prev?.apiKeyEncrypted) p.apiKeyEncrypted = prev.apiKeyEncrypted;
      delete p.apiKey;
      delete p.githubToken;
    }
    return p;
  });
  const config = { providers };
  llmConfigDb.set(userId, config);
  return readGlobalLlmConfigForWeb(userId);
}

export async function sendGlobalLlmConfigToAgent(agentId) {
  const agent = agents.get(agentId);
  if (!agent?.ownerId) return;
  await sendToAgent(agentId, {
    type: 'llm_global_config_updated',
    globalConfig: readGlobalLlmConfigForAgent(agent.ownerId),
  });
}

export async function sendGlobalLlmConfigToUserAgents(userId) {
  const tasks = [];
  for (const [agentId, agent] of agents) {
    if (agent.ownerId === userId) tasks.push(sendGlobalLlmConfigToAgent(agentId));
  }
  await Promise.all(tasks);
}

export async function broadcastGlobalLlmConfigToWeb(userId, agentId = null) {
  const globalConfig = readGlobalLlmConfigForWeb(userId);
  for (const [, client] of webClients) {
    if (!client.authenticated) continue;
    if (!CONFIG.skipAuth && client.userId !== userId) continue;
    await sendToWebClient(client, {
      type: 'llm_global_config_updated',
      agentId,
      globalConfig,
    });
  }
}

export async function startGithubDeviceFlow({ fetchFn = fetch } = {}) {
  const res = await fetchFn(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: COPILOT_OAUTH_CLIENT_ID, scope: 'read:user' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code) {
    throw new Error(`GitHub device flow start failed: HTTP ${res.status}`);
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval || 5,
  };
}

export async function pollGithubDeviceFlow({ deviceCode, fetchFn = fetch } = {}) {
  if (!deviceCode) throw new Error('deviceCode is required');
  const res = await fetchFn(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: COPILOT_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    return { ok: false, pending: data.error === 'authorization_pending' || data.error === 'slow_down', error: data.error, interval: data.error === 'slow_down' ? 10 : undefined };
  }
  if (!res.ok || !data.access_token) {
    throw new Error(`GitHub device flow poll failed: HTTP ${res.status}`);
  }
  const provider = {
    ...DEFAULT_GITHUB_PROVIDER,
    type: 'github-device',
    githubToken: data.access_token,
  };
  return { ok: true, provider };
}
