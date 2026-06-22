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
    respondTo(child, id, method);
  }
}

function respondTo(child, id, method) {
  let result = null;
  if (method === 'initialize') result = { agentCapabilities: { loadSession: true } };
  else if (method === 'session/new') result = { sessionId: 'copilot-session-1', models: { availableModels: [] } };
  else if (method === 'session/load') result = { models: { availableModels: [] } };
  else if (method === 'session/prompt') result = { stopReason: 'end_turn' };
  child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

// Release only the queued responses for a specific method, leaving the rest of
// the handshake pending. Lets a test sit inside the initialize→session/new window.
async function releaseMethod(method) {
  const keep = [];
  for (const entry of pendingResponses.splice(0)) {
    if (entry.method === method) respondTo(entry.child, entry.id, entry.method);
    else keep.push(entry);
  }
  pendingResponses.push(...keep);
  await flush();
}

function methodsQueued() {
  return pendingResponses.map((p) => p.method);
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

  it('does NOT prompt with a null sessionId when a message arrives in the initialize→session/new window', async () => {
    ctx.CONFIG = { debug: false };
    ctx.sendToServer = vi.fn();

    const writes = [];
    const origWrite = FakeWritable.prototype.write;
    // Capture every JSON-RPC frame the provider writes to the child.
    FakeWritable.prototype.write = function (chunk) {
      writes.push(JSON.parse(String(chunk)));
      return origWrite.call(this, chunk);
    };

    try {
      const state = await copilot.start({
        conversationId: 'conv-window',
        workDir: '/tmp/project',
        providerOptions: { allowAllTools: true },
        deferBoot: true,
      });

      // Sit inside the window: initialize answered, session/new still pending.
      await releaseMethod('initialize');
      expect(methodsQueued()).toContain('session/new');
      expect(state.sessionId).toBeNull(); // fresh session id not assigned yet

      // User fires their first message right now.
      const sendPromise = copilot.sendInput(state, 'first message', {});
      await flush();

      // It must NOT have dispatched session/prompt yet — sessionId is still null,
      // so a prompt here would carry sessionId:null and the turn would be lost.
      // sendInput must wait for the in-flight boot to finish establishing the session.
      const earlyPrompt = writes.find((w) => w.method === 'session/prompt');
      expect(earlyPrompt).toBeUndefined();

      // Finish the handshake; now the prompt may go out — with a real sessionId.
      await drainHandshake();
      await sendPromise;

      const promptFrame = writes.find((w) => w.method === 'session/prompt');
      expect(promptFrame).toBeTruthy();
      expect(promptFrame.params.sessionId).toBe('copilot-session-1');
      expect(spawns).toHaveLength(1);
    } finally {
      FakeWritable.prototype.write = origWrite;
    }
  });
});
