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
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildShellInvocation, getRuntimePlatformInfo } from '../runtime-platform.js';
import {
  wrapInvocationInSystemdUserScope,
  wrapInvocationInSystemdUserService,
} from '../systemd-scope.js';
import { runProcess } from './process-runner.js';

export { buildShellInvocation };

/** Max output size in bytes before truncation (256 KB). */
const MAX_OUTPUT = 256 * 1024;

/** Default timeout in ms (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Max timeout in ms (10 minutes). */
const MAX_TIMEOUT_MS = 600_000;
const LINUX_NAMESPACE_HELPER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'linux-process-namespace.js',
);
const RUN_PROCESS_OVERRIDE = Symbol('runProcessOverride');

/**
 * Run a command in a child process.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, timedOut: boolean, terminationError: string | null }>}
 */
function runCommand(command, { cwd, timeout, signal, runtimePlatform, runProcessImpl = runProcess }) {
  const platform = runtimePlatform || getRuntimePlatformInfo();
  const env = { ...process.env, TERM: 'dumb', FORCE_COLOR: '0' };
  const baseInvocation = buildShellInvocation(command, { runtimePlatform: platform });
  let invocation = wrapInvocationInSystemdUserScope(baseInvocation, {
    runtimePlatform: platform,
    env,
    scopeId: `foreground-${Date.now()}-${process.pid}`,
  });
  if (platform.isLinux && !invocation.systemdControl) {
    invocation = wrapInvocationInSystemdUserService(baseInvocation, {
      runtimePlatform: platform,
      env,
      cwd,
      unitId: `foreground-${Date.now()}-${process.pid}`,
    });
  }
  if (platform.isLinux && !invocation.systemdControl) {
    const unsharePath = env.YEAFT_UNSHARE_PATH || '/usr/bin/unshare';
    if (!existsSync(unsharePath)) {
      throw new Error(
        'Foreground Bash requires systemd-run or unshare on Linux so timeout can guarantee complete process-tree cleanup. Use background=true or install util-linux.',
      );
    }
    invocation = {
      command: process.execPath,
      args: [LINUX_NAMESPACE_HELPER, '--', baseInvocation.command, ...(baseInvocation.args || [])],
      family: baseInvocation.family,
      systemdControl: null,
    };
  }
  return runProcessImpl(invocation.command, invocation.args, {
    cwd,
    env,
    signal,
    timeoutMs: timeout,
    maxBytes: MAX_OUTPUT,
    outputLimitAction: 'head-tail',
    requireExitConfirmation: true,
    systemdScope: invocation.systemdControl,
    onSettled: invocation.cleanup || null,
    platform: platform.platform,
  }).then(result => ({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
    timedOut: result.timedOut,
    truncated: result.truncated,
    terminationError: result.terminationError || null,
  }));
}

const bashTool = defineTool({
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
- Large outputs retain a bounded head/tail (256KB per stream); capture limits do not stop the command. Use background tasks for persistent full logs
- Use absolute paths when possible
- Avoid interactive commands (no stdin support)
- Use background=true for long-running or persistent tasks that should survive across turns
- Foreground timeout and cleanup status is returned to you; decide whether to inspect, retry, stop, or use a background task
- stderr is captured separately and included in the result`,
    zh: `执行 Shell 命令并返回输出。

用于运行 CLI 命令、脚本和系统操作。

使用指南：
- 命令在工作目录中执行（上下文中的 cwd）
- 默认超时 2 分钟（最大 10 分钟）
- 大输出有界保留首尾（每个流 256KB），不因输出上限终止命令；需要持久完整日志时使用后台任务
- 尽量使用绝对路径
- 避免交互式命令（不支持 stdin）
- 长时间或需要跨 turn 持续存在的任务使用 background=true
- 前台命令的超时和清理状态会返回给你；由你决定检查、重试、停止或改用后台任务
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
          en: 'Working directory; relative paths resolve against engine cwd',
          zh: '命令工作目录；相对路径以引擎当前目录为基准',
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
  errorOutput: null,
  // Foreground Bash owns a bounded timeout and process-tree cleanup state
  // machine. A second ToolRegistry timer can preempt that cleanup and turn an
  // owned exit 124 into a fatal orphan, so it must stay disabled for this tool.
  timeoutMs: 0,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  // A detached shell task can write after this tool has returned. Once one is
  // launched, same-query filesystem reads must execute instead of reusing a
  // snapshot captured before the task's eventual mutation.
  mayMutateWorkspaceAfterReturn: input => input?.background === true,
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
    if (!command) throw new Error('command is required');

    // Resolve working directory
    const cwd = resolve(ctx?.cwd || process.cwd(), inputCwd || '.');

    if (!existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    // Clamp timeout
    const timeout = Math.min(Math.max(timeout_ms || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const runtimePlatform = ctx?.runtimePlatform || getRuntimePlatformInfo();

    if (background) {
      if (!ctx?.taskManager) {
        throw new Error('background tasks are unavailable in this runtime');
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
        return `Started background task ${task.id}.\nWorking directory: ${cwd}\nStatus: ${task.status}\nLog: ${task.log?.path || ''}\nThe task is detached from this turn. Use ListTasks, ReadTaskLog, or CancelTask to inspect or control it.`;
      } catch (err) {
        throw new Error(err?.message || String(err));
      }
    }

    try {
      const result = await runCommand(command, {
        cwd,
        timeout,
        signal: ctx?.signal,
        runtimePlatform,
        runProcessImpl: ctx?.[RUN_PROCESS_OVERRIDE] || runProcess,
      });

      // Format output similar to Claude Code
      const parts = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`STDERR:\n${result.stderr}`);
      if (result.truncated) parts.push('[Captured output truncated; command exit/timeout status is reported separately. Use a background task for a durable log.]');
      if (result.timedOut) parts.push(`\n(Command timed out after ${timeout}ms)`);
      if (result.terminationError) {
        parts.push([
          `WARNING: ${result.terminationError}`,
          'The command timed out, but process-tree termination could not be confirmed. The command may still be running.',
          'Decide whether to inspect or stop it, retry, or use background=true.',
        ].join('\n'));
      }
      if (result.timedOut) {
        ctx?.requestToolBatchBarrier?.({
          kind: 'owned_timeout',
          message: [
            result.terminationError
              ? 'The foreground Bash command timed out and process-tree termination could not be confirmed.'
              : 'The foreground Bash command timed out.',
            'Return this result to the model before executing another tool call from the same batch.',
          ].join(' '),
        });
      }

      const output = parts.join('\n');
      if (result.exitCode !== 0) {
        return `Exit code: ${result.exitCode}\nWorking directory: ${cwd}\n${output}`;
      }
      return output || '(no output)';
    } catch (err) {
      err.message = `${err.message} (working directory: ${cwd})`;
      if (err?.name === 'ProcessTerminationError') err.fatalToolTimeout = true;
      throw err;
    }
  },
});

export function createBashTool({ runProcessImpl = runProcess } = {}) {
  return {
    ...bashTool,
    execute(input, ctx) {
      return bashTool.execute(input, { ...ctx, [RUN_PROCESS_OVERRIDE]: runProcessImpl });
    },
  };
}

export default bashTool;
