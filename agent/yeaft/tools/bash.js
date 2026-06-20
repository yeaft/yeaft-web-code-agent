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
import { buildShellInvocation, getRuntimePlatformInfo } from '../runtime-platform.js';
import { wrapInvocationInSystemdUserScope } from '../systemd-scope.js';

export { buildShellInvocation };

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
function runCommand(command, { cwd, timeout, signal, runtimePlatform }) {
  return new Promise((resolve) => {
    const platform = runtimePlatform || getRuntimePlatformInfo();
    const env = { ...process.env, TERM: 'dumb', FORCE_COLOR: '0' };
    const baseInvocation = buildShellInvocation(command, { runtimePlatform: platform });
    const invocation = wrapInvocationInSystemdUserScope(baseInvocation, {
      runtimePlatform: platform,
      env,
      scopeId: `foreground-${Date.now()}-${process.pid}`,
    });
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      env,
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
- Use background=true for long-running or persistent tasks that should survive across turns
- stderr is captured separately and included in the result`,
    zh: `执行 Shell 命令并返回输出。

用于运行 CLI 命令、脚本和系统操作。

使用指南：
- 命令在工作目录中执行（上下文中的 cwd）
- 默认超时 2 分钟（最大 10 分钟）
- 大输出在 256KB 处截断
- 尽量使用绝对路径
- 避免交互式命令（不支持 stdin）
- 长时间或需要跨 turn 持续存在的任务使用 background=true
- stderr 单独捕获并包含在结果中`
  },
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: {
          en: 'The shell command to execute using the Agent OS default shell',
          zh: '要使用 Agent 操作系统默认 shell 执行的命令',
        },
      },
      cwd: {
        type: 'string',
        description: {
          en: 'Working directory for the command (default: engine cwd)',
          zh: '命令的工作目录（默认为引擎当前目录）',
        },
      },
      timeout_ms: {
        type: 'number',
        description: {
          en: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS})`,
          zh: `超时时间，单位毫秒（默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}）`,
        },
      },
      background: {
        type: 'boolean',
        description: {
          en: 'Run as a persistent Session task and return immediately with a taskId and log path',
          zh: '作为持久化 Session 后台任务运行，并立即返回 taskId 和日志路径',
        },
      },
      taskTitle: {
        type: 'string',
        description: {
          en: 'Human-readable title for the background task',
          zh: '后台任务的人类可读标题',
        },
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
    const { command, cwd: inputCwd, timeout_ms, background = false, taskTitle } = input;
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

    if (background) {
      if (!ctx?.taskManager) {
        return JSON.stringify({ error: 'background tasks are unavailable in this runtime' });
      }
      try {
        const task = ctx.taskManager.startShellTask({
          command,
          cwd,
          sessionId: ctx.sessionId || 'default',
          ownerVpId: ctx.currentVpId || null,
          title: taskTitle || command.slice(0, 120),
          runtimePlatform,
          source: {
            threadId: ctx.threadId || 'main',
          },
        });
        // Same-turn parking: tell the engine "this turn has an async
        // task in flight". The engine refuses to finalize end_turn
        // while the set is non-empty and will splice the task result
        // into the next adapter loop when it terminates. No-op when
        // the engine didn't wire the hook (legacy callers / tests).
        const currentToolCall = typeof ctx.currentToolCall === 'function' ? ctx.currentToolCall() : null;
        try { ctx.registerAsyncTask?.(task.id, currentToolCall || {}); } catch { /* never block tool return on coord errors */ }
        return `Started background task ${task.id}.\nStatus: ${task.status}\nLog: ${task.log?.path || ''}\nUse ListTasks, ReadTaskLog, or CancelTask to inspect or control it.`;
      } catch (err) {
        return JSON.stringify({ error: err?.message || String(err) });
      }
    }

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
