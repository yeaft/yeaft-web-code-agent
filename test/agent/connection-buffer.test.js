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

    await sendToServer({ type: 'first' });
    await sendToServer({ type: 'second' });

    expect(sent).toEqual([]);
    await waitImmediate();
    expect(sent.map(msg => msg.type)).toEqual(['first']);
    await waitImmediate();
    expect(sent.map(msg => msg.type)).toEqual(['first', 'second']);
  });
});
