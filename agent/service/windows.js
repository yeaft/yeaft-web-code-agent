/*
 * Service — Windows (pm2) platform implementation
 */
import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { getConfigDir, getLogDir, getNodePath, getCliPath, getPm2AppName, DEFAULT_INSTANCE_ID } from './config.js';

const WIN_TASK_NAME = 'YeaftAgent';

// Legacy paths for cleanup
function getWinWrapperPath(instanceId = DEFAULT_INSTANCE_ID) { return join(getConfigDir(instanceId), 'run.vbs'); }
function getWinBatPath(instanceId = DEFAULT_INSTANCE_ID) { return join(getConfigDir(instanceId), 'run.bat'); }

function ensurePm2() {
  try {
    execSync('pm2 --version', { stdio: 'pipe' });
  } catch {
    console.log('Installing pm2...');
    execSync('npm install -g pm2', { stdio: 'inherit' });
  }
}

export function getEcosystemPath(instanceId = DEFAULT_INSTANCE_ID) {
  return join(getConfigDir(instanceId), 'ecosystem.config.cjs');
}

function generateEcosystem(config) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const cliDir = dirname(cliPath);
  const logDir = getLogDir(config.instanceId);
  const pm2AppName = getPm2AppName(config.instanceId);

  const env = {};
  if (config.instanceId) env.YEAFT_AGENT_INSTANCE = config.instanceId;
  if (config.serverUrl) env.SERVER_URL = config.serverUrl;
  if (config.agentName) env.AGENT_NAME = config.agentName;
  if (config.agentSecret) env.AGENT_SECRET = config.agentSecret;
  if (config.workDir) env.WORK_DIR = config.workDir;
  if (config.yeaftDir) env.YEAFT_DIR = config.yeaftDir;

  return `module.exports = {
  apps: [{
    name: '${pm2AppName}',
    script: '${cliPath.replace(/\\/g, '\\\\')}',
    interpreter: '${nodePath.replace(/\\/g, '\\\\')}',
    cwd: '${cliDir.replace(/\\/g, '\\\\')}',
    env: ${JSON.stringify(env, null, 6)},
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '${join(logDir, 'error.log').replace(/\\/g, '\\\\')}',
    out_file: '${join(logDir, 'out.log').replace(/\\/g, '\\\\')}',
    merge_logs: true,
    max_memory_restart: '500M',
  }]
};
`;
}

export function winInstall(config) {
  ensurePm2();
  const logDir = getLogDir(config.instanceId);
  const pm2AppName = getPm2AppName(config.instanceId);
  mkdirSync(logDir, { recursive: true });

  // Generate ecosystem config
  const ecoPath = getEcosystemPath(config.instanceId);
  writeFileSync(ecoPath, generateEcosystem(config));

  // Stop existing instance if any
  try { execSync(`pm2 delete ${pm2AppName}`, { stdio: 'pipe' }); } catch {}

  // Start with pm2
  execSync(`pm2 start "${ecoPath}"`, { stdio: 'inherit' });

  // Save pm2 process list for resurrection
  execSync('pm2 save', { stdio: 'pipe' });

  // Setup auto-start: create startup script in Windows Startup folder
  // pm2-startup doesn't work well on Windows, use Startup folder approach
  const trayScript = join(dirname(getCliPath()), 'scripts', 'agent-tray.ps1');
  const startupDir = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const startupBat = join(startupDir, `${pm2AppName}.bat`);
  // Resurrect pm2 processes + launch tray icon
  let batContent = `@echo off\r\npm2 resurrect\r\n`;
  if (existsSync(trayScript)) {
    batContent += `start "" powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File "${trayScript}"\r\n`;
  }
  writeFileSync(startupBat, batContent);

  // Launch tray now
  if (existsSync(trayScript)) {
    spawn('powershell', ['-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', trayScript], {
      detached: true, stdio: 'ignore'
    }).unref();
  }

  console.log(`\nService installed and started: ${pm2AppName}`);
  console.log(`  Ecosystem: ${ecoPath}`);
  console.log(`  Startup:   ${startupBat}`);
  console.log(`\nManage with:`);
  console.log(`  yeaft-agent status --instance ${config.instanceId}`);
  console.log(`  yeaft-agent logs --instance ${config.instanceId}`);
  console.log(`  yeaft-agent restart --instance ${config.instanceId}`);
  console.log(`  yeaft-agent uninstall --instance ${config.instanceId}`);
}

export function winUninstall(instanceId = DEFAULT_INSTANCE_ID) {
  const pm2AppName = getPm2AppName(instanceId);
  try { execSync(`pm2 delete ${pm2AppName}`, { stdio: 'pipe' }); } catch {}
  try { execSync('pm2 save', { stdio: 'pipe' }); } catch {}
  // Clean up ecosystem config
  const ecoPath = getEcosystemPath(instanceId);
  if (existsSync(ecoPath)) unlinkSync(ecoPath);
  // Clean up Startup bat
  const startupBat = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${pm2AppName}.bat`);
  if (existsSync(startupBat)) unlinkSync(startupBat);
  // Clean up legacy files
  const vbsPath = getWinWrapperPath(instanceId);
  const batPath = getWinBatPath(instanceId);
  if (existsSync(vbsPath)) unlinkSync(vbsPath);
  if (existsSync(batPath)) unlinkSync(batPath);
  const startupVbs = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${WIN_TASK_NAME}.vbs`);
  if (existsSync(startupVbs)) unlinkSync(startupVbs);
  console.log(`Service uninstalled: ${pm2AppName}`);
}

export function winStart(instanceId = DEFAULT_INSTANCE_ID) {
  const pm2AppName = getPm2AppName(instanceId);
  try {
    execSync(`pm2 start ${pm2AppName}`, { stdio: 'inherit' });
  } catch {
    // Try ecosystem file
    const ecoPath = getEcosystemPath(instanceId);
    if (existsSync(ecoPath)) {
      execSync(`pm2 start "${ecoPath}"`, { stdio: 'inherit' });
    } else {
      console.error('Service not installed. Run "yeaft-agent install" first.');
      process.exit(1);
    }
  }
}

export function winStop(instanceId = DEFAULT_INSTANCE_ID) {
  try {
    execSync(`pm2 stop ${getPm2AppName(instanceId)}`, { stdio: 'inherit' });
  } catch {
    console.error('Service not running or not installed.');
  }
}

export function winRestart(instanceId = DEFAULT_INSTANCE_ID) {
  try {
    execSync(`pm2 restart ${getPm2AppName(instanceId)}`, { stdio: 'inherit' });
  } catch {
    console.error('Service not running. Use "yeaft-agent start" to start.');
  }
}

/**
 * Query pm2 for the current service status.
 * Returns { running: boolean, pid: string|null }.
 */
export function getWinServiceStatus(instanceId = DEFAULT_INSTANCE_ID) {
  const pm2AppName = getPm2AppName(instanceId);
  try {
    const output = execSync('pm2 jlist', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const apps = JSON.parse(output);
    const app = Array.isArray(apps) && apps.find(a => a.name === pm2AppName);
    if (app) {
      const running = app.pm2_env && app.pm2_env.status === 'online';
      const pid = running ? app.pid : null;
      return { running, pid: pid ? String(pid) : null };
    }
    return { running: false, pid: null };
  } catch {
    return { running: false, pid: null };
  }
}

export function winStatus(instanceId = DEFAULT_INSTANCE_ID) {
  try {
    execSync(`pm2 describe ${getPm2AppName(instanceId)}`, { stdio: 'inherit' });
  } catch {
    console.log('Service is not installed.');
  }
}

export function winLogs(instanceId = DEFAULT_INSTANCE_ID) {
  const pm2AppName = getPm2AppName(instanceId);
  const child = spawn('pm2', ['logs', pm2AppName, '--lines', '100'], {
    stdio: 'inherit',
    shell: true
  });
  child.on('error', () => {
    // Fallback to reading log file directly
    const logFile = join(getLogDir(instanceId), 'out.log');
    if (existsSync(logFile)) {
      console.log(readFileSync(logFile, 'utf-8'));
    } else {
      console.log('No logs found.');
    }
  });
}
