import { platform, arch } from 'os';
import { existsSync, chmodSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import ctx from './context.js';
import { getRuntimePlatformInfo } from './yeaft/runtime-platform.js';
import { wrapInvocationInSystemdUserScope } from './yeaft/systemd-scope.js';

// Package name of the PTY backend. We use the Homebridge prebuilt fork
// because upstream node-pty ships no Linux prebuilds and falls back to
// node-gyp + C++20, which silently fails on older toolchains. The fork
// ships prebuilds for darwin/linux/win32 across x64/arm64 (incl. musl).
const PTY_PKG = '@homebridge/node-pty-prebuilt-multiarch';

// Ensure spawn-helper has executable permission on Unix systems.
// npm may strip execute bits from prebuilt binaries, causing
// "posix_spawnp failed" on macOS/Linux.
function ensureSpawnHelperPermissions() {
  if (platform() === 'win32') return;
  try {
    const cjsRequire = createRequire(import.meta.url);
    const ptyPkgPath = dirname(cjsRequire.resolve(`${PTY_PKG}/package.json`));
    const targets = [
      join(ptyPkgPath, 'prebuilds', `${platform()}-${arch()}`, 'spawn-helper'),
      join(ptyPkgPath, 'build', 'Release', 'spawn-helper'),
    ];
    for (const helper of targets) {
      if (!existsSync(helper)) continue;
      const mode = statSync(helper).mode;
      if (!(mode & 0o111)) {
        chmodSync(helper, 0o755);
        console.log(`[PTY] Fixed spawn-helper permissions: ${helper}`);
      }
    }
  } catch (e) {
    console.warn('[PTY] Could not ensure spawn-helper permissions:', e.message);
  }
}

// Load PTY backend. With the prebuilt fork this is essentially never
// expected to fail at runtime — it's a regular `dependencies` entry and
// every supported (platform, abi) combination ships a prebuilt binary.
// We still catch and degrade so a single missing binary doesn't crash
// the whole agent on an exotic host.
export async function loadNodePty() {
  if (ctx.nodePty !== null) return ctx.nodePty;
  try {
    let pty = await import(PTY_PKG);
    if (pty.default) pty = pty.default;
    ensureSpawnHelperPermissions();
    ctx.nodePty = pty;
    console.log('[PTY] node-pty loaded successfully');
    return pty;
  } catch (e) {
    console.warn('[PTY] node-pty not available:', e.message);
    ctx.nodePty = false;
    return false;
  }
}

export async function handleTerminalCreate(msg) {
  const { conversationId, cols, rows } = msg;
  const terminalId = msg.terminalId || conversationId;
  const conv = ctx.conversations.get(conversationId);
  const workDir = conv?.workDir || ctx.CONFIG.workDir;

  // 如果已存在终端，先关闭
  if (ctx.terminals.has(terminalId)) {
    const existing = ctx.terminals.get(terminalId);
    if (existing.pty) {
      try { existing.pty.kill(); } catch {}
    }
    if (existing.timer) clearTimeout(existing.timer);
    ctx.terminals.delete(terminalId);
  }

  const pty = await loadNodePty();
  if (!pty) {
    ctx.sendToServer({
      type: 'terminal_error',
      conversationId,
      terminalId,
      message: 'Terminal backend is not installed. Run: npm install'
    });
    return;
  }

  try {
    const shell = platform() === 'win32'
      ? (existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
        ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
        : (existsSync(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`)
          ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
          : (process.env.COMSPEC || 'cmd.exe')))
      : (process.env.SHELL || 'bash');
    const terminalEnv = { ...process.env };
    const terminalInvocation = wrapInvocationInSystemdUserScope(
      { command: shell, args: [], family: platform() === 'win32' ? 'powershell' : 'posix' },
      {
        runtimePlatform: getRuntimePlatformInfo(),
        env: terminalEnv,
        scopeId: `terminal-${terminalId}`,
        scopePrefix: 'yeaft-terminal',
      },
    );
    const ptyProcess = pty.spawn(terminalInvocation.command, terminalInvocation.args || [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: workDir,
      env: terminalEnv
    });

    // 输出缓冲 - 每 16ms 批量发送
    let buffer = '';
    let timer = null;

    ptyProcess.onData(data => {
      buffer += data;
      if (!timer) {
        timer = setTimeout(() => {
          ctx.sendToServer({
            type: 'terminal_output',
            conversationId,
            terminalId,
            data: buffer
          });
          buffer = '';
          timer = null;
        }, 16);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      // 发送剩余缓冲
      if (buffer) {
        ctx.sendToServer({
          type: 'terminal_output',
          conversationId,
          terminalId,
          data: buffer
        });
        buffer = '';
      }
      if (timer) clearTimeout(timer);

      console.log(`[PTY] Process exited for ${terminalId}, code: ${exitCode}`);
      ctx.terminals.delete(terminalId);
      ctx.sendToServer({
        type: 'terminal_closed',
        conversationId,
        terminalId
      });
    });

    ctx.terminals.set(terminalId, {
      pty: ptyProcess,
      conversationId,
      cols: cols || 80,
      rows: rows || 24,
      buffer: '',
      timer: null
    });

    console.log(`[PTY] Created terminal ${terminalId} for ${conversationId} in ${workDir}`);
    ctx.sendToServer({
      type: 'terminal_created',
      conversationId,
      terminalId,
      success: true
    });
  } catch (e) {
    console.error(`[PTY] Failed to create terminal:`, e.message);
    ctx.sendToServer({
      type: 'terminal_error',
      conversationId,
      terminalId,
      message: `Failed to create terminal: ${e.message}`
    });
  }
}

export function handleTerminalInput(msg) {
  const terminalId = msg.terminalId || msg.conversationId;
  const term = ctx.terminals.get(terminalId);
  if (term?.pty) {
    try {
      term.pty.write(msg.data);
    } catch (e) {
      console.error(`[PTY] Write error for ${terminalId}:`, e.message);
    }
  }
}

export function handleTerminalResize(msg) {
  const terminalId = msg.terminalId || msg.conversationId;
  const { cols, rows } = msg;
  const term = ctx.terminals.get(terminalId);
  if (term?.pty && cols > 0 && rows > 0) {
    try {
      term.pty.resize(cols, rows);
      term.cols = cols;
      term.rows = rows;
    } catch (e) {
      console.error(`[PTY] Resize error for ${terminalId}:`, e.message);
    }
  }
}

export function handleTerminalClose(msg) {
  const terminalId = msg.terminalId || msg.conversationId;
  const term = ctx.terminals.get(terminalId);
  if (term) {
    if (term.pty) {
      try { term.pty.kill(); } catch {}
    }
    if (term.timer) clearTimeout(term.timer);
    ctx.terminals.delete(terminalId);
    console.log(`[PTY] Closed terminal ${terminalId}`);
    ctx.sendToServer({
      type: 'terminal_closed',
      conversationId: term.conversationId || msg.conversationId,
      terminalId
    });
  }
}
