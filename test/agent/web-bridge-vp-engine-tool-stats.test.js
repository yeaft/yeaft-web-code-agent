/**
 * web-bridge-vp-engine-tool-stats.test.js — pins the wiring fix in
 * `getOrCreateVpEngine`. Before the fix, per-VP Engine instances were
 * built WITHOUT the session's `toolStats`, so tool calls executed by VPs
 * in a group conversation were silently dropped from the
 * `~/.yeaft/stats/tool-usage.json` snapshot read by
 * `unify_fetch_tool_stats`. The user-visible bug was "tool usage stats
 * in group conversations don't work".
 *
 * The test installs a session-shaped stub via `__testSetSession`, asks
 * the bridge to build a per-VP Engine via `__testGetOrCreateVpEngine`,
 * drives one tool through it, and asserts the stub stats received a
 * `record(...)` call with the tool name.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  __testSetSession,
  __testGetOrCreateVpEngine,
  __testResetVpState,
} from '../../agent/unify/web-bridge.js';
import { NullTrace } from '../../agent/unify/debug-trace.js';
import { ToolRegistry } from '../../agent/unify/tools/registry.js';
import { defineTool } from '../../agent/unify/tools/types.js';

function mkStatsStub() {
  const calls = [];
  return {
    calls,
    record(args) { calls.push(args); },
    snapshot() { return { tools: {} }; },
  };
}

class OneShotToolAdapter {
  constructor(toolName) {
    this.toolName = toolName;
    this._counter = 0;
  }
  async *stream() {
    if (this._counter === 0) {
      this._counter += 1;
      yield { type: 'tool_call', id: 'tc-1', name: this.toolName, input: {} };
      yield { type: 'stop', stopReason: 'tool_use' };
    } else {
      yield { type: 'text_delta', text: 'all done' };
      yield { type: 'stop', stopReason: 'end_turn' };
    }
  }
  async call() { return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }; }
}

describe('getOrCreateVpEngine: per-VP engine inherits session.toolStats', () => {
  beforeEach(async () => {
    await __testResetVpState();
    __testSetSession(null);
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

    const adapter = new OneShotToolAdapter('echo');
    __testSetSession({
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
      toolStats: stats,
    });

    const engine = __testGetOrCreateVpEngine('grp_test', 'vp_test');
    expect(engine).toBeTruthy();

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

    const adapter = new OneShotToolAdapter('echo');
    __testSetSession({
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
      // toolStats intentionally absent — exercises the `|| null` fallback
    });
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
