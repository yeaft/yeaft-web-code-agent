import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const writes = [];
const spawns = [];

class FakeWritable extends EventEmitter {
  write(chunk) {
    writes.push(String(chunk));
    const msg = JSON.parse(String(chunk));
    queueMicrotask(() => respond(msg));
    return true;
  }
}

function respond(msg) {
  const child = spawns[spawns.length - 1];
  if (!child || msg.id == null || process.env.TEST_COPILOT_SPAWN_ERROR) return;
  let result = null;
  if (msg.method === 'initialize') {
    result = { agentCapabilities: { loadSession: true } };
  } else if (msg.method === 'session/new') {
    result = { sessionId: 'copilot-session-1', models: { availableModels: [] } };
  } else if (msg.method === 'session/prompt') {
    result = { stopReason: 'end_turn' };
  }
  child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
}

vi.mock('child_process', () => ({
  spawn: vi.fn((bin, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new FakeWritable();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    child.bin = bin;
    child.args = args;
    child.opts = opts;
    spawns.push(child);
    if (process.env.TEST_COPILOT_SPAWN_ERROR) {
      queueMicrotask(() => child.emit('error', new Error(process.env.TEST_COPILOT_SPAWN_ERROR)));
    }
    return child;
  }),
}));

const ctx = (await import('../../agent/context.js')).default;
const copilot = await import('../../agent/providers/copilot.js');

afterEach(() => {
  ctx.conversations.clear();
  ctx.CONFIG = null;
  writes.length = 0;
  spawns.length = 0;
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('Copilot chat provider model handling', () => {
  it('does not expose a web model picker or model list API', () => {
    expect(copilot.capabilities.modelPicker).toBe(false);
    expect(copilot.listModels).toBeUndefined();
    expect(copilot.default.listModels).toBeUndefined();
  });

  it('uses a shell on Windows so PATH shims like copilot.cmd can start', () => {
    const winLaunch = copilot.resolveCopilotLaunchOptions({
      cwd: 'Q:\\M365\\Sydney',
      env: { PATH: 'C:\\Tools' },
      platform: 'win32',
      bin: 'copilot',
    });
    expect(winLaunch).toMatchObject({
      command: 'copilot',
      options: {
        cwd: 'Q:\\M365\\Sydney',
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    });

    const linuxLaunch = copilot.resolveCopilotLaunchOptions({
      cwd: '/tmp/project',
      env: {},
      platform: 'linux',
      bin: 'copilot',
    });
    expect(linuxLaunch.options.shell).toBeUndefined();
    expect(linuxLaunch.options.windowsHide).toBeUndefined();
  });

  it('does not pass UI model overrides to copilot --acp', async () => {
    ctx.CONFIG = { debug: false };
    ctx.sendToServer = vi.fn();

    const state = await copilot.start({
      conversationId: 'conv-1',
      workDir: '/tmp/project',
      providerOptions: { allowAllTools: true, model: 'claude-opus-4.8' },
    });

    expect(state.model).toBeNull();
    expect(spawns).toHaveLength(1);
    expect(spawns[0].args).toEqual(['--acp']);
    expect(spawns[0].args).not.toContain('--model');

    await copilot.sendInput(state, 'hello', {});

    const promptFrame = writes.map((w) => JSON.parse(w)).find((m) => m.method === 'session/prompt');
    expect(promptFrame).toMatchObject({
      method: 'session/prompt',
      params: {
        sessionId: 'copilot-session-1',
        prompt: [{ type: 'text', text: 'hello' }],
      },
    });
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'claude_output',
      conversationId: 'conv-1',
      data: expect.objectContaining({ type: 'result', subtype: 'success' }),
    }));
  });

  it('surfaces copilot spawn errors instead of hanging the turn', async () => {
    vi.stubEnv('TEST_COPILOT_SPAWN_ERROR', 'spawn ENOENT');
    ctx.CONFIG = { debug: false };
    ctx.sendToServer = vi.fn();

    const state = await copilot.start({
      conversationId: 'conv-err',
      workDir: 'Q:\\M365\\Sydney',
      providerOptions: { allowAllTools: true },
    });

    await copilot.sendInput(state, 'hi', {});

    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'claude_output',
      conversationId: 'conv-err',
      data: expect.objectContaining({
        type: 'result',
        subtype: 'error',
        is_error: true,
        error: expect.stringContaining('copilot process error: spawn ENOENT'),
      }),
    }));
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_completed',
      conversationId: 'conv-err',
    }));
  });
});
