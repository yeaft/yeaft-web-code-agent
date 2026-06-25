import { afterEach, describe, expect, it } from 'vitest';

import ctx from '../../agent/context.js';
import { BUFFERABLE_TYPES, sendToServer } from '../../agent/connection/buffer.js';

const originalCtx = {
  ws: ctx.ws,
  sessionKey: ctx.sessionKey,
  serverEncryptionRequired: ctx.serverEncryptionRequired,
  outboundSendQueue: ctx.outboundSendQueue,
  outboundSendQueueActive: ctx.outboundSendQueueActive,
  messageBuffer: ctx.messageBuffer,
};

afterEach(() => {
  ctx.ws = originalCtx.ws;
  ctx.sessionKey = originalCtx.sessionKey;
  ctx.serverEncryptionRequired = originalCtx.serverEncryptionRequired;
  ctx.outboundSendQueue = originalCtx.outboundSendQueue;
  ctx.outboundSendQueueActive = originalCtx.outboundSendQueueActive;
  ctx.messageBuffer = originalCtx.messageBuffer;
});

function waitImmediate() {
  return new Promise(resolve => setImmediate(resolve));
}

describe('agent connection buffer', () => {
  it('buffers Yeaft history chunks while the websocket reconnects', () => {
    expect(BUFFERABLE_TYPES.has('yeaft_history_chunk')).toBe(true);
  });

  it('queues outbound websocket frames and yields between sends', async () => {
    const sent = [];
    ctx.ws = {
      readyState: 1,
      send(payload) {
        sent.push(JSON.parse(payload));
      },
    };
    ctx.sessionKey = null;
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    ctx.messageBuffer = [];

    const first = sendToServer({ type: 'first' });
    const second = sendToServer({ type: 'second' });

    expect(sent).toEqual([]);
    await waitImmediate();
    expect(sent.map(msg => msg.type)).toEqual(['first']);
    await waitImmediate();
    expect(sent.map(msg => msg.type)).toEqual(['first', 'second']);
    await expect(first).resolves.toBe('sent');
    await expect(second).resolves.toBe('sent');
  });

  it('keeps sendToServer awaitable until the queued frame is sent', async () => {
    const sent = [];
    let resolved = false;
    ctx.ws = {
      readyState: 1,
      send(payload) {
        sent.push(JSON.parse(payload));
      },
    };
    ctx.sessionKey = null;
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    ctx.messageBuffer = [];

    const pending = sendToServer({ type: 'turn_completed' }).then(outcome => {
      resolved = true;
      return outcome;
    });

    expect(resolved).toBe(false);
    expect(sent).toEqual([]);

    await expect(pending).resolves.toBe('sent');
    expect(resolved).toBe(true);
    expect(sent.map(msg => msg.type)).toEqual(['turn_completed']);
  });

  it('resolves buffered messages without waiting for reconnect flush', async () => {
    ctx.ws = null;
    ctx.sessionKey = null;
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    ctx.messageBuffer = [];

    await expect(sendToServer({ type: 'turn_completed' })).resolves.toBe('buffered');
    expect(ctx.messageBuffer.map(msg => msg.type)).toEqual(['turn_completed']);
  });
});
