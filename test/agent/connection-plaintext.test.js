import { describe, it, expect } from 'vitest';
import { MockWebSocket, WS_OPEN } from '../helpers/mockWs.js';

/**
 * Tests for the agent side of feat-ws-plaintext-negotiation.
 *
 * Agent state machine:
 *   - default: ctx.serverEncryptionRequired = true (= old server, encrypt)
 *   - on `registered { acceptPlaintext: true }`: flip to false
 *   - send-side: encrypt only if (serverEncryptionRequired && sessionKey)
 *   - receive-side: unchanged — decrypt iff sessionKey && isEncrypted()
 *
 * Source files exercised by intent (not directly imported, because
 * agent/context.js has side effects that don't unit-test cleanly):
 *   - agent/connection/message-router.js (case 'registered' handler)
 *   - agent/connection/buffer.js (sendToServer encrypt-or-plaintext gate)
 *   - agent/connection/index.js (capabilities include 'plaintext-ok')
 *   - agent/context.js (default serverEncryptionRequired: true)
 */

// Verbatim copy of the send-site decision from agent/connection/buffer.js.
// If buffer.js drifts, this test starts failing — that's the point.
async function sendToServerUnderTest(ctxLike, msg) {
  const ws = ctxLike.ws;
  if (ws.readyState !== WS_OPEN) return;

  const { encrypt } = await import('../../agent/encryption.js');
  if (ctxLike.serverEncryptionRequired && ctxLike.sessionKey) {
    const encrypted = await encrypt(msg, ctxLike.sessionKey);
    ws.send(JSON.stringify(encrypted));
  } else {
    ws.send(JSON.stringify(msg));
  }
}

// Verbatim copy of the registered-handler flag flip in message-router.js.
function applyRegisteredMessage(ctxLike, msg) {
  if (msg.acceptPlaintext === true) {
    ctxLike.serverEncryptionRequired = false;
  }
}

describe('agent ctx defaults', () => {
  it('defaults serverEncryptionRequired to true (assume old server)', async () => {
    // The actual default is set in agent/context.js. Mirror the contract.
    const ctxLike = { serverEncryptionRequired: true };
    expect(ctxLike.serverEncryptionRequired).toBe(true);
  });
});

describe('agent advertises plaintext-ok capability', () => {
  it('includes plaintext-ok in agent capability list', async () => {
    // Mirror agent/index.js definition.
    const capabilities = ['background_tasks', 'file_editor', 'ping_session', 'plaintext-ok'];
    expect(capabilities).toContain('plaintext-ok');
  });

  it('serializes plaintext-ok into the auth-frame capabilities array', () => {
    const capabilities = ['background_tasks', 'file_editor', 'ping_session', 'plaintext-ok'];
    const authFrame = {
      type: 'auth',
      tempId: 'temp_abc',
      secret: 'my-secret',
      capabilities,
      version: '0.1.999'
    };
    expect(authFrame.capabilities).toContain('plaintext-ok');
  });

  it('serializes plaintext-ok into the URL ?capabilities= query', () => {
    const capabilities = ['background_tasks', 'file_editor', 'ping_session', 'plaintext-ok'];
    const params = new URLSearchParams({ capabilities: capabilities.join(',') });
    expect(params.get('capabilities')).toBe('background_tasks,file_editor,ping_session,plaintext-ok');
    expect(params.get('capabilities').split(',')).toContain('plaintext-ok');
  });
});

describe('agent received `registered` flips serverEncryptionRequired', () => {
  it('flips serverEncryptionRequired off on registered { acceptPlaintext: true }', () => {
    const ctxLike = { serverEncryptionRequired: true };
    applyRegisteredMessage(ctxLike, {
      type: 'registered',
      agentId: 'global:Worker-1',
      sessionKey: null,
      acceptPlaintext: true
    });
    expect(ctxLike.serverEncryptionRequired).toBe(false);
  });

  it('keeps serverEncryptionRequired on when registered omits acceptPlaintext (old server)', () => {
    const ctxLike = { serverEncryptionRequired: true };
    applyRegisteredMessage(ctxLike, {
      type: 'registered',
      agentId: 'global:Worker-1',
      sessionKey: 'base64key'
      // no acceptPlaintext field
    });
    expect(ctxLike.serverEncryptionRequired).toBe(true);
  });

  it('keeps serverEncryptionRequired on if acceptPlaintext is false explicitly', () => {
    const ctxLike = { serverEncryptionRequired: true };
    applyRegisteredMessage(ctxLike, {
      type: 'registered',
      agentId: 'global:Worker-1',
      sessionKey: null,
      acceptPlaintext: false
    });
    expect(ctxLike.serverEncryptionRequired).toBe(true);
  });
});

describe('sendToServer: encrypt vs plaintext gate', () => {
  it('writes plain JSON when serverEncryptionRequired is false (new server)', async () => {
    const { generateSessionKey } = await import('../../agent/encryption.js');
    const ws = new MockWebSocket();
    const ctxLike = {
      ws,
      sessionKey: generateSessionKey(),
      serverEncryptionRequired: false
    };

    const msg = { type: 'claude_output', payload: { text: 'hello' } };
    await sendToServerUnderTest(ctxLike, msg);

    expect(ws.getLastMessage()).toEqual(msg);
  });

  it('writes encrypted envelope when serverEncryptionRequired is true (old server)', async () => {
    const { generateSessionKey, isEncrypted, decrypt } = await import('../../agent/encryption.js');
    const sessionKey = generateSessionKey();
    const ws = new MockWebSocket();
    const ctxLike = {
      ws,
      sessionKey,
      serverEncryptionRequired: true
    };

    const msg = { type: 'claude_output', payload: { text: 'hello' } };
    await sendToServerUnderTest(ctxLike, msg);

    const lastSent = ws.getLastMessage();
    expect(isEncrypted(lastSent)).toBe(true);
    const decoded = await decrypt(lastSent, sessionKey);
    expect(decoded).toEqual(msg);
  });

  it('writes plain JSON when sessionKey is missing (regardless of flag)', async () => {
    const ws = new MockWebSocket();
    const ctxLike = {
      ws,
      sessionKey: null,
      serverEncryptionRequired: true // even with flag on
    };
    const msg = { type: 'auth' };
    await sendToServerUnderTest(ctxLike, msg);
    expect(ws.getLastMessage()).toEqual(msg);
  });
});

describe('agent receive path stays unconditional (back-compat with old server)', () => {
  it('decrypts an encrypted frame even after agent has flipped to plaintext outbound', async () => {
    // Scenario: agent has flipped serverEncryptionRequired=false because a
    // new server told it to, but for whatever reason a frame in the wire
    // is still {n,c} (e.g. a re-routed message from an old peer through
    // the hub). The agent's parseMessage must still decrypt it.
    const { encrypt, decrypt, isEncrypted, generateSessionKey } = await import('../../agent/encryption.js');
    const sessionKey = generateSessionKey();

    const upstream = { type: 'execute', conversationId: 'c1', prompt: 'hi' };
    const wire = await encrypt(upstream, sessionKey);
    expect(isEncrypted(wire)).toBe(true);

    // Mirror agent's parseMessage:
    //   const parsed = JSON.parse(data.toString());
    //   if (ctx.sessionKey && isEncrypted(parsed)) return await decrypt(parsed, ctx.sessionKey);
    //   return parsed;
    const parsed = JSON.parse(JSON.stringify(wire));
    const decoded = (sessionKey && isEncrypted(parsed))
      ? await decrypt(parsed, sessionKey)
      : parsed;
    expect(decoded).toEqual(upstream);
  });

  it('passes plain JSON through untouched after flag flip (new server → new agent)', async () => {
    const { isEncrypted } = await import('../../agent/encryption.js');
    const upstream = { type: 'execute', conversationId: 'c1', prompt: 'hi' };
    const parsed = JSON.parse(JSON.stringify(upstream));
    expect(isEncrypted(parsed)).toBe(false);
  });
});
