import { describe, it, expect } from 'vitest';
import path from 'path';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { buildShellInvocation, getRuntimePlatformInfo, renderRuntimePlatformPrompt } from '../../agent/yeaft/runtime-platform.js';
import bashTool from '../../agent/yeaft/tools/bash.js';
import enterWorktreeTool from '../../agent/yeaft/tools/enter-worktree.js';
import { checkPathAllowed, isPathInsideOrEqual } from '../../agent/yeaft/tools/path-safety.js';
import { buildSystemPrompt } from '../../agent/yeaft/prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * Compatibility audit summary for PR body:
 * - Shell execution needed adaptation: Bash now keeps the wire name but picks
 *   POSIX shell on Linux/macOS and PowerShell/cmd on Windows.
 * - Git worktree tools needed adaptation: argv-based git calls avoid shell
 *   quoting bugs with Windows drive letters and spaces.
 * - File/search/list/notebook/js-repl/web/history tools are Node/path based and
 *   remain naturally cross-platform; ViewImage now uses a shared containment
 *   helper with win32 regressions.
 * - Grep uses rg when present and already falls back to a Node walker when rg
 *   is unavailable.
 */
describe('Yeaft tool runtime platform compatibility', () => {
  it('builds platform-specific shell invocations', () => {
    const win = getRuntimePlatformInfo({ platform: 'win32', env: {} });
    expect(win.isWindows).toBe(true);
    expect(win.defaultShell).toBe('powershell.exe');
    expect(win.shellFamily).toBe('powershell');

    const winInvocation = buildShellInvocation('Get-ChildItem', { runtimePlatform: win });
    expect(winInvocation.command).toBe('powershell.exe');
    expect(winInvocation.args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Get-ChildItem',
    ]);

    const cmd = getRuntimePlatformInfo({ platform: 'win32', env: { YEAFT_WINDOWS_SHELL: 'cmd.exe' } });
    expect(buildShellInvocation('dir', { runtimePlatform: cmd })).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'dir'],
      family: 'cmd',
    });

    const linux = getRuntimePlatformInfo({ platform: 'linux', env: { SHELL: '/bin/zsh' } });
    expect(buildShellInvocation('pwd', { runtimePlatform: linux })).toEqual({
      command: '/bin/zsh',
      args: ['-c', 'pwd'],
      family: 'posix',
    });

    const mac = getRuntimePlatformInfo({ platform: 'darwin', env: { SHELL: '/bin/bash' } });
    expect(mac.os).toBe('macOS');
    expect(buildShellInvocation('pwd', { runtimePlatform: mac }).args).toEqual(['-c', 'pwd']);
  });

  it('marks Windows destructive shell commands as destructive', () => {
    expect(bashTool.isDestructive({ command: 'Remove-Item -Recurse .\\dist' })).toBe(true);
    expect(bashTool.isDestructive({ command: 'cmd /c del important.txt' })).toBe(true);
    expect(bashTool.isDestructive({ command: 'Get-ChildItem' })).toBe(false);
  });

  it('handles Windows drive-letter containment and allowlist checks', () => {
    const cwd = 'Q:\\M365\\Sydney';
    const image = 'Q:\\M365\\Sydney\\screens\\shot.png';
    const outside = 'Q:\\M365\\Other\\shot.png';
    const otherDrive = 'R:\\M365\\Sydney\\shot.png';

    expect(isPathInsideOrEqual(cwd, image, path.win32)).toBe(true);
    expect(isPathInsideOrEqual(cwd, cwd, path.win32)).toBe(true);
    expect(isPathInsideOrEqual(cwd, outside, path.win32)).toBe(false);
    expect(isPathInsideOrEqual(cwd, otherDrive, path.win32)).toBe(false);

    expect(checkPathAllowed(image, cwd, [], path.win32)).toBeNull();
    expect(checkPathAllowed(outside, cwd, ['Q:\\M365\\Other'], path.win32)).toBeNull();
    expect(checkPathAllowed(otherDrive, cwd, ['Q:\\M365\\Other'], path.win32)).toMatchObject({
      kind: 'absolute_outside_allowlist',
    });
  });

  it('injects OS and shell guidance into the harness prompt', () => {
    const win = getRuntimePlatformInfo({ platform: 'win32', env: {} });
    const block = renderRuntimePlatformPrompt(win, 'en');
    expect(block).toContain('Agent OS: Windows (win32)');
    expect(block).toContain('PowerShell syntax');

    const prompt = buildSystemPrompt({
      language: 'en',
      toolNames: ['Bash', 'FileRead'],
      runtimePlatform: win,
    });
    expect(prompt).toContain('## runtime_platform');
    expect(prompt).toContain('Agent OS: Windows (win32)');
    expect(prompt).toContain('prefer PowerShell/cmd syntax');
  });

  it('keeps git worktree tools on argv-based git calls instead of shell-quoted command strings', () => {
    const enter = readFileSync(join(repoRoot, 'agent/yeaft/tools/enter-worktree.js'), 'utf8');
    const exit = readFileSync(join(repoRoot, 'agent/yeaft/tools/exit-worktree.js'), 'utf8');

    expect(enter).toContain("execFileSync('git', ['rev-parse', '--git-dir']");
    expect(enter).toContain("execFileSync('git', ['worktree', 'add'");
    expect(exit).toContain("execFileSync('git', ['worktree', 'remove'");
    expect(enter).not.toContain('git worktree add -b');
    expect(exit).not.toContain('git worktree remove "');
  });

  it('detects a git repo before creating an EnterWorktree worktree', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'yeaft-enter-worktree-'));

    try {
      execFileSync('git', ['init'], { cwd: tmp, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmp, stdio: 'pipe' });
      mkdirSync(join(tmp, 'src'));
      execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'pipe' });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'seed'], { cwd: tmp, stdio: 'pipe' });

      const raw = await enterWorktreeTool.execute({ name: 'probe' }, { cwd: tmp });
      const result = JSON.parse(raw);

      expect(result.error).toBeUndefined();
      expect(result.path).toBe(join(tmp, '.yeaft', 'worktrees', 'probe'));
      expect(result.branch).toBe('yeaft-wt/probe');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
