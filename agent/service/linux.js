/**
 * Service — Linux (systemd) platform implementation
 */
import { execSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { SERVICE_NAME, getLogDir, getNodePath, getCliPath } from './config.js';

export function getSystemdServicePath() {
  const dir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${SERVICE_NAME}.service`);
}

function generateSystemdUnit(config) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const envLines = [];
  if (config.serverUrl) envLines.push(`Environment=SERVER_URL=${config.serverUrl}`);
  if (config.agentName) envLines.push(`Environment=AGENT_NAME=${config.agentName}`);
  if (config.agentSecret) envLines.push(`Environment=AGENT_SECRET=${config.agentSecret}`);
  if (config.workDir) envLines.push(`Environment=WORK_DIR=${config.workDir}`);

  // Include node's bin dir in PATH for claude CLI access
  const nodeBinDir = dirname(nodePath);

  return `[Unit]
Description=Yeaft WebChat Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${cliPath}
WorkingDirectory=${config.workDir || homedir()}
Restart=on-failure
RestartSec=10
KillMode=process
${envLines.join('\n')}
Environment=PATH=${nodeBinDir}:${homedir()}/.local/bin:${homedir()}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

StandardOutput=append:${getLogDir()}/out.log
StandardError=append:${getLogDir()}/error.log

[Install]
WantedBy=default.target
`;
}

export function linuxInstall(config) {
  const servicePath = getSystemdServicePath();
  writeFileSync(servicePath, generateSystemdUnit(config));
  execSync('systemctl --user daemon-reload');
  execSync(`systemctl --user enable ${SERVICE_NAME}`);
  execSync(`systemctl --user start ${SERVICE_NAME}`);
  console.log(`Service installed and started.`);
  console.log(`\nManage with:`);
  console.log(`  yeaft-agent status`);
  console.log(`  yeaft-agent logs`);
  console.log(`  yeaft-agent restart`);
  console.log(`  yeaft-agent uninstall`);
  console.log(`\nTo run when not logged in:`);
  console.log(`  sudo loginctl enable-linger $(whoami)`);
}

export function linuxUninstall() {
  try { execSync(`systemctl --user stop ${SERVICE_NAME} 2>/dev/null`); } catch {}
  try { execSync(`systemctl --user disable ${SERVICE_NAME} 2>/dev/null`); } catch {}
  const servicePath = getSystemdServicePath();
  if (existsSync(servicePath)) unlinkSync(servicePath);
  try { execSync('systemctl --user daemon-reload'); } catch {}
  console.log('Service uninstalled.');
}

export function linuxStart() {
  execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: 'inherit' });
  console.log('Service started.');
}

export function linuxStop() {
  execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'inherit' });
  console.log('Service stopped.');
}

export function linuxRestart() {
  execSync(`systemctl --user restart ${SERVICE_NAME}`, { stdio: 'inherit' });
  console.log('Service restarted.');
}

/**
 * Query systemd for the current service status.
 * Returns { running: boolean, pid: string|null }.
 */
export function getLinuxServiceStatus() {
  try {
    const output = execSync(`systemctl --user is-active ${SERVICE_NAME}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (output === 'active') {
      let pid = null;
      try {
        pid = execSync(`systemctl --user show ${SERVICE_NAME} --property=MainPID --value`, {
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

export function linuxStatus() {
  try {
    execSync(`systemctl --user status ${SERVICE_NAME}`, { stdio: 'inherit' });
  } catch {
    // systemctl status returns non-zero when service is stopped
  }
}

export function linuxLogs() {
  try {
    execSync(`journalctl --user -u ${SERVICE_NAME} -f --no-pager -n 100`, { stdio: 'inherit' });
  } catch {
    // Fallback to log files
    const logFile = join(getLogDir(), 'out.log');
    if (existsSync(logFile)) {
      execSync(`tail -f -n 100 ${logFile}`, { stdio: 'inherit' });
    } else {
      console.log('No logs found.');
    }
  }
}
