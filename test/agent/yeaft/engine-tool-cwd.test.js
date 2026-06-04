import { describe, it, expect, beforeEach } from 'vitest';
import { resolve as resolvePath } from 'path';
import { Engine } from '../../../agent/yeaft/engine.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
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

  it('resolves relative workDir to an absolute path (parity with Claude Chat spawn cwd)', async () => {
    const { engine, getSeenCwd } = makeEngine();
    adapter.pushResponse([
      { type: 'tool_call', id: 'c1', name: 'probe_cwd', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'text_delta', text: 'done' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    for await (const _ of engine.query({ prompt: 'go', workDir: './sub/dir/' })) {
      // drain
    }
    expect(getSeenCwd()).toBe(resolvePath('./sub/dir/'));
    // Trailing slash normalized away.
    expect(getSeenCwd().endsWith('/')).toBe(false);
  });

  it('also exposes ctx.cwd to tools registered via ToolRegistry (production path)', async () => {
    // The `engine.registerTool` legacy `#tools` Map and the ToolRegistry
    // path are two different execute branches in engine.js (~line 2350).
    // Production wires ToolRegistry via the constructor; only legacy /
    // tests use registerTool. Both must see the same ctx.cwd or the
    // production fleet silently regresses while the test suite passes.
    let seenCwd = null;
    const registry = new ToolRegistry();
    registry.register({
      name: 'probe_cwd',
      description: 'records ctx.cwd',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => { seenCwd = ctx?.cwd ?? null; return 'ok'; },
    });
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
    });
    adapter.pushResponse([
      { type: 'tool_call', id: 'c1', name: 'probe_cwd', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'text_delta', text: 'done' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    for await (const _ of engine.query({ prompt: 'go', workDir: '/tmp/yeaft-registry' })) {
      // drain
    }
    expect(seenCwd).toBe('/tmp/yeaft-registry');
  });
});
