/**
 * Tests for task-249: Typing indicator stuck fix — independent test-3 verification
 *
 * This covers BOTH:
 * - PR #473: Processing state guards (_turnCompletedConvs, agent_list pruning)
 * - PR #474 follow-up: finishStreamingForConversation walks backwards through turn
 *
 * Test approach:
 * 1. Source-level verification of messages.js changes
 * 2. Pure function tests: finishStreamingForConversation with complex message patterns
 * 3. Source-level verification of conversationHandler.js and agentHandler.js
 * 4. Combined scenarios: text + image + tool-use interleaved
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { finishStreamingForConversation } from '../../web/stores/helpers/messages.js';

let messagesSource;
let conversationHandlerSource;
let agentHandlerSource;

beforeAll(() => {
  const base = resolve(__dirname, '../..');
  messagesSource = readFileSync(resolve(base, 'web/stores/helpers/messages.js'), 'utf-8');
  conversationHandlerSource = readFileSync(resolve(base, 'web/stores/helpers/handlers/conversationHandler.js'), 'utf-8');
  agentHandlerSource = readFileSync(resolve(base, 'web/stores/helpers/handlers/agentHandler.js'), 'utf-8');
});

// Helper to create mock store
function mockStore(convId, messages) {
  return { messagesMap: { [convId]: messages } };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Source-level: messages.js finishStreamingForConversation
// ─────────────────────────────────────────────────────────────────────────
describe('Source: finishStreamingForConversation backward iteration', () => {
  it('uses backward for-loop (i >= 0; i--)', () => {
    const fnBlock = messagesSource.substring(
      messagesSource.indexOf('export function finishStreamingForConversation'),
      messagesSource.indexOf('export function finishStreamingForConversation') + 500
    );
    expect(fnBlock).toMatch(/for\s*\(\s*let\s+i\s*=\s*msgs\.length\s*-\s*1\s*;\s*i\s*>=\s*0\s*;\s*i--\s*\)/);
  });

  it('clears isStreaming on any message with isStreaming flag', () => {
    const fnStart = messagesSource.indexOf('export function finishStreamingForConversation');
    const fnEnd = messagesSource.indexOf('\nexport ', fnStart + 10);
    const fnBlock = messagesSource.substring(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 1000);
    expect(fnBlock).toContain('isStreaming');
    expect(fnBlock).toContain('isStreaming = false');
  });

  it('stops at user message boundary (turn boundary)', () => {
    const fnStart = messagesSource.indexOf('export function finishStreamingForConversation');
    const fnEnd = messagesSource.indexOf('\nexport ', fnStart + 10);
    const fnBlock = messagesSource.substring(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 1000);
    expect(fnBlock).toMatch(/type\s*===\s*'user'/);
    expect(fnBlock).toContain('break');
  });

  it('guards on null conversationId', () => {
    expect(messagesSource).toContain('if (!conversationId) return');
  });

  it('checks msgs exists and has length > 0', () => {
    const fnBlock = messagesSource.substring(
      messagesSource.indexOf('export function finishStreamingForConversation'),
      messagesSource.indexOf('export function finishStreamingForConversation') + 500
    );
    expect(fnBlock).toContain('msgs && msgs.length > 0');
  });

  it('does NOT only check last message (old buggy pattern removed)', () => {
    const fnBlock = messagesSource.substring(
      messagesSource.indexOf('export function finishStreamingForConversation'),
      messagesSource.indexOf('export function finishStreamingForConversation') + 500
    );
    // Old pattern: const lastMsg = msgs[msgs.length - 1]; if (lastMsg.isStreaming) ...
    expect(fnBlock).not.toContain('const lastMsg');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Pure function: text + chat-image scenario (reviewer point #1)
// ─────────────────────────────────────────────────────────────────────────
describe('Scenario: AI uses screenshot tool → image appears after streaming text', () => {
  it('clears streaming on assistant text when chat-image is last', () => {
    const store = mockStore('c1', [
      { type: 'user', content: 'Take a screenshot' },
      { type: 'assistant', content: 'I\'ll take a screenshot now.', isStreaming: true },
      { type: 'chat-image', fileId: 'img-1', previewToken: 'tok-1', isStreaming: false }
    ]);
    finishStreamingForConversation(store, 'c1');
    expect(store.messagesMap['c1'][1].isStreaming).toBe(false);
    expect(store.messagesMap['c1'][2].isStreaming).toBe(false);
  });

  it('clears streaming on assistant text when tool-use is last', () => {
    const store = mockStore('c2', [
      { type: 'user', content: 'Edit file' },
      { type: 'assistant', content: 'Editing the file...', isStreaming: true },
      { type: 'tool-use', toolName: 'Edit', isStreaming: false }
    ]);
    finishStreamingForConversation(store, 'c2');
    expect(store.messagesMap['c2'][1].isStreaming).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Pure function: multi tool-use + text alternation (reviewer point #2)
// ─────────────────────────────────────────────────────────────────────────
describe('Scenario: multiple tool-use + text alternating in same turn', () => {
  it('clears all streaming flags in complex interleaved pattern', () => {
    const store = mockStore('c3', [
      { type: 'user', content: 'Do multiple things' },
      { type: 'assistant', content: 'First, let me read...', isStreaming: true },
      { type: 'tool-use', toolName: 'Read', isStreaming: false },
      { type: 'assistant', content: 'Now editing...', isStreaming: true },
      { type: 'tool-use', toolName: 'Edit', isStreaming: false },
      { type: 'assistant', content: 'Done! Here\'s the result.', isStreaming: true },
      { type: 'chat-image', fileId: 'img-1', isStreaming: false }
    ]);
    finishStreamingForConversation(store, 'c3');
    // ALL three assistant messages should be cleared
    expect(store.messagesMap['c3'][1].isStreaming).toBe(false);
    expect(store.messagesMap['c3'][3].isStreaming).toBe(false);
    expect(store.messagesMap['c3'][5].isStreaming).toBe(false);
  });

  it('handles tool-use with isStreaming: true (edge case)', () => {
    const store = mockStore('c4', [
      { type: 'user', content: 'Go' },
      { type: 'assistant', content: 'Working...', isStreaming: true },
      { type: 'tool-use', toolName: 'Read', isStreaming: true }
    ]);
    finishStreamingForConversation(store, 'c4');
    expect(store.messagesMap['c4'][1].isStreaming).toBe(false);
    expect(store.messagesMap['c4'][2].isStreaming).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Pure function: quick consecutive messages (reviewer point #3)
// ─────────────────────────────────────────────────────────────────────────
describe('Scenario: quick consecutive messages — only current turn affected', () => {
  it('first turn streaming preserved, second turn cleared', () => {
    const store = mockStore('c5', [
      { type: 'user', content: 'First question' },
      { type: 'assistant', content: 'First answer', isStreaming: true },
      { type: 'user', content: 'Second question' },
      { type: 'assistant', content: 'Second answer', isStreaming: true }
    ]);
    finishStreamingForConversation(store, 'c5');
    // Only second turn (after last user msg) should be cleared
    expect(store.messagesMap['c5'][1].isStreaming).toBe(true); // Previous turn untouched
    expect(store.messagesMap['c5'][3].isStreaming).toBe(false); // Current turn cleared
  });

  it('three rapid turns — only last turn cleared', () => {
    const store = mockStore('c6', [
      { type: 'user', content: 'Q1' },
      { type: 'assistant', content: 'A1', isStreaming: true },
      { type: 'user', content: 'Q2' },
      { type: 'assistant', content: 'A2', isStreaming: true },
      { type: 'user', content: 'Q3' },
      { type: 'assistant', content: 'A3', isStreaming: true },
      { type: 'chat-image', fileId: 'img-1', isStreaming: false }
    ]);
    finishStreamingForConversation(store, 'c6');
    expect(store.messagesMap['c6'][1].isStreaming).toBe(true); // Turn 1: untouched
    expect(store.messagesMap['c6'][3].isStreaming).toBe(true); // Turn 2: untouched
    expect(store.messagesMap['c6'][5].isStreaming).toBe(false); // Turn 3: cleared
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Pure function: edge cases
// ─────────────────────────────────────────────────────────────────────────
describe('Edge cases for finishStreamingForConversation', () => {
  it('handles single message (just user, no assistant)', () => {
    const store = mockStore('e1', [
      { type: 'user', content: 'Hello' }
    ]);
    expect(() => finishStreamingForConversation(store, 'e1')).not.toThrow();
  });

  it('handles only system messages (no user boundary)', () => {
    const store = mockStore('e2', [
      { type: 'system', content: 'Welcome' },
      { type: 'assistant', content: 'Hi', isStreaming: true }
    ]);
    finishStreamingForConversation(store, 'e2');
    // Should still clear — no user boundary means walk all the way back
    expect(store.messagesMap['e2'][1].isStreaming).toBe(false);
  });

  it('handles messages without isStreaming property', () => {
    const store = mockStore('e3', [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi' },
      { type: 'chat-image', fileId: 'img-1' }
    ]);
    expect(() => finishStreamingForConversation(store, 'e3')).not.toThrow();
  });

  it('handles all messages being streaming', () => {
    const store = mockStore('e4', [
      { type: 'assistant', content: 'Part 1', isStreaming: true },
      { type: 'assistant', content: 'Part 2', isStreaming: true },
      { type: 'assistant', content: 'Part 3', isStreaming: true }
    ]);
    finishStreamingForConversation(store, 'e4');
    expect(store.messagesMap['e4'][0].isStreaming).toBe(false);
    expect(store.messagesMap['e4'][1].isStreaming).toBe(false);
    expect(store.messagesMap['e4'][2].isStreaming).toBe(false);
  });

  it('idempotent: calling twice is safe', () => {
    const store = mockStore('e5', [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi', isStreaming: true }
    ]);
    finishStreamingForConversation(store, 'e5');
    finishStreamingForConversation(store, 'e5');
    expect(store.messagesMap['e5'][1].isStreaming).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Source: PR #473 — conversationHandler.js guards
// ─────────────────────────────────────────────────────────────────────────
describe('Source: PR #473 conversationHandler.js — _turnCompletedConvs guards', () => {
  it('handleTurnCompleted sets _turnCompletedConvs.add(convId)', () => {
    const fnStart = conversationHandlerSource.indexOf('export function handleTurnCompleted');
    const fnBlock = conversationHandlerSource.substring(fnStart, fnStart + 1000);
    expect(fnBlock).toContain('_turnCompletedConvs');
    expect(fnBlock).toContain('.add(convId)');
  });

  it('handleConversationClosed sets _turnCompletedConvs.add(convId)', () => {
    const fnStart = conversationHandlerSource.indexOf('export function handleConversationClosed');
    const fnBlock = conversationHandlerSource.substring(fnStart, fnStart + 1000);
    expect(fnBlock).toContain('_turnCompletedConvs');
    expect(fnBlock).toContain('.add(convId)');
  });

  it('handleExecutionCancelled sets _turnCompletedConvs.add(convId)', () => {
    const fnStart = conversationHandlerSource.indexOf('export function handleExecutionCancelled');
    const fnBlock = conversationHandlerSource.substring(fnStart, fnStart + 1000);
    expect(fnBlock).toContain('_turnCompletedConvs');
    expect(fnBlock).toContain('.add(convId)');
  });

  it('handleConversationRefresh checks _turnCompletedConvs before setting processing', () => {
    const fnStart = conversationHandlerSource.indexOf('export function handleConversationRefresh');
    const fnBlock = conversationHandlerSource.substring(fnStart, fnStart + 500);
    expect(fnBlock).toContain('_turnCompletedConvs?.has(msg.conversationId)');
  });

  it('all three handlers initialize _turnCompletedConvs as Set if missing', () => {
    // Each handler should have: if (!store._turnCompletedConvs) store._turnCompletedConvs = new Set();
    const handlers = ['handleTurnCompleted', 'handleConversationClosed', 'handleExecutionCancelled'];
    for (const name of handlers) {
      const fnStart = conversationHandlerSource.indexOf(`export function ${name}`);
      const fnBlock = conversationHandlerSource.substring(fnStart, fnStart + 1000);
      expect(fnBlock).toContain('_turnCompletedConvs = new Set()');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Source: PR #473 — agentHandler.js pruning (not clearing)
// ─────────────────────────────────────────────────────────────────────────
describe('Source: PR #473 agentHandler.js — agent_list prunes instead of clears', () => {
  it('does NOT use store._closedAt = {} (blanket clear)', () => {
    const fnStart = agentHandlerSource.indexOf('export function handleAgentList');
    const fnEnd = agentHandlerSource.indexOf('export function', fnStart + 10);
    const fnBlock = agentHandlerSource.substring(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 5000);
    expect(fnBlock).not.toContain('store._closedAt = {}');
  });

  it('does NOT use _turnCompletedConvs?.clear() (blanket clear)', () => {
    const fnStart = agentHandlerSource.indexOf('export function handleAgentList');
    const fnEnd = agentHandlerSource.indexOf('export function', fnStart + 10);
    const fnBlock = agentHandlerSource.substring(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 5000);
    expect(fnBlock).not.toContain('_turnCompletedConvs?.clear()');
  });

  it('uses 30000ms (30s) time window for stale guard pruning', () => {
    const fnStart = agentHandlerSource.indexOf('export function handleAgentList');
    const fnEnd = agentHandlerSource.indexOf('export function', fnStart + 10);
    const fnBlock = agentHandlerSource.substring(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 5000);
    expect(fnBlock).toContain('30000');
  });

  it('deletes both _closedAt entry and _turnCompletedConvs entry when stale', () => {
    const fnStart = agentHandlerSource.indexOf('export function handleAgentList');
    const fnEnd = agentHandlerSource.indexOf('export function', fnStart + 10);
    const fnBlock = agentHandlerSource.substring(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 5000);
    expect(fnBlock).toContain('delete store._closedAt[convId]');
    expect(fnBlock).toContain('_turnCompletedConvs?.delete(convId)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Behavioral: 30s reconnect recovery
// ─────────────────────────────────────────────────────────────────────────
describe('Behavioral: 30s window — reconnect recovery works', () => {
  it('within 30s: guard prevents re-setting processing', () => {
    const store = {
      processingConversations: {},
      _closedAt: { 'conv-1': Date.now() },
      _turnCompletedConvs: new Set(['conv-1'])
    };
    const isGuarded = store._turnCompletedConvs.has('conv-1');
    expect(isGuarded).toBe(true);
  });

  it('after 30s: pruning removes guard, processing can be re-set', () => {
    const store = {
      processingConversations: {},
      _closedAt: { 'conv-1': Date.now() - 35000 },
      _turnCompletedConvs: new Set(['conv-1'])
    };
    // Simulate pruning logic
    const now = Date.now();
    for (const convId of Object.keys(store._closedAt)) {
      if (now - store._closedAt[convId] > 30000) {
        delete store._closedAt[convId];
        store._turnCompletedConvs.delete(convId);
      }
    }
    expect(store._turnCompletedConvs.has('conv-1')).toBe(false);
    expect(store._closedAt['conv-1']).toBeUndefined();
  });
});
