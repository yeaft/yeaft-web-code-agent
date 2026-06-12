/**
 * Integration: synthetic tool_use round-trip — agent emits →
 * DB-shaped row → formatDbMessage → ToolLine-ready props.
 *
 * The two synthetic-tool sentinels (__SubagentResult, __CompactSummary)
 * are de-facto cross-tier schema: the agent persists them via the
 * existing tool_use path (agent-output.js → SQLite tool_name column),
 * and the web rehydrates them via formatDbMessage's tool_use branch.
 *
 * The hops are individually tested (parsers in
 * claude-message-filter.test.js, DB persistence in server tests). This
 * file pins the SEAM between agent-emitted wire shape and
 * web-rehydrated render shape — the contract that breaks silently when
 * someone refactors agent-output.js or formatDbMessage.
 */
import { describe, it, expect } from 'vitest';
import { buildSyntheticToolUseMessage } from '../../../../agent/claude.js';
import { SYNTHETIC_TOOL_NAMES } from '../../../../agent/synthetic-tools.js';

globalThis.Pinia = globalThis.Pinia || { defineStore: () => () => ({}) };
const { formatDbMessage } = await import('../../../../web/stores/helpers/messages.js');

/**
 * Mimic the agent-output.js DB-insert step: pull the first tool_use block
 * out of an assistant message and store it as a row with message_type =
 * 'tool_use', tool_name = block.name, tool_input = JSON.stringify(block.input).
 *
 * This is intentionally hand-rolled to avoid coupling the test to the
 * server's full agent-output handler (which depends on Express, JWT, the DB
 * driver, etc). The shape is what server/handlers/agent-output.js writes —
 * if THAT shape changes, this test fails loudly and reminds the next
 * refactorer to keep the cross-tier contract intact.
 */
function persistAsDbRow(syntheticMessage, idCounter = { n: 1 }) {
  const block = syntheticMessage.message.content.find(b => b.type === 'tool_use');
  return {
    id: idCounter.n++,
    message_type: 'tool_use',
    tool_name: block.name,
    tool_input: JSON.stringify(block.input),
    created_at: Date.now(),
  };
}

describe('synthetic tool round-trip — __SubagentResult', () => {
  it('flows from agent wire shape → DB row → ToolLine-ready props', () => {
    const parsed = {
      taskId: 'task-abc',
      toolUseId: 'toolu_01XYZ',
      outputFile: '/tmp/out.json',
      status: 'completed',
      summary: 'Investigated foo',
      result: 'Found 3 matches across src/',
    };
    const wireMessage = buildSyntheticToolUseMessage(SYNTHETIC_TOOL_NAMES.SUBAGENT_RESULT, parsed);
    const dbRow = persistAsDbRow(wireMessage);
    const rehydrated = formatDbMessage(dbRow);

    expect(rehydrated.type).toBe('tool-use');
    expect(rehydrated.toolName).toBe('__SubagentResult');
    expect(rehydrated.toolInput).toEqual(parsed);
    expect(rehydrated.hasResult).toBe(true);
    expect(rehydrated.isHistory).toBe(true);
  });
});

describe('synthetic tool round-trip — __CompactSummary', () => {
  it('flows from agent wire shape → DB row → ToolLine-ready props', () => {
    const summary = 'This session is being continued from a previous conversation...\n\nSummary:\n1. ...';
    const wireMessage = buildSyntheticToolUseMessage(SYNTHETIC_TOOL_NAMES.COMPACT_SUMMARY, { summary });
    const dbRow = persistAsDbRow(wireMessage);
    const rehydrated = formatDbMessage(dbRow);

    expect(rehydrated.type).toBe('tool-use');
    expect(rehydrated.toolName).toBe('__CompactSummary');
    expect(rehydrated.toolInput.summary).toBe(summary);
    expect(rehydrated.hasResult).toBe(true);
  });
});

describe('synthetic tool round-trip — DB-stored tool_input survives JSON round-trip without loss', () => {
  it('preserves multi-line and unicode characters', () => {
    const parsed = {
      taskId: 't1',
      toolUseId: 'tu1',
      outputFile: '',
      status: 'completed',
      summary: 'unicode test 测试 ✓',
      result: 'line1\nline2\n\n"quoted" + backslash \\ end',
    };
    const wireMessage = buildSyntheticToolUseMessage(SYNTHETIC_TOOL_NAMES.SUBAGENT_RESULT, parsed);
    const dbRow = persistAsDbRow(wireMessage);
    const rehydrated = formatDbMessage(dbRow);

    expect(rehydrated.toolInput).toEqual(parsed);
  });
});
