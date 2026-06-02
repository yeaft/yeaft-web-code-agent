/**
 * Service — platform dispatcher
 * Routes install/uninstall/start/stop/restart/status/logs to the correct platform module.
 */
import { existsSync } from 'fs';
import { platform } from 'os';
import {
  SERVICE_NAME, getConfigDir, getLogDir, getConfigPath,
  saveServiceConfig, loadServiceConfig,
  parseServiceArgs, validateConfig
} from './config.js';
import { initYeaftDir } from '../yeaft/init.js';
import { getSystemdServicePath, linuxInstall, linuxUninstall, linuxStart, linuxStop, linuxRestart, linuxStatus, linuxLogs } from './linux.js';
import { getLaunchdPlistPath, macInstall, macUninstall, macStart, macStop, macRestart, macStatus, macLogs } from './macos.js';
import { winInstall, winUninstall, winStart, winStop, winRestart, winStatus, winLogs } from './windows.js';
import { doctor } from './doctor.js';

export {
  getConfigDir, getLogDir, getConfigPath,
  saveServiceConfig, loadServiceConfig,
  parseServiceArgs
};

const os = platform();

function ensureInstalled() {
  if (os === 'linux') {
    if (!existsSync(getSystemdServicePath())) {
      console.error('Service not installed. Run "yeaft-agent install" first.');
      process.exit(1);
    }
  } else if (os === 'darwin') {
    if (!existsSync(getLaunchdPlistPath())) {
      console.error('Service not installed. Run "yeaft-agent install" first.');
      process.exit(1);
    }
  }
  // Windows check is done inside individual functions
}

export function install(args) {
  const config = parseServiceArgs(args);
  validateConfig(config);
  saveServiceConfig(config);

  // Initialize ~/.yeaft/ directory + default config.json
  // so `yeaft` CLI is ready to use immediately after install
  const { dir, created } = initYeaftDir();
  if (created.length > 0) {
    console.log(`Initialized ${dir}`);
    console.log(`  Edit ${dir}/config.json to configure LLM providers.`);
    console.log('');
  }

  console.log(`Installing ${SERVICE_NAME} service...`);
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Name:   ${config.agentName || '(auto)'}`);
  console.log(`  WorkDir: ${config.workDir || '(home)'}`);
  console.log('');

  if (os === 'linux') linuxInstall(config);
  else if (os === 'darwin') macInstall(config);
  else if (os === 'win32') winInstall(config);
  else {
    console.error(`Unsupported platform: ${os}`);
    console.log('You can run the agent directly: yeaft-agent --server <url> --secret <secret>');
    process.exit(1);
  }
}

export function uninstall() {
  console.log(`Uninstalling ${SERVICE_NAME} service...`);
  if (os === 'linux') linuxUninstall();
  else if (os === 'darwin') macUninstall();
  else if (os === 'win32') winUninstall();
  else { console.error(`Unsupported platform: ${os}`); process.exit(1); }
}

export function start() {
  ensureInstalled();
  if (os === 'linux') linuxStart();
  else if (os === 'darwin') macStart();
  else if (os === 'win32') winStart();
}

export function stop() {
  ensureInstalled();
  if (os === 'linux') linuxStop();
  else if (os === 'darwin') macStop();
  else if (os === 'win32') winStop();
}

export function restart() {
  ensureInstalled();
  if (os === 'linux') linuxRestart();
  else if (os === 'darwin') macRestart();
  else if (os === 'win32') winRestart();
}

export function status() {
  if (os === 'linux') linuxStatus();
  else if (os === 'darwin') macStatus();
  else if (os === 'win32') winStatus();
}

export function logs() {
  if (os === 'linux') linuxLogs();
  else if (os === 'darwin') macLogs();
  else if (os === 'win32') winLogs();
}

export { doctor };
