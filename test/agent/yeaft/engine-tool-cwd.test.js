import { describe, it, expect, beforeEach } from 'vitest';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';

class MockAdapter {
  constructor() { this.responses = []; }
  pushResponse(events) { this.responses.push(events); }
  async *stream() {
    const events = this.responses.shift();
    if (!events) throw new Error('MockAdapter: no more responses queued');
    for (const ev of events) yield ev;
  }
  async call() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }
}

describe('Engine — toolCtx.cwd reflects query({ workDir })', () => {
  let adapter;
  beforeEach(() => { adapter = new MockAdapter(); });

  function makeEngine() {
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024 },
    });
    let seenCwd = null;
    engine.registerTool({
      name: 'probe_cwd',
      description: 'records ctx.cwd',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => { seenCwd = ctx?.cwd ?? null; return 'ok'; },
    });
    return { engine, getSeenCwd: () => seenCwd };
  }

  it('passes the group workDir as ctx.cwd to tools', async () => {
    const { engine, getSeenCwd } = makeEngine();
    adapter.pushResponse([
      { type: 'tool_call', id: 'c1', name: 'probe_cwd', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'text_delta', text: 'done' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    for await (const _ of engine.query({ prompt: 'go', workDir: '/tmp/yeaft-proj-a' })) {
      // drain
    }
    expect(getSeenCwd()).toBe('/tmp/yeaft-proj-a');
  });

  it('falls back to process.cwd() when no workDir is provided', async () => {
    const { engine, getSeenCwd } = makeEngine();
    adapter.pushResponse([
      { type: 'tool_call', id: 'c1', name: 'probe_cwd', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'text_delta', text: 'done' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    for await (const _ of engine.query({ prompt: 'go' })) {
      // drain
    }
    expect(getSeenCwd()).toBe(process.cwd());
  });

  it('ignores blank workDir and falls back to process.cwd()', async () => {
    const { engine, getSeenCwd } = makeEngine();
    adapter.pushResponse([
      { type: 'tool_call', id: 'c1', name: 'probe_cwd', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'text_delta', text: 'done' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    for await (const _ of engine.query({ prompt: 'go', workDir: '   ' })) {
      // drain
    }
    expect(getSeenCwd()).toBe(process.cwd());
  });
});
