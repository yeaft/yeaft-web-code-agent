import { describe, expect, it } from 'vitest';
import { hasOrphanPairs } from '../../../agent/yeaft/pair-sanitize.js';
import {
  estimateContentPartTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateContentTokens,
  stripToolNoiseFromOlderTurns,
  trimSnapshotForBudget,
  buildHistoryBuckets,
  fitProviderRequestToContext,
} from '../../../agent/yeaft/history-window.js';

describe('deterministic provider history window', () => {
  it('keeps a current turn larger than 32K when the model request still fits', () => {
    const history = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'h'.repeat(160_000) },
    ];
    const current = { role: 'user', content: 'c'.repeat(140_000) };
    const buckets = buildHistoryBuckets([...history, current], {
      currentTurnStartIndex: history.length,
      messageTokenBudget: 32_768,
    });

    expect(estimateMessageTokens(current)).toBeGreaterThan(32_768);
    expect(buckets.messages.at(-1).content).toBe(current.content);
    expect(buckets.meta.budget.usedTokens).toBeLessThanOrEqual(32_768);

    const fitted = fitProviderRequestToContext(buckets.messages, {
      contextWindow: 100_000,
      systemTokens: 1_000,
      toolSchemaTokens: 1_000,
      outputReserve: 8_000,
      historyMessageCount: buckets.messages.length - buckets.meta.current.messageCount,
    });
    expect(fitted.messages.at(-1).content).toBe(current.content);
    expect(fitted.meta.estimatedTokens).toBeLessThanOrEqual(100_000);
  });

  it('drops recent history below five turns instead of throwing an internal budget error', () => {
    const history = Array.from({ length: 5 }, (_, index) => [
      { role: 'user', content: `question ${index}` },
      { role: 'assistant', content: 'x'.repeat(2_000) },
    ]).flat();
    const current = { role: 'user', content: 'current' };
    const result = buildHistoryBuckets([...history, current], {
      currentTurnStartIndex: history.length,
      messageTokenBudget: 600,
    });

    expect(result.meta.recent.turnCount).toBeLessThan(5);
    expect(result.messages.at(-1)).toEqual(current);
  });

  it('uses different whole-request limits for different model windows', () => {
    const messages = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'x'.repeat(80_000) },
      { role: 'user', content: 'current' },
    ];
    const small = fitProviderRequestToContext(messages, {
      contextWindow: 12_000, outputReserve: 2_000, historyMessageCount: 2,
    });
    const large = fitProviderRequestToContext(messages, {
      contextWindow: 40_000, outputReserve: 2_000, historyMessageCount: 2,
    });
    expect(small.messages.length).toBeLessThan(large.messages.length);
    expect(small.meta.contextWindow).toBe(12_000);
    expect(large.meta.contextWindow).toBe(40_000);
  });

  it('drops current tool protocol as paired units without mutating the source', () => {
    const messages = [
      { role: 'user', content: 'current request' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read', input: {} }] },
      { role: 'tool', toolCallId: 'old', content: 'old result' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'new', name: 'read', input: {} }] },
      { role: 'tool', toolCallId: 'new', content: 'new result' },
    ];
    const original = structuredClone(messages);
    const fitted = fitProviderRequestToContext(messages, {
      contextWindow: 10_000,
      outputReserve: 100,
      historyMessageCount: 0,
      maxMessageCount: 3,
    });

    expect(messages).toEqual(original);
    expect(fitted.messages).toHaveLength(3);
    const owners = new Set(fitted.messages.flatMap(message =>
      message.toolCalls?.map(call => call.id) || []));
    const results = new Set(fitted.messages.filter(message => message.role === 'tool')
      .map(message => message.toolCallId));
    expect(owners).toEqual(new Set(['new']));
    expect(results).toEqual(owners);
  });

  it('counts signed thinking blocks and JSON-serialized function outputs', () => {
    const thinking = {
      thinking: 'x'.repeat(100_000),
      signature: 'signature',
    };
    const functionOutput = {
      type: 'function_call_output',
      output: { payload: 'y'.repeat(100_000) },
    };

    expect(estimateMessageTokens({ role: 'assistant', content: 'done', thinkingBlocks: [thinking] })).toBeGreaterThan(20_000);
    expect(estimateContentPartTokens(functionOutput)).toBeGreaterThan(20_000);
    expect(estimateContentTokens([functionOutput])).toBeGreaterThan(20_000);
  });

  it('drops a signed thinking/tool arc atomically when its replay cannot fit', () => {
    const messages = [
      { role: 'user', content: 'run the tool' },
      {
        role: 'assistant',
        content: '',
        thinkingBlocks: [{ thinking: 'x'.repeat(100_000), signature: 'opaque-signature' }],
        toolCalls: [{ id: 'call-signed', name: 'Inspect', input: {} }],
      },
      { role: 'tool', toolCallId: 'call-signed', content: 'tool result' },
    ];

    const window = trimSnapshotForBudget(messages, { messageTokenBudget: 100 });

    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(100);
    expect(window).toEqual([{ role: 'user', content: 'run the tool' }]);
    expect(JSON.stringify(window)).not.toContain('opaque-signature');
    expect(messages[1].thinkingBlocks[0].thinking).toHaveLength(100_000);
  });

  it('drops an oversized signed thinking block as an atomic replay unit', () => {
    const thinking = [{
      role: 'assistant',
      content: 'answer',
      thinkingBlocks: [{ thinking: 'x'.repeat(100_000), signature: 'opaque-signature' }],
    }];

    const window = trimSnapshotForBudget(thinking, { messageTokenBudget: 100 });

    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(100);
    expect(window).toEqual([{ role: 'assistant', content: 'answer' }]);
    expect(JSON.stringify(window)).not.toContain('opaque-signature');
    expect(thinking[0].thinkingBlocks[0].thinking).toHaveLength(100_000);
  });

  it('bounds object-valued function_call_output before Responses JSON serialization', () => {
    const messages = [{
      role: 'user',
      content: [{
        type: 'function_call_output',
        output: { payload: 'y'.repeat(100_000) },
      }],
    }];

    const window = trimSnapshotForBudget(messages, { messageTokenBudget: 100 });

    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(100);
    expect(JSON.stringify(window)).not.toContain('y'.repeat(1_000));
    expect(messages[0].content[0].output.payload).toHaveLength(100_000);
  });

  it('counts text, image, and document content parts instead of treating arrays as zero', () => {
    const textPart = { type: 'text', text: 'x'.repeat(100_000) };
    const imagePart = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(100_000) },
    };
    const documentPart = {
      type: 'document',
      title: 'requirements.pdf',
      source: { type: 'base64', media_type: 'application/pdf', data: 'b'.repeat(100_000) },
    };

    expect(estimateContentPartTokens(textPart)).toBeGreaterThan(10_000);
    expect(estimateContentPartTokens(imagePart)).toBeGreaterThan(6_000);
    expect(estimateContentPartTokens(documentPart)).toBeGreaterThan(6_000);
    expect(estimateMessageTokens({ role: 'user', content: [textPart, imagePart, documentPart] })).toBeGreaterThan(20_000);
  });

  it('bounds a single oversized multimodal message without sending the full part', () => {
    const messages = [{
      role: 'user',
      content: [{
        type: 'text',
        text: 'x'.repeat(100_000),
      }, {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(100_000) },
      }],
    }];

    const window = trimSnapshotForBudget(messages, { messageTokenBudget: 100 });

    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(100);
    expect(JSON.stringify(window)).not.toContain('a'.repeat(1_000));
    expect(messages[0].content[0].text).toHaveLength(100_000);
  });

  it('keeps the newest complete turns without generating a summary', () => {
    const messages = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'middle question' },
      { role: 'assistant', content: 'middle answer' },
      { role: 'user', content: 'new question' },
      { role: 'assistant', content: 'new answer' },
    ];

    const window = trimSnapshotForBudget(messages, {
      recentTurnCap: 2,
      messageTokenBudget: 10_000,
    });

    expect(window.map(message => message.content)).toEqual([
      'middle question',
      'middle answer',
      'new question',
      'new answer',
    ]);
    expect(window.some(message => String(message.content).includes('conversation_summary'))).toBe(false);
    expect(messages).toHaveLength(6);
  });

  it('drops oldest turns until the deterministic token budget fits', () => {
    const messages = [
      { role: 'user', content: 'a'.repeat(100) },
      { role: 'assistant', content: 'b'.repeat(100) },
      { role: 'user', content: 'c'.repeat(100) },
      { role: 'assistant', content: 'd'.repeat(100) },
    ];

    const window = trimSnapshotForBudget(messages, {
      recentTurnCap: 10,
      messageTokenBudget: 55,
    });

    expect(window.map(message => message.content)).toEqual([
      'c'.repeat(100),
      'd'.repeat(100),
    ]);
    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(55);
  });

  it('removes old tool noise but preserves recent tool pairs', () => {
    const messages = [
      { role: 'user', content: 'old task' },
      {
        role: 'assistant',
        content: 'old tool answer',
        toolCalls: [{ id: 'old-call', name: 'Bash', input: { command: 'pwd' } }],
      },
      { role: 'tool', toolCallId: 'old-call', content: 'old result' },
      { role: 'user', content: 'current task' },
      {
        role: 'assistant',
        content: 'current tool answer',
        toolCalls: [{ id: 'current-call', name: 'Bash', input: { command: 'pwd' } }],
      },
      { role: 'tool', toolCallId: 'current-call', content: 'current result' },
    ];

    const window = stripToolNoiseFromOlderTurns(messages, { keepToolTurns: 1 });

    expect(window).toEqual([
      { role: 'user', content: 'old task' },
      { role: 'assistant', content: 'old tool answer' },
      { role: 'user', content: 'current task' },
      {
        role: 'assistant',
        content: 'current tool answer',
        toolCalls: [{ id: 'current-call', name: 'Bash', input: { command: 'pwd' } }],
      },
      { role: 'tool', toolCallId: 'current-call', content: 'current result' },
    ]);
    expect(messages[1].toolCalls).toHaveLength(1);
  });

  it('keeps twenty text turns when old function payloads would otherwise consume the budget', () => {
    const messages = [];
    for (let turn = 1; turn <= 20; turn += 1) {
      const callId = `call-${turn}`;
      const oldPayload = turn <= 17 ? 'x'.repeat(20_000) : `input-${turn}`;
      const oldResult = turn <= 17 ? 'y'.repeat(20_000) : `result-${turn}`;
      messages.push(
        { role: 'user', content: `question-${turn}` },
        {
          role: 'assistant',
          content: `answer-${turn}`,
          toolCalls: [{ id: callId, name: 'Inspect', input: { payload: oldPayload } }],
        },
        { role: 'tool', toolCallId: callId, content: oldResult },
      );
    }

    const window = trimSnapshotForBudget(messages, {
      recentTurnCap: 20,
      messageTokenBudget: 1_000,
    });

    expect(window.filter(message => message.role === 'user')).toHaveLength(20);
    expect(window[0]).toEqual({ role: 'user', content: 'question-1' });
    expect(window.filter(message => Array.isArray(message.toolCalls))).toHaveLength(3);
    expect(window.filter(message => message.role === 'tool')).toHaveLength(3);
    expect(JSON.stringify(window)).not.toContain('x'.repeat(1_000));
    expect(JSON.stringify(window)).not.toContain('y'.repeat(1_000));
  });

  it('applies the message cap after removing old tool rows', () => {
    const messages = [];
    for (let turn = 1; turn <= 20; turn += 1) {
      const toolCalls = Array.from({ length: 20 }, (_, index) => ({
        id: `call-${turn}-${index}`,
        name: 'Inspect',
        input: { turn, index },
      }));
      messages.push(
        { role: 'user', content: `question-${turn}` },
        { role: 'assistant', content: `answer-${turn}`, toolCalls },
        ...toolCalls.map(call => ({
          role: 'tool',
          toolCallId: call.id,
          content: `result-${call.id}`,
        })),
      );
    }

    const window = trimSnapshotForBudget(messages, {
      recentTurnCap: 20,
      maxMessageCount: 256,
      messageTokenBudget: 100_000,
    });

    expect(window.filter(message => message.role === 'user')).toHaveLength(20);
    expect(window[0]).toEqual({ role: 'user', content: 'question-1' });
    expect(window.filter(message => Array.isArray(message.toolCalls))).toHaveLength(3);
    expect(window.filter(message => message.role === 'tool')).toHaveLength(60);
    expect(window).toHaveLength(100);
  });

  it('drops optional recent function payload before textual turns under token pressure', () => {
    const messages = [];
    for (let turn = 1; turn <= 20; turn += 1) {
      const callId = `call-${turn}`;
      messages.push(
        { role: 'user', content: `question-${turn}` },
        {
          role: 'assistant',
          content: `answer-${turn}`,
          toolCalls: turn >= 18
            ? [{ id: callId, name: 'Inspect', input: { payload: 'x'.repeat(20_000) } }]
            : undefined,
        },
      );
      if (turn >= 18) {
        messages.push({ role: 'tool', toolCallId: callId, content: `result-${turn}` });
      }
    }

    const window = trimSnapshotForBudget(messages, {
      recentTurnCap: 20,
      messageTokenBudget: 1_000,
    });

    expect(window.filter(message => message.role === 'user')).toHaveLength(20);
    expect(window[0]).toEqual({ role: 'user', content: 'question-1' });
    expect(window.filter(message => Array.isArray(message.toolCalls))).toHaveLength(0);
    expect(window.filter(message => message.role === 'tool')).toHaveLength(0);
    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(1_000);
    expect(hasOrphanPairs(window)).toBe(false);
  });

  it('does not spend partial token headroom by evicting an already-fitted text turn', () => {
    const messages = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      const callId = `call-${turn}`;
      messages.push(
        { role: 'user', content: `question-${turn} ${'q'.repeat(120)}` },
        {
          role: 'assistant',
          content: `answer-${turn} ${'a'.repeat(120)}`,
          ...(turn === 5
            ? { toolCalls: [{ id: callId, name: 'Inspect', input: { payload: 'x'.repeat(220) } }] }
            : {}),
        },
      );
      if (turn === 5) {
        messages.push({ role: 'tool', toolCallId: callId, content: `result-${turn}` });
      }
    }

    const textOnly = trimSnapshotForBudget(messages, {
      messageTokenBudget: 340,
      keepToolTurns: 0,
    });
    const enriched = trimSnapshotForBudget(messages, {
      messageTokenBudget: 340,
      keepToolTurns: 3,
    });

    expect(estimateMessagesTokens(textOnly)).toBe(280);
    expect(textOnly.filter(message => message.role === 'user').map(message => message.content.slice(0, 10)))
      .toEqual(['question-2', 'question-3', 'question-4', 'question-5']);
    expect(enriched).toEqual(textOnly);
    expect(enriched.filter(message => Array.isArray(message.toolCalls))).toHaveLength(0);
    expect(enriched.filter(message => message.role === 'tool')).toHaveLength(0);
  });

  it('drops optional recent tool rows before textual turns at the message cap', () => {
    const messages = [];
    for (let turn = 1; turn <= 20; turn += 1) {
      const toolCalls = turn >= 18
        ? Array.from({ length: 100 }, (_, index) => ({
            id: `call-${turn}-${index}`,
            name: 'Inspect',
            input: { turn, index },
          }))
        : [];
      messages.push(
        { role: 'user', content: `question-${turn}` },
        { role: 'assistant', content: `answer-${turn}`, ...(toolCalls.length > 0 ? { toolCalls } : {}) },
        ...toolCalls.map(call => ({
          role: 'tool',
          toolCallId: call.id,
          content: `result-${call.id}`,
        })),
      );
    }

    const window = trimSnapshotForBudget(messages, {
      recentTurnCap: 20,
      maxMessageCount: 256,
      messageTokenBudget: 100_000,
    });

    expect(window.filter(message => message.role === 'user')).toHaveLength(20);
    expect(window[0]).toEqual({ role: 'user', content: 'question-1' });
    expect(window).toHaveLength(256);
    expect(window.filter(message => message.role === 'tool')).toHaveLength(216);
    expect(window.filter(message => Array.isArray(message.toolCalls))
      .reduce((total, message) => total + message.toolCalls.length, 0)).toBe(216);
    expect(hasOrphanPairs(window)).toBe(false);
  });

  it('keeps function calls only for the default three most recent turns', () => {
    const messages = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      const callId = `call-${turn}`;
      messages.push(
        { role: 'user', content: `question-${turn}` },
        {
          role: 'assistant',
          content: `answer-${turn}`,
          toolCalls: [{ id: callId, name: 'Inspect', input: { turn } }],
        },
        { role: 'tool', toolCallId: callId, content: `result-${turn}` },
      );
    }

    const window = trimSnapshotForBudget(messages, { messageTokenBudget: 10_000 });

    expect(window.filter(message => Array.isArray(message.toolCalls)).map(message => message.toolCalls[0].id))
      .toEqual(['call-3', 'call-4', 'call-5']);
    expect(window.filter(message => message.role === 'tool').map(message => message.toolCallId))
      .toEqual(['call-3', 'call-4', 'call-5']);
  });
});
