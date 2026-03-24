/**
 * Service — doctor command
 * Diagnoses service configuration issues: checks paths, service status, version consistency.
 *
 * Reuses path and status functions from platform modules to avoid duplication.
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { platform, homedir } from 'os';
import { getNodePath } from './config.js';
import { getLaunchdPlistPath, getMacServiceStatus } from './macos.js';
import { getSystemdServicePath, getLinuxServiceStatus } from './linux.js';
import { getEcosystemPath, getWinServiceStatus } from './windows.js';

// ── Parse paths from service config files ──────────────────────────────────

/**
 * Parse node path and cli path from macOS launchd plist.
 * ProgramArguments is an array: [nodePath, cliPath]
 */
function parseMacPaths(plistPath) {
  const content = readFileSync(plistPath, 'utf-8');
  const args = [];
  // Match <string> values inside <array> after ProgramArguments
  const arrayMatch = content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (arrayMatch) {
    const stringRegex = /<string>(.*?)<\/string>/g;
    let m;
    while ((m = stringRegex.exec(arrayMatch[1])) !== null) {
      args.push(m[1]);
    }
  }
  return { nodePath: args[0] || null, cliPath: args[1] || null };
}

/**
 * Parse node path and cli path from Linux systemd unit.
 * ExecStart=<nodePath> <cliPath>
 */
function parseLinuxPaths(servicePath) {
  const content = readFileSync(servicePath, 'utf-8');
  const match = content.match(/^ExecStart=(.+)$/m);
  if (match) {
    const parts = match[1].trim().split(/\s+/);
    return { nodePath: parts[0] || null, cliPath: parts[1] || null };
  }
  return { nodePath: null, cliPath: null };
}

/**
 * Parse node path and cli path from Windows pm2 ecosystem config.
 * interpreter: '<nodePath>', script: '<cliPath>'
 */
function parseWindowsPaths(ecoPath) {
  const content = readFileSync(ecoPath, 'utf-8');
  const interpreterMatch = content.match(/interpreter:\s*'([^']+)'/);
  const scriptMatch = content.match(/script:\s*'([^']+)'/);
  return {
    nodePath: interpreterMatch ? interpreterMatch[1].replace(/\\\\/g, '\\') : null,
    cliPath: scriptMatch ? scriptMatch[1].replace(/\\\\/g, '\\') : null,
  };
}

// ── Check helpers ──────────────────────────────────────────────────────────

function isExecutable(filePath) {
  try {
    const stat = statSync(filePath);
    if (platform() === 'win32') {
      return stat.isFile();
    }
    // On Unix, check if any execute bit is set
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function getNodeVersion(nodePath) {
  try {
    return execSync(`"${nodePath}" --version`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function getCliVersion(nodePath, cliPath) {
  try {
    return execSync(`"${nodePath}" "${cliPath}" --version`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function getCurrentNodePath() {
  return getNodePath();
}

function getCurrentNodeVersion() {
  return process.version;
}

// ── Tilde shorthand for display ────────────────────────────────────────────

function tildeify(filePath) {
  const home = homedir();
  if (filePath && filePath.startsWith(home)) {
    return '~' + filePath.slice(home.length);
  }
  return filePath;
}

// ── Main doctor logic ──────────────────────────────────────────────────────

export function doctor() {
  const os = platform();
  let configPath = null;
  let parsePaths = null;
  let getServiceStatus = null;

  console.log('');

  // 1. Determine platform and config path
  if (os === 'darwin') {
    configPath = getLaunchdPlistPath();
    parsePaths = parseMacPaths;
    getServiceStatus = getMacServiceStatus;
  } else if (os === 'linux') {
    configPath = getSystemdServicePath();
    parsePaths = parseLinuxPaths;
    getServiceStatus = getLinuxServiceStatus;
  } else if (os === 'win32') {
    configPath = getEcosystemPath();
    parsePaths = parseWindowsPaths;
    getServiceStatus = getWinServiceStatus;
  } else {
    console.log(`\u26a0\ufe0f  Unsupported platform: ${os}`);
    console.log(`   The doctor command supports macOS, Linux, and Windows.`);
    console.log('');
    process.exit(1);
  }

  // 2. Check if service config exists
  if (!existsSync(configPath)) {
    console.log(`\u26a0\ufe0f  No service configuration found.`);
    console.log(`   Run 'yeaft-agent install --server <url> --name <name> --secret <secret>' to set up.`);
    console.log('');
    return;
  }

  console.log(`\u2705 Service installed: ${tildeify(configPath)}`);

  let hasErrors = false;

  // 3. Parse paths from config
  const { nodePath, cliPath } = parsePaths(configPath);

  // 4. Check node path
  if (!nodePath) {
    console.log(`\u274c Node path: not found in service config`);
    hasErrors = true;
  } else if (!existsSync(nodePath)) {
    console.log(`\u274c Node path invalid: ${nodePath} (file not found)`);
    console.log(`   Current node: ${getCurrentNodePath()} (${getCurrentNodeVersion()})`);
    hasErrors = true;
  } else if (!isExecutable(nodePath)) {
    console.log(`\u274c Node path not executable: ${nodePath}`);
    console.log(`   Current node: ${getCurrentNodePath()} (${getCurrentNodeVersion()})`);
    hasErrors = true;
  } else {
    const nodeVersion = getNodeVersion(nodePath);
    console.log(`\u2705 Node path valid: ${nodePath} (${nodeVersion || 'unknown version'})`);

    // 4a. Version consistency check
    const currentVersion = getCurrentNodeVersion();
    if (nodeVersion && nodeVersion !== currentVersion) {
      console.log(`   \u26a0\ufe0f  Version mismatch: service uses ${nodeVersion}, current terminal uses ${currentVersion}`);
    }
  }

  // 5. Check cli path
  if (!cliPath) {
    console.log(`\u274c CLI path: not found in service config`);
    hasErrors = true;
  } else if (!existsSync(cliPath)) {
    console.log(`\u274c CLI path invalid: ${cliPath} (file not found)`);
    hasErrors = true;
  } else {
    // Try to get CLI version
    let versionStr = '';
    if (nodePath && existsSync(nodePath)) {
      const cliVersion = getCliVersion(nodePath, cliPath);
      if (cliVersion) versionStr = ` (v${cliVersion})`;
    }
    console.log(`\u2705 CLI path valid: ${tildeify(cliPath)}${versionStr}`);
  }

  // 6. Check service status
  const status = getServiceStatus();
  if (status.running) {
    console.log(`\u2705 Service running: PID ${status.pid}`);
  } else {
    console.log(`\u274c Service not running`);
    hasErrors = true;
  }

  // 7. Summary
  console.log('');
  if (hasErrors) {
    console.log('Fix: Run the following commands:');
    console.log('  npm install -g @yeaft/webchat-agent');
    console.log('  yeaft-agent install --server <your-server-url> --name <your-agent-name> --secret <your-secret>');
  } else {
    console.log('All checks passed.');
  }
  console.log('');
}
