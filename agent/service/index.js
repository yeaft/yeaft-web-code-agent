/*
 * Service — platform dispatcher
 * Routes install/uninstall/start/stop/restart/status/logs to the correct platform module.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import {
  getConfigDir, getLogDir, getConfigPath,
  saveServiceConfig, loadServiceConfig,
  parseServiceArgs, validateConfig, getInstanceIdFromArgs, getDefaultYeaftDir
} from './config.js';
import { initYeaftDir } from '../yeaft/init.js';
import { DEFAULT_GITHUB_COPILOT_MODEL, tryAutoConfigureGitHubCopilot } from '../llm-config-cli.js';
import { getSystemdServicePath, linuxInstall, linuxUninstall, linuxStart, linuxStop, linuxRestart, linuxStatus, linuxLogs } from './linux.js';
import { getLaunchdPlistPath, macInstall, macUninstall, macStart, macStop, macRestart, macStatus, macLogs } from './macos.js';
import { winInstall, winUninstall, winStart, winStop, winRestart, winStatus, winLogs } from './windows.js';
import { doctor } from './doctor.js';

export {
  getConfigDir, getLogDir, getConfigPath,
  saveServiceConfig, loadServiceConfig,
  parseServiceArgs
};
export {
  SERVICE_NAME,
  DEFAULT_INSTANCE_ID,
  normalizeInstanceId,
  isDefaultInstance,
  validateInstanceId,
  getInstanceIdFromArgs,
  getServiceName,
  getPm2AppName,
  getLaunchdLabel,
  getDefaultYeaftDir,
} from './config.js';
// Re-export the launchd plist-path resolver so consumers (e.g. the upgrade
// flow) reach it via the service barrel instead of deep-importing macos.js.
export { getLaunchdPlistPath } from './macos.js';

const os = platform();

export async function autoConfigureGitHubCopilotIfAvailable(yeaftDir, options = {}) {
  const result = await tryAutoConfigureGitHubCopilot(join(yeaftDir, 'config.json'), options);
  if (result.configured) {
    console.log(`Configured GitHub Copilot provider automatically with ${DEFAULT_GITHUB_COPILOT_MODEL}.`);
    if (result.discovery?.warning) console.log(`Warning: ${result.discovery.warning}`);
  } else if (result.reason === 'already-configured') {
    console.log('LLM config already exists; skipped automatic GitHub Copilot setup.');
  } else if (result.reason === 'invalid-config') {
    console.log('Existing LLM config is invalid; skipped automatic GitHub Copilot setup.');
  }
  return result;
}

function ensureInstalled(instanceId) {
  if (os === 'linux') {
    if (!existsSync(getSystemdServicePath(instanceId))) {
      console.error('Service not installed. Run "yeaft-agent install" first.');
      process.exit(1);
    }
  } else if (os === 'darwin') {
    if (!existsSync(getLaunchdPlistPath(instanceId))) {
      console.error('Service not installed. Run "yeaft-agent install" first.');
      process.exit(1);
    }
  }
  // Windows check is done inside individual functions
}

export async function install(args) {
  const config = parseServiceArgs(args);
  validateConfig(config);
  saveServiceConfig(config);

  // Initialize ~/.yeaft/ directory + default config.json
  // so `yeaft` CLI is ready to use immediately after install
  const effectiveYeaftDir = config.yeaftDir || getDefaultYeaftDir(config.instanceId);
  const { dir, created } = initYeaftDir(effectiveYeaftDir);
  await autoConfigureGitHubCopilotIfAvailable(dir, {
    allowConfigured: created.includes(join(dir, 'config.json')),
  });
  if (created.length > 0) {
    console.log(`Initialized ${dir}`);
    console.log(`  Edit ${dir}/config.json to configure LLM providers.`);
    console.log('');
  }

  console.log(`Installing yeaft-agent service...`);
  console.log(`  Instance: ${config.instanceId}`);
  console.log(`  Server:   ${config.serverUrl}`);
  console.log(`  Name:     ${config.agentName || '(auto)'}`);
  console.log(`  WorkDir:  ${config.workDir || '(home)'}`);
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

export function uninstall(args = []) {
  const instanceId = getInstanceIdFromArgs(args);
  console.log(`Uninstalling yeaft-agent service (${instanceId})...`);
  if (os === 'linux') linuxUninstall(instanceId);
  else if (os === 'darwin') macUninstall(instanceId);
  else if (os === 'win32') winUninstall(instanceId);
  else { console.error(`Unsupported platform: ${os}`); process.exit(1); }
}

export function start(args = []) {
  const instanceId = getInstanceIdFromArgs(args);
  ensureInstalled(instanceId);
  if (os === 'linux') linuxStart(instanceId);
  else if (os === 'darwin') macStart(instanceId);
  else if (os === 'win32') winStart(instanceId);
}

export function stop(args = []) {
  const instanceId = getInstanceIdFromArgs(args);
  ensureInstalled(instanceId);
  if (os === 'linux') linuxStop(instanceId);
  else if (os === 'darwin') macStop(instanceId);
  else if (os === 'win32') winStop(instanceId);
}

export function restart(args = []) {
  const instanceId = getInstanceIdFromArgs(args);
  ensureInstalled(instanceId);
  if (os === 'linux') linuxRestart(instanceId);
  else if (os === 'darwin') macRestart(instanceId);
  else if (os === 'win32') winRestart(instanceId);
}

export function status(args = []) {
  const instanceId = getInstanceIdFromArgs(args);
  if (os === 'linux') linuxStatus(instanceId);
  else if (os === 'darwin') macStatus(instanceId);
  else if (os === 'win32') winStatus(instanceId);
}

export function logs(args = []) {
  const instanceId = getInstanceIdFromArgs(args);
  if (os === 'linux') linuxLogs(instanceId);
  else if (os === 'darwin') macLogs(instanceId);
  else if (os === 'win32') winLogs(instanceId);
}

export { doctor };
