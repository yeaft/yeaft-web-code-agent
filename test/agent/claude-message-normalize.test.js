import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Query } from '../../agent/sdk/query.js';
import {
  normalizeAssistantContent,
  normalizeClaudeMessage,
  shouldForwardTextDeltaForBlockType,
} from '../../agent/sdk/message-normalize.js';

function assistantWith(blocks) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: blocks,
    },
  };
}

describe('Claude Code message normalization', () => {
  it('keeps normal text and tool_use blocks unchanged', () => {
    const tool = { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } };
    const content = [{ type: 'text', text: 'Checking.' }, tool];

    const normalized = normalizeAssistantContent(content);

    expect(normalized).toEqual(content);
    expect(normalized[1]).toBe(tool);
  });

  it('normalizes new call-shaped assistant blocks into tool_use blocks', () => {
    const msg = assistantWith([
      { type: 'text', text: 'Checking git state.' },
      {
        type: 'call',
        call_id: 'bnjbapmna',
        name: 'Bash',
        arguments: JSON.stringify({
          command: 'git branch --show-current',
          description: 'Check git branch',
        }),
      },
    ]);

    expect(normalizeClaudeMessage(msg).message.content).toEqual([
      { type: 'text', text: 'Checking git state.' },
      {
        type: 'tool_use',
        id: 'bnjbapmna',
        name: 'Bash',
        input: {
          command: 'git branch --show-current',
          description: 'Check git branch',
        },
      },
    ]);
  });

  it('normalizes function_call-shaped blocks and preserves raw unparseable arguments', () => {
    const normalized = normalizeAssistantContent([
      {
        type: 'function_call',
        call_id: 'call-1',
        function: { name: 'Bash', arguments: '{not-json' },
      },
    ]);

    expect(normalized).toEqual([
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'Bash',
        input: { arguments: '{not-json' },
      },
    ]);
  });

  it('uses a stable fallback id when a tool-like block has no id', () => {
    const first = normalizeAssistantContent([
      { type: 'call', name: 'Bash', input: { nested: { b: 2, a: 1 } } },
    ])[0];
    const second = normalizeAssistantContent([
      { name: 'Bash', input: { nested: { a: 1, b: 2 } }, type: 'call' },
    ])[0];

    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^Bash-/);
  });

  it('only forwards stream text deltas from real text blocks', () => {
    expect(shouldForwardTextDeltaForBlockType('text')).toBe(true);
    expect(shouldForwardTextDeltaForBlockType(undefined)).toBe(true);
    expect(shouldForwardTextDeltaForBlockType('tool_use')).toBe(false);
    expect(shouldForwardTextDeltaForBlockType('call')).toBe(false);
    expect(shouldForwardTextDeltaForBlockType('function_call')).toBe(false);
  });

  it('does not stream raw call/id/argument deltas as assistant text', async () => {
    const stdout = new PassThrough();
    const query = new Query(null, stdout, Promise.resolve(), null);
    const seen = [];
    const reader = (async () => {
      for await (const msg of query) seen.push(msg);
    })();

    for (const event of [
      { type: 'content_block_start', index: 0, content_block: { type: 'call' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'call' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\\nbnjbapmna' } },
      { type: 'content_block_stop', index: 0 },
    ]) {
      stdout.write(JSON.stringify({ type: 'stream_event', event }) + '\n');
    }
    stdout.write(JSON.stringify(assistantWith([
      { type: 'call', call_id: 'bnjbapmna', name: 'Bash', arguments: '{"command":"git status"}' },
    ])) + '\n');
    stdout.end();
    await reader;

    expect(seen).toEqual([
      assistantWith([
        { type: 'tool_use', id: 'bnjbapmna', name: 'Bash', input: { command: 'git status' } },
      ]),
    ]);
  });
});
