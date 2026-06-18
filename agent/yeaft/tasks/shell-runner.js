/**
 * shell-runner.js — Cross-platform background shell task runner.
 */

import { spawn } from 'child_process';
import { buildShellInvocation } from '../tools/bash.js';
import { getRuntimePlatformInfo } from '../runtime-platform.js';

export function startShellProcess({ command, cwd, runtimePlatform, onOutput, onExit, onError }) {
  const platform = runtimePlatform || getRuntimePlatformInfo();
  const invocation = buildShellInvocation(command, { runtimePlatform: platform });
  const proc = spawn(invocation.command, invocation.args, {
    cwd,
    env: { ...process.env, TERM: 'dumb', FORCE_COLOR: '0' },
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
    kill(signal = 'SIGTERM') {
      if (!proc.pid) return false;
      try {
        if (!platform.isWindows) {
          process.kill(-proc.pid, signal);
          return true;
        }
      } catch {
        // Fall through to killing the child pid.
      }
      try {
        proc.kill(signal);
        return true;
      } catch {
        return false;
      }
    },
  };
}
