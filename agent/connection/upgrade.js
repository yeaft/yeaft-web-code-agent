import { execFile, execFileSync, spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform, homedir } from 'os';
import ctx from '../context.js';
import { getConfigDir, getServiceName, getPm2AppName, getLaunchdPlistPath, DEFAULT_INSTANCE_ID } from '../service.js';
import { sendToServer } from './buffer.js';
import { stopAgentHeartbeat } from './heartbeat.js';

/**
 * Resolve the local service instance id for this running agent. Each agent
 * process is pinned to one instance (set in index.js from
 * YEAFT_AGENT_INSTANCE / config), so the upgrade flow must target THAT
 * instance's service unit — not the bare `yeaft-agent` default. Without this,
 * a named instance (e.g. `server-e7a9eb`) installs the new package but its
 * systemd unit `yeaft-agent@server-e7a9eb` is never restarted, leaving the
 * agent permanently offline after a UI-triggered upgrade.
 */
export function resolveInstanceId() {
  return ctx.CONFIG?.instanceId || process.env.YEAFT_AGENT_INSTANCE || DEFAULT_INSTANCE_ID;
}

// Derive absolute paths for npm/pm2 from current node executable.
// In launchd/systemd environments, PATH may not include nvm/node dirs,
// but process.execPath always points to the running node binary.
const nodeBinDir = dirname(process.execPath);
const isWin = platform() === 'win32';
// Windows: use bare 'npm'/'pm2' + shell:true — cmd.exe finds them via PATH.
// This was the working pattern before ce58bbc. Absolute paths break when
// the path contains spaces (e.g., "C:\Program Files\nodejs\npm.cmd").
// macOS/Linux: use absolute path — launchd/systemd have minimal PATH.
const npmPath = isWin ? 'npm' : join(nodeBinDir, 'npm');
const pm2Path = isWin ? 'pm2' : join(nodeBinDir, 'pm2');
const shellOpt = isWin ? { shell: true, windowsHide: true } : {};

// Ensure PATH includes nodeBinDir so that `#!/usr/bin/env node` shebangs
// can locate node in launchd/systemd environments with minimal PATH.
const currentPath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
const safePath = currentPath.includes(nodeBinDir) ? currentPath : `${nodeBinDir}:${currentPath}`;
const safeEnv = { ...process.env, PATH: safePath };

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

/**
 * Fetch the `engines.node` SemVer range for a specific published version of
 * a package. Returns the range string (e.g. ">=22.5.0") or `null` if the
 * field is absent / the lookup fails. Failure is non-fatal — callers fall
 * back to running the upgrade unconditionally rather than blocking on a
 * registry hiccup.
 */
async function fetchRequiredNodeRange(pkgName, version) {
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        npmPath,
        ['view', `${pkgName}@${version}`, 'engines.node'],
        { stdio: 'pipe', env: safeEnv, ...shellOpt },
        (err, out) => { if (err) reject(err); else resolve(out.toString().trim()); },
      );
    });
    return stdout || null;
  } catch (e) {
    console.warn(`[Agent] Could not fetch engines.node for ${pkgName}@${version}:`, e.message);
    return null;
  }
}

/**
 * Minimal SemVer range checker — supports the subset of operators that
 * appear in real-world `engines.node` fields:
 *   - exact:           "22.5.0"
 *   - comparator:      ">=22.5.0", ">22", "<=24", "<25.0.0"
 *   - whitespace AND:  ">=18.0.0 <23.0.0"
 *   - "||" OR:         ">=18 <19 || >=20"
 *   - "*" / "" / "x":  always satisfied
 *
 * We deliberately avoid pulling in the `semver` npm package — the agent has
 * a minimal dep set and this gate only needs to reject obviously-wrong Node
 * versions. Anything we can't parse is treated as "satisfied" (fail-open)
 * so a weird range never blocks a legitimate upgrade.
 */
export function nodeRangeSatisfied(current, range) {
  if (!range || range === '*' || range === 'x' || range === 'X') return true;
  const cur = parseSemver(current);
  if (!cur) return true;
  const orParts = String(range).split('||').map(s => s.trim()).filter(Boolean);
  if (orParts.length === 0) return true;
  return orParts.some(part => part.split(/\s+/).filter(Boolean).every(cmp => compareCmp(cur, cmp)));
}

function parseSemver(v) {
  if (!v) return null;
  const m = String(v).replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

function cmpTuple(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function compareCmp(cur, cmp) {
  const m = cmp.match(/^(>=|<=|>|<|=|\^|~)?\s*v?(.+)$/);
  if (!m) return true; // unparseable → fail-open
  const op = m[1] || '=';
  const target = parseSemver(m[2]);
  if (!target) return true;
  const d = cmpTuple(cur, target);
  switch (op) {
    case '>=': return d >= 0;
    case '<=': return d <= 0;
    case '>':  return d > 0;
    case '<':  return d < 0;
    case '=':  return d === 0;
    case '^':  return d >= 0 && cur[0] === target[0];
    case '~':  return d >= 0 && cur[0] === target[0] && cur[1] === target[1];
    default:   return true;
  }
}

export async function handleUpgradeAgent() {
  console.log('[Agent] Upgrade requested, checking for updates...');
  try {
    const pkgName = ctx.pkgName || '@yeaft/webchat-agent';
    // Check latest version (async to avoid blocking heartbeat)
    const latestVersion = await new Promise((resolve, reject) => {
      execFile(npmPath, ['view', pkgName, 'version'], { stdio: 'pipe', env: safeEnv, ...shellOpt }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout.toString().trim());
      });
    });
    if (latestVersion === ctx.agentVersion) {
      console.log(`[Agent] Already at latest version (${ctx.agentVersion}), skipping upgrade.`);
      sendToServer({ type: 'upgrade_agent_ack', success: true, alreadyLatest: true, version: ctx.agentVersion });
      return;
    }

    // Node.js compatibility gate: fetch engines.node of the *target* version
    // and refuse to upgrade if the running Node is too old. Without this,
    // npm install would replace files and the agent would crash on next
    // restart with no actionable signal.
    const requiredNode = await fetchRequiredNodeRange(pkgName, latestVersion);
    const currentNode = process.versions.node;
    if (requiredNode && !nodeRangeSatisfied(currentNode, requiredNode)) {
      const msg = `Node ${currentNode} does not satisfy required ${requiredNode} for ${pkgName}@${latestVersion}`;
      console.warn(`[Agent] Upgrade aborted: ${msg}`);
      sendToServer({
        type: 'upgrade_agent_ack',
        success: false,
        reason: 'node_incompatible',
        error: msg,
        currentNode,
        requiredNode,
        version: latestVersion,
      });
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
      execFile(npmPath, ['prefix', '-g'], { env: safeEnv, ...shellOpt }, (err, stdout) => {
        if (err) { resolve(false); return; }
        const globalPrefix = stdout.toString().trim().replace(/\\/g, '/');
        resolve(installDir === globalPrefix || installDir === globalPrefix + '/lib');
      });
    });

    const isWindows = platform() === 'win32';
    const instanceId = resolveInstanceId();

    if (isWindows) {
      spawnWindowsUpgradeScript(pkgName, installDir, isGlobalInstall, latestVersion, instanceId);
    } else {
      spawnUnixUpgradeScript(pkgName, installDir, isGlobalInstall, latestVersion, instanceId);
    }

    // On PM2: delete the app BEFORE exiting so PM2 won't auto-restart the old version.
    // The upgrade script will re-register it with `pm2 start <ecosystem>` after replacing files.
    const isPm2 = !!process.env.pm_id;
    if (isPm2) {
      try {
        execFileSync(pm2Path, ['delete', getPm2AppName(instanceId)], { stdio: 'pipe', env: safeEnv, ...shellOpt });
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

function spawnWindowsUpgradeScript(pkgName, installDir, isGlobalInstall, latestVersion, instanceId = DEFAULT_INSTANCE_ID) {
  const pid = process.pid;
  const configDir = getConfigDir(instanceId);
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

/**
 * Build the Unix (systemd/launchd) upgrade shell script as a string.
 *
 * Side-effect-free apart from reading the environment FS (`existsSync` to
 * detect which service manager is installed) — and crucially it does NOT
 * spawn, so the generated unit names can be asserted in unit tests. The
 * service-manager target is resolved from `instanceId` via the shared helpers
 * (`getServiceName` / `getLaunchdPlistPath`), so a named instance restarts
 * `yeaft-agent@<id>` instead of the bare `yeaft-agent` default.
 *
 * On systemd the script pins XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS (the
 * detached upgrade shell may not inherit them, and `systemctl --user` needs
 * them to reach the user manager) and logs + retries a failed restart instead
 * of failing silently.
 *
 * The env-pin is systemd-specific: launchd reaches its manager via the
 * inherited Mach bootstrap port and PM2 via a fixed named pipe, so neither
 * needs these vars. NOTE this is only about the *env* asymmetry — the launchd
 * branch does NOT yet have the same restart-failure logging/retry hardening;
 * that resilience gap is deferred, not "launchd is already safe".
 *
 * @param {object} opts
 * @param {string} opts.pkgName        npm package name
 * @param {string} opts.installDir     install dir (local install) — used as cwd
 * @param {boolean} opts.isGlobalInstall  global vs local npm install
 * @param {number} opts.pid            pid of the exiting agent to wait on
 * @param {string} opts.configDir      instance config dir (holds logs/upgrade.log)
 * @param {string} opts.npmPath        absolute npm path
 * @param {string} opts.safePath       PATH with nodeBinDir prepended
 * @param {string} opts.instanceId     local service instance id
 * @param {boolean} opts.isDarwin      whether the platform is macOS
 * @returns {string} the upgrade.sh contents
 */
export function buildUnixUpgradeScript({
  pkgName,
  installDir,
  isGlobalInstall,
  pid,
  configDir,
  npmPath,
  safePath,
  instanceId = DEFAULT_INSTANCE_ID,
  isDarwin = platform() === 'darwin',
}) {
  const shPath = join(configDir, 'upgrade.sh');
  const serviceName = getServiceName(instanceId);
  const systemdUnitPath = join(homedir(), '.config', 'systemd', 'user', `${serviceName}.service`);
  const isSystemd = existsSync(systemdUnitPath);
  const plistPath = getLaunchdPlistPath(instanceId);
  const isLaunchd = isDarwin && existsSync(plistPath);
  const cwd = isGlobalInstall ? undefined : installDir;

  const shLines = [
    '#!/bin/bash',
    `PID=${pid}`,
    `PKG="${pkgName}@latest"`,
    `NPM="${npmPath}"`,
    `LOGFILE="${join(configDir, 'logs', 'upgrade.log')}"`,
    `export PATH="${safePath}"`,
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
      // `systemctl --user` locates the user manager via XDG_RUNTIME_DIR (and
      // its bus via DBUS_SESSION_BUS_ADDRESS). The agent normally inherits both
      // from its systemd-managed environment, but the detached upgrade shell
      // cannot rely on that always being populated — if either is missing,
      // `systemctl --user` fails with "Failed to connect to bus" and BOTH the
      // stop and the restart silently no-op, stranding the agent offline after
      // upgrade. Pin per-user defaults (keeping any inherited value) before the
      // first systemctl call so the whole sequence can reach the manager.
      'YEAFT_UID="$(id -u)"',
      'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$YEAFT_UID}"',
      'export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$YEAFT_UID/bus}"',
      '',
      '# Stop systemd service to prevent restart loop',
      `systemctl --user stop "${serviceName}" 2>/dev/null`,
      'sleep 1',
      '',
    );
  } else if (isLaunchd) {
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
      '# Restart systemd service. Capture failure explicitly: a silent',
      '# `systemctl start` failure here is exactly what strands the agent',
      '# offline, so log the exit code + reason and retry once before giving up.',
      `if systemctl --user start "${serviceName}"; then`,
      '  echo "[Upgrade] Service restarted via systemd"',
      'else',
      '  START_RC=$?',
      `  echo "[Upgrade] systemctl start failed (rc=$START_RC); retrying after reload..."`,
      '  systemctl --user daemon-reload || true',
      '  sleep 2',
      `  if systemctl --user start "${serviceName}"; then`,
      '    echo "[Upgrade] Service restarted via systemd (after retry)"',
      '  else',
      `    echo "[Upgrade] ERROR: systemctl start still failing (rc=$?). Manual start required: systemctl --user start ${serviceName}"`,
      '  fi',
      'fi',
    );
  } else if (isLaunchd) {
    shLines.push(
      '# Reload launchd service',
      `launchctl load "${plistPath}"`,
      'echo "[Upgrade] Service restarted via launchd"',
    );
  }

  // 清理脚本自身
  shLines.push('', `rm -f "${shPath}"`);

  return shLines.join('\n');
}

function spawnUnixUpgradeScript(pkgName, installDir, isGlobalInstall, latestVersion, instanceId = DEFAULT_INSTANCE_ID) {
  const configDir = getConfigDir(instanceId);
  // Create logs/ too: the generated script's `exec > "$LOGFILE" 2>&1` aborts
  // the whole upgrade silently if that directory is missing.
  mkdirSync(join(configDir, 'logs'), { recursive: true });
  const shPath = join(configDir, 'upgrade.sh');

  const script = buildUnixUpgradeScript({
    pkgName,
    installDir,
    isGlobalInstall,
    pid: process.pid,
    configDir,
    npmPath,
    safePath,
    instanceId,
  });

  writeFileSync(shPath, script, { mode: 0o755 });
  const child = spawn('bash', [shPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`[Agent] Spawned upgrade script: ${shPath}`);
  sendToServer({ type: 'upgrade_agent_ack', success: true, version: latestVersion, pendingRestart: true });
}
