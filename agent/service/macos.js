/**
 * Service — macOS (launchd) platform implementation
 */
import { execSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogDir, getNodePath, getCliPath } from './config.js';

export function getLaunchdPlistPath() {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'com.yeaft.agent.plist');
}

function generateLaunchdPlist(config) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const logDir = getLogDir();

  const envDict = [];
  if (config.serverUrl) envDict.push(`      <key>SERVER_URL</key>\n      <string>${config.serverUrl}</string>`);
  if (config.agentName) envDict.push(`      <key>AGENT_NAME</key>\n      <string>${config.agentName}</string>`);
  if (config.agentSecret) envDict.push(`      <key>AGENT_SECRET</key>\n      <string>${config.agentSecret}</string>`);
  if (config.workDir) envDict.push(`      <key>WORK_DIR</key>\n      <string>${config.workDir}</string>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yeaft.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${cliPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${config.workDir || homedir()}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envDict.join('\n')}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${logDir}/out.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/error.log</string>
</dict>
</plist>
`;
}

export function macInstall(config) {
  const plistPath = getLaunchdPlistPath();
  // Unload first if exists
  if (existsSync(plistPath)) {
    try { execSync(`launchctl unload ${plistPath} 2>/dev/null`); } catch {}
  }
  writeFileSync(plistPath, generateLaunchdPlist(config));
  execSync(`launchctl load ${plistPath}`);
  console.log('Service installed and started.');
  console.log(`\nManage with:`);
  console.log(`  yeaft-agent status`);
  console.log(`  yeaft-agent logs`);
  console.log(`  yeaft-agent restart`);
  console.log(`  yeaft-agent uninstall`);
}

export function macUninstall() {
  const plistPath = getLaunchdPlistPath();
  if (existsSync(plistPath)) {
    try { execSync(`launchctl unload ${plistPath}`); } catch {}
    unlinkSync(plistPath);
  }
  console.log('Service uninstalled.');
}

export function macStart() {
  const plistPath = getLaunchdPlistPath();
  if (!existsSync(plistPath)) {
    console.error('Service not installed. Run "yeaft-agent install" first.');
    process.exit(1);
  }
  execSync(`launchctl load ${plistPath}`);
  console.log('Service started.');
}

export function macStop() {
  const plistPath = getLaunchdPlistPath();
  if (existsSync(plistPath)) {
    execSync(`launchctl unload ${plistPath}`);
  }
  console.log('Service stopped.');
}

export function macRestart() {
  macStop();
  macStart();
}

/**
 * Query launchd for the current service status.
 * Returns { running: boolean, pid: string|null, exitCode: string|null }.
 */
export function getMacServiceStatus() {
  try {
    const output = execSync('launchctl list | grep com.yeaft.agent', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (output.trim()) {
      const parts = output.trim().split(/\s+/);
      const pid = parts[0];
      const exitCode = parts[1];
      if (pid !== '-') {
        return { running: true, pid, exitCode };
      }
      return { running: false, pid: null, exitCode };
    }
    return { running: false, pid: null, exitCode: null };
  } catch {
    return { running: false, pid: null, exitCode: null };
  }
}

export function macStatus() {
  const status = getMacServiceStatus();
  if (status.running) {
    console.log(`Service is running (PID: ${status.pid})`);
  } else if (status.exitCode !== null) {
    console.log(`Service is stopped (last exit code: ${status.exitCode})`);
  } else {
    console.log('Service is not installed.');
  }
}

export function macLogs() {
  const logFile = join(getLogDir(), 'out.log');
  if (existsSync(logFile)) {
    execSync(`tail -f -n 100 ${logFile}`, { stdio: 'inherit' });
  } else {
    console.log('No logs found.');
  }
}
