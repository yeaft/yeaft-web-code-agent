/**
 * shell-runner.js — Cross-platform background shell task runner.
 */

import { spawn, spawnSync } from 'child_process';
import { buildShellInvocation, getRuntimePlatformInfo } from '../runtime-platform.js';
import { wrapInvocationInSystemdUserScope } from '../systemd-scope.js';

export function buildWindowsTaskkillArgs(pid) {
  return ['/pid', String(pid), '/t', '/f'];
}

export function killShellProcessTree(pid, runtimePlatform, signal = 'SIGTERM') {
  if (!pid) return false;
  const platform = runtimePlatform || getRuntimePlatformInfo();
  if (platform.isWindows) {
    const result = spawnSync('taskkill.exe', buildWindowsTaskkillArgs(pid), {
      windowsHide: true,
      stdio: 'ignore',
    });
    return result.status === 0;
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function startShellProcess({ command, cwd, runtimePlatform, scopeId = null, onOutput, onExit, onError }) {
  const platform = runtimePlatform || getRuntimePlatformInfo();
  const env = { ...process.env, TERM: 'dumb', FORCE_COLOR: '0' };
  const baseInvocation = buildShellInvocation(command, { runtimePlatform: platform });
  const invocation = wrapInvocationInSystemdUserScope(baseInvocation, {
    runtimePlatform: platform,
    env,
    scopeId,
  });
  const proc = spawn(invocation.command, invocation.args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !platform.isWindows,
    windowsHide: true,
  });

  const write = (stream, chunk) => {
    if (!chunk) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    onOutput?.(stream, text);
  };

  proc.stdout?.on('data', (chunk) => write('stdout', chunk));
  proc.stderr?.on('data', (chunk) => write('stderr', chunk));
  proc.on('error', (err) => onError?.(err));
  proc.on('close', (code, signal) => onExit?.({ code, signal }));

  return {
    pid: proc.pid || null,
    systemdScope: invocation.systemdScope || null,
    kill(signal = 'SIGTERM') {
      return killShellProcessTree(proc.pid, platform, signal);
    },
  };
}
