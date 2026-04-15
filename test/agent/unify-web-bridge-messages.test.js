/**
 * Tests for task-269: Unify conversation history passing via web-bridge.
 *
 * Verifies that web-bridge.js:
 * 1. Maintains a conversationMessages array
 * 2. Passes it to engine.query() as the `messages` parameter
 * 3. Accumulates user+assistant messages after each query
 * 4. Clears conversationMessages on consolidation events
 * 5. Clears conversationMessages on session reset
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const WEB_BRIDGE_PATH = join(import.meta.dirname, '..', '..', 'agent', 'unify', 'web-bridge.js');

describe('web-bridge conversation history (code structure)', () => {
  let src;

  // Read the source once
  src = readFileSync(WEB_BRIDGE_PATH, 'utf8');

  it('declares conversationMessages module-level array', () => {
    expect(src).toContain('let conversationMessages = []');
  });

  it('passes conversationMessages to engine.query()', () => {
    // Should pass messages: conversationMessages in the query call
    expect(src).toContain('messages: conversationMessages');
  });

  it('collects assistant text from text_delta events', () => {
    // Should push text parts for later accumulation
    expect(src).toContain('assistantTextParts.push(event.text)');
  });

  it('appends user message to conversationMessages after query', () => {
    // After the query loop, should push user message with plain string content
    expect(src).toContain("conversationMessages.push({ role: 'user', content: prompt })");
  });

  it('appends assistant message with plain text content to conversationMessages after query', () => {
    // After the query loop, should push plain string content (not content-block array)
    expect(src).toContain("conversationMessages.push({ role: 'assistant', content: fullText })");
  });

  it('builds fullText from collected text parts', () => {
    // Should join text parts into full text
    expect(src).toContain('assistantTextParts.join');
  });

  it('only appends assistant message when fullText is non-empty', () => {
    // Should check fullText before pushing
    expect(src).toContain('if (fullText)');
  });

  it('clears conversationMessages on consolidation event', () => {
    // The consolidate case should reset the array
    const consolidateSection = src.slice(
      src.indexOf("case 'consolidate':"),
      src.indexOf("case 'consolidate':") + 300
    );
    expect(consolidateSection).toContain('conversationMessages = []');
  });

  it('clears conversationMessages on session reset', () => {
    // resetUnifySession should clear the array
    const resetSection = src.slice(
      src.indexOf('async function resetUnifySession'),
      src.indexOf('async function resetUnifySession') + 500
    );
    expect(resetSection).toContain('conversationMessages = []');
  });

  it('does NOT collect tool_use blocks into conversationMessages (regression guard)', () => {
    // After the fix, web-bridge should NOT accumulate tool_use blocks.
    // Engine manages intra-query tool loops internally.
    expect(src).not.toContain('assistantToolUseBlocks');
  });

  it('stores assistant content as plain string, not content-block array', () => {
    // Must NOT use assistantContent array format — engine expects content: 'string'
    expect(src).not.toContain("assistantContent.push({ type: 'text'");
    expect(src).not.toContain("content: assistantContent");
  });
});

describe('engine.query() messages parameter', () => {
  let engineSrc;

  engineSrc = readFileSync(
    join(import.meta.dirname, '..', '..', 'agent', 'unify', 'engine.js'),
    'utf8'
  );

  it('engine.query() accepts messages parameter with default empty array', () => {
    // Signature: async *query({ prompt, mode = 'chat', messages = [], signal })
    expect(engineSrc).toMatch(/async\s+\*query\(\{\s*prompt[\s\S]*?messages\s*=\s*\[\]/);
  });

  it('engine spreads messages into conversationMessages', () => {
    // Should use: [...messages, { role: 'user', content: prompt }]
    expect(engineSrc).toContain('...messages');
  });
});
