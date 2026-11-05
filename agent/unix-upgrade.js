import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** A shared install has one kernel lock, independent of the requesting instance. */
export function getUnixUpgradeLockPath(installDir, lockRoot) {
  const key = createHash('sha256').update(realpathSync(installDir)).digest('hex');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  return join(lockRoot, `${key}.lock`);
}

/** Runtime files live outside the npm package and never contain public credentials. */
export function createUnixUpgradeRun(configDir) {
  const root = join(configDir, 'upgrade-runtime');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, 'unix-'));
  return {
    dir,
    scriptPath: join(dir, 'upgrade.sh'),
    readyPath: join(dir, 'ready'),
    authorizePath: join(dir, 'authorized'),
    acceptedPath: join(dir, 'accepted'),
    cancelPath: join(dir, 'cancelled'),
    errorPath: join(dir, 'error'),
  };
}

function processRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * Start an updater in a separate systemd service (never a detached child in the
 * Agent cgroup). The shell must acquire its install lock and signal readiness
 * before the caller acknowledges or exits. Failure leaves the Agent online.
 */
export async function launchUnixUpgrade({
  run,
  instanceId,
  isSystemd,
  env = process.env,
  nodePath = process.execPath,
  serviceRunnerPath,
  sendUpgradeAck,
  version,
  timeoutMs = 10_000,
}, dependencies = {}) {
  const exec = dependencies.execFileAsync || execFileAsync;
  const spawnProcess = dependencies.spawn || spawn;
  const running = dependencies.processRunning || processRunning;
  const unit = `yeaft-upgrade-${instanceId.slice(0, 60)}-${process.pid}-${run.dir.split('unix-').at(-1)}.service`;
  const uid = process.getuid?.();
  const managerEnv = {
    ...env,
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
  };
  let child;
  try {
    if (isSystemd) {
      // Pass the inherited environment privately, not as --setenv command-line
      // arguments. The runner consumes/removes this payload before npm runs.
      const payloadDir = join(run.dir, 'invocation');
      mkdirSync(payloadDir, { mode: 0o700 });
      const payloadPath = join(payloadDir, 'invocation.json');
      writeFileSync(payloadPath, JSON.stringify({
        command: '/bin/bash', args: [run.scriptPath], cwd: run.dir, env: managerEnv,
      }), { mode: 0o600 });
      await exec('systemd-run', [
        '--user', '--quiet', '--collect', '--service-type=exec',
        `--unit=${unit}`, '--', nodePath, serviceRunnerPath, payloadPath,
      ], { env: managerEnv, timeout: timeoutMs });
    } else {
      child = spawnProcess('bash', [run.scriptPath], {
        cwd: run.dir, env, detached: true, stdio: 'ignore',
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    }

    const deadline = Date.now() + timeoutMs;
    let ownerPid;
    while (Date.now() < deadline) {
      if (existsSync(run.errorPath)) throw new Error(readFileSync(run.errorPath, 'utf8').trim());
      try {
        const pid = Number(readFileSync(run.readyPath, 'utf8'));
        if (Number.isInteger(pid) && pid > 0 && running(pid)) { ownerPid = pid; break; }
      } catch {}
      if (child && child.exitCode != null) throw new Error(`Unix upgrade runner exited with code ${child.exitCode}`);
      await delay(50);
    }
    if (!ownerPid) throw new Error('Unix upgrade runner did not become ready; Agent remains online');
    let ackTimer;
    try {
      const outcome = await Promise.race([
        sendUpgradeAck({ success: true, version, pendingRestart: true }),
        new Promise((_, reject) => {
          ackTimer = setTimeout(() => reject(new Error('Upgrade acknowledgement timed out; Agent remains online')), timeoutMs);
        }),
      ]);
      if (outcome !== 'sent') throw new Error('Upgrade acknowledgement was not sent; Agent remains online');
    } finally { clearTimeout(ackTimer); }
    if (!running(ownerPid)) throw new Error('Unix upgrade runner exited during acknowledgement; Agent remains online');
    writeFileSync(run.authorizePath, 'authorized');
    const acceptDeadline = Date.now() + timeoutMs;
    while (Date.now() < acceptDeadline) {
      if (!running(ownerPid)) throw new Error('Unix upgrade runner exited before accepting handoff; Agent remains online');
      if (existsSync(run.acceptedPath)) return { unit: isSystemd ? unit : null };
      await delay(50);
    }
    throw new Error('Unix upgrade runner did not accept handoff; Agent remains online');
  } catch (error) {
    // Revoke authorization even if the manager is slow or start timed out.
    writeFileSync(run.cancelPath, 'cancelled');
    if (isSystemd) {
      try { await exec('systemctl', ['--user', 'stop', unit], { env: managerEnv, timeout: 5000 }); } catch {}
    } else if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
    // Keep cancellation files: an ambiguously started runner must see them.
    throw error;
  }
}
