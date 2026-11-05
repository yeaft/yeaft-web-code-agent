import { execFile, execFileSync, spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { platform, homedir } from 'os';
import ctx from '../context.js';
import { getConfigDir, getServiceName, getPm2AppName, getLaunchdPlistPath, DEFAULT_INSTANCE_ID } from '../service.js';
import {
  buildUpgradeInstallCommand,
  buildUpgradeMetadataArgs,
  buildContainerImageUpgradeMessage,
  CONTAINER_AGENT_CAPABILITY,
  CONTAINER_IMAGE_UPGRADE_REASON,
  isContainerAgentRuntime,
  createWindowsUpgradeRun,
  launchWindowsUpgradeScript,
  prepareWindowsUpgradeRunner,
  releaseWindowsUpgradeLock,
  resolveWindowsNpmCliPath,
  resolveWindowsPm2CliPath,
} from '../upgrade-command.js';
import { sendToServer } from './buffer.js';
import { stopAgentHeartbeat } from './heartbeat.js';
import { createUnixUpgradeRun, getUnixUpgradeLockPath, launchUnixUpgrade, shellQuote } from '../unix-upgrade.js';

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

/** Return true only when `latestVersion` is semantically newer. */
export function isUpgradeAvailable(currentVersion, latestVersion) {
  const current = parseSemver(currentVersion);
  const latest = parseSemver(latestVersion);
  if (!current || !latest) return currentVersion !== latestVersion;
  return cmpTuple(latest, current) > 0;
}

// Shared cleanup logic for restart/upgrade
function cleanupAndExit(exitCode, { maxCleanupMs = null } = {}) {
  setTimeout(async () => {
    // The updater waits for this process. Do not let an unbounded async cleanup
    // outlive the handoff and strand an on-failure service after exit(0).
    if (maxCleanupMs) setTimeout(() => process.exit(exitCode), maxCleanupMs).unref();
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
    try {
      const { shutdownWorkCenter } = await import('../yeaft/work-center/bridge.js');
      await shutdownWorkCenter();
    } catch (err) {
      console.warn(`[Agent] Work Center shutdown failed: ${err?.message || err}`);
    }
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

export async function handleRestartAgent(correlation = {}) {
  console.log('[Agent] Restart requested, shutting down for PM2/systemd restart...');
  await sendToServer({ type: 'restart_agent_ack', requestId: correlation.requestId, clientId: correlation.clientId });
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
        buildUpgradeMetadataArgs(`${pkgName}@${version}`, 'engines.node'),
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

export async function handleUpgradeAgent(correlation = {}) {
  const sendUpgradeAck = (payload) => sendToServer({
    type: 'upgrade_agent_ack',
    ...payload,
    requestId: correlation.requestId,
    clientId: correlation.clientId,
  });
  if (isContainerAgentRuntime() || ctx.agentCapabilities?.includes(CONTAINER_AGENT_CAPABILITY)) {
    const version = ctx.agentVersion || null;
    const error = buildContainerImageUpgradeMessage(version);
    console.warn(`[Agent] Upgrade rejected (${CONTAINER_IMAGE_UPGRADE_REASON}): ${error}`);
    await sendUpgradeAck({
      success: false,
      reason: CONTAINER_IMAGE_UPGRADE_REASON,
      error,
      version,
    });
    return;
  }

  console.log('[Agent] Upgrade requested, checking for updates...');
  try {
    const pkgName = ctx.pkgName || '@yeaft/webchat-agent';
    // Force an online refresh from the company-approved Yeaft registry instead
    // of inheriting a blocked or stale registry from the user's npm config.
    const latestVersion = await new Promise((resolve, reject) => {
      execFile(npmPath, buildUpgradeMetadataArgs(`${pkgName}@latest`, 'version'), { stdio: 'pipe', env: safeEnv, ...shellOpt }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout.toString().trim());
      });
    });
    if (!isUpgradeAvailable(ctx.agentVersion, latestVersion)) {
      console.log(`[Agent] No newer version than ${ctx.agentVersion} is available (registry: ${latestVersion}), skipping upgrade.`);
      await sendUpgradeAck({ success: true, alreadyLatest: true, version: ctx.agentVersion });
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
      await sendUpgradeAck({
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
      await sendUpgradeAck({ success: false, error: 'Source-based install: please use git pull to upgrade' });
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
      await spawnWindowsUpgradeScript(pkgName, installDir, isGlobalInstall, latestVersion, instanceId, sendUpgradeAck);
    } else {
      await spawnUnixUpgradeScript(pkgName, installDir, isGlobalInstall, latestVersion, instanceId, sendUpgradeAck);
    }

    // On Windows the detached runner removes the PM2 app only after this
    // process exits. Unix keeps the existing pre-exit service-manager behavior.
    const isPm2 = !!process.env.pm_id;
    if (!isWindows && isPm2) {
      try {
        execFileSync(pm2Path, ['delete', getPm2AppName(instanceId)], { stdio: 'pipe', env: safeEnv, ...shellOpt });
        console.log('[Agent] PM2 app deleted to prevent auto-restart during upgrade');
      } catch {
        console.log('[Agent] PM2 delete skipped (app may not be registered)');
      }
    }

    // 清理并退出，让升级脚本接管
    cleanupAndExit(0, { maxCleanupMs: 20_000 });
  } catch (e) {
    console.error('[Agent] Upgrade failed:', e.message);
    await sendUpgradeAck({ success: false, error: e.message });
  }
}

async function spawnWindowsUpgradeScript(pkgName, installDir, isGlobalInstall, latestVersion, instanceId = DEFAULT_INSTANCE_ID, sendUpgradeAck = (payload) => sendToServer({ type: 'upgrade_agent_ack', ...payload })) {
  const configDir = getConfigDir(instanceId);
  const upgradeDir = join(configDir, 'upgrade-runtime');
  const logDir = join(configDir, 'logs');
  mkdirSync(logDir, { recursive: true });

  const logPath = join(logDir, 'upgrade.log');
  const ecosystemPath = join(configDir, 'ecosystem.config.cjs');
  const npmCliPath = resolveWindowsNpmCliPath(process.execPath);
  if (!npmCliPath) throw new Error('npm JavaScript CLI entry point could not be resolved');
  const isPm2 = !!process.env.pm_id;
  const pm2CliPath = isPm2 ? resolveWindowsPm2CliPath(process.execPath) : null;
  if (isPm2 && !pm2CliPath) {
    throw new Error('PM2 manages this Agent, but its JavaScript CLI entry point could not be resolved');
  }

  const run = createWindowsUpgradeRun(upgradeDir);
  const {
    runId,
    lockPath,
    bootstrapPath,
    runnerPath,
    commandPath,
    payloadPath,
    handoffPath,
    authorizePath,
    cancelPath,
  } = run;
  const payload = {
    runId,
    lockPath,
    parentPid: process.pid,
    packageSpec: `${pkgName}@${latestVersion}`,
    globalInstall: isGlobalInstall,
    installDir,
    logPath,
    handoffPath,
    authorizePath,
    cancelPath,
    bootstrapPath,
    runnerPath,
    commandPath,
    payloadPath,
    nodePath: process.execPath,
    npmCliPath,
    pm2CliPath,
    pm2AppName: isPm2 ? getPm2AppName(instanceId) : null,
    ecosystemPath: isPm2 ? ecosystemPath : null,
  };
  try {
    prepareWindowsUpgradeRunner({
      sourceBootstrapPath: fileURLToPath(new URL('../windows-upgrade-bootstrap.js', import.meta.url)),
      sourceRunnerPath: fileURLToPath(new URL('../windows-upgrade-runner.js', import.meta.url)),
      sourceCommandPath: fileURLToPath(new URL('../upgrade-command.js', import.meta.url)),
      bootstrapPath,
      runnerPath,
      commandPath,
      payloadPath,
      payload,
    });
  } catch (err) {
    releaseWindowsUpgradeLock(lockPath, runId);
    throw err;
  }

  const launcher = await launchWindowsUpgradeScript({
    runId,
    nodePath: process.execPath,
    bootstrapPath,
    runnerPath,
    payloadPath,
    logPath,
    handoffPath,
    authorizePath,
    cancelPath,
    lockPath,
    spawnProcess: spawn,
  });
  console.log(`[Agent] Spawned Windows upgrade runner via ${launcher} (pm2=${isPm2}, dir=${installDir})`);
  await sendUpgradeAck({ success: true, version: latestVersion, pendingRestart: true });
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
 * @param {string} opts.targetVersion  exact version selected by the metadata check
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
  targetVersion,
  installDir,
  isGlobalInstall,
  pid,
  configDir,
  npmPath,
  safePath,
  instanceId = DEFAULT_INSTANCE_ID,
  isDarwin = platform() === 'darwin',
  run,
  lockPath,
  nodePath = process.execPath,
  isSystemd = existsSync(join(homedir(), '.config', 'systemd', 'user', `${getServiceName(instanceId)}.service`)),
}) {
  const serviceName = getServiceName(instanceId);
  const plistPath = getLaunchdPlistPath(instanceId);
  const isLaunchd = isDarwin && existsSync(plistPath);
  const cwd = isGlobalInstall ? undefined : installDir;

  const shLines = [
    '#!/bin/bash',
    `PID=${pid}`,
    `PKG=${shellQuote(`${pkgName}@${targetVersion}`)}`,
    `NPM=${shellQuote(npmPath)}`,
    `LOGFILE=${shellQuote(join(configDir, 'logs', 'upgrade.log'))}`,
    `export PATH=${shellQuote(safePath)}`,
    '',
    '# Redirect all output to log file',
    'exec >> "$LOGFILE" 2>&1 || exit 1',
    'echo "[Upgrade] Started at $(date)"',
    '',
    ...(cwd ? [`INSTALL_DIR=${shellQuote(cwd)}`] : []),
    ...(run ? [
      `RUN_DIR=${shellQuote(run.dir)}`,
      `READY=${shellQuote(run.readyPath)}`,
      `AUTHORIZED=${shellQuote(run.authorizePath)}`,
      `ACCEPTED=${shellQuote(run.acceptedPath)}`,
      `CANCELLED=${shellQuote(run.cancelPath)}`,
      `ERROR_FILE=${shellQuote(run.errorPath)}`,
      ...(lockPath ? [
        `LOCK=${shellQuote(lockPath)}`,
        'if ! command -v flock >/dev/null || ! exec 9>"$LOCK"; then',
        '  echo "Cannot acquire installation upgrade lock; Agent remains online" > "$ERROR_FILE"',
        '  exit 1',
        'fi',
        'if ! flock -n 9; then',
        '  echo "Another Agent is upgrading this shared installation; retry after it finishes" > "$ERROR_FILE"',
        '  exit 1',
        'fi',
      ] : []),
      'echo "$$" > "$READY" || exit 1',
      'COUNT=0',
      'while [ ! -f "$AUTHORIZED" ]; do',
      '  if [ -f "$CANCELLED" ] || ! kill -0 "$PID" 2>/dev/null || [ "$COUNT" -ge 60 ]; then',
      '    echo "[Upgrade] Handoff cancelled; installation unchanged"',
      '    exit 1',
      '  fi',
      '  COUNT=$((COUNT+1))',
      '  sleep 1',
      'done',
      '[ ! -f "$CANCELLED" ] || exit 1',
      'touch "$ACCEPTED" || exit 1',
    ] : []),
    '',
    '# Wait for current process to exit',
    'COUNT=0',
    'while kill -0 $PID 2>/dev/null; do',
    '  COUNT=$((COUNT+1))',
    '  if [ $COUNT -ge 30 ]; then',
    '    echo "[Upgrade] Timeout waiting for PID $PID to exit"',
    '    exit 1',
    '  fi',
    '  sleep 2',
    'done',
    ...(run ? ['[ ! -f "$CANCELLED" ] || exit 1'] : []),
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
      `if ! systemctl --user stop "${serviceName}"; then`,
      '  echo "[Upgrade] Could not stop selected service; refusing to modify installation"',
      '  exit 1',
      'fi',
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
  const npmArgs = buildUpgradeInstallCommand('"$PKG"', { global: isGlobalInstall });
  const npmCmd = isGlobalInstall
    ? npmArgs.replace(/^npm /, '"$NPM" ')
    : `cd "$INSTALL_DIR" && ${npmArgs.replace(/^npm /, '"$NPM" ')}`;

  // Recheck after acquiring the shared lock. An older queued process must not
  // replace a package that another instance has already upgraded.
  const installedManifest = join(installDir, 'node_modules', pkgName, 'package.json');
  const versionCheck = `try { const fs = require('node:fs'); const v = JSON.parse(fs.readFileSync(process.argv[1])).version; const a = v.split('.').map(Number); const b = process.argv[2].split('.').map(Number); let d = 0; for (let i = 0; i < 3 && !d; i++) d = a[i] - b[i]; process.exit(d >= 0 ? 0 : 1); } catch { process.exit(1); }`;
  shLines.push(
    `if ${shellQuote(nodePath)} -e ${shellQuote(versionCheck)} ${shellQuote(installedManifest)} ${shellQuote(targetVersion)}; then`,
    '  echo "[Upgrade] Shared installation already has this version or newer; restarting selected instance only"',
    '  EXIT_CODE=0',
    'else',
    'echo "[Upgrade] Installing $PKG..."',
    npmCmd,
    'EXIT_CODE=$?',
    'fi',
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

  // Keep failed handoffs for diagnosis; successful runs remove only their own files.
  shLines.push('', run ? 'rm -rf -- "$RUN_DIR"' : `rm -f ${shellQuote(join(configDir, 'upgrade.sh'))}`);

  return shLines.join('\n');
}

async function spawnUnixUpgradeScript(pkgName, installDir, isGlobalInstall, latestVersion, instanceId = DEFAULT_INSTANCE_ID, sendUpgradeAck = (payload) => sendToServer({ type: 'upgrade_agent_ack', ...payload })) {
  const configDir = getConfigDir(instanceId);
  // Create logs/ too: the generated script's `exec > "$LOGFILE" 2>&1` aborts
  // the whole upgrade silently if that directory is missing.
  mkdirSync(join(configDir, 'logs'), { recursive: true });
  const run = createUnixUpgradeRun(configDir);
  const isSystemd = platform() === 'linux' && (
    !!process.env.INVOCATION_ID
    || existsSync(join(homedir(), '.config', 'systemd', 'user', `${getServiceName(instanceId)}.service`))
  );
  // Linux flock is kernel-owned: it releases automatically even when an updater
  // crashes. Never unlink the shared lock inode while another runner may use it.
  const lockPath = platform() === 'linux'
    ? getUnixUpgradeLockPath(installDir, join(getConfigDir(DEFAULT_INSTANCE_ID), 'upgrade-locks'))
    : null;

  const script = buildUnixUpgradeScript({
    pkgName,
    targetVersion: latestVersion,
    installDir,
    isGlobalInstall,
    pid: process.pid,
    configDir,
    npmPath,
    safePath,
    instanceId,
    run,
    lockPath,
    isSystemd,
  });

  writeFileSync(run.scriptPath, script, { mode: 0o700 });
  await launchUnixUpgrade({
    run,
    instanceId,
    isSystemd,
    env: safeEnv,
    serviceRunnerPath: fileURLToPath(new URL('../yeaft/systemd-service-runner.js', import.meta.url)),
    sendUpgradeAck,
    version: latestVersion,
  });
  console.log(`[Agent] Upgrade runner ready outside service cgroup: ${run.scriptPath}`);
}
