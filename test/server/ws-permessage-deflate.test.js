import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * Tests for RFC 7692 permessage-deflate negotiation.
 *
 * The plan: replace the hand-rolled gzip-before-encrypt with the ws library's
 * built-in permessage-deflate. Browser clients advertise it natively; the
 * agent opts in explicitly via `new WebSocket(url, {perMessageDeflate: ...})`.
 *
 * Source files exercised:
 *   - server/index.js (WebSocketServer({perMessageDeflate: {...}}))
 *   - agent/connection/index.js (new WebSocket(url, {perMessageDeflate: ...}))
 *
 * We boot a local `WebSocketServer` with the same config and inspect what
 * the WS handshake actually negotiates.
 */

const serverDeflateConfig = {
  zlibDeflateOptions: { level: 6, memLevel: 7 },
  zlibInflateOptions: { chunkSize: 10 * 1024 },
  clientNoContextTakeover: true,
  serverNoContextTakeover: true,
  threshold: 1024
};

const clientDeflateConfig = {
  clientNoContextTakeover: true,
  serverNoContextTakeover: true,
  threshold: 1024
};

let httpServer = null;
let wss = null;

function listen() {
  return new Promise((resolve) => {
    httpServer = createServer();
    wss = new WebSocketServer({
      server: httpServer,
      perMessageDeflate: serverDeflateConfig
    });
    httpServer.listen(0, '127.0.0.1', () => {
      resolve(httpServer.address().port);
    });
  });
}

afterEach(async () => {
  if (wss) {
    await new Promise(r => wss.close(r));
    wss = null;
  }
  if (httpServer) {
    await new Promise(r => httpServer.close(r));
    httpServer = null;
  }
});

describe('server WebSocketServer accepts permessage-deflate config', () => {
  it('boots without throwing with the production config', async () => {
    const port = await listen();
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThan(0);
  });
});

describe('agent ↔ server: permessage-deflate negotiation', () => {
  it('negotiates permessage-deflate when both sides offer it', async () => {
    const port = await listen();

    const serverSocketReady = new Promise((resolve) => {
      wss.on('connection', (ws) => resolve(ws));
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}`, {
      perMessageDeflate: clientDeflateConfig
    });

    await new Promise((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    const serverSocket = await serverSocketReady;

    // ws library exposes the negotiated extensions on each socket as a
    // comma-separated string containing the extension names. When deflate
    // is negotiated both sides should contain "permessage-deflate".
    expect(String(serverSocket.extensions)).toContain('permessage-deflate');
    expect(String(client.extensions)).toContain('permessage-deflate');

    const closed = new Promise(r => client.once('close', r));
    client.close();
    await closed;
  });

  it('round-trips data correctly across the deflated connection', async () => {
    const port = await listen();

    let serverReceived = null;
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        serverReceived = data.toString();
        ws.send('pong:' + serverReceived);
      });
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}`, {
      perMessageDeflate: clientDeflateConfig
    });

    await new Promise(r => client.once('open', r));

    // A payload above the 1024-byte threshold so compression actually engages.
    const payload = 'x'.repeat(5000);
    client.send(payload);

    const reply = await new Promise(r => client.once('message', d => r(d.toString())));
    expect(serverReceived).toBe(payload);
    expect(reply).toBe('pong:' + payload);

    const closed = new Promise(r => client.once('close', r));
    client.close();
    await closed;
  });

  it('still works when client does not request deflate (back-compat)', async () => {
    // Old agents without explicit perMessageDeflate config — the server
    // should still accept them (uncompressed) without breaking.
    const port = await listen();

    const serverSocketReady = new Promise((resolve) => {
      wss.on('connection', (ws) => resolve(ws));
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}`, {
      perMessageDeflate: false
    });

    await new Promise(r => client.once('open', r));
    const serverSocket = await serverSocketReady;

    // No extensions negotiated when the client declined.
    expect(String(serverSocket.extensions || '')).not.toContain('permessage-deflate');

    const closed = new Promise(r => client.once('close', r));
    client.close();
    await closed;
  });
});

describe('threshold honored', () => {
  it('small payloads (under threshold) round-trip identical', async () => {
    const port = await listen();

    let serverReceived = null;
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        serverReceived = data.toString();
      });
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}`, {
      perMessageDeflate: clientDeflateConfig
    });
    await new Promise(r => client.once('open', r));

    const small = 'hello';
    client.send(small);
    await new Promise(r => setTimeout(r, 50));
    expect(serverReceived).toBe(small);

    const closed = new Promise(r => client.once('close', r));
    client.close();
    await closed;
  });
});
