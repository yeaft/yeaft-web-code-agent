import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';


afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('child_process');
});

/**
 * Post-ACP rewrite tests. The old NDJSON/-p driver shipped two pure helpers
 * (translateCopilotEvent + createNdjsonParser) that we could unit-test in
 * isolation; the new driver does all translation inline against a real
 * AcpClient. We verify two black-box behaviors that matter to users:
 *   1) `capabilities` reflects what the UI now uses for gating
 *   2) `respondToPermissionRequest` resolves a pending permission promise
 *      with the selected optionId so an in-flight session/prompt can proceed
 */
describe('copilot provider — capability descriptor', () => {
  it('declares the gaps the new ACP driver closes', async () => {
    const { capabilities } = await import('../../../agent/providers/copilot.js');
    expect(capabilities.clear).toBe(true);
    expect(capabilities.attachments).toBe(true);
    expect(capabilities.askUser).toBe(true);
    expect(capabilities.modelPicker).toBe(true);
    // Things still gated off — make sure UI keeps hiding them.
    expect(capabilities.expert).toBe(false);
    expect(capabilities.subagents).toBe(false);
  });
});

describe('copilot provider — respondToPermissionRequest', () => {
  it('resolves the pending permission with the selected optionId', async () => {
    const { respondToPermissionRequest } = await import('../../../agent/providers/copilot.js');
    let resolved;
    const slot = {
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
      resolve: (v) => { resolved = v; },
    };
    const state = { pendingPermissions: new Map([['req-1', slot]]) };
    const ok = respondToPermissionRequest(state, 'req-1', 'reject_once');
    expect(ok).toBe(true);
    expect(resolved).toEqual({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
    expect(state.pendingPermissions.has('req-1')).toBe(false);
  });

  it('returns false when the requestId is unknown', async () => {
    const { respondToPermissionRequest } = await import('../../../agent/providers/copilot.js');
    const state = { pendingPermissions: new Map() };
    expect(respondToPermissionRequest(state, 'missing', 'allow')).toBe(false);
  });
});

describe('copilot provider — sendInput surfaces ACP boot errors', () => {
  it('emits an error result + turn_completed when the child can not be spawned', async () => {
    vi.resetModules();
    const ctxMod = await import('../../../agent/context.js');
    const sent = [];
    ctxMod.default.sendToServer = (m) => sent.push(m);
    ctxMod.default.CONFIG = ctxMod.default.CONFIG || {};
    ctxMod.default.conversations = new Map();

    // child with no stdin/stdout — AcpClient will throw on first write.
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => { throw new Error('boom'); } };
    child.kill = () => {};

    vi.doMock('child_process', () => ({ spawn: () => child, execFile: () => {}, exec: () => {} }));
    const copilot = await import('../../../agent/providers/copilot.js?fresh=acp');

    const state = await copilot.start({ conversationId: 'c1', workDir: '/tmp' });
    // Start should have emitted an init-failed result envelope (best-effort path).
    const result = sent.find((m) => m.type === 'claude_output' && m.data?.type === 'result' && m.data?.is_error);
    expect(result).toBeTruthy();
    expect(state.providerName).toBe('copilot');
    vi.doUnmock('child_process');
  });
});

describe('copilot provider — session parity', () => {
  it('emits session_id_update for new sessions and clear sessions', async () => {
    vi.resetModules();
    const ctxMod = await import('../../../agent/context.js');
    const sent = [];
    ctxMod.default.sendToServer = (m) => sent.push(m);
    ctxMod.default.CONFIG = { debug: false };
    ctxMod.default.conversations = new Map();

    const child = makeAcpChild(({ method }) => {
      if (method === 'initialize') return { agentCapabilities: { loadSession: true } };
      if (method === 'session/new') return { sessionId: `sess-${sent.filter(m => m.type === 'session_id_update').length + 1}` };
      throw new Error(`unexpected ${method}`);
    });

    vi.doMock('child_process', () => ({ spawn: () => child }));
    const copilot = await import('../../../agent/providers/copilot.js');
    const state = await copilot.start({ conversationId: 'conv-session', workDir: '/tmp/project', providerOptions: {} });

    expect(sent.some(m => m.type === 'session_id_update' && m.claudeSessionId === 'sess-1')).toBe(true);
    await copilot.clear(state);
    expect(sent.some(m => m.type === 'session_id_update' && m.claudeSessionId === 'sess-2')).toBe(true);
    expect(state.sessionId).toBe('sess-2');
  });

  it('resumes with session/load when ACP advertises loadSession', async () => {
    vi.resetModules();
    const ctxMod = await import('../../../agent/context.js');
    const sent = [];
    const calls = [];
    ctxMod.default.sendToServer = (m) => sent.push(m);
    ctxMod.default.CONFIG = { debug: false };
    ctxMod.default.conversations = new Map();

    const child = makeAcpChild(({ method, params }) => {
      calls.push({ method, params });
      if (method === 'initialize') return { agentCapabilities: { loadSession: true } };
      if (method === 'session/load') return { modes: {}, models: {} };
      throw new Error(`unexpected ${method}`);
    });

    vi.doMock('child_process', () => ({ spawn: () => child }));
    const copilot = await import('../../../agent/providers/copilot.js');
    const state = await copilot.start({ conversationId: 'conv-resume', workDir: '/tmp/project', resumeSessionId: 'resume-1', providerOptions: {} });

    expect(calls.some(c => c.method === 'session/load' && c.params.sessionId === 'resume-1')).toBe(true);
    expect(calls.some(c => c.method === 'session/new')).toBe(false);
    expect(state.sessionId).toBe('resume-1');
    expect(sent.some(m => m.type === 'session_id_update' && m.claudeSessionId === 'resume-1')).toBe(true);
  });

  it('renders permission requests through AskUserQuestion and maps selected labels back to optionId', async () => {
    vi.resetModules();
    const ctxMod = await import('../../../agent/context.js');
    const sent = [];
    ctxMod.default.sendToServer = (m) => sent.push(m);
    ctxMod.default.CONFIG = { debug: false };
    ctxMod.default.conversations = new Map();

    const child = makeAcpChild(({ method, params }, serverRequest) => {
      if (method === 'initialize') return { agentCapabilities: { loadSession: true } };
      if (method === 'session/new') return { sessionId: 'sess-perm' };
      if (method === 'session/prompt') {
        serverRequest('session/request_permission', {
          toolCall: { title: 'Run command', rawInput: { command: 'npm test' } },
          options: [
            { optionId: 'deny', kind: 'reject', name: 'Deny' },
            { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          ],
        });
        return { stopReason: 'end_turn' };
      }
      throw new Error(`unexpected ${method}`);
    });

    vi.doMock('child_process', () => ({ spawn: () => child }));
    const copilot = await import('../../../agent/providers/copilot.js');
    const state = await copilot.start({ conversationId: 'conv-perm', workDir: '/tmp/project', providerOptions: {} });
    const input = copilot.sendInput(state, 'hello', { conversationId: 'conv-perm' });

    await waitUntil(() => sent.some(m => m.type === 'ask_user_question'));
    const ask = sent.find(m => m.type === 'ask_user_question');
    expect(ask.questions[0].question).toContain('Run command');
    expect(ask.questions[0].options.map(o => o.label)).toEqual(['Deny', 'Allow once']);
    expect(sent.some(m => m.type === 'claude_output' && m.data?.message?.content?.[0]?.name === 'AskUserQuestion')).toBe(true);

    expect(copilot.respondToPermissionRequest(state, ask.requestId, 'Allow once')).toBe(true);
    await input;
    await waitUntil(() => child._writes.some(w => w.result?.outcome?.optionId === 'allow_once'));
    expect(sent.filter(m => m.type === 'turn_completed')).toHaveLength(1);
  });
});

function makeAcpChild(handler) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child._writes = [];
  child.stdin = {
    write(data) {
      const msg = JSON.parse(String(data).trim());
      child._writes.push(msg);
      if (msg.id && msg.method) {
        queueMicrotask(async () => {
          try {
            const result = await handler(msg, (method, params) => {
              const id = 1000 + child._writes.length;
              child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
              return id;
            });
            child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
          } catch (err) {
            child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err.message } }) + '\n');
          }
        });
      }
    },
  };
  child.kill = () => { child.emit('close', 0); };
  return child;
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
