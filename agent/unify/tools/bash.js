/**
 * bash.js — Execute shell commands.
 *
 * Spawns a child process to run shell commands with timeout, output
 * truncation, working directory support, and cancellation via AbortSignal.
 *
 * Modeled after Claude Code's Bash tool implementation.
 */

import { defineTool } from './types.js';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

/** Max output size in bytes before truncation (256 KB). */
const MAX_OUTPUT = 256 * 1024;

/** Default timeout in ms (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Max timeout in ms (10 minutes). */
const MAX_TIMEOUT_MS = 600_000;

/**
 * Run a command in a child process.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, timedOut: boolean }>}
 */
function runCommand(command, { cwd, timeout, signal }) {
  return new Promise((resolve, reject) => {
    const shell = process.env.SHELL || '/bin/bash';
    const proc = spawn(shell, ['-c', command], {
      cwd,
      env: { ...process.env, TERM: 'dumb', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    proc.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += chunk.toString();
        if (stdout.length > MAX_OUTPUT) {
          stdout = stdout.slice(0, MAX_OUTPUT);
          stdoutTruncated = true;
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += chunk.toString();
        if (stderr.length > MAX_OUTPUT) {
          stderr = stderr.slice(0, MAX_OUTPUT);
          stderrTruncated = true;
        }
      }
    });

    // Handle abort signal
    const onAbort = () => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 2000);
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        stdout: stdoutTruncated ? stdout + '\n... (output truncated)' : stdout,
        stderr: stderrTruncated ? stderr + '\n... (stderr truncated)' : stderr,
        exitCode: code ?? 1,
        timedOut,
      });
    });

    proc.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err.code === 'ETIMEDOUT' || err.killed) {
        timedOut = true;
        resolve({
          stdout,
          stderr: stderr + `\nProcess timed out after ${timeout}ms`,
          exitCode: 124,
          timedOut: true,
        });
      } else {
        resolve({
          stdout,
          stderr: `Error spawning process: ${err.message}`,
          exitCode: 1,
          timedOut: false,
        });
      }
    });
  });
}

export default defineTool({
  name: 'Bash',
  description: `Execute a shell command and return its output.

Use this tool to run CLI commands, scripts, and system operations.

Guidelines:
- Commands run in the working directory (cwd from context)
- Timeout defaults to 2 minutes (max 10 minutes)
- Large outputs are truncated at 256KB
- Use absolute paths when possible
- Avoid interactive commands (no stdin support)
- For long-running tasks, consider redirecting output to a file
- stderr is captured separately and included in the result`,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command (default: engine cwd)',
      },
      timeout_ms: {
        type: 'number',
        description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS})`,
      },
    },
    required: ['command'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: (input) => {
    if (!input?.command) return false;
    const cmd = input.command.toLowerCase();
    return cmd.includes('rm ') || cmd.includes('rmdir') ||
           cmd.includes('git reset --hard') || cmd.includes('git clean') ||
           cmd.includes('dd ') || cmd.includes('mkfs') ||
           cmd.includes('> /dev/') || cmd.includes('chmod 000');
  },
  async execute(input, ctx) {
    const { command, cwd: inputCwd, timeout_ms } = input;
    if (!command) return JSON.stringify({ error: 'command is required' });

    // Resolve working directory
    const cwd = inputCwd
      ? resolve(inputCwd)
      : (ctx?.cwd || process.cwd());

    if (!existsSync(cwd)) {
      return JSON.stringify({ error: `Working directory does not exist: ${cwd}` });
    }

    // Clamp timeout
    const timeout = Math.min(Math.max(timeout_ms || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);

    try {
      const result = await runCommand(command, {
        cwd,
        timeout,
        signal: ctx?.signal,
      });

      // Format output similar to Claude Code
      const parts = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`STDERR:\n${result.stderr}`);
      if (result.timedOut) parts.push(`\n(Command timed out after ${timeout}ms)`);

      const output = parts.join('\n') || '(no output)';

      return result.exitCode === 0
        ? output
        : `Exit code: ${result.exitCode}\n${output}`;
    } catch (err) {
      return JSON.stringify({ error: `Bash execution failed: ${err.message}` });
    }
  },
});
