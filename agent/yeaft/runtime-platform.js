/**
 * runtime-platform.js — Runtime OS/platform facts for prompts and tools.
 *
 * Keep OS detection in one place. Tools should read `ctx.runtimePlatform`
 * instead of guessing from scattered `process.platform` checks.
 */

const WINDOWS_PLATFORMS = new Set(['win32']);
const MAC_PLATFORMS = new Set(['darwin']);
const LINUX_PLATFORMS = new Set(['linux']);

/**
 * @param {string | undefined | null} platform
 * @returns {NodeJS.Platform | string}
 */
export function normalizePlatform(platform) {
  const raw = typeof platform === 'string' && platform.trim()
    ? platform.trim().toLowerCase()
    : process.platform;
  if (raw === 'windows') return 'win32';
  if (raw === 'mac' || raw === 'macos' || raw === 'osx') return 'darwin';
  return raw;
}

/**
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ command: string, argsPrefix: string[], family: 'powershell' | 'cmd' | 'posix' }}
 */
export function resolveDefaultShell(opts = {}) {
  const platform = normalizePlatform(opts.platform);
  const env = opts.env || process.env;

  if (WINDOWS_PLATFORMS.has(platform)) {
    const configured = env.YEAFT_WINDOWS_SHELL || env.PWSH || env.POWERSHELL;
    const shell = configured || 'powershell.exe';
    const lower = shell.toLowerCase();
    if (lower.includes('cmd.exe') || lower.endsWith('cmd')) {
      return { command: shell, argsPrefix: ['/d', '/s', '/c'], family: 'cmd' };
    }
    return {
      command: shell,
      argsPrefix: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'],
      family: 'powershell',
    };
  }

  return {
    command: env.SHELL || '/bin/bash',
    argsPrefix: ['-c'],
    family: 'posix',
  };
}

/**
 * Build a platform-specific shell invocation for executing a command string.
 * Kept in runtime-platform so tools and task runners share OS behavior without
 * depending on each other.
 *
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
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
export function getRuntimePlatformInfo(opts = {}) {
  const platform = normalizePlatform(opts.platform);
  const shell = resolveDefaultShell({ platform, env: opts.env });
  const isWindows = WINDOWS_PLATFORMS.has(platform);
  const isMacOS = MAC_PLATFORMS.has(platform);
  const isLinux = LINUX_PLATFORMS.has(platform);

  return Object.freeze({
    platform,
    os: isWindows ? 'Windows' : (isMacOS ? 'macOS' : (isLinux ? 'Linux' : platform)),
    isWindows,
    isMacOS,
    isLinux,
    pathSeparator: isWindows ? '\\' : '/',
    defaultShell: shell.command,
    shellFamily: shell.family,
    shellArgsPrefix: shell.argsPrefix,
  });
}

/**
 * @param {ReturnType<typeof getRuntimePlatformInfo>} info
 * @param {string} [language]
 */
export function renderRuntimePlatformPrompt(info = getRuntimePlatformInfo(), language = 'en') {
  const shell = info.shellFamily === 'powershell'
    ? `${info.defaultShell} (PowerShell syntax)`
    : (info.shellFamily === 'cmd' ? `${info.defaultShell} (cmd.exe syntax)` : `${info.defaultShell} (POSIX shell syntax)`);

  if ((language || '').toLowerCase().startsWith('zh')) {
    return [
      '## runtime_platform',
      `当前 Agent 运行系统：${info.os} (${info.platform})`,
      `默认命令 shell：${shell}`,
      `路径分隔符：${info.pathSeparator}`,
      '生成 Bash 工具命令时必须匹配当前系统；Windows 上优先使用 PowerShell/cmd 语法，不要默认输出 Linux-only 命令。',
    ].join('\n');
  }

  return [
    '## runtime_platform',
    `Agent OS: ${info.os} (${info.platform})`,
    `Default command shell: ${shell}`,
    `Path separator: ${info.pathSeparator}`,
    'When generating Bash tool commands, match this OS. On Windows, prefer PowerShell/cmd syntax instead of Linux-only commands.',
  ].join('\n');
}
