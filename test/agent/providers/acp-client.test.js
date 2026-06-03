import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { AcpClient } from '../../../agent/providers/acp-client.js';

function makePair() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  return { stdin, stdout };
}

describe('AcpClient — JSONRPC framing + dispatch', () => {
  it('writes a request with auto-incrementing id and resolves on matching response', async () => {
    const { stdin, stdout } = makePair();
    const client = new AcpClient({ stdin, stdout });

    const writes = [];
    stdin.on('data', (chunk) => writes.push(chunk.toString('utf8')));

    const p = client.request('initialize', { protocolVersion: 1 });
    await new Promise(r => setImmediate(r));
    expect(writes.join('')).toContain('"method":"initialize"');
    const sent = JSON.parse(writes.join('').trim());
    expect(sent.id).toBeTypeOf('number');

    stdout.write(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { ok: true } }) + '\n');
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects pending requests on error responses', async () => {
    const { stdin, stdout } = makePair();
    const client = new AcpClient({ stdin, stdout });
    stdin.on('data', () => {});
    const p = client.request('m', {});
    await new Promise(r => setImmediate(r));
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } }) + '\n');
    await expect(p).rejects.toThrow(/nope/);
  });

  it('routes server-initiated requests to onRequest and writes back result', async () => {
    const { stdin, stdout } = makePair();
    const writes = [];
    stdin.on('data', (c) => writes.push(c.toString('utf8')));
    new AcpClient({
      stdin, stdout,
      onRequest: async (method) => method === 'fs/read_text_file' ? { content: 'hi' } : null,
    });
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'fs/read_text_file', params: {} }) + '\n');
    await new Promise(r => setTimeout(r, 10));
    const reply = JSON.parse(writes.join('').trim());
    expect(reply).toMatchObject({ id: 42, result: { content: 'hi' } });
  });

  it('dispatches notifications (no id) to onNotification', async () => {
    const { stdin, stdout } = makePair();
    const seen = [];
    new AcpClient({ stdin, stdout, onNotification: (m, p) => seen.push([m, p]) });
    stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1' } }) + '\n');
    await new Promise(r => setImmediate(r));
    expect(seen).toEqual([['session/update', { sessionId: 's1' }]]);
  });

  it('survives partial chunks split mid-message', async () => {
    const { stdin, stdout } = makePair();
    const seen = [];
    new AcpClient({ stdin, stdout, onNotification: (m, p) => seen.push([m, p]) });
    stdout.write('{"jsonrpc":"2.0","method":"a","params":');
    stdout.write('{"x":1}}\n{"jsonrpc":"2.0","method":"b"}\n');
    await new Promise(r => setImmediate(r));
    expect(seen).toEqual([['a', { x: 1 }], ['b', undefined]]);
  });

  it('close() rejects all pending requests', async () => {
    const { stdin, stdout } = makePair();
    const client = new AcpClient({ stdin, stdout });
    stdin.on('data', () => {});
    const p = client.request('x', {});
    client.close('test');
    await expect(p).rejects.toThrow(/test/);
  });
});
