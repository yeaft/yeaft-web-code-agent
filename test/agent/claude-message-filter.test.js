/**
 * Tests for parseTaskNotification and isCompactSummary in agent/claude.js.
 *
 * These two helpers identify the two classes of "fake user messages" that
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
import { parseTaskNotification, isCompactSummary } from '../../agent/claude.js';

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

  it('returns empty strings for missing tags rather than failing', () => {
    const text = `<task-notification>
  <task-id>only-id</task-id>
</task-notification>`;
    const parsed = parseTaskNotification(text);
    expect(parsed).toEqual({
      taskId: 'only-id',
      toolUseId: '',
      outputFile: '',
      status: '',
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
