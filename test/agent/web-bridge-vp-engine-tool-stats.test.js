/**
 * web-bridge-vp-engine-tool-stats.test.js — pins the wiring fix in
 * `getOrCreateVpEngine`. Before the fix, per-VP Engine instances were
 * built WITHOUT the session's `toolStats`, so tool calls executed by VPs
 * in a group conversation were silently dropped from the
 * `~/.yeaft/stats/tool-usage.json` snapshot read by
 * `yeaft_fetch_tool_stats`. The user-visible bug was "tool usage stats
 * in group conversations don't work".
 *
 * Two-layer assertion:
 *
 *   1. Identity — the per-VP engine carries the EXACT instance the
 *      session exposes. Verified by registering a capture-tool and
 *      reading `ctx.parentEngineDeps.toolStats`. Without this assertion
 *      a future per-VP wrapper that swapped the instance for a clone
 *      would silently re-introduce the bug.
 *
 *   2. Behaviour — driving a real tool through the engine produces a
 *      `record({ name, durationMs, isError })` call on the same stub.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  __testSetSession,
  __testGetOrCreateVpEngine,
  __testResetVpState,
} from '../../agent/yeaft/web-bridge.js';
import { NullTrace } from '../../agent/yeaft/debug-trace.js';
import { ToolRegistry } from '../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../agent/yeaft/tools/types.js';
import { mkStatsStub, OneShotToolAdapter } from '../helpers/tool-stats.js';

function mkSession({ toolRegistry, adapter, toolStats }) {
  return {
    adapter,
    trace: new NullTrace(),
    config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language: 'en' },
    conversationStore: null,
    memoryIndex: null,
    amsRegistry: null,
    toolRegistry,
    skillManager: null,
    mcpManager: null,
    yeaftDir: null,
    toolStats,
  };
}

describe('getOrCreateVpEngine: per-VP engine inherits session.toolStats', () => {
  beforeEach(async () => {
    await __testResetVpState();
    __testSetSession(null);
  });

  it('per-VP engine surfaces session.toolStats by identity through ctx.parentEngineDeps', async () => {
    const stats = mkStatsStub();
    let capturedCtx = null;
    const captureTool = defineTool({
      name: 'capture',
      description: 'captures ctx so the test can assert on it',
      parameters: { type: 'object', properties: {} },
      async execute(_input, ctx) {
        capturedCtx = ctx;
        return 'ok';
      },
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(captureTool);

    __testSetSession(mkSession({
      toolRegistry,
      adapter: new OneShotToolAdapter('capture'),
      toolStats: stats,
    }));

    const engine = __testGetOrCreateVpEngine('grp_test', 'vp_test');
    for await (const _evt of engine.query({ prompt: 'go', messages: [] })) {
      // drain
    }
    // Identity, not just shape — guarantees the same instance the
    // yeaft_fetch_tool_stats handler reads back.
    expect(capturedCtx.parentEngineDeps.toolStats).toBe(stats);
  });

  it('tool calls executed inside a per-VP engine increment session.toolStats', async () => {
    const stats = mkStatsStub();
    const echoTool = defineTool({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
      async execute() { return 'ok'; },
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(echoTool);

    __testSetSession(mkSession({
      toolRegistry,
      adapter: new OneShotToolAdapter('echo'),
      toolStats: stats,
    }));

    const engine = __testGetOrCreateVpEngine('grp_test', 'vp_test');
    for await (const _evt of engine.query({ prompt: 'use echo once', messages: [] })) {
      // drain
    }

    const echoCalls = stats.calls.filter(c => c.name === 'echo');
    expect(echoCalls.length).toBe(1);
    expect(echoCalls[0]).toMatchObject({ name: 'echo', isError: false });
    expect(typeof echoCalls[0].durationMs).toBe('number');
  });

  it('session without toolStats produces an engine that still runs (defensive)', async () => {
    const echoTool = defineTool({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
      async execute() { return 'ok'; },
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(echoTool);

    __testSetSession(mkSession({
      toolRegistry,
      adapter: new OneShotToolAdapter('echo'),
      // toolStats omitted — exercises the `|| null` fallback
    }));

    const engine = __testGetOrCreateVpEngine('grp_test', 'vp_test');
    let endTurn = false;
    for await (const evt of engine.query({ prompt: 'use echo once', messages: [] })) {
      if (evt.type === 'turn_end') endTurn = true;
    }
    expect(endTurn).toBe(true);
  });

  it('throws a clear message when no session has been loaded', () => {
    __testSetSession(null);
    expect(() => __testGetOrCreateVpEngine('grp', 'vp')).toThrow(/session not loaded/);
  });
});
