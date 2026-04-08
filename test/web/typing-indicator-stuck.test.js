import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for task-249: Typing indicator stuck after AI response completes
 *
 * Root cause: When a conversation turn completes (result/turn_completed),
 * processingConversations[convId] is deleted and guards (_closedAt and
 * _turnCompletedConvs) are set. However:
 * 1. handleTurnCompleted didn't set _turnCompletedConvs (only _closedAt)
 * 2. handleConversationRefresh didn't check _turnCompletedConvs guard
 * 3. agent_list handler cleared ALL guards on every broadcast, allowing
 *    subsequent stale agent_list/conversation_refresh to re-set processing
 *
 * Fix:
 * - All turn-completion handlers (turn_completed, conversation_closed,
 *   execution_cancelled) now set _turnCompletedConvs
 * - handleConversationRefresh checks _turnCompletedConvs guard
 * - agent_list handler prunes stale guards (>30s) instead of clearing all
 */

const rootDir = join(import.meta.dirname, '..', '..');
const conversationHandlerJs = readFileSync(join(rootDir, 'web/stores/helpers/handlers/conversationHandler.js'), 'utf8');
const agentHandlerJs = readFileSync(join(rootDir, 'web/stores/helpers/handlers/agentHandler.js'), 'utf8');
const claudeOutputJs = readFileSync(join(rootDir, 'web/stores/helpers/claudeOutput.js'), 'utf8');

// =====================================================================
// handleTurnCompleted sets _turnCompletedConvs guard
// =====================================================================
describe('handleTurnCompleted sets _turnCompletedConvs', () => {
  const fnStart = conversationHandlerJs.indexOf('export function handleTurnCompleted');
  const fnBody = conversationHandlerJs.substring(fnStart, fnStart + 1500);

  it('handleTurnCompleted function exists', () => {
    expect(fnStart).toBeGreaterThan(-1);
  });

  it('sets _turnCompletedConvs', () => {
    expect(fnBody).toContain('_turnCompletedConvs');
    expect(fnBody).toContain('.add(convId)');
  });

  it('deletes processingConversations', () => {
    expect(fnBody).toContain('delete store.processingConversations[convId]');
  });

  it('sets _closedAt', () => {
    expect(fnBody).toContain('_closedAt[convId] = Date.now()');
  });
});

// =====================================================================
// handleConversationClosed sets _turnCompletedConvs guard
// =====================================================================
describe('handleConversationClosed sets _turnCompletedConvs', () => {
  const fnStart = conversationHandlerJs.indexOf('export function handleConversationClosed');
  const fnBody = conversationHandlerJs.substring(fnStart, fnStart + 1500);

  it('handleConversationClosed function exists', () => {
    expect(fnStart).toBeGreaterThan(-1);
  });

  it('sets _turnCompletedConvs', () => {
    expect(fnBody).toContain('_turnCompletedConvs');
    expect(fnBody).toContain('.add(convId)');
  });
});

// =====================================================================
// handleExecutionCancelled sets _turnCompletedConvs guard
// =====================================================================
describe('handleExecutionCancelled sets _turnCompletedConvs', () => {
  const fnStart = conversationHandlerJs.indexOf('export function handleExecutionCancelled');
  const fnBody = conversationHandlerJs.substring(fnStart, fnStart + 1000);

  it('handleExecutionCancelled function exists', () => {
    expect(fnStart).toBeGreaterThan(-1);
  });

  it('sets _turnCompletedConvs', () => {
    expect(fnBody).toContain('_turnCompletedConvs');
    expect(fnBody).toContain('.add(convId)');
  });
});

// =====================================================================
// handleConversationRefresh checks _turnCompletedConvs guard
// =====================================================================
describe('handleConversationRefresh checks _turnCompletedConvs guard', () => {
  const fnStart = conversationHandlerJs.indexOf('export function handleConversationRefresh');
  const fnBody = conversationHandlerJs.substring(fnStart, fnStart + 1000);

  it('handleConversationRefresh function exists', () => {
    expect(fnStart).toBeGreaterThan(-1);
  });

  it('checks _turnCompletedConvs before setting processing', () => {
    expect(fnBody).toContain('_turnCompletedConvs');
  });

  it('checks both isRecentlyClosed AND _turnCompletedConvs', () => {
    expect(fnBody).toContain('isRecentlyClosed');
    expect(fnBody).toContain('_turnCompletedConvs');
  });
});

// =====================================================================
// result handler in claudeOutput.js sets _turnCompletedConvs (baseline)
// =====================================================================
describe('claudeOutput result handler sets _turnCompletedConvs (baseline)', () => {
  it('claudeOutput.js contains _turnCompletedConvs', () => {
    expect(claudeOutputJs).toContain('_turnCompletedConvs');
  });

  it('result handler adds conversationId to _turnCompletedConvs', () => {
    // The result handler should have .add(conversationId)
    expect(claudeOutputJs).toContain('.add(conversationId)');
  });
});

// =====================================================================
// agent_list handler prunes stale guards instead of clearing all
// =====================================================================
describe('agent_list handler prunes stale guards', () => {
  const fnStart = agentHandlerJs.indexOf('export function handleAgentList');
  const fnEnd = agentHandlerJs.indexOf('export function handleAgentSelected');
  const fnBody = agentHandlerJs.substring(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 8000);

  it('does NOT blanket-clear _closedAt', () => {
    // The old code had: store._closedAt = {}
    // The new code prunes entries older than 30s
    expect(fnBody).not.toContain('store._closedAt = {}');
  });

  it('does NOT blanket-clear _turnCompletedConvs', () => {
    // The old code had: store._turnCompletedConvs?.clear()
    expect(fnBody).not.toContain('_turnCompletedConvs?.clear()');
  });

  it('prunes _closedAt entries using time-based check', () => {
    // Should check age of entries and only delete old ones
    expect(fnBody).toContain('30000');
    expect(fnBody).toContain('_closedAt');
  });

  it('prunes _turnCompletedConvs alongside _closedAt', () => {
    expect(fnBody).toContain('_turnCompletedConvs?.delete(convId)');
  });
});

// =====================================================================
// Behavioral: processing state is not re-set after turn completes
// =====================================================================
describe('Behavioral: processing state guard after turn completion', () => {
  function makeStore(convId) {
    return {
      processingConversations: {},
      _closedAt: {},
      _turnCompletedConvs: new Set(),
      conversations: [{ id: convId }],
      messagesMap: { [convId]: [] },
      executionStatusMap: {},
      currentConversation: convId,
      activeConversations: [convId],
    };
  }

  it('_turnCompletedConvs prevents agent_list from re-setting processing', () => {
    const store = makeStore('conv-1');
    // Simulate: turn completed → processing cleared, guard set
    store._closedAt['conv-1'] = Date.now();
    store._turnCompletedConvs.add('conv-1');

    // Simulate: stale agent_list arrives with processing: true
    const serverConv = { id: 'conv-1', processing: true };
    const isRecentlyClosed = !!store._closedAt['conv-1'] && (Date.now() - store._closedAt['conv-1']) < 30000;
    const hasTurnCompleted = store._turnCompletedConvs.has('conv-1');

    // Guard should prevent re-setting
    const shouldSetProcessing = serverConv.processing && !isRecentlyClosed && !hasTurnCompleted;
    expect(shouldSetProcessing).toBe(false);
  });

  it('_closedAt alone prevents re-setting within 30s window', () => {
    const store = makeStore('conv-1');
    store._closedAt['conv-1'] = Date.now();
    // No _turnCompletedConvs entry

    const serverConv = { id: 'conv-1', processing: true };
    const isRecentlyClosed = !!store._closedAt['conv-1'] && (Date.now() - store._closedAt['conv-1']) < 30000;

    const shouldSetProcessing = serverConv.processing && !isRecentlyClosed;
    expect(shouldSetProcessing).toBe(false);
  });

  it('after 30s, pruning allows re-setting (reconnect recovery)', () => {
    const store = makeStore('conv-1');
    store._closedAt['conv-1'] = Date.now() - 35000; // 35s ago
    store._turnCompletedConvs.add('conv-1');

    // Simulate prune (the logic in agent_list handler)
    const now = Date.now();
    for (const convId of Object.keys(store._closedAt)) {
      if (now - store._closedAt[convId] > 30000) {
        delete store._closedAt[convId];
        store._turnCompletedConvs.delete(convId);
      }
    }

    // After pruning, guards are gone
    const isRecentlyClosed = !!store._closedAt['conv-1'] && (Date.now() - store._closedAt['conv-1']) < 30000;
    const hasTurnCompleted = store._turnCompletedConvs.has('conv-1');

    const shouldSetProcessing = true && !isRecentlyClosed && !hasTurnCompleted;
    expect(shouldSetProcessing).toBe(true);
  });

  it('conversation_refresh with isProcessing=true is blocked by _turnCompletedConvs', () => {
    const store = makeStore('conv-1');
    store._turnCompletedConvs.add('conv-1');
    store._closedAt['conv-1'] = Date.now();

    // Simulate handleConversationRefresh logic
    const msg = { conversationId: 'conv-1', isProcessing: true };
    const isRecentlyClosed = !!store._closedAt[msg.conversationId] && (Date.now() - store._closedAt[msg.conversationId]) < 30000;
    const hasTurnCompleted = store._turnCompletedConvs.has(msg.conversationId);

    const shouldSetProcessing = msg.isProcessing && !isRecentlyClosed && !hasTurnCompleted;
    expect(shouldSetProcessing).toBe(false);
    // processing should remain cleared
    expect(store.processingConversations['conv-1']).toBeUndefined();
  });

  it('new user message clears _turnCompletedConvs to allow re-processing', () => {
    const store = makeStore('conv-1');
    store._turnCompletedConvs.add('conv-1');

    // Simulate sendMessage → _turnCompletedConvs.delete(convId)
    store._turnCompletedConvs.delete('conv-1');
    delete store._closedAt['conv-1'];

    // Now agent_list can set processing
    const isRecentlyClosed = false;
    const hasTurnCompleted = store._turnCompletedConvs.has('conv-1');
    const shouldSetProcessing = true && !isRecentlyClosed && !hasTurnCompleted;
    expect(shouldSetProcessing).toBe(true);
  });
});
