#!/usr/bin/env node
/**
 * CLI entry point for @yeaft/webchat-agent
 * Parses command-line arguments and starts the agent or runs subcommands
 */
import { assertNodeVersion } from './check-node-version.js';
assertNodeVersion({ component: '@yeaft/webchat-agent' });

import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

const args = process.argv.slice(2);
const command = args[0];
const subArgs = args.slice(1);

// Service management subcommands
const SERVICE_COMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs'];

if (command === 'doctor') {
  handleDoctorCommand();
} else if (command === 'upgrade') {
  upgrade();
} else if (command === '--version' || command === '-v') {
  console.log(pkg.version);
} else if (command === '--help' || command === '-h') {
  printHelp();
} else if (SERVICE_COMMANDS.includes(command)) {
  handleServiceCommand(command, subArgs);
} else {
  // Normal agent startup — parse flags and set env vars
  parseAndStart(args);
}

function printHelp() {
  console.log(`
  ${pkg.name} v${pkg.version}

  Usage:
    yeaft-agent [options]              Run agent in foreground
    yeaft-agent install [options]      Install as system service
    yeaft-agent uninstall              Remove system service
    yeaft-agent start                  Start installed service
    yeaft-agent stop                   Stop installed service
    yeaft-agent restart                Restart installed service
    yeaft-agent status                 Show service status
    yeaft-agent logs                   View service logs (follow mode)
    yeaft-agent doctor                 Diagnose service configuration
    yeaft-agent upgrade                Upgrade to latest version
    yeaft-agent --version              Show version

  Options:
    --server <url>      WebSocket server URL (default: ws://localhost:3456)
    --name <name>       Agent display name (default: Worker-{platform}-{pid})
    --secret <secret>   Agent secret for authentication
    --work-dir <dir>    Default working directory (default: cwd)
    --auto-upgrade      Check for updates on startup

  Environment variables (alternative to flags):
    SERVER_URL          WebSocket server URL
    AGENT_NAME          Agent display name
    AGENT_SECRET        Agent secret
    WORK_DIR            Working directory

  Examples:
    yeaft-agent --server wss://your-server.com --name my-worker --secret xxx
    yeaft-agent install --server wss://your-server.com --name my-worker --secret xxx
    yeaft-agent status
    yeaft-agent logs
`);
}

async function handleServiceCommand(command, args) {
  const service = await import('./service.js');
  switch (command) {
    case 'install':   service.install(args); break;
    case 'uninstall': service.uninstall(); break;
    case 'start':     service.start(); break;
    case 'stop':      service.stop(); break;
    case 'restart':   service.restart(); break;
    case 'status':    service.status(); break;
    case 'logs':      service.logs(); break;
  }
}

async function handleDoctorCommand() {
  const { doctor } = await import('./service.js');
  doctor();
}

function parseAndStart(args) {
  // Parse CLI flags → set environment variables (env vars take precedence over flags)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--server':
        if (next) { process.env.SERVER_URL = process.env.SERVER_URL || next; i++; }
        break;
      case '--name':
        if (next) { process.env.AGENT_NAME = process.env.AGENT_NAME || next; i++; }
        break;
      case '--secret':
        if (next) { process.env.AGENT_SECRET = process.env.AGENT_SECRET || next; i++; }
        break;
      case '--work-dir':
        if (next) { process.env.WORK_DIR = process.env.WORK_DIR || next; i++; }
        break;
      case '--auto-upgrade':
        checkForUpdates();
        break;
      default:
        if (arg.startsWith('-')) {
          console.warn(`Unknown option: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }

  // Import and start the agent
  import('./index.js');
}

async function checkForUpdates() {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`);
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.version;
    if (latest && latest !== pkg.version) {
      console.log(`\n  Update available: ${pkg.version} → ${latest}`);
      console.log(`  Run "yeaft-agent upgrade" to update\n`);
    }
  } catch {
    // Silently ignore — network may be unavailable
  }
}

function upgrade() {
  console.log(`Current version: ${pkg.version}`);
  console.log('Checking for updates...');

  try {
    const latest = execSync(`npm view ${pkg.name} version`, { encoding: 'utf-8' }).trim();
    if (latest === pkg.version) {
      console.log('Already up to date.');
      return;
    }
    console.log(`Upgrading to ${latest}...`);

    if (platform() === 'win32') {
      // On Windows, the current process locks its own files. npm cannot overwrite
      // them while this process is running. Spawn a detached bat script that waits
      // for us to exit, then runs npm install, then optionally restarts the service.
      upgradeWindows(latest);
    } else {
      execSync(`npm install -g ${pkg.name}@latest`, { stdio: 'inherit' });
      console.log(`Successfully upgraded to ${latest}`);

      // If PM2 is managing yeaft-agent, restart it so the new version takes effect
      try {
        const pm2List = execSync('pm2 jlist', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const apps = JSON.parse(pm2List);
        if (Array.isArray(apps) && apps.some(app => app.name === 'yeaft-agent')) {
          console.log('Restarting yeaft-agent via PM2...');
          execSync('pm2 restart yeaft-agent', { stdio: 'inherit' });
          console.log('PM2 service restarted.');
        }
      } catch {
        // PM2 not installed or not managing yeaft-agent — nothing to do
      }
    }
  } catch (e) {
    console.error('Upgrade failed:', e.message);
    process.exit(1);
  }
}

function upgradeWindows(latestVersion) {
  const configDir = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'yeaft-agent');
  mkdirSync(configDir, { recursive: true });
  const logDir = join(configDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const batPath = join(configDir, 'upgrade-cli.bat');
  const vbsPath = join(configDir, 'upgrade-cli.vbs');
  const logPath = join(logDir, 'upgrade.log');
  const pid = process.pid;
  const pkgSpec = `${pkg.name}@${latestVersion}`;

  // --- PM2 handling: delete app before exit to prevent auto-restart ---
  let isPm2 = false;
  const ecoPath = join(configDir, 'ecosystem.config.cjs');
  try {
    const pm2List = execSync('pm2 jlist', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const apps = JSON.parse(pm2List);
    isPm2 = Array.isArray(apps) && apps.some(app => app.name === 'yeaft-agent');
    if (isPm2) {
      execSync('pm2 delete yeaft-agent', { stdio: 'pipe' });
      console.log('PM2 app deleted to prevent auto-restart during upgrade.');
    }
  } catch {
    // PM2 not installed or not managing yeaft-agent — continue
  }

  const batLines = [
    '@echo off',
    'setlocal',
    `set PID=${pid}`,
    `set PKG=${pkgSpec}`,
    `set LOGFILE=${logPath}`,
    `set MAX_WAIT=30`,
    `set COUNT=0`,
    '',
    ':: Change to temp dir to avoid EBUSY on cwd',
    'cd /d "%TEMP%"',
    '',
    'echo [Upgrade] Started at %date% %time% > "%LOGFILE%"',
    `echo [Upgrade] Version: ${pkg.version} -> ${latestVersion} >> "%LOGFILE%"`,
    `echo [Upgrade] PM2 managed: ${isPm2 ? 'yes (deleted pre-exit)' : 'no'} >> "%LOGFILE%"`,
    'echo [Upgrade] Waiting for CLI process (PID %PID%) to exit... >> "%LOGFILE%"',
    '',
    ':WAIT_LOOP',
    'tasklist /FI "PID eq %PID%" /NH 2>NUL | findstr /C:"%PID%" >NUL',
    'if errorlevel 1 goto PID_EXITED',
    'set /A COUNT+=1',
    'if %COUNT% GEQ %MAX_WAIT% (',
    '  echo [Upgrade] Timeout waiting for PID %PID% to exit after %MAX_WAIT%s >> "%LOGFILE%"',
    '  goto PID_EXITED',
    ')',
    'ping -n 3 127.0.0.1 >NUL',
    'goto WAIT_LOOP',
    ':PID_EXITED',
    '',
    ':: Extra wait for file locks to release',
    'echo [Upgrade] Process exited at %time%, waiting for file locks... >> "%LOGFILE%"',
    'ping -n 5 127.0.0.1 >NUL',
    '',
    'echo [Upgrade] Running npm install -g %PKG%... >> "%LOGFILE%"',
    'call npm install -g %PKG% >> "%LOGFILE%" 2>&1',
    'if not "%errorlevel%"=="0" (',
    '  echo [Upgrade] npm install failed with exit code %errorlevel% at %time% >> "%LOGFILE%"',
    '  goto PM2_RESTART',
    ')',
    'echo [Upgrade] npm install succeeded at %time% >> "%LOGFILE%"',
  ];

  // PM2 re-registration after successful upgrade
  batLines.push(
    '',
    ':PM2_RESTART',
  );
  if (isPm2) {
    batLines.push(
      'echo [Upgrade] Re-registering agent via PM2... >> "%LOGFILE%"',
      `if exist "${ecoPath}" (`,
      `  call pm2 start "${ecoPath}" >> "%LOGFILE%" 2>&1`,
      '  call pm2 save >> "%LOGFILE%" 2>&1',
      '  echo [Upgrade] PM2 app re-registered at %time% >> "%LOGFILE%"',
      ') else (',
      '  echo [Upgrade] WARNING: ecosystem.config.cjs not found, PM2 not restarted >> "%LOGFILE%"',
      ')',
    );
  }

  batLines.push(
    '',
    'echo [Upgrade] Finished at %time% >> "%LOGFILE%"',
    ':CLEANUP',
    `del /F /Q "${vbsPath}" 2>NUL`,
    `del /F /Q "${batPath}" 2>NUL`,
  );

  writeFileSync(batPath, batLines.join('\r\n'));

  // Use VBScript wrapper to fully detach the bat process from the parent.
  // WshShell.Run with 0 (hidden window) and False (don't wait) ensures the bat
  // runs completely independently — survives parent exit, no console window flash.
  const vbsLines = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run """${batPath}""", 0, False`,
  ];
  writeFileSync(vbsPath, vbsLines.join('\r\n'));

  spawn('wscript.exe', [vbsPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();

  console.log(`Upgrade script spawned via VBScript wrapper.`);
  console.log(`This process will exit now. The upgrade will proceed after exit.`);
  console.log(`Check upgrade log: ${logPath}`);
  process.exit(0);
}
