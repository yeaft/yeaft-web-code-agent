/**
 * tool-stats.js — shared fixtures for the two PR-782 tests that pin the
 * "ToolUsageStats is threaded into every Engine that runs tools" wiring.
 *
 * Kept tiny on purpose: only the surfaces the tests touch.
 */

/**
 * Minimal ToolUsageStats stub — only the `record({ name, durationMs,
 * isError, errorMessage })` surface Engine.record-on-tool-exec calls.
 * `calls` is a list of every record invocation so tests can assert.
 */
export function mkStatsStub() {
  const calls = [];
  return {
    calls,
    record(args) { calls.push(args); },
  };
}

/**
 * Scripted adapter that emits ONE tool_call for `toolName` on the first
 * stream() call, then end_turn on the second. Lets a test drive the
 * engine through exactly one tool execution and back to a quiet state.
 */
export class OneShotToolAdapter {
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
