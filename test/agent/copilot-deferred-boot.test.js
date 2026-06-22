import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Controllable ACP handshake: each request's response is held until we release
// it, so we can observe state between "start() returned" and "boot finished".
const spawns = [];
const pendingResponses = []; // { child, id, method }

class FakeWritable extends EventEmitter {
  write(chunk) {
    const msg = JSON.parse(String(chunk));
    if (msg.id != null) {
      const child = spawns[spawns.length - 1];
      pendingResponses.push({ child, id: msg.id, method: msg.method });
    }
    return true;
  }
}

function releaseAll() {
  while (pendingResponses.length) {
    const { child, id, method } = pendingResponses.shift();
    let result = null;
    if (method === 'initialize') result = { agentCapabilities: { loadSession: true } };
    else if (method === 'session/new') result = { sessionId: 'copilot-session-1', models: { availableModels: [] } };
    else if (method === 'session/load') result = { models: { availableModels: [] } };
    else if (method === 'session/prompt') result = { stopReason: 'end_turn' };
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }
}

// The ACP handshake is sequential (initialize → await → session/new), so each
// release surfaces the next request. Keep releasing until no new request appears.
async function drainHandshake() {
  for (let i = 0; i < 10; i++) {
    if (!pendingResponses.length) await flush();
    if (!pendingResponses.length) return;
    releaseAll();
    await flush();
  }
}

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter();
    child.stdin = new FakeWritable();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    spawns.push(child);
    return child;
  }),
}));

const ctx = (await import('../../agent/context.js')).default;
const copilot = await import('../../agent/providers/copilot.js');

afterEach(() => {
  ctx.conversations.clear();
  ctx.CONFIG = null;
  spawns.length = 0;
  pendingResponses.length = 0;
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Copilot deferred boot', () => {
  it('returns from start() before the ACP handshake completes when deferBoot is set', async () => {
    ctx.CONFIG = { debug: false };
    ctx.sendToServer = vi.fn();

    const state = await copilot.start({
      conversationId: 'conv-defer',
      workDir: '/tmp/project',
      providerOptions: { allowAllTools: true },
      deferBoot: true,
    });

    // start() resolved, but the handshake responses are still held — session
    // not yet initialized. This is the whole point: the caller (createConversation)
    // can emit conversation_created immediately without waiting on the CLI.
    expect(state.initialized).toBe(false);
    expect(state._bootPromise).not.toBeNull();
    expect(spawns).toHaveLength(1); // child spawned, handshake in flight

    // No system_init emitted yet (boot not finished).
    const initFrames = ctx.sendToServer.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.data?.subtype === 'init');
    expect(initFrames).toHaveLength(0);

    // Let the handshake complete → init frame fires, state initialized.
    await drainHandshake();
    expect(state.initialized).toBe(true);
    const initFramesAfter = ctx.sendToServer.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.data?.subtype === 'init');
    expect(initFramesAfter).toHaveLength(1);
  });

  it('coalesces a racing sendInput onto the in-flight deferred boot — only one child spawns', async () => {
    ctx.CONFIG = { debug: false };
    ctx.sendToServer = vi.fn();

    const state = await copilot.start({
      conversationId: 'conv-race',
      workDir: '/tmp/project',
      providerOptions: { allowAllTools: true },
      deferBoot: true,
    });
    expect(spawns).toHaveLength(1);

    // Fire a message before boot finished. It must JOIN the existing boot,
    // not spawn a second copilot --acp child.
    const sendPromise = copilot.sendInput(state, 'hello', {});
    await flush();
    expect(spawns).toHaveLength(1); // still exactly one child

    await drainHandshake();  // initialize + session/new + session/prompt
    await sendPromise;

    expect(spawns).toHaveLength(1);
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'claude_output',
      conversationId: 'conv-race',
      data: expect.objectContaining({ type: 'result', subtype: 'success' }),
    }));
  });
});
