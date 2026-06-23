import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawns = [];
const execFileSyncCalls = [];
const tempDirs = [];

class FakeWritable extends EventEmitter {
  write(chunk) {
    const msg = JSON.parse(String(chunk));
    const child = spawns[spawns.length - 1];
    queueMicrotask(() => {
      let result = {};
      if (msg.method === 'session/new') {
        result = { sessionId: 'copilot-probe', models: { availableModels: [{ modelId: 'gpt-5', name: 'GPT-5' }] } };
      } else if (msg.method === 'tools/list') {
        result = { tools: [] };
      }
      child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
    });
    return true;
  }
}

vi.mock('child_process', () => ({
  spawn: vi.fn((command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new FakeWritable();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    child.command = command;
    child.args = args;
    child.options = options;
    spawns.push(child);

    if (command === 'powershell.exe') {
      queueMicrotask(() => child.emit('close', 0));
    } else if (command === 'rg' && args?.[0] === '--version') {
      queueMicrotask(() => child.emit('close', 0));
    } else if (command === 'rg') {
      queueMicrotask(() => {
        child.stdout.emit('data', 'file.js:1:needle\n');
        child.emit('close', 0);
      });
    }

    return child;
  }),
  spawnSync: vi.fn(() => ({ status: 0 })),
  execFileSync: vi.fn((command, args, options) => {
    execFileSyncCalls.push({ command, args, options });
    if (args?.[0] === 'status') return '';
    if (args?.[0] === 'rev-parse' && args?.[1] === '--abbrev-ref') return 'yeaft-wt/review\n';
    return '';
  }),
}));

const bashTool = (await import('../../agent/yeaft/tools/bash.js')).default;
const grepTool = (await import('../../agent/yeaft/tools/grep.js')).default;
const enterWorktreeTool = (await import('../../agent/yeaft/tools/enter-worktree.js')).default;
const exitWorktreeTool = (await import('../../agent/yeaft/tools/exit-worktree.js')).default;
const { createMCPManager } = await import('../../agent/yeaft/mcp.js');
const { listCopilotModels, _resetCopilotModelsCacheForTests } = await import('../../agent/providers/copilot-models.js');

afterEach(() => {
  spawns.length = 0;
  execFileSyncCalls.length = 0;
  _resetCopilotModelsCacheForTests();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('Windows hidden non-interactive process launches', () => {
  it('hides the foreground Bash tool shell on Windows', async () => {
    const result = await bashTool.execute(
      { command: 'Write-Output ok', cwd: process.cwd(), timeout_ms: 1000 },
      { runtimePlatform: { isWindows: true, shellFamily: 'powershell', defaultShell: 'powershell.exe' } },
    );

    expect(result).toBe('(no output)');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      command: 'powershell.exe',
      options: expect.objectContaining({ windowsHide: true }),
    });
  });

  it('hides ripgrep availability checks and searches', async () => {
    const result = await grepTool.execute({ pattern: 'needle', path: '.' }, { cwd: process.cwd() });

    expect(result).toBe('file.js:1:needle');
    expect(spawns).toHaveLength(2);
    expect(spawns[0]).toMatchObject({
      command: 'rg',
      args: ['--version'],
      options: expect.objectContaining({ windowsHide: true }),
    });
    expect(spawns[1]).toMatchObject({
      command: 'rg',
      options: expect.objectContaining({ windowsHide: true }),
    });
  });

  it('hides stdio MCP server processes', async () => {
    const manager = await createMCPManager({
      mcp_servers: [{ name: 'fake', command: 'node', args: ['fake-mcp.js'] }],
    });

    expect(manager.status()).toEqual([{ name: 'fake', ready: true, toolCount: 0 }]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      command: 'node',
      args: ['fake-mcp.js'],
      options: expect.objectContaining({ windowsHide: true }),
    });
  });

  it('hides one-shot Copilot ACP model probes', async () => {
    const models = await listCopilotModels({ force: true });

    expect(models.map(m => m.id)).toEqual(['gpt-5']);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      command: 'copilot',
      args: ['--acp'],
      options: expect.objectContaining({ windowsHide: true }),
    });
  });

  it('hides EnterWorktree git checks and worktree creation', async () => {
    const cwd = makeTempDir('yeaft-enter-hidden-');
    const result = JSON.parse(await enterWorktreeTool.execute({ name: 'review-hidden', base_ref: 'HEAD' }, { cwd }));

    expect(result).toMatchObject({ success: true, branch: 'yeaft-wt/review-hidden' });
    expect(execFileSyncCalls.map(call => call.args.slice(0, 2))).toEqual([
      ['rev-parse', '--git-dir'],
      ['worktree', 'add'],
    ]);
    expect(execFileSyncCalls).toHaveLength(2);
    expect(execFileSyncCalls.every(call => call.command === 'git')).toBe(true);
    expect(execFileSyncCalls.every(call => call.options?.windowsHide === true)).toBe(true);
  });

  it('hides ExitWorktree git status, branch, removal, and branch deletion calls', async () => {
    const mainCwd = makeTempDir('yeaft-exit-main-hidden-');
    const worktreePath = makeTempDir('yeaft-exit-worktree-hidden-');
    const result = JSON.parse(await exitWorktreeTool.execute({ path: worktreePath, action: 'remove' }, { cwd: mainCwd }));

    expect(result).toMatchObject({ success: true, action: 'remove', branch: 'yeaft-wt/review' });
    expect(execFileSyncCalls.map(call => call.args.slice(0, 2))).toEqual([
      ['status', '--porcelain'],
      ['rev-parse', '--abbrev-ref'],
      ['worktree', 'remove'],
      ['branch', '-D'],
    ]);
    expect(execFileSyncCalls).toHaveLength(4);
    expect(execFileSyncCalls.every(call => call.command === 'git')).toBe(true);
    expect(execFileSyncCalls.every(call => call.options?.windowsHide === true)).toBe(true);
  });
});
