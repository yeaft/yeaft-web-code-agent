import { execFile, execFileSync, spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';
import ctx from '../context.js';
import { getConfigDir } from '../service.js';
import { sendToServer } from './buffer.js';
import { stopAgentHeartbeat } from './heartbeat.js';

const PM2_APP_NAME = 'yeaft-agent';

// Derive absolute paths for npm/pm2 from current node executable.
// In launchd/systemd environments, PATH may not include nvm/node dirs,
// but process.execPath always points to the running node binary.
const nodeBinDir = dirname(process.execPath);
const isWin = platform() === 'win32';
const npmPath = join(nodeBinDir, isWin ? 'npm.cmd' : 'npm');
const pm2Path = join(nodeBinDir, isWin ? 'pm2.cmd' : 'pm2');

// Shared cleanup logic for restart/upgrade
function cleanupAndExit(exitCode) {
  setTimeout(() => {
    for (const [, term] of ctx.terminals) {
      if (term.pty) { try { term.pty.kill(); } catch {} }
      if (term.timer) clearTimeout(term.timer);
    }
    ctx.terminals.clear();
    for (const [, state] of ctx.conversations) {
      if (state.abortController) state.abortController.abort();
      if (state.inputStream) state.inputStream.done();
    }
    ctx.conversations.clear();
    stopAgentHeartbeat();
    if (ctx.ws) {
      ctx.ws.removeAllListeners('close');
      ctx.ws.close();
    }
    clearTimeout(ctx.reconnectTimer);
    console.log(`[Agent] Cleanup done, exiting with code ${exitCode}...`);
    process.exit(exitCode);
  }, 500);
}

export function handleRestartAgent() {
  console.log('[Agent] Restart requested, shutting down for PM2/systemd restart...');
  sendToServer({ type: 'restart_agent_ack' });
  cleanupAndExit(1);
}

export async function handleUpgradeAgent() {
  console.log('[Agent] Upgrade requested, checking for updates...');
  try {
    const pkgName = ctx.pkgName || '@yeaft/webchat-agent';
    // Check latest version (async to avoid blocking heartbeat)
    const latestVersion = await new Promise((resolve, reject) => {
      execFile(npmPath, ['view', pkgName, 'version'], { stdio: 'pipe' }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout.toString().trim());
      });
    });
    if (latestVersion === ctx.agentVersion) {
      console.log(`[Agent] Already at latest version (${ctx.agentVersion}), skipping upgrade.`);
      sendToServer({ type: 'upgrade_agent_ack', success: true, alreadyLatest: true, version: ctx.agentVersion });
      return;
    }
    console.log(`[Agent] Upgrading from ${ctx.agentVersion} to latest (${latestVersion})...`);

    // 检测安装方式：npm install 的路径包含 node_modules，源码运行则不包含
    const scriptPath = (process.argv[1] || '').replace(/\\/g, '/');
    const nmIndex = scriptPath.lastIndexOf('/node_modules/');
    const isNpmInstall = nmIndex !== -1;

    if (!isNpmInstall) {
      // 源码运行不支持远程升级（代码在 git repo 中，需要手动 git pull）
      console.log('[Agent] Source-based install detected, remote upgrade not supported.');
      sendToServer({ type: 'upgrade_agent_ack', success: false, error: 'Source-based install: please use git pull to upgrade' });
      return;
    }

    // 提取 node_modules 的父目录
    const installDir = scriptPath.substring(0, nmIndex);

    // 判断全局安装 vs 局部安装
    const isGlobalInstall = await new Promise((resolve) => {
      execFile(npmPath, ['prefix', '-g'], (err, stdout) => {
        if (err) { resolve(false); return; }
        const globalPrefix = stdout.toString().trim().replace(/\\/g, '/');
        resolve(installDir === globalPrefix || installDir === globalPrefix + '/lib');
      });
    });

    const isWindows = platform() === 'win32';

    if (isWindows) {
      spawnWindowsUpgradeScript(pkgName, installDir, isGlobalInstall, latestVersion);
    } else {
      spawnUnixUpgradeScript(pkgName, installDir, isGlobalInstall, latestVersion);
    }

    // On PM2: delete the app BEFORE exiting so PM2 won't auto-restart the old version.
    // The upgrade script will re-register it with `pm2 start <ecosystem>` after replacing files.
    const isPm2 = !!process.env.pm_id;
    if (isPm2) {
      try {
        execFileSync(pm2Path, ['delete', PM2_APP_NAME], { stdio: 'pipe' });
        console.log(`[Agent] PM2 app deleted to prevent auto-restart during upgrade`);
      } catch {
        console.log(`[Agent] PM2 delete skipped (app may not be registered)`);
      }
    }

    // 清理并退出，让升级脚本接管
    cleanupAndExit(0);
  } catch (e) {
    console.error('[Agent] Upgrade failed:', e.message);
    sendToServer({ type: 'upgrade_agent_ack', success: false, error: e.message });
  }
}

function spawnWindowsUpgradeScript(pkgName, installDir, isGlobalInstall, latestVersion) {
  const pid = process.pid;
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
  const logDir = join(configDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const batPath = join(configDir, 'upgrade.bat');
  const vbsPath = join(configDir, 'upgrade.vbs');
  const logPath = join(logDir, 'upgrade.log');
  const isPm2 = !!process.env.pm_id;
  const installDirWin = installDir.replace(/\//g, '\\');
  const ecoPath = join(configDir, 'ecosystem.config.cjs').replace(/\//g, '\\');

  // Copy upgrade-worker-template.js to config dir (runs as CJS there, away from ESM context)
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const workerSrc = join(thisDir, 'upgrade-worker-template.js');
  const workerDst = join(configDir, 'upgrade-worker.js');
  cpSync(workerSrc, workerDst);

  // Determine the target package directory inside node_modules
  const pkgDir = join(installDir, 'node_modules', ...pkgName.split('/')).replace(/\//g, '\\');

  const pm2Win = pm2Path.replace(/\//g, '\\');

  const batLines = [
    '@echo off',
    'setlocal',
    `set PID=${pid}`,
    `set PKG=${pkgName}@latest`,
    `set INSTALL_DIR=${installDirWin}`,
    `set PKG_DIR=${pkgDir}`,
    `set LOGFILE=${logPath}`,
    `set WORKER=${workerDst}`,
    `set MAX_WAIT=30`,
    `set COUNT=0`,
    '',
    ':: Change to temp dir to avoid EBUSY on cwd',
    'cd /d "%TEMP%"',
    '',
    'echo [Upgrade] Started at %date% %time% > "%LOGFILE%"',
    `echo [Upgrade] Version: ${ctx.agentVersion} -> ${latestVersion} >> "%LOGFILE%"`,
    `echo [Upgrade] PM2 managed: ${isPm2 ? 'yes (deleted pre-exit)' : 'no'} >> "%LOGFILE%"`,
    `echo [Upgrade] Install dir: ${installDirWin} >> "%LOGFILE%"`,
  ];

  // Wait for old process to exit (PM2 already deleted before exit, so no auto-restart race)
  batLines.push(
    'echo [Upgrade] Waiting for PID %PID% to exit... >> "%LOGFILE%"',
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
  );

  // No need to pm2 stop — PM2 app was already deleted before process exit.
  // Wait extra time for file locks to fully release.
  batLines.push(
    'echo [Upgrade] Process exited at %time%, waiting for file locks... >> "%LOGFILE%"',
    'ping -n 5 127.0.0.1 >NUL',
  );

  // Use Node.js worker for file-level upgrade (avoids EBUSY on directory rename)
  batLines.push(
    'echo [Upgrade] Running upgrade worker at %time%... >> "%LOGFILE%"',
    `"${process.execPath.replace(/\//g, '\\')}" "%WORKER%" "%PKG%" "%PKG_DIR%" "%LOGFILE%"`,
    'if not "%errorlevel%"=="0" (',
    '  echo [Upgrade] Worker failed with exit code %errorlevel% at %time% >> "%LOGFILE%"',
    '  goto CLEANUP',
    ')',
    'echo [Upgrade] Worker completed successfully at %time% >> "%LOGFILE%"',
  );

  batLines.push(':CLEANUP');

  if (isPm2) {
    // Re-register and start via ecosystem config (PM2 app was deleted pre-exit)
    batLines.push(
      'echo [Upgrade] Re-registering agent via PM2... >> "%LOGFILE%"',
      `if exist "${ecoPath}" (`,
      `  call "${pm2Win}" start "${ecoPath}" >> "%LOGFILE%" 2>&1`,
      `  call "${pm2Win}" save >> "%LOGFILE%" 2>&1`,
      '  echo [Upgrade] PM2 app re-registered at %time% >> "%LOGFILE%"',
      ') else (',
      '  echo [Upgrade] WARNING: ecosystem.config.cjs not found, PM2 not restarted >> "%LOGFILE%"',
      ')',
    );
  }

  // Clean up worker, vbs launcher, and bat script
  batLines.push(
    '',
    'echo [Upgrade] Finished at %time% >> "%LOGFILE%"',
    `del /F /Q "${workerDst}" 2>NUL`,
    `del /F /Q "${vbsPath}" 2>NUL`,
    `del /F /Q "${batPath}"`,
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

  console.log(`[Agent] Spawned upgrade via VBScript (PID wait for ${pid}, pm2=${isPm2}, dir=${installDir}): ${batPath}`);
  sendToServer({ type: 'upgrade_agent_ack', success: true, version: latestVersion, pendingRestart: true });
}

function spawnUnixUpgradeScript(pkgName, installDir, isGlobalInstall, latestVersion) {
  const pid = process.pid;
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
  const shPath = join(configDir, 'upgrade.sh');
  const isSystemd = existsSync(join(process.env.HOME || '', '.config', 'systemd', 'user', 'yeaft-agent.service'));
  const isLaunchd = platform() === 'darwin' && existsSync(join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.yeaft.agent.plist'));
  const cwd = isGlobalInstall ? undefined : installDir;

  // Ensure PATH includes the node bin dir (critical for launchd which has minimal PATH)
  const currentPath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
  const exportPath = currentPath.includes(nodeBinDir) ? currentPath : `${nodeBinDir}:${currentPath}`;

  const shLines = [
    '#!/bin/bash',
    `PID=${pid}`,
    `PKG="${pkgName}@latest"`,
    `NPM="${npmPath}"`,
    `LOGFILE="${join(configDir, 'logs', 'upgrade.log')}"`,
    `export PATH="${exportPath}"`,
    '',
    '# Redirect all output to log file',
    'exec > "$LOGFILE" 2>&1',
    'echo "[Upgrade] Started at $(date)"',
    '',
    ...(cwd ? [`INSTALL_DIR="${cwd}"`] : []),
    '',
    '# Wait for current process to exit',
    'COUNT=0',
    'while kill -0 $PID 2>/dev/null; do',
    '  COUNT=$((COUNT+1))',
    '  if [ $COUNT -ge 30 ]; then',
    '    echo "[Upgrade] Timeout waiting for PID $PID to exit"',
    '    break',
    '  fi',
    '  sleep 2',
    'done',
    '',
  ];

  // 停止服务管理器的自动重启
  if (isSystemd) {
    shLines.push(
      '# Stop systemd service to prevent restart loop',
      'systemctl --user stop yeaft-agent 2>/dev/null',
      'sleep 1',
      '',
    );
  } else if (isLaunchd) {
    const plistPath = join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.yeaft.agent.plist');
    shLines.push(
      '# Unload launchd service to prevent restart loop',
      `launchctl unload "${plistPath}" 2>/dev/null`,
      'sleep 1',
      '',
    );
  }

  // npm install (use absolute path via $NPM variable)
  const npmCmd = isGlobalInstall
    ? `"$NPM" install -g "$PKG"`
    : `cd "$INSTALL_DIR" && "$NPM" install "$PKG"`;

  shLines.push(
    'echo "[Upgrade] Installing $PKG..."',
    npmCmd,
    'EXIT_CODE=$?',
    'if [ $EXIT_CODE -ne 0 ]; then',
    '  echo "[Upgrade] npm install failed with exit code $EXIT_CODE"',
    'else',
    '  echo "[Upgrade] Successfully installed $PKG"',
    'fi',
    '',
  );

  // 重新启动服务
  if (isSystemd) {
    shLines.push(
      '# Restart systemd service',
      'systemctl --user start yeaft-agent',
      'echo "[Upgrade] Service restarted via systemd"',
    );
  } else if (isLaunchd) {
    const plistPath = join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.yeaft.agent.plist');
    shLines.push(
      '# Reload launchd service',
      `launchctl load "${plistPath}"`,
      'echo "[Upgrade] Service restarted via launchd"',
    );
  }

  // 清理脚本自身
  shLines.push('', `rm -f "${shPath}"`);

  writeFileSync(shPath, shLines.join('\n'), { mode: 0o755 });
  const child = spawn('bash', [shPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`[Agent] Spawned upgrade script: ${shPath}`);
  sendToServer({ type: 'upgrade_agent_ack', success: true, version: latestVersion, pendingRestart: true });
}
