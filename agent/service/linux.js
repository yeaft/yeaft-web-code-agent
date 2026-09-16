/*
 * Service — Linux (systemd) platform implementation
 */
import { execSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { getServiceName, getLogDir, getNodePath, getCliPath, DEFAULT_INSTANCE_ID } from './config.js';

/** Pure path getter — no side effects (no directory creation). */
export function getSystemdServicePath(instanceId = DEFAULT_INSTANCE_ID) {
  return join(homedir(), '.config', 'systemd', 'user', `${getServiceName(instanceId)}.service`);
}

// systemd unit values use C-style quoting and percent specifier expansion.
function quoteUnit(value, { executable = false } = {}) {
  let escaped = String(value).replace(/%/g, '%%');
  if (executable) escaped = escaped.replace(/\$/g, '$$$$');
  return JSON.stringify(escaped);
}

function unitPath(value) {
  const path = String(value);
  if (/[\r\n\0]/.test(path)) throw new Error('Service paths cannot contain line breaks or NUL');
  return path.replace(/%/g, '%%');
}

export function generateSystemdUnit(config) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const logDir = getLogDir(config.instanceId);
  const envLines = [];
  if (config.instanceId) envLines.push(`Environment=${quoteUnit(`YEAFT_AGENT_INSTANCE=${config.instanceId}`)}`);
  if (config.serverUrl) envLines.push(`Environment=${quoteUnit(`SERVER_URL=${config.serverUrl}`)}`);
  if (config.agentName) envLines.push(`Environment=${quoteUnit(`AGENT_NAME=${config.agentName}`)}`);
  if (config.agentSecret) envLines.push(`Environment=${quoteUnit(`AGENT_SECRET=${config.agentSecret}`)}`);
  if (config.workDir) envLines.push(`Environment=${quoteUnit(`WORK_DIR=${config.workDir}`)}`);
  if (config.yeaftDir) envLines.push(`Environment=${quoteUnit(`YEAFT_DIR=${config.yeaftDir}`)}`);

  // Include node's bin dir in PATH for claude CLI access
  const nodeBinDir = dirname(nodePath);

  return `[Unit]
Description=Yeaft WebChat Agent (${config.instanceId || DEFAULT_INSTANCE_ID})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quoteUnit(nodePath, { executable: true })} ${quoteUnit(cliPath, { executable: true })}
WorkingDirectory=${unitPath(config.workDir || homedir())}
Restart=on-failure
RestartSec=10
KillMode=mixed
TimeoutStopSec=15
${envLines.join('\n')}
Environment=${quoteUnit(`PATH=${nodeBinDir}:${homedir()}/.local/bin:${homedir()}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`)}

StandardOutput=append:${unitPath(`${logDir}/out.log`)}
StandardError=append:${unitPath(`${logDir}/error.log`)}

[Install]
WantedBy=default.target
`;
}

export function linuxInstall(config) {
  const serviceName = getServiceName(config.instanceId);
  const servicePath = getSystemdServicePath(config.instanceId);
  // Ensure systemd user directory exists before writing
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  mkdirSync(getLogDir(config.instanceId), { recursive: true });
  writeFileSync(servicePath, generateSystemdUnit(config));
  execSync('systemctl --user daemon-reload');
  execSync(`systemctl --user enable ${serviceName}`);
  execSync(`systemctl --user start ${serviceName}`);
  console.log(`Service installed and started: ${serviceName}`);
  console.log(`\nManage with:`);
  console.log(`  yeaft-agent status --name ${config.instanceId}`);
  console.log(`  yeaft-agent logs --name ${config.instanceId}`);
  console.log(`  yeaft-agent restart --name ${config.instanceId}`);
  console.log(`  yeaft-agent uninstall --name ${config.instanceId}`);
  console.log(`\nTo run when not logged in:`);
  console.log(`  sudo loginctl enable-linger $(whoami)`);
}

export function linuxUninstall(instanceId = DEFAULT_INSTANCE_ID) {
  const serviceName = getServiceName(instanceId);
  try { execSync(`systemctl --user stop ${serviceName} 2>/dev/null`); } catch {}
  try { execSync(`systemctl --user disable ${serviceName} 2>/dev/null`); } catch {}
  const servicePath = getSystemdServicePath(instanceId);
  if (existsSync(servicePath)) unlinkSync(servicePath);
  try { execSync('systemctl --user daemon-reload'); } catch {}
  console.log(`Service uninstalled: ${serviceName}`);
}

export function linuxStart(instanceId = DEFAULT_INSTANCE_ID) {
  const serviceName = getServiceName(instanceId);
  execSync(`systemctl --user start ${serviceName}`, { stdio: 'inherit' });
  console.log(`Service started: ${serviceName}`);
}

export function linuxStop(instanceId = DEFAULT_INSTANCE_ID) {
  const serviceName = getServiceName(instanceId);
  execSync(`systemctl --user stop ${serviceName}`, { stdio: 'inherit' });
  console.log(`Service stopped: ${serviceName}`);
}

export function linuxRestart(instanceId = DEFAULT_INSTANCE_ID) {
  const serviceName = getServiceName(instanceId);
  execSync(`systemctl --user restart ${serviceName}`, { stdio: 'inherit' });
  console.log(`Service restarted: ${serviceName}`);
}

/**
 * Query systemd for the current service status.
 * Returns { running: boolean, pid: string|null }.
 */
export function getLinuxServiceStatus(instanceId = DEFAULT_INSTANCE_ID) {
  const serviceName = getServiceName(instanceId);
  try {
    const output = execSync(`systemctl --user is-active ${serviceName}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (output === 'active') {
      let pid = null;
      try {
        pid = execSync(`systemctl --user show ${serviceName} --property=MainPID --value`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (pid === '0') pid = null;
      } catch {}
      return { running: true, pid };
    }
    return { running: false, pid: null };
  } catch {
    return { running: false, pid: null };
  }
}

export function linuxStatus(instanceId = DEFAULT_INSTANCE_ID) {
  try {
    execSync(`systemctl --user status ${getServiceName(instanceId)}`, { stdio: 'inherit' });
  } catch {
    // systemctl status returns non-zero when service is stopped
  }
}

export function linuxLogs(instanceId = DEFAULT_INSTANCE_ID) {
  const serviceName = getServiceName(instanceId);
  try {
    execSync(`journalctl --user -u ${serviceName} -f --no-pager -n 100`, { stdio: 'inherit' });
  } catch {
    // Fallback to log files
    const logFile = join(getLogDir(instanceId), 'out.log');
    if (existsSync(logFile)) {
      execSync(`tail -f -n 100 ${logFile}`, { stdio: 'inherit' });
    } else {
      console.log('No logs found.');
    }
  }
}
