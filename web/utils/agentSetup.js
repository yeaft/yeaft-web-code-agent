export function getServerWsUrl(locationLike = globalThis.location) {
  const protocol = locationLike?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = locationLike?.host || 'localhost';
  return `${protocol}//${host}`;
}

export function getAgentInstallCommand() {
  return 'npm install -g @yeaft/webchat-agent';
}

export function getAgentLlmCommand() {
  return 'yeaft-agent llm use github-copilot --model gpt-5.5';
}

export function getAgentName(profile = null) {
  const base = (profile && (profile.username || profile.displayName)) || 'agent';
  let h = 0x811c9dc5;
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  const id = h.toString(16).padStart(8, '0').slice(0, 6);
  const safe = String(base).replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  return `${safe}-${id}`;
}

export function getAgentServiceCommand({
  profile = null,
  agentSecret = '',
  serverWsUrl = getServerWsUrl(),
} = {}) {
  if (!agentSecret) return '';
  const agentName = getAgentName(profile);
  return `yeaft-agent install --instance ${agentName} --server ${serverWsUrl} --secret ${agentSecret} --name ${agentName}`;
}
