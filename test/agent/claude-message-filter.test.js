/**
 * Tests for parseTaskNotification, isCompactSummary, extractUserText, and
 * buildSyntheticToolUseMessage in agent/claude.js.
 *
 * These helpers identify the two classes of "fake user messages" that
 * Claude Code injects back into the main conversation:
 *   1. <task-notification>...</task-notification> — fired when a background
 *      Agent/Task tool completes; rewritten into __SubagentResult tool action.
 *   2. Compact summaries — the `This session is being continued...` block
 *      Claude Code injects after context compaction; rewritten into
 *      __CompactSummary tool action.
 *
 * Without these filters they would render as giant user bubbles in the UI.
 */
import { describe, it, expect } from 'vitest';
import {
  parseTaskNotification,
  isCompactSummary,
  extractUserText,
  buildSyntheticToolUseMessage,
} from '../../agent/claude.js';
import { SYNTHETIC_TOOL_NAMES, isSyntheticToolName } from '../../agent/synthetic-tools.js';

// =====================================================================
// 1. parseTaskNotification — happy path
// =====================================================================
describe('parseTaskNotification — valid <task-notification> blocks', () => {
  it('extracts all 6 fields from a fully populated notification', () => {
    const text = `<task-notification>
  <task-id>abc123</task-id>
  <tool-use-id>toolu_01ABC</tool-use-id>
  <output-file>/tmp/task-abc.json</output-file>
  <status>completed</status>
  <summary>Searched the codebase for foo</summary>
  <result>Found 3 matches in src/foo.js</result>
</task-notification>`;
    const parsed = parseTaskNotification(text);
    expect(parsed).toEqual({
      taskId: 'abc123',
      toolUseId: 'toolu_01ABC',
      outputFile: '/tmp/task-abc.json',
      status: 'completed',
      summary: 'Searched the codebase for foo',
      result: 'Found 3 matches in src/foo.js',
    });
  });

  it('handles multi-line <result> content', () => {
    const text = `<task-notification>
  <task-id>t1</task-id>
  <tool-use-id>tu1</tool-use-id>
  <output-file>x</output-file>
  <status>completed</status>
  <summary>multi-line work</summary>
  <result>line 1
line 2
line 3</result>
</task-notification>`;
    const parsed = parseTaskNotification(text);
    expect(parsed.result).toBe('line 1\nline 2\nline 3');
  });

  it('preserves nested <task-notification> mentions inside <result> (greedy match)', () => {
    // If a subagent quotes Claude Code internals or talks about its own
    // protocol, the <result> block can contain literal `<task-notification>`
    // text. With a lazy regex this would truncate at the first close tag and
    // silently corrupt the captured result. The greedy match below keeps
    // the entire payload intact because the outer wrapper is always the
    // last close tag in the message.
    const inner = 'we observed <task-notification>...<result>inner-result</result></task-notification> in the dump';
    const text = `<task-notification>
  <task-id>nest1</task-id>
  <tool-use-id>tu</tool-use-id>
  <output-file></output-file>
  <status>completed</status>
  <summary>summary text</summary>
  <result>${inner}</result>
</task-notification>`;
    const parsed = parseTaskNotification(text);
    expect(parsed).not.toBeNull();
    expect(parsed.taskId).toBe('nest1');
    expect(parsed.result).toBe(inner);
  });

  it('returns empty strings for absent secondary fields, as long as at least one of status/summary/result survives', () => {
    const text = `<task-notification>
  <task-id>only-id</task-id>
  <status>completed</status>
</task-notification>`;
    const parsed = parseTaskNotification(text);
    expect(parsed).toEqual({
      taskId: 'only-id',
      toolUseId: '',
      outputFile: '',
      status: 'completed',
      summary: '',
      result: '',
    });
  });

  it('tolerates leading whitespace before <task-notification>', () => {
    const text = `   \n  <task-notification>
  <task-id>ws</task-id>
  <tool-use-id></tool-use-id>
  <output-file></output-file>
  <status>ok</status>
  <summary>s</summary>
  <result>r</result>
</task-notification>`;
    const parsed = parseTaskNotification(text);
    expect(parsed).not.toBeNull();
    expect(parsed.taskId).toBe('ws');
    expect(parsed.status).toBe('ok');
  });
});

// =====================================================================
// 2. parseTaskNotification — rejection cases
// =====================================================================
describe('parseTaskNotification — non-matching input returns null', () => {
  it('returns null for plain user text', () => {
    expect(parseTaskNotification('Hello, how do I sort an array?')).toBeNull();
  });

  it('returns null for text that merely mentions task-notification', () => {
    expect(parseTaskNotification('We use <task-notification> tags internally.')).toBeNull();
  });

  it('returns null for null / undefined / non-string input', () => {
    expect(parseTaskNotification(null)).toBeNull();
    expect(parseTaskNotification(undefined)).toBeNull();
    expect(parseTaskNotification(42)).toBeNull();
    expect(parseTaskNotification({})).toBeNull();
    expect(parseTaskNotification([])).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseTaskNotification('')).toBeNull();
  });

  it('returns null for a different XML wrapper', () => {
    expect(parseTaskNotification('<system-reminder>foo</system-reminder>')).toBeNull();
  });

  it('returns null for degenerate notification with no useful fields (e.g. truncated stream)', () => {
    // status/summary/result are all empty — declining to rewrite means the
    // malformed text shows up somewhere debuggable instead of producing a
    // content-less ToolLine.
    const text = `<task-notification>
  <task-id>only</task-id>
</task-notification>`;
    expect(parseTaskNotification(text)).toBeNull();
  });

  it('returns null for an opening tag with no closing tag at all', () => {
    const text = `<task-notification>
  <task-id>x</task-id>
  <status>pending`;
    expect(parseTaskNotification(text)).toBeNull();
  });
});

// =====================================================================
// 3. isCompactSummary — detection (matches the patterns in claude.js)
// =====================================================================
describe('isCompactSummary — positive matches', () => {
  it('matches the "This session is being continued" header', () => {
    const text = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

Summary:
1. Primary Request: user asked about X
2. Key Technical Concepts: ...
` + 'x'.repeat(200);
    expect(isCompactSummary(text)).toBe(true);
  });

  it('matches the alternate "summary below covers" wording', () => {
    const text = `Something else.

The summary below covers the earlier portion of the conversation.

` + 'y'.repeat(300);
    expect(isCompactSummary(text)).toBe(true);
  });

  it('matches when long text has Summary: + numbered Primary Request', () => {
    const text = `Header text\n` + 'pad '.repeat(60) + `\nSummary:\n1. Primary Request and Intent: user wants X\n2. Key things\n`;
    expect(isCompactSummary(text)).toBe(true);
  });
});

// =====================================================================
// 4. isCompactSummary — rejection
// =====================================================================
describe('isCompactSummary — negative cases', () => {
  it('rejects short normal user input', () => {
    expect(isCompactSummary('Hi')).toBe(false);
    expect(isCompactSummary('Can you help me with sort?')).toBe(false);
  });

  it('rejects empty / null / undefined input', () => {
    expect(isCompactSummary('')).toBe(false);
    expect(isCompactSummary(null)).toBe(false);
    expect(isCompactSummary(undefined)).toBe(false);
  });

  it('rejects long text that does not include any compact marker', () => {
    const text = 'A normal long message. '.repeat(50);
    expect(isCompactSummary(text)).toBe(false);
  });

  it('rejects a message that merely mentions "continued"', () => {
    const text = 'I continued my work on the previous task.' + ' filler'.repeat(50);
    expect(isCompactSummary(text)).toBe(false);
  });

  it('rejects short text even if it contains the marker (length guard)', () => {
    // Length guard requires >= 200 chars to avoid false positives on
    // someone deliberately quoting the marker as a question.
    expect(isCompactSummary('This session is being continued from a previous conversation')).toBe(false);
  });
});

// =====================================================================
// 5. extractUserText — papers over the four observed SDK message shapes
// =====================================================================
describe('extractUserText — SDK message shape coverage', () => {
  it('returns string content directly', () => {
    expect(extractUserText({ content: 'hello' })).toBe('hello');
  });

  it('returns string content nested under .message.content', () => {
    expect(extractUserText({ message: { content: 'hi' } })).toBe('hi');
  });

  it('concatenates array of {type, text} blocks under .message.content', () => {
    const msg = { message: { content: [{ type: 'text', text: 'foo' }, { type: 'text', text: 'bar' }] } };
    expect(extractUserText(msg)).toBe('foobar');
  });

  it('concatenates array blocks under top-level .content', () => {
    const msg = { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
    expect(extractUserText(msg)).toBe('ab');
  });

  it('skips non-text blocks in arrays gracefully', () => {
    const msg = { message: { content: [{ type: 'text', text: 'hi' }, { type: 'image' }, { type: 'text', text: ' there' }] } };
    expect(extractUserText(msg)).toBe('hi there');
  });

  it('returns empty string for null / undefined / shape-unknown input', () => {
    expect(extractUserText(null)).toBe('');
    expect(extractUserText(undefined)).toBe('');
    expect(extractUserText({})).toBe('');
    expect(extractUserText({ foo: 'bar' })).toBe('');
  });
});

// =====================================================================
// 6. buildSyntheticToolUseMessage — wire shape contract
// =====================================================================
describe('buildSyntheticToolUseMessage — wire shape', () => {
  it('produces an assistant message with a single tool_use block', () => {
    const msg = buildSyntheticToolUseMessage(SYNTHETIC_TOOL_NAMES.SUBAGENT_RESULT, { summary: 'x' });
    expect(msg.type).toBe('assistant');
    expect(Array.isArray(msg.message.content)).toBe(true);
    expect(msg.message.content).toHaveLength(1);
    const block = msg.message.content[0];
    expect(block.type).toBe('tool_use');
    expect(block.name).toBe('__SubagentResult');
    expect(block.input).toEqual({ summary: 'x' });
    expect(typeof block.id).toBe('string');
    expect(block.id.startsWith('synthetic-__SubagentResult-')).toBe(true);
  });

  it('uses different ids across calls (collision resistance within a session)', () => {
    const a = buildSyntheticToolUseMessage(SYNTHETIC_TOOL_NAMES.COMPACT_SUMMARY, { summary: 'a' });
    const b = buildSyntheticToolUseMessage(SYNTHETIC_TOOL_NAMES.COMPACT_SUMMARY, { summary: 'b' });
    expect(a.message.content[0].id).not.toBe(b.message.content[0].id);
  });
});

// =====================================================================
// 7. SYNTHETIC_TOOL_NAMES — constants module
// =====================================================================
describe('SYNTHETIC_TOOL_NAMES — single source of truth for synthetic names', () => {
  it('exposes the two expected names with the __ prefix', () => {
    expect(SYNTHETIC_TOOL_NAMES.SUBAGENT_RESULT).toBe('__SubagentResult');
    expect(SYNTHETIC_TOOL_NAMES.COMPACT_SUMMARY).toBe('__CompactSummary');
  });

  it('isSyntheticToolName recognises both sentinels and only those', () => {
    expect(isSyntheticToolName('__SubagentResult')).toBe(true);
    expect(isSyntheticToolName('__CompactSummary')).toBe(true);
    expect(isSyntheticToolName('__Other')).toBe(false);
    expect(isSyntheticToolName('Read')).toBe(false);
    expect(isSyntheticToolName(null)).toBe(false);
    expect(isSyntheticToolName(undefined)).toBe(false);
    expect(isSyntheticToolName(42)).toBe(false);
  });

  it('is frozen — accidental rename would throw in strict mode', () => {
    expect(Object.isFrozen(SYNTHETIC_TOOL_NAMES)).toBe(true);
  });
});
