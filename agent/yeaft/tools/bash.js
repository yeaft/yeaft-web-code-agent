/**
 * bash.js — Execute shell commands.
 *
 * Spawns a child process to run shell commands with timeout, output
 * truncation, working directory support, and cancellation via AbortSignal.
 *
 * The tool name remains Bash for wire compatibility. Internally it uses the
 * platform default shell: POSIX shell on Linux/macOS, PowerShell/cmd on Windows.
 */

import { defineTool } from './types.js';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getRuntimePlatformInfo, resolveDefaultShell } from '../runtime-platform.js';

/** Max output size in bytes before truncation (256 KB). */
const MAX_OUTPUT = 256 * 1024;

/** Default timeout in ms (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Max timeout in ms (10 minutes). */
const MAX_TIMEOUT_MS = 600_000;

/**
 * @param {string} command
 * @param {{ runtimePlatform?: object }} opts
 */
export function buildShellInvocation(command, opts = {}) {
  const runtimePlatform = opts.runtimePlatform || getRuntimePlatformInfo();
  const shell = runtimePlatform.defaultShell
    ? {
        command: runtimePlatform.defaultShell,
        argsPrefix: Array.isArray(runtimePlatform.shellArgsPrefix) ? runtimePlatform.shellArgsPrefix : null,
        family: runtimePlatform.shellFamily,
      }
    : resolveDefaultShell({ platform: runtimePlatform.platform });

  const argsPrefix = Array.isArray(shell.argsPrefix)
    ? shell.argsPrefix
    : resolveDefaultShell({ platform: runtimePlatform.platform }).argsPrefix;

  return {
    command: shell.command,
    args: [...argsPrefix, command],
    family: shell.family || runtimePlatform.shellFamily || 'posix',
  };
}

/**
 * Run a command in a child process.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, timedOut: boolean }>}
 */
function runCommand(command, { cwd, timeout, signal, runtimePlatform }) {
  return new Promise((resolve) => {
    const platform = runtimePlatform || getRuntimePlatformInfo();
    const invocation = buildShellInvocation(command, { runtimePlatform: platform });
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, TERM: 'dumb', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !platform.isWindows,
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let timeoutId = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve(result);
    };

    const killProcess = () => {
      try {
        if (!platform.isWindows && proc.pid) {
          process.kill(-proc.pid, 'SIGTERM');
          return;
        }
      } catch {
        // Fall back to killing the shell process below.
      }
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    };

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

    timeoutId = setTimeout(() => {
      timedOut = true;
      killProcess();
      finish({
        stdout,
        stderr: stderr + `\nProcess timed out after ${timeout}ms`,
        exitCode: 124,
        timedOut: true,
      });
    }, timeout);

    if (signal) {
      signal.addEventListener('abort', () => {
        killProcess();
      }, { once: true });
    }

    proc.on('close', (code, signalName) => {
      if (stdoutTruncated) stdout += '\n[Output truncated]';
      if (stderrTruncated) stderr += '\n[Output truncated]';
      finish({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : (code ?? (signalName ? 128 : 1)),
        timedOut,
      });
    });

    proc.on('error', (err) => {
      finish({
        stdout,
        stderr: `Error spawning process: ${err.message}`,
        exitCode: 1,
        timedOut: false,
      });
    });
  });
}

export default defineTool({
  name: 'Bash',
  description: {
    en: `Execute a shell command and return its output.

Use this tool to run CLI commands, scripts, and system operations. The tool name
is kept as Bash for compatibility; on Windows the command is executed through
the configured Windows shell (PowerShell by default, or cmd when configured).

Guidelines:
- Commands run in the working directory (cwd from context)
- Match command syntax to the Agent OS shown in the runtime_platform prompt
- Timeout defaults to 2 minutes (max 10 minutes)
- Large outputs are truncated at 256KB
- Use absolute paths when possible
- Avoid interactive commands (no stdin support)
- For long-running tasks, consider redirecting output to a file
- stderr is captured separately and included in the result`,
    zh: `执行 Shell 命令并返回输出。

用于运行 CLI 命令、脚本和系统操作。

使用指南：
- 命令在工作目录中执行（上下文中的 cwd）
- 默认超时 2 分钟（最大 10 分钟）
- 大输出在 256KB 处截断
- 尽量使用绝对路径
- 避免交互式命令（不支持 stdin）
- 长时间任务建议重定向输出到文件
- stderr 单独捕获并包含在结果中`
  },
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute using the Agent OS default shell',
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
           cmd.includes('remove-item') || cmd.startsWith('del ') || cmd.includes(' del ') ||
           cmd.includes('git reset --hard') || cmd.includes('git clean') ||
           cmd.includes('dd ') || cmd.includes('mkfs') || cmd.includes('format ') ||
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
    const runtimePlatform = ctx?.runtimePlatform || getRuntimePlatformInfo();

    try {
      const result = await runCommand(command, {
        cwd,
        timeout,
        signal: ctx?.signal,
        runtimePlatform,
      });

      // Format output similar to Claude Code
      const parts = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`STDERR:\n${result.stderr}`);
      if (result.timedOut) parts.push(`\n(Command timed out after ${timeout}ms)`);

      const output = parts.join('\n');
      if (result.exitCode !== 0) {
        return `Exit code: ${result.exitCode}\n${output}`;
      }
      return output || '(no output)';
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
});
