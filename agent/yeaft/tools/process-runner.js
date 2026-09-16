import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_KILL_GRACE_MS = 250;
const DEFAULT_FORCE_SETTLE_MS = 1000;
const CONFIRMATION_POLL_MS = 25;

export class ProcessTerminationError extends Error {
  constructor(command, forceSettleMs) {
    super(`Process tree did not exit within ${forceSettleMs}ms after SIGKILL: ${command}`);
    this.name = 'ProcessTerminationError';
    this.command = command;
    this.forceSettleMs = forceSettleMs;
  }
}

function abortError(signal) {
  if (signal?.reason instanceof Error && signal.reason.name === 'AbortError') return signal.reason;
  const error = new Error(
    signal?.reason instanceof Error ? signal.reason.message : 'The operation was aborted',
  );
  error.name = 'AbortError';
  return error;
}

function signalSystemdScope(scope, signalName, spawnProcessSync) {
  if (!scope?.unit || !scope?.systemctlPath) return false;
  try {
    const result = spawnProcessSync(scope.systemctlPath, [
      '--user',
      'kill',
      `--signal=${signalName}`,
      scope.unit,
    ], {
      env: scope.env || process.env,
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: 5000,
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function isSystemdScopeInactive(scope, spawnProcessSync) {
  if (!scope?.unit || !scope?.systemctlPath) return true;
  try {
    const result = spawnProcessSync(scope.systemctlPath, [
      '--user',
      'show',
      '--property=ActiveState',
      '--value',
      scope.unit,
    ], {
      env: scope.env || process.env,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const state = String(result.stdout || '').trim();
    if (!result.error && result.status === 0) {
      return state === 'inactive' || state === 'failed';
    }
    return /(?:could not be found|not found|does not exist|not loaded)/i
      .test(String(result.stderr || ''));
  } catch {
    return false;
  }
}

function killProcessTree(
  proc,
  signalName,
  platform,
  spawnProcessSync,
  systemdScope,
  commandTimeoutMs = 5000,
) {
  if (!proc.pid) return false;
  if (platform === 'win32') {
    try {
      const result = spawnProcessSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: Math.max(1, commandTimeoutMs),
      });
      if (!result.error && result.status === 0) return true;
    } catch {}
    try { proc.kill(signalName); } catch {}
    return false;
  }

  let signalled = signalSystemdScope(systemdScope, signalName, spawnProcessSync);
  try {
    process.kill(-proc.pid, signalName);
    signalled = true;
  } catch {}
  try {
    if (proc.kill(signalName) !== false) signalled = true;
  } catch {}
  return signalled;
}

function processGroupIsInactive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

/**
 * Execute a binary directly without a shell and keep captured output bounded.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, outputLimitAction?: 'stop'|'head-tail', env?: NodeJS.ProcessEnv, preserveCarriageReturns?: boolean, killGraceMs?: number, gracefulTerminationDeadline?: number, terminationDeadline?: number, forceSettleMs?: number, treeKillTimeoutMs?: number, requireExitConfirmation?: boolean, requireProcessGroupExit?: boolean, systemdScope?: { unit: string, systemctlPath: string, env?: NodeJS.ProcessEnv } | null, onSettled?: (() => void) | null, platform?: NodeJS.Platform, spawnProcess?: typeof spawn, spawnProcessSync?: typeof spawnSync }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, truncated: boolean, timedOut: boolean, terminationError?: string }>}
 */
export function runProcess(command, args, options = {}) {
  if (options.signal?.aborted) {
    try { options.onSettled?.(); } catch {}
    return Promise.reject(abortError(options.signal));
  }

  return new Promise((resolve, reject) => {
    const platform = options.platform || process.platform;
    const spawnProcess = options.spawnProcess || spawn;
    const spawnProcessSync = options.spawnProcessSync || spawnSync;
    const maxBytes = Number.isFinite(options.maxBytes)
      ? Math.max(0, options.maxBytes)
      : DEFAULT_MAX_BYTES;
    const keepOutputTail = options.outputLimitAction === 'head-tail';
    const killGraceMs = Number.isFinite(options.killGraceMs)
      ? Math.max(0, options.killGraceMs)
      : DEFAULT_KILL_GRACE_MS;
    const forceSettleMs = Number.isFinite(options.forceSettleMs)
      ? Math.max(1, options.forceSettleMs)
      : DEFAULT_FORCE_SETTLE_MS;
    const treeKillTimeoutMs = Number.isFinite(options.treeKillTimeoutMs)
      ? Math.max(1, options.treeKillTimeoutMs)
      : 5000;
    const deadlineBudget = (maximum, deadline) => {
      if (!Number.isFinite(deadline)) return maximum;
      return Math.max(0, Math.min(maximum, deadline - Date.now()));
    };
    const terminationBudget = maximum => deadlineBudget(maximum, options.terminationDeadline);
    const treeKillBudget = () => Number.isFinite(options.terminationDeadline)
      ? terminationBudget(treeKillTimeoutMs)
      : treeKillTimeoutMs;
    let proc;
    try {
      proc = spawnProcess(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: platform !== 'win32',
      });
    } catch (error) {
      try { options.onSettled?.(); } catch {}
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stopRequested = false;
    let forceRequested = false;
    let processTreeKillConfirmed = platform !== 'win32';
    let treeKillFailed = false;
    let directClosed = false;
    let directCode = null;
    let timer = null;
    let forceTimer = null;
    let forceSettleTimer = null;
    let confirmationTimer = null;

    let onStdout;
    let onStderr;
    let onError;
    let onClose;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      if (confirmationTimer) clearInterval(confirmationTimer);
      timer = null;
      forceTimer = null;
      forceSettleTimer = null;
      confirmationTimer = null;
      options.signal?.removeEventListener('abort', onAbort);
      if (onStdout) proc.stdout?.off('data', onStdout);
      if (onStderr) proc.stderr?.off('data', onStderr);
      if (onError) proc.off('error', onError);
      if (onClose) proc.off('close', onClose);
      try { options.onSettled?.(); } catch {}
    };
    const decode = (chunks, wasTruncated, preserveCarriageReturns = false) => {
      const decoder = new StringDecoder('utf8');
      if (wasTruncated && keepOutputTail) {
        const buffer = Buffer.concat(chunks);
        const marker = '\n[Process output middle omitted]\n';
        const budget = Math.max(0, maxBytes - Buffer.byteLength(marker));
        const headEnd = Math.floor(budget / 2);
        let tailStart = buffer.length - (budget - headEnd);
        while (tailStart < buffer.length && (buffer[tailStart] & 0xc0) === 0x80) tailStart += 1;
        const head = decoder.write(buffer.subarray(0, headEnd));
        const tail = new StringDecoder('utf8').write(buffer.subarray(tailStart));
        const value = head + marker.slice(0, maxBytes) + tail;
        return preserveCarriageReturns ? value : value.replace(/\r/g, '');
      }
      let value = decoder.write(Buffer.concat(chunks));
      if (!wasTruncated) value += decoder.end();
      return preserveCarriageReturns ? value : value.replace(/\r/g, '');
    };
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result = {
        code: timedOut ? 124 : (code ?? 1),
        stdout: decode(stdout, stdoutTruncated, options.preserveCarriageReturns),
        stderr: decode(stderr, stderrTruncated),
        truncated,
        timedOut,
      };
      if (aborted) {
        reject(abortError(options.signal));
        return;
      }
      if (error) {
        // A command timeout is an owned, bounded outcome. Failure to observe
        // the final child close is important context for the caller, but it
        // must not turn the timeout into an infrastructure exception that
        // prevents the model from deciding what to do next.
        if (timedOut && error instanceof ProcessTerminationError) {
          resolve({ ...result, terminationError: error.message });
          return;
        }
        reject(error);
        return;
      }
      resolve(result);
    };
    const terminationConfirmed = () => {
      if (!options.requireExitConfirmation) return directClosed;
      const scopeInactive = isSystemdScopeInactive(options.systemdScope, spawnProcessSync);
      const processTreeInactive = !options.requireProcessGroupExit
        || (platform === 'win32'
          ? processTreeKillConfirmed
          : processGroupIsInactive(proc.pid));
      const treeKillSucceeded = platform !== 'win32'
        || !options.requireProcessGroupExit
        || !treeKillFailed;
      return directClosed && scopeInactive && processTreeInactive && treeKillSucceeded;
    };
    const maybeFinishStopped = () => {
      if (settled || !stopRequested || !terminationConfirmed()) return false;
      finish(directCode);
      return true;
    };
    const startConfirmationPolling = () => {
      if (!options.requireExitConfirmation || confirmationTimer) return;
      confirmationTimer = setInterval(maybeFinishStopped, CONFIRMATION_POLL_MS);
      if (!options.requireProcessGroupExit) confirmationTimer.unref?.();
    };
    const forceStop = () => {
      if (settled || forceRequested) return;
      forceRequested = true;
      const settleBudget = terminationBudget(forceSettleMs);
      killProcessTree(
        proc,
        'SIGKILL',
        platform,
        spawnProcessSync,
        options.systemdScope,
        Math.max(1, treeKillBudget() || 1),
      );
      if (maybeFinishStopped()) return;
      if (settleBudget <= 0) {
        finish(
          null,
          options.requireExitConfirmation
            ? new ProcessTerminationError(command, forceSettleMs)
            : null,
        );
        return;
      }
      forceSettleTimer = setTimeout(() => {
        if (maybeFinishStopped()) return;
        finish(
          null,
          options.requireExitConfirmation
            ? new ProcessTerminationError(command, forceSettleMs)
            : null,
        );
      }, settleBudget);
    };
    const stop = () => {
      if (settled || stopRequested) return;
      stopRequested = true;
      if (platform === 'win32') {
        // taskkill must run while the parent PID still identifies the tree.
        // It is already forceful, so do not wait for the direct child to exit.
        forceRequested = true;
        const settleBudget = terminationBudget(forceSettleMs);
        processTreeKillConfirmed = killProcessTree(
          proc,
          'SIGKILL',
          platform,
          spawnProcessSync,
          null,
          Math.max(1, treeKillBudget() || 1),
        );
        treeKillFailed = !processTreeKillConfirmed;
        if (maybeFinishStopped()) return;
        if (!settled) {
          const finishAfterForce = () => {
            if (maybeFinishStopped()) return;
            finish(
              null,
              options.requireExitConfirmation
                ? new ProcessTerminationError(command, forceSettleMs)
                : null,
            );
          };
          const remainingSettleBudget = terminationBudget(forceSettleMs);
          if (remainingSettleBudget <= 0) finishAfterForce();
          else forceSettleTimer = setTimeout(finishAfterForce, remainingSettleBudget);
        }
        return;
      }
      startConfirmationPolling();
      if (maybeFinishStopped()) return;
      killProcessTree(
        proc,
        'SIGTERM',
        platform,
        spawnProcessSync,
        options.systemdScope,
      );
      const graceBudget = deadlineBudget(killGraceMs, options.gracefulTerminationDeadline);
      if (graceBudget <= 0) forceStop();
      else {
        forceTimer = setTimeout(forceStop, graceBudget);
        if (!options.requireProcessGroupExit) forceTimer.unref?.();
      }
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const capture = (target, chunk, isStdout) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const current = isStdout ? stdoutBytes : stderrBytes;
      const remaining = maxBytes - current;
      if (keepOutputTail && (buffer.length > remaining || (isStdout ? stdoutTruncated : stderrTruncated))) {
        const prior = Buffer.concat(target);
        const headSize = Math.floor(maxBytes / 2);
        const tailSize = maxBytes - headSize;
        const head = prior.length >= headSize ? prior.subarray(0, headSize)
          : Buffer.concat([prior, buffer.subarray(0, headSize - prior.length)]);
        const tail = buffer.length >= tailSize ? buffer.subarray(buffer.length - tailSize)
          : Buffer.concat([prior.subarray(Math.max(0, prior.length - (tailSize - buffer.length))), buffer]);
        // Copy slices so a tiny retained tail cannot retain an unbounded chunk.
        target.splice(0, target.length, Buffer.from(head), Buffer.from(tail));
        truncated = true;
        if (isStdout) { stdoutTruncated = true; stdoutBytes = maxBytes; }
        else { stderrTruncated = true; stderrBytes = maxBytes; }
        return;
      }
      if (remaining <= 0) {
        truncated = true;
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
        stop();
        return;
      }
      const bounded = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
      target.push(bounded);
      if (isStdout) stdoutBytes += bounded.length;
      else stderrBytes += bounded.length;
      if (bounded.length !== buffer.length) {
        truncated = true;
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
        stop();
      }
    };

    onStdout = chunk => capture(stdout, chunk, true);
    onStderr = chunk => capture(stderr, chunk, false);
    const finishStoppedChild = () => {
      if (!forceRequested) {
        if (forceTimer) clearTimeout(forceTimer);
        forceTimer = null;
        forceStop();
      }
      maybeFinishStopped();
    };
    onError = error => {
      if (settled) return;
      if (stopRequested) {
        directClosed = true;
        if (platform !== 'win32' || !treeKillFailed || !options.requireProcessGroupExit) finishStoppedChild();
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    onClose = code => {
      directClosed = true;
      directCode = code;
      if (!stopRequested && options.requireProcessGroupExit && !terminationConfirmed()) {
        stop();
        return;
      }
      if (stopRequested) {
        if (platform !== 'win32' || !treeKillFailed || !options.requireProcessGroupExit) finishStoppedChild();
        return;
      }
      finish(code);
    };
    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);
    proc.on('error', onError);
    proc.on('close', onClose);

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        // Preserve the first stop reason. Output overflow and Abort may have
        // already started termination; a later deadline must not relabel that
        // cleanup failure as a recoverable command timeout.
        if (settled || stopRequested) return;
        timedOut = true;
        stop();
      }, options.timeoutMs);
      timer.unref?.();
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}
