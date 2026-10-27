import { describe, expect, it } from 'vitest';
import {
  estimateContentTokens,
  estimateMessagesTokens,
  fitProviderRequestToContext,
} from '../../../agent/yeaft/history-window.js';
import { hasOrphanPairs } from '../../../agent/yeaft/pair-sanitize.js';

const STATIC_OPTIONS = { systemTokens: 73, toolSchemaTokens: 41, outputReserve: 99 };
const STATIC_TOKENS = 213;

function fit(messages, messageBudget, options = {}) {
  return fitProviderRequestToContext(messages, {
    ...STATIC_OPTIONS,
    contextWindow: messageBudget + STATIC_TOKENS,
    ...options,
  });
}

function batch(ids, contents, extra = {}) {
  return [
    {
      role: 'assistant', content: `Inspect ${ids.join(', ')} without changing arguments.`,
      toolCalls: ids.map(id => ({ id, name: 'Bash', input: { command: `inspect ${id}`, cwd: '/repo' } })),
    },
    ...ids.map((id, index) => ({
      role: 'tool', toolCallId: id, name: 'Bash', content: contents[index], ...extra,
    })),
  ];
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object') return value;
  Object.values(value).forEach(freezeDeep);
  return Object.freeze(value);
}

function assertBounded(result) {
  expect(result.meta.estimatedTokens).toBeLessThanOrEqual(result.meta.contextWindow);
  expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(result.meta.messageBudget);
  expect(hasOrphanPairs(result.messages)).toBe(false);
}

function assertPairsAndTextUnchanged(before, after) {
  expect(after.filter(message => message.role !== 'tool'))
    .toEqual(before.filter(message => message.role !== 'tool'));
  expect(after.filter(message => message.role === 'tool').map(({ toolCallId, isError }) => ({ toolCallId, isError })))
    .toEqual(before.filter(message => message.role === 'tool').map(({ toolCallId, isError }) => ({ toolCallId, isError })));
}

describe('pressure-driven provider tool-result compaction', () => {
  it('leaves even large results lossless under low pressure and budgets history after the current turn', () => {
    const history = [
      { role: 'user', content: 'Past question' },
      { role: 'assistant', content: 'Past answer' },
    ];
    const current = [
      { role: 'user', content: 'Keep my exact request.' },
      ...batch(['large'], ['start\n' + 'x'.repeat(100_000) + '\nend']),
    ];
    const source = freezeDeep([...history, ...current]);
    const result = fit(source, estimateMessagesTokens(current) + 1, { historyMessageCount: history.length });
    expect(result.messages).toEqual(current);
    expect(result.meta.compactedToolResults).toBe(0);
    expect(result.meta.compactedToolResultTokensSaved).toBe(0);
    expect(source).toEqual([...history, ...current]);
    assertBounded(result);
  });

  it('samples oldest tool text first, preserving head/tail, errors, all arguments, ordinary text and latest result', () => {
    const old = 'OLD_HEAD\n' + 'older output '.repeat(2_000) + '\nOLD_TAIL';
    const latest = 'LATEST_HEAD\n' + 'fresh '.repeat(1_000) + '\nLATEST_TAIL';
    const source = freezeDeep([
      { role: 'user', content: 'Do not truncate the question.' },
      ...batch(['old'], [old], { isError: true }),
      { role: 'assistant', content: 'Retain this intermediate explanation.' },
      ...batch(['new'], [latest]),
      { role: 'assistant', content: 'Continue from the latest result.' },
    ]);
    const result = fit(source, estimateMessagesTokens(source) - 3_000);
    expect(result.messages).toHaveLength(source.length);
    assertPairsAndTextUnchanged(source, result.messages);
    const tool = result.messages.find(message => message.toolCallId === 'old');
    expect(tool.content).toMatch(/^OLD_HEAD/);
    expect(tool.content).toMatch(/middle omitted/);
    expect(tool.content).toMatch(/OLD_TAIL$/);
    expect(tool.isError).toBe(true);
    expect(result.messages.find(message => message.toolCallId === 'new').content).toBe(latest);
    expect(source[2].content).toBe(old);
    expect(result.meta.compactedToolResults).toBe(1);
    expect(result.meta.compactedToolResultTokensSaved)
      .toBe(estimateMessagesTokens(source) - estimateMessagesTokens(result.messages));
    expect(fit(source, result.meta.messageBudget)).toEqual(result);
    assertBounded(result);
  });

  it('keeps structured JSON parseable, including the complete Bash failure envelope', () => {
    const failure = JSON.stringify({
      error: 'Command exited with code 1.', code: 'bash_exit_nonzero', errorEffect: 'unknown',
      failureType: 'exit_nonzero', exitCode: 1, timedOut: false, terminationConfirmed: true,
      status: 'Exit code: 1; termination confirmed',
      output: 'ERROR_HEAD\n' + 'stack and logs\n'.repeat(1_000) + '\nERROR_TAIL',
      diagnostics: { log: 'DIAGNOSTIC_HEAD' + 'diagnostic '.repeat(1_000) + 'DIAGNOSTIC_TAIL' },
    });
    // Registry/MCP/provider adapters can supply the same envelope as JSON
    // text, a structured object, or a text content part. All stay parseable.
    for (const failureContent of [failure, JSON.parse(failure), [{ type: 'text', text: failure }]]) {
      const source = freezeDeep([
        { role: 'user', content: 'Inspect the failure.' },
        ...batch(['failed'], [failureContent], { isError: true }),
        ...batch(['latest'], ['latest output']),
      ]);
      const result = fit(source, estimateMessagesTokens(source) - 5_000);
      const content = result.messages.find(message => message.toolCallId === 'failed').content;
      const compacted = JSON.parse(Array.isArray(content) ? content[0].text : content);
      const original = JSON.parse(failure);
      expect({ ...compacted, output: '', diagnostics: null }).toEqual({ ...original, output: '', diagnostics: null });
      expect(compacted.output).toMatch(/^ERROR_HEAD[\s\S]*middle omitted[\s\S]*ERROR_TAIL$/);
      expect(compacted.diagnostics.log).toMatch(/^DIAGNOSTIC_HEAD[\s\S]*middle omitted[\s\S]*DIAGNOSTIC_TAIL$/);
      assertPairsAndTextUnchanged(source, result.messages);
      expect(result.meta.compactedToolResults).toBe(1);
      assertBounded(result);
    }
  });

  it('preserves numeric facts and safely falls back for deeply nested untrusted JSON', () => {
    const numbers = [
      '{"record_id":9007199254740993,"output":"' + 'x'.repeat(10_000) + '"}',
      '{"record_id":1e400,"output":"' + 'x'.repeat(10_000) + '"}',
      '{"values":[9007199254740993,1e400,-0,1.00],"output":"' + 'x'.repeat(10_000) + '"}',
    ];
    const deep = '['.repeat(5_000) + '"' + 'x'.repeat(10_000) + '"' + ']'.repeat(5_000);
    for (const content of [...numbers, deep]) {
      const source = freezeDeep([
        { role: 'user', content: 'Preserve the exact evidence.' },
        ...batch(['unsafe'], [content]),
        ...batch(['compactable'], ['HEAD\n' + 'y'.repeat(20_000) + '\nTAIL']),
        ...batch(['latest'], ['latest output']),
      ]);
      // Pressure is real, but can be paid by a different safe result. The JSON
      // that cannot safely round-trip must stay byte-for-byte unchanged.
      const result = fit(source, estimateMessagesTokens(source) - 500);
      expect(result.messages.find(message => message.toolCallId === 'unsafe').content).toBe(content);
      expect(result.meta.compactedToolResults).toBe(1);
      assertPairsAndTextUnchanged(source, result.messages);
      assertBounded(result);
      // When it cannot fit at all, the old bounded fitter wins without a crash.
      assertBounded(fit(source, 300));
      expect(source[2].content).toBe(content);
    }
  });

  it('shares pressure across old multi-tool batches while protecting every result in the latest batch', () => {
    const old = id => `${id}_HEAD\n` + 'old '.repeat(1_000) + `\n${id}_TAIL`;
    const source = freezeDeep([
      { role: 'user', content: 'Inspect in parallel.' },
      ...batch(['old-a', 'old-b', 'old-c'], ['old-a', 'old-b', 'old-c'].map(old)),
      ...batch(['new-a', 'new-b'], ['new A '.repeat(500), 'new B '.repeat(500)]),
    ]);
    const result = fit(source, estimateMessagesTokens(source) - 2_500);
    expect(result.meta.compactedToolResults).toBe(3);
    expect(result.messages).toHaveLength(source.length);
    assertPairsAndTextUnchanged(source, result.messages);
    for (const id of ['old-a', 'old-b', 'old-c']) {
      const content = result.messages.find(message => message.toolCallId === id).content;
      expect(content).toMatch(new RegExp(`^${id}_HEAD[\\s\\S]*middle omitted[\\s\\S]*${id}_TAIL$`));
    }
    expect(result.messages.slice(-2)).toEqual(source.slice(-2));
    assertBounded(result);
  });

  it('charges CJK, astral characters, JSON escapes and omission markers against the actual remaining budget', () => {
    const old = JSON.stringify({ output: '中文开头😀\n' + '中文路径😀\\"\n'.repeat(3_000) + '\n中文末尾😀' });
    const source = freezeDeep([
      { role: 'user', content: '保留请求和工具调用参数。' },
      ...batch(['old'], [old]),
      ...batch(['new'], ['最新结果不能变。'.repeat(50)]),
    ]);
    const result = fit(source, 777, { language: 'zh' });
    const content = JSON.parse(result.messages.find(message => message.toolCallId === 'old').content).output;
    expect(content).toMatch(/^中文开头😀[\s\S]*middle omitted[\s\S]*中文末尾😀$/);
    expect(content).not.toContain('\ufffd');
    expect(result.messages.at(-1)).toEqual(source.at(-1));
    expect(result.meta.compactedToolResults).toBe(1);
    assertPairsAndTextUnchanged(source, result.messages);
    assertBounded(result);
  });

  it('samples mixed text parts in place without cutting, removing or reordering images/documents', () => {
    const content = [
      { type: 'text', text: 'FIRST_HEAD\n' + 'first '.repeat(2_000) + '\nFIRST_TAIL', annotations: ['keep'] },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc'.repeat(400) } },
      { type: 'document', title: 'Evidence', source: { type: 'base64', media_type: 'application/pdf', data: 'xyz'.repeat(400) } },
      { type: 'text', text: 'LAST_HEAD\n' + 'last '.repeat(2_000) + '\nLAST_TAIL' },
    ];
    const source = freezeDeep([
      { role: 'user', content: 'Keep binary evidence intact.' },
      ...batch(['mixed'], [content]),
      ...batch(['new'], ['latest']),
    ]);
    const result = fit(source, estimateMessagesTokens(source) - 4_000);
    const projected = result.messages.find(message => message.toolCallId === 'mixed').content;
    expect(projected.map(part => part.type)).toEqual(content.map(part => part.type));
    expect(projected[0]).toMatchObject({ annotations: ['keep'] });
    expect(projected[0].text).toMatch(/^FIRST_HEAD[\s\S]*middle omitted[\s\S]*FIRST_TAIL$/);
    expect(projected[3].text).toMatch(/^LAST_HEAD[\s\S]*middle omitted[\s\S]*LAST_TAIL$/);
    expect(projected[1]).toEqual(content[1]);
    expect(projected[2]).toEqual(content[2]);
    expect(content[0].text).not.toContain('middle omitted');
    expect(result.meta.compactedToolResultTokensSaved)
      .toBe(estimateContentTokens(content) - estimateContentTokens(projected));
    assertPairsAndTextUnchanged(source, result.messages);
    assertBounded(result);
  });

  it('falls back to bounded protocol-unit fitting when compaction cannot reclaim enough text', () => {
    const source = freezeDeep([
      { role: 'user', content: 'Important request ' + 'q'.repeat(100) },
      ...batch(['binary'], [[{ type: 'image', source: { type: 'base64', data: 'A'.repeat(10_000) } }]]),
      ...batch(['numbers'], [JSON.stringify({ values: Array.from({ length: 1_000 }, (_, i) => i) })]),
      ...batch(['new'], ['fresh'.repeat(2_000)]),
    ]);
    // Include a tiny budget and an explicit row cap: neither has enough
    // compressible old text, so the existing last-resort fitter must win.
    for (const messageBudget of [0, 1, 2, 40, 200]) {
      const result = fit(source, messageBudget, { maxMessageCount: 4 });
      expect(result.meta.compactedToolResults).toBe(0);
      expect(result.meta.compactedToolResultTokensSaved).toBe(0);
      expect(result.meta.droppedCurrentMessages).toBeGreaterThan(0);
      expect(result.messages.length).toBeLessThanOrEqual(4);
      assertBounded(result);
    }
    // A compressible old result can still be insufficient: account its savings
    // and then let final fitting evict units/omit whole attachments as needed.
    const withOldText = freezeDeep([
      source[0],
      ...batch(['old-text'], ['HEAD\n' + 'old '.repeat(2_000) + '\nTAIL']),
      ...source.slice(1),
    ]);
    const afterCompaction = fit(withOldText, 200);
    expect(afterCompaction.meta.compactedToolResults).toBe(1);
    expect(afterCompaction.meta.compactedToolResultTokensSaved).toBeGreaterThan(0);
    expect(afterCompaction.meta.droppedCurrentMessages).toBeGreaterThan(0);
    assertBounded(afterCompaction);
    expect(source[2].content[0].source.data).toHaveLength(10_000);
    expect(source.at(-1).content).toHaveLength(10_000);
  });
});
