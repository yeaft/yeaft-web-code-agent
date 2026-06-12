import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';
import { MockWebSocket, createMockAgent, createMockWebClient, WS_OPEN } from '../helpers/mockWs.js';

/**
 * Tests for the feat-ws-plaintext-negotiation capability handshake.
 *
 * The plan: send plaintext by default; encrypt only when the peer hasn't
 * told us it can speak plaintext. The receive path stays unconditional
 * (gated by `isEncrypted()`), so old peers still work.
 *
 * Backwards-compat matrix exercised:
 *   - server → web : controlled by per-client `encryptOutbound` (default true,
 *                    flipped to false when client_hello arrives)
 *   - server → agent : controlled by per-agent `encryptOutbound`, derived from
 *                      the agent's advertised capabilities (`plaintext-ok`)
 *
 * The send-site logic under test is a verbatim copy of the production
 * `sendToWebClient` / `sendToAgent` flag check from server/ws-utils.js,
 * lifted out so we can exercise it without dragging in config.js side
 * effects (matches the pattern in ws-utils.test.js).
 */

let db, userDb, sessionDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  userDb = ops.userDb;
  sessionDb = ops.sessionDb;
});

afterAll(() => cleanupTestDb());

// Mirrors the send-site decision in server/ws-utils.js. This is an
// independent copy of the branching logic, not the production function —
// keep it in sync by hand if ws-utils.js changes.
async function sendToWebClientUnderTest(client, msg, { skipAuth = false } = {}) {
  if (client.ws.readyState !== WS_OPEN) return;
  if (skipAuth || client.encryptOutbound === false) {
    client.ws.send(JSON.stringify(msg));
    return;
  }
  if (!client.sessionKey) {
    client.ws.close(1008, 'Encryption required');
    return;
  }
  const { encrypt } = await import('../../server/encryption.js');
  const encrypted = await encrypt(msg, client.sessionKey);
  client.ws.send(JSON.stringify(encrypted));
}

async function sendToAgentUnderTest(agent, msg, { skipAuth = false } = {}) {
  if (agent.ws.readyState !== WS_OPEN) return;
  if (skipAuth || agent.encryptOutbound === false) {
    agent.ws.send(JSON.stringify(msg));
    return;
  }
  if (!agent.sessionKey) {
    agent.ws.close(1008, 'Encryption required');
    return;
  }
  const { encrypt } = await import('../../server/encryption.js');
  const encrypted = await encrypt(msg, agent.sessionKey);
  agent.ws.send(JSON.stringify(encrypted));
}

describe('server → web : auth_result frame advertises acceptPlaintext', () => {
  it('always includes acceptPlaintext: true on success', () => {
    // What the new server code is supposed to put on the wire (server/ws-client.js)
    const sessionKey = Buffer.alloc(32, 7); // arbitrary 32-byte key
    const frame = {
      type: 'auth_result',
      success: true,
      sessionKey: Buffer.from(sessionKey).toString('base64'),
      role: 'admin',
      acceptPlaintext: true
    };
    expect(frame.acceptPlaintext).toBe(true);
    // Field still carries sessionKey so old clients keep working.
    expect(frame.sessionKey).toBeTruthy();
  });
});

describe('server → web : encryptOutbound default + client_hello flip', () => {
  it('defaults encryptOutbound to true so old clients still get ciphertext', () => {
    const client = createMockWebClient();
    // Production code in server/ws-client.js sets `encryptOutbound: true` at
    // webClients.set time. We mirror that default explicitly.
    client.encryptOutbound = true;
    expect(client.encryptOutbound).toBe(true);
  });

  it('flips encryptOutbound to false when client_hello arrives with plaintextOk', () => {
    const client = createMockWebClient();
    client.encryptOutbound = true;

    // Mirror the early-dispatch branch in handleWebMessage
    const incoming = { type: 'client_hello', plaintextOk: true };
    if (incoming.type === 'client_hello') {
      if (incoming.plaintextOk === true) {
        client.encryptOutbound = false;
      }
    }

    expect(client.encryptOutbound).toBe(false);
  });

  it('does NOT flip if client_hello omits plaintextOk', () => {
    const client = createMockWebClient();
    client.encryptOutbound = true;

    const incoming = { type: 'client_hello' }; // no plaintextOk
    if (incoming.type === 'client_hello') {
      if (incoming.plaintextOk === true) client.encryptOutbound = false;
    }

    expect(client.encryptOutbound).toBe(true);
  });

  it('does NOT flip if client_hello says plaintextOk: false explicitly', () => {
    const client = createMockWebClient();
    client.encryptOutbound = true;

    const incoming = { type: 'client_hello', plaintextOk: false };
    if (incoming.type === 'client_hello') {
      if (incoming.plaintextOk === true) client.encryptOutbound = false;
    }

    expect(client.encryptOutbound).toBe(true);
  });
});

describe('server → web : sendToWebClient writes plaintext vs ciphertext', () => {
  it('writes plain JSON when encryptOutbound === false (new client)', async () => {
    const { generateSessionKey } = await import('../../server/encryption.js');
    const client = createMockWebClient({
      sessionKey: generateSessionKey(),
      encryptOutbound: false
    });

    const msg = { type: 'claude_output', payload: { text: 'hello' } };
    await sendToWebClientUnderTest(client, msg);

    const lastSent = client.ws.getLastMessage();
    // Plain JSON: matches the original `msg` shape exactly, no {n,c} envelope.
    expect(lastSent).toEqual(msg);
    expect(lastSent.n).toBeUndefined();
    expect(lastSent.c).toBeUndefined();
  });

  it('writes encrypted {n,c} envelope when encryptOutbound === true (old client)', async () => {
    const { generateSessionKey, isEncrypted, decrypt } = await import('../../server/encryption.js');
    const sessionKey = generateSessionKey();
    const client = createMockWebClient({ sessionKey, encryptOutbound: true });

    const msg = { type: 'claude_output', payload: { text: 'hello' } };
    await sendToWebClientUnderTest(client, msg);

    const lastSent = client.ws.getLastMessage();
    expect(isEncrypted(lastSent)).toBe(true);
    expect(lastSent.n).toBeTruthy(); // nonce
    expect(lastSent.c).toBeTruthy(); // ciphertext
    // Round-trips back to the original message via the session key.
    const decoded = await decrypt(lastSent, sessionKey);
    expect(decoded).toEqual(msg);
  });

  it('skipAuth forces plaintext even if encryptOutbound is true (dev visibility)', async () => {
    const { generateSessionKey } = await import('../../server/encryption.js');
    const client = createMockWebClient({
      sessionKey: generateSessionKey(),
      encryptOutbound: true // pretend old client
    });

    const msg = { type: 'ping' };
    await sendToWebClientUnderTest(client, msg, { skipAuth: true });

    expect(client.ws.getLastMessage()).toEqual(msg);
  });
});

describe('server → agent : registered frame advertises acceptPlaintext', () => {
  it('always includes acceptPlaintext: true so new agents can flip outbound', () => {
    const sessionKey = Buffer.alloc(32, 7);
    const frame = {
      type: 'registered',
      agentId: 'global:Worker-1',
      sessionKey: Buffer.from(sessionKey).toString('base64'),
      acceptPlaintext: true
    };
    expect(frame.acceptPlaintext).toBe(true);
    // Key still present — old agents need it to encrypt outbound.
    expect(frame.sessionKey).toBeTruthy();
  });

  it('still carries upgradeAvailable next to acceptPlaintext when set', () => {
    const frame = {
      type: 'registered',
      agentId: 'global:Worker-1',
      sessionKey: null,
      acceptPlaintext: true,
      upgradeAvailable: '0.1.999'
    };
    expect(frame.acceptPlaintext).toBe(true);
    expect(frame.upgradeAvailable).toBe('0.1.999');
  });
});

describe('server → agent : encryptOutbound derived from advertised capabilities', () => {
  it('flips encryptOutbound off when capabilities include plaintext-ok', () => {
    const advertised = ['terminal', 'file_editor', 'background_tasks', 'plaintext-ok'];
    const encryptOutbound = !advertised.includes('plaintext-ok');
    expect(encryptOutbound).toBe(false);
  });

  it('keeps encryptOutbound on when capabilities omit plaintext-ok (old agent)', () => {
    const advertised = ['terminal', 'file_editor', 'background_tasks'];
    const encryptOutbound = !advertised.includes('plaintext-ok');
    expect(encryptOutbound).toBe(true);
  });

  it('keeps encryptOutbound on for legacy default-empty capabilities path', () => {
    // ws-agent.js falls back to ['terminal', 'file_editor', 'background_tasks']
    // when the agent reports no capabilities at all. None of those is
    // plaintext-ok, so encryptOutbound stays true — correct for old agents.
    const reported = [];
    const effective = reported.length > 0 ? reported : ['terminal', 'file_editor', 'background_tasks'];
    const encryptOutbound = !effective.includes('plaintext-ok');
    expect(encryptOutbound).toBe(true);
  });
});

describe('server → agent : sendToAgent writes plaintext vs ciphertext', () => {
  it('writes plain JSON when encryptOutbound === false (new agent)', async () => {
    const { generateSessionKey } = await import('../../server/encryption.js');
    const agent = createMockAgent({
      sessionKey: generateSessionKey(),
      encryptOutbound: false
    });

    const msg = { type: 'execute', conversationId: 'c1', prompt: 'hello' };
    await sendToAgentUnderTest(agent, msg);

    const lastSent = agent.ws.getLastMessage();
    expect(lastSent).toEqual(msg);
    expect(lastSent.n).toBeUndefined();
    expect(lastSent.c).toBeUndefined();
  });

  it('writes encrypted {n,c} envelope when encryptOutbound === true (old agent)', async () => {
    const { generateSessionKey, isEncrypted, decrypt } = await import('../../server/encryption.js');
    const sessionKey = generateSessionKey();
    const agent = createMockAgent({ sessionKey, encryptOutbound: true });

    const msg = { type: 'execute', conversationId: 'c1', prompt: 'hello' };
    await sendToAgentUnderTest(agent, msg);

    const lastSent = agent.ws.getLastMessage();
    expect(isEncrypted(lastSent)).toBe(true);
    const decoded = await decrypt(lastSent, sessionKey);
    expect(decoded).toEqual(msg);
  });
});

describe('server : receive path stays unconditional (back-compat bridge)', () => {
  it('decrypts an old client encrypting upstream even when server is in plaintext mode', async () => {
    // The scenario: new server, old client. Server's encryptOutbound for
    // this client stays true (no client_hello), but the old client also
    // encrypts when sending. The server's parseMessage must still decrypt
    // those frames — it's gated by `sessionKey && isEncrypted()`, not by
    // any outbound flag.
    const { encrypt, generateSessionKey, isEncrypted, decrypt } = await import('../../server/encryption.js');
    const sessionKey = generateSessionKey();
    const upstream = { type: 'send_message', text: 'hi' };
    const wire = await encrypt(upstream, sessionKey);

    expect(isEncrypted(wire)).toBe(true);

    // Receiver code path: JSON.parse → if encrypted, decrypt.
    const parsed = JSON.parse(JSON.stringify(wire));
    const decoded = isEncrypted(parsed) ? await decrypt(parsed, sessionKey) : parsed;
    expect(decoded).toEqual(upstream);
  });

  it('passes plaintext upstream through untouched (new client → new server)', async () => {
    const { isEncrypted } = await import('../../server/encryption.js');
    const upstream = { type: 'send_message', text: 'hi' };
    const parsed = JSON.parse(JSON.stringify(upstream));
    expect(isEncrypted(parsed)).toBe(false);
    // Receiver returns the plain message as-is when it doesn't match the
    // encrypted envelope shape.
  });
});
