/**
 * Service — Windows (pm2) platform implementation
 */
import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { SERVICE_NAME, getConfigDir, getLogDir, getNodePath, getCliPath } from './config.js';

const WIN_TASK_NAME = 'YeaftAgent';
const PM2_APP_NAME = 'yeaft-agent';

// Legacy paths for cleanup
function getWinWrapperPath() { return join(getConfigDir(), 'run.vbs'); }
function getWinBatPath() { return join(getConfigDir(), 'run.bat'); }

function ensurePm2() {
  try {
    execSync('pm2 --version', { stdio: 'pipe' });
  } catch {
    console.log('Installing pm2...');
    execSync('npm install -g pm2', { stdio: 'inherit' });
  }
}

export function getEcosystemPath() {
  return join(getConfigDir(), 'ecosystem.config.cjs');
}

function generateEcosystem(config) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const cliDir = dirname(cliPath);
  const logDir = getLogDir();

  const env = {};
  if (config.serverUrl) env.SERVER_URL = config.serverUrl;
  if (config.agentName) env.AGENT_NAME = config.agentName;
  if (config.agentSecret) env.AGENT_SECRET = config.agentSecret;
  if (config.workDir) env.WORK_DIR = config.workDir;

  return `module.exports = {
  apps: [{
    name: '${PM2_APP_NAME}',
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
  const logDir = getLogDir();
  mkdirSync(logDir, { recursive: true });

  // Generate ecosystem config
  const ecoPath = getEcosystemPath();
  writeFileSync(ecoPath, generateEcosystem(config));

  // Stop existing instance if any
  try { execSync(`pm2 delete ${PM2_APP_NAME}`, { stdio: 'pipe' }); } catch {}

  // Start with pm2
  execSync(`pm2 start "${ecoPath}"`, { stdio: 'inherit' });

  // Save pm2 process list for resurrection
  execSync('pm2 save', { stdio: 'pipe' });

  // Setup auto-start: create startup script in Windows Startup folder
  // pm2-startup doesn't work well on Windows, use Startup folder approach
  const trayScript = join(dirname(getCliPath()), 'scripts', 'agent-tray.ps1');
  const startupDir = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const startupBat = join(startupDir, `${PM2_APP_NAME}.bat`);
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

  console.log(`\nService installed and started.`);
  console.log(`  Ecosystem: ${ecoPath}`);
  console.log(`  Startup:   ${startupBat}`);
  console.log(`\nManage with:`);
  console.log(`  yeaft-agent status`);
  console.log(`  yeaft-agent logs`);
  console.log(`  yeaft-agent restart`);
  console.log(`  yeaft-agent uninstall`);
}

export function winUninstall() {
  try { execSync(`pm2 delete ${PM2_APP_NAME}`, { stdio: 'pipe' }); } catch {}
  try { execSync('pm2 save', { stdio: 'pipe' }); } catch {}
  // Clean up ecosystem config
  const ecoPath = getEcosystemPath();
  if (existsSync(ecoPath)) unlinkSync(ecoPath);
  // Clean up Startup bat
  const startupBat = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${PM2_APP_NAME}.bat`);
  if (existsSync(startupBat)) unlinkSync(startupBat);
  // Clean up legacy files
  const vbsPath = getWinWrapperPath();
  const batPath = getWinBatPath();
  if (existsSync(vbsPath)) unlinkSync(vbsPath);
  if (existsSync(batPath)) unlinkSync(batPath);
  const startupVbs = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${WIN_TASK_NAME}.vbs`);
  if (existsSync(startupVbs)) unlinkSync(startupVbs);
  console.log('Service uninstalled.');
}

export function winStart() {
  try {
    execSync(`pm2 start ${PM2_APP_NAME}`, { stdio: 'inherit' });
  } catch {
    // Try ecosystem file
    const ecoPath = getEcosystemPath();
    if (existsSync(ecoPath)) {
      execSync(`pm2 start "${ecoPath}"`, { stdio: 'inherit' });
    } else {
      console.error('Service not installed. Run "yeaft-agent install" first.');
      process.exit(1);
    }
  }
}

export function winStop() {
  try {
    execSync(`pm2 stop ${PM2_APP_NAME}`, { stdio: 'inherit' });
  } catch {
    console.error('Service not running or not installed.');
  }
}

export function winRestart() {
  try {
    execSync(`pm2 restart ${PM2_APP_NAME}`, { stdio: 'inherit' });
  } catch {
    console.error('Service not running. Use "yeaft-agent start" to start.');
  }
}

/**
 * Query pm2 for the current service status.
 * Returns { running: boolean, pid: string|null }.
 */
export function getWinServiceStatus() {
  try {
    const output = execSync('pm2 jlist', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const apps = JSON.parse(output);
    const app = Array.isArray(apps) && apps.find(a => a.name === 'yeaft-agent');
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

export function winStatus() {
  try {
    execSync(`pm2 describe ${PM2_APP_NAME}`, { stdio: 'inherit' });
  } catch {
    console.log('Service is not installed.');
  }
}

export function winLogs() {
  const child = spawn('pm2', ['logs', PM2_APP_NAME, '--lines', '100'], {
    stdio: 'inherit',
    shell: true
  });
  child.on('error', () => {
    // Fallback to reading log file directly
    const logFile = join(getLogDir(), 'out.log');
    if (existsSync(logFile)) {
      console.log(readFileSync(logFile, 'utf-8'));
    } else {
      console.log('No logs found.');
    }
  });
}
