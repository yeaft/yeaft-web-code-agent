export function getServerWsUrl(locationLike = globalThis.location) {
  const protocol = locationLike?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = locationLike?.host || 'localhost';
  return `${protocol}//${host}`;
}

export function getInstallerBaseUrl(locationLike = globalThis.location) {
  const origin = locationLike?.origin;
  if (origin && origin !== 'null') return origin.replace(/\/$/, '');
  const protocol = locationLike?.protocol === 'https:' ? 'https:' : 'http:';
  const host = locationLike?.host || 'localhost';
  return `${protocol}//${host}`;
}

export function escapePosixArgument(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function escapePowerShellArgument(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function getAgentInstallerCommand({
  platform = 'posix',
  agentSecret = '',
  serverWsUrl,
  locationLike = globalThis.location,
} = {}) {
  if (!agentSecret) return '';
  const server = serverWsUrl || getServerWsUrl(locationLike);
  const baseUrl = getInstallerBaseUrl(locationLike);

  if (platform === 'powershell') {
    const scriptUrl = escapePowerShellArgument(`${baseUrl}/installers/install.ps1`);
    return `& { param($Server, $Secret) $tls = [Net.ServicePointManager]::SecurityProtocol; try { [Net.ServicePointManager]::SecurityProtocol = $tls -bor [Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing ${scriptUrl} -MaximumRedirection 0 -ErrorAction Stop).Content)) -Server $Server -Secret $Secret } finally { [Net.ServicePointManager]::SecurityProtocol = $tls } } -Server ${escapePowerShellArgument(server)} -Secret ${escapePowerShellArgument(agentSecret)}`;
  }

  const scriptUrl = escapePosixArgument(`${baseUrl}/installers/install.sh`);
  const transport = baseUrl.startsWith('https:')
    ? "--proto '=https' --proto-redir '=https' --tlsv1.2"
    : "--proto '=http,https' --proto-redir '=http,https'";
  return `(tmp=$(mktemp) && trap 'rm -f "$tmp"' EXIT && curl -fSL ${transport} ${scriptUrl} -o "$tmp" && sh "$tmp" --server ${escapePosixArgument(server)} --secret ${escapePosixArgument(agentSecret)})`;
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
  return `yeaft-agent install --server ${serverWsUrl} --secret ${agentSecret} --name ${agentName}`;
}

export function getAgentContainerCommand({
  profile = null,
  agentSecret = '',
  serverWsUrl = getServerWsUrl(),
} = {}) {
  if (!agentSecret) return '';
  const agentName = getAgentName(profile);
  return `yeaft-agent container install --server ${serverWsUrl} --secret ${agentSecret} --name ${agentName}`;
}
