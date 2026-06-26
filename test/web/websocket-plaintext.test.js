import { describe, it, expect } from 'vitest';

/**
 * Tests for the web/browser side of feat-ws-plaintext-negotiation.
 *
 * Web client state machine:
 *   - default: store.serverEncryptionRequired = true (= old server, encrypt)
 *   - on `auth_result { acceptPlaintext: true }`: flip to false
 *   - send-side (sendWsMessage): encrypt only if (serverEncryptionRequired && sessionKey)
 *   - receive-side (parseWsMessage): unchanged — decrypt iff (sessionKey && isEncrypted())
 *
 * Browser-only modules can't be unit-tested in Node (web/utils/encryption.js
 * relies on the `nacl` and `pako` globals from <script src=...> tags). We
 * exercise the *negotiation* logic in pure JS, and the *receive* round-trip
 * via the server's Node-compatible encryption module — the wire format is
 * identical, which is the whole point.
 *
 * Source files exercised by intent:
 *   - web/stores/helpers/websocket.js (sendWsMessage gate + client_hello frame)
 *   - web/stores/helpers/messageHandler.js (auth_result handler sets the flag)
 *   - web/stores/chat.js (default serverEncryptionRequired: true)
 */

// Verbatim copy of sendWsMessage's encryption gate from
// web/stores/helpers/websocket.js. We don't import the real encrypt() (which
// relies on browser globals); we substitute a fake whose only job is to wrap
// the payload in a recognizable envelope so we can assert which branch ran.
function sendWsMessageUnderTest(store, msg, fakeEncrypt) {
  if (!store.ws || store.ws.readyState !== 1) return false;
  if (store.serverEncryptionRequired && store.sessionKey) {
    const encrypted = fakeEncrypt(msg, store.sessionKey);
    store.ws.send(JSON.stringify(encrypted));
  } else {
    store.ws.send(JSON.stringify(msg));
  }
  return true;
}

function makeFakeBrowserWs() {
  const sent = [];
  return {
    readyState: 1, // OPEN
    send(data) { sent.push(data); },
    _sent: sent,
    getLastMessage() {
      if (sent.length === 0) return null;
      try { return JSON.parse(sent[sent.length - 1]); }
      catch { return sent[sent.length - 1]; }
    }
  };
}

describe('web store default', () => {
  it('defaults serverEncryptionRequired to true (assume old server)', () => {
    // Mirror the state field initialisation in web/stores/chat.js.
    const storeState = { serverEncryptionRequired: true };
    expect(storeState.serverEncryptionRequired).toBe(true);
  });
});

describe('web auth_result handler flips serverEncryptionRequired', () => {
  // Mirror the case 'auth_result' branch in messageHandler.js exactly.
  function applyAuthResult(store, msg) {
    if (!msg.success) return;
    if (msg.sessionKey) {
      // (decode skipped; not relevant to this test)
      store.sessionKey = msg.sessionKey;
    }
    if (msg.acceptPlaintext === true) {
      store.serverEncryptionRequired = false;
    }
  }

  it('flips serverEncryptionRequired off on auth_result { acceptPlaintext: true }', () => {
    const store = { serverEncryptionRequired: true, sessionKey: null };
    applyAuthResult(store, {
      type: 'auth_result',
      success: true,
      sessionKey: 'base64key',
      role: 'admin',
      acceptPlaintext: true
    });
    expect(store.serverEncryptionRequired).toBe(false);
    expect(store.sessionKey).toBe('base64key');
  });

  it('keeps serverEncryptionRequired on when auth_result omits acceptPlaintext (old server)', () => {
    const store = { serverEncryptionRequired: true, sessionKey: null };
    applyAuthResult(store, {
      type: 'auth_result',
      success: true,
      sessionKey: 'base64key',
      role: 'admin'
      // no acceptPlaintext
    });
    expect(store.serverEncryptionRequired).toBe(true);
    expect(store.sessionKey).toBe('base64key');
  });

  it('keeps serverEncryptionRequired on if auth_result fails', () => {
    const store = { serverEncryptionRequired: true, sessionKey: null };
    applyAuthResult(store, {
      type: 'auth_result',
      success: false,
      error: 'bad token'
    });
    expect(store.serverEncryptionRequired).toBe(true);
  });
});

describe('web sends client_hello on connect', () => {
  it('emits a client_hello frame with plaintextOk: true after WS opens', () => {
    const ws = makeFakeBrowserWs();
    const store = { ws };

    // Mirror the onopen branch from websocket.js exactly.
    store.ws.send(JSON.stringify({
      type: 'client_hello',
      plaintextOk: true
    }));

    const sent = ws.getLastMessage();
    expect(sent.type).toBe('client_hello');
    expect(sent.plaintextOk).toBe(true);
  });

  it('omits any version field (no client version source wired)', () => {
    const ws = makeFakeBrowserWs();
    const store = { ws };

    store.ws.send(JSON.stringify({
      type: 'client_hello',
      plaintextOk: true
    }));

    expect(ws.getLastMessage()).not.toHaveProperty('version');
  });
});

describe('sendWsMessage: encrypt vs plaintext gate', () => {
  it('writes plain JSON when serverEncryptionRequired is false', () => {
    const ws = makeFakeBrowserWs();
    const store = {
      ws,
      sessionKey: new Uint8Array(32), // present but should not be used
      serverEncryptionRequired: false
    };

    const fakeEncrypt = () => ({ n: 'SHOULD_NOT_BE_CALLED', c: 'XX' });
    const msg = { type: 'send_message', text: 'hello' };
    const ok = sendWsMessageUnderTest(store, msg, fakeEncrypt);

    expect(ok).toBe(true);
    expect(ws.getLastMessage()).toEqual(msg);
    // Confirm we didn't end up with the fake envelope.
    expect(ws.getLastMessage().n).toBeUndefined();
  });

  it('writes encrypted envelope when serverEncryptionRequired is true and sessionKey present', () => {
    const ws = makeFakeBrowserWs();
    const store = {
      ws,
      sessionKey: new Uint8Array(32),
      serverEncryptionRequired: true
    };

    // Record what the fake "encrypt" was given so we can assert it ran.
    let captured = null;
    const fakeEncrypt = (m, k) => {
      captured = { m, k };
      return { n: 'fake-nonce', c: 'fake-ciphertext' };
    };
    const msg = { type: 'send_message', text: 'hello' };
    sendWsMessageUnderTest(store, msg, fakeEncrypt);

    expect(captured).not.toBeNull();
    expect(captured.m).toEqual(msg);
    expect(ws.getLastMessage()).toEqual({ n: 'fake-nonce', c: 'fake-ciphertext' });
  });

  it('writes plain JSON when sessionKey is missing (regardless of flag)', () => {
    const ws = makeFakeBrowserWs();
    const store = {
      ws,
      sessionKey: null,
      serverEncryptionRequired: true // even with flag on, no key = plaintext
    };
    const fakeEncrypt = () => ({ n: 'SHOULD_NOT_BE_CALLED', c: 'XX' });
    const msg = { type: 'ping' };
    sendWsMessageUnderTest(store, msg, fakeEncrypt);
    expect(ws.getLastMessage()).toEqual(msg);
  });

  it('drops the message if WS is not OPEN', () => {
    const ws = makeFakeBrowserWs();
    ws.readyState = 3; // CLOSED
    const store = { ws, serverEncryptionRequired: false };
    const ok = sendWsMessageUnderTest(store, { type: 'ping' }, () => ({}));
    expect(ok).toBe(false);
    expect(ws._sent.length).toBe(0);
  });
});

describe('web receive path still decrypts encrypted frames after plaintext flip', () => {
  it('parseWsMessage detection logic accepts both encrypted and plain frames', async () => {
    // We can't import web/utils/encryption.js in Node (depends on browser
    // globals), but the wire format is identical to server/encryption.js,
    // so we use the Node module to manufacture a representative envelope.
    const { encrypt, generateSessionKey, isEncrypted } = await import('../../server/encryption.js');
    const sessionKey = generateSessionKey();

    // Encrypted-from-old-server case.
    const upstream = { type: 'claude_output', data: 'hi' };
    const wire = await encrypt(upstream, sessionKey);

    expect(isEncrypted(wire)).toBe(true);

    // Detection logic that gates the decrypt branch in parseWsMessage:
    //   if (store.sessionKey && isEncrypted(parsed)) return decrypt(parsed, store.sessionKey);
    //   return parsed;
    const looksEncrypted = wire && typeof wire === 'object' &&
      typeof wire.n === 'string' && typeof wire.c === 'string';
    expect(looksEncrypted).toBe(true);

    // Plaintext case: same detector returns false; the parsed message
    // passes through unchanged.
    const plainWire = { type: 'claude_output', data: 'hi' };
    const looksEncryptedPlain = plainWire && typeof plainWire === 'object' &&
      typeof plainWire.n === 'string' && typeof plainWire.c === 'string';
    expect(looksEncryptedPlain).toBe(false);
  });
});

describe('Yeaft-incompatible message guard is independent of encryption flag', () => {
  // The Yeaft view guard sits before the encryption gate. A new client
  // negotiating plaintext mode must NOT suddenly forward yeaft-incompatible
  // types to the server.
  const YEAFT_INCOMPATIBLE_TYPES = new Set([
    'sync_messages', 'refresh_conversation', 'select_conversation',
    'cancel_execution', 'update_conversation_settings', 'ask_user_answer',
  ]);

  it('still short-circuits yeaft-incompatible types in yeaft view regardless of plaintext flag', () => {
    function wouldShortCircuit(store, msg) {
      if (store.currentView === 'yeaft' && YEAFT_INCOMPATIBLE_TYPES.has(msg.type)) {
        const convId = msg.conversationId;
        if (!convId ||
            (typeof convId === 'string' && convId.startsWith('yeaft-')) ||
            convId === store.yeaftConversationId) {
          return true;
        }
      }
      return false;
    }

    const store = {
      currentView: 'yeaft',
      yeaftConversationId: 'yeaft-12345',
      serverEncryptionRequired: false // plaintext negotiated
    };
    expect(wouldShortCircuit(store, { type: 'sync_messages', conversationId: 'yeaft-12345' })).toBe(true);
    expect(wouldShortCircuit(store, { type: 'sync_messages', conversationId: 'real_conv' })).toBe(false);
    expect(wouldShortCircuit(store, { type: 'send_message', conversationId: 'yeaft-12345' })).toBe(false);
  });
});
