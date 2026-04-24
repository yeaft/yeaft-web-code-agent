/**
 * Static source analysis tests for Unify history loading (task-272).
 *
 * Verifies the full-stack pipeline:
 *   Agent (web-bridge.js) → message-router.js → server (client-conversation.js) → frontend (chat.js)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');

const webBridge = readFileSync(join(root, 'agent/unify/web-bridge.js'), 'utf8');
const messageRouter = readFileSync(join(root, 'agent/connection/message-router.js'), 'utf8');
const clientConv = readFileSync(join(root, 'server/handlers/client-conversation.js'), 'utf8');
const chatStore = readFileSync(join(root, 'web/stores/chat.js'), 'utf8');

describe('Unify History Loading — Agent (web-bridge.js)', () => {
  it('exports handleUnifyLoadHistory function', () => {
    expect(webBridge).toContain('export async function handleUnifyLoadHistory');
  });

  it('calls session.conversationStore.loadRecent()', () => {
    expect(webBridge).toContain('conversationStore.loadRecent');
  });

  it('calls session.conversationStore.readCompactSummary()', () => {
    expect(webBridge).toContain('conversationStore.readCompactSummary');
  });

  it('sends history messages via sendUnifyOutput (data path)', () => {
    // Must use sendUnifyOutput for history messages so they go through handleClaudeOutput
    const fnBody = webBridge.slice(webBridge.indexOf('async function handleUnifyLoadHistory'));
    expect(fnBody).toContain('sendUnifyOutput');
  });

  it('sends history_loaded event via sendUnifyEvent', () => {
    const fnBody = webBridge.slice(webBridge.indexOf('async function handleUnifyLoadHistory'));
    expect(fnBody).toContain("type: 'history_loaded'");
  });

  it('includes count, hasCompactSummary, totalHot, totalCold in history_loaded event', () => {
    expect(webBridge).toContain('count: messages.length');
    expect(webBridge).toContain('hasCompactSummary:');
    expect(webBridge).toContain('totalHot:');
    expect(webBridge).toContain('totalCold:');
  });

  it('restores per-thread history from ConversationStore on session init in handleUnifyChat (task-320)', () => {
    // The lazy-init block in handleUnifyChat should restore messagesByThread.
    // task-fix (three-bugs): the inline restore loop was refactored into
    // `restoreThreadHistoryFromRecent(recent)` so tool messages + toolCalls
    // survive the restore. The helper still calls conversationStore.loadRecent
    // and still clears + populates messagesByThread.
    const chatFn = webBridge.slice(webBridge.indexOf('async function handleUnifyChat'));
    const initBlock = chatFn.slice(0, chatFn.indexOf('Per-call AbortController'));
    expect(initBlock).toContain('conversationStore.loadRecent');
    expect(initBlock).toContain('restoreThreadHistoryFromRecent');
    // The helper itself must call the expected primitives.
    expect(webBridge).toContain('messagesByThread.clear()');
    expect(webBridge).toContain('getThreadMessages(');
  });

  it('filters to user/assistant/tool roles when restoring per-thread history', () => {
    // task-fix (three-bugs): tool role is now retained so paired
    // tool_call_id messages reach the next turn.
    expect(webBridge).toContain("m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool'");
  });

  it('sends user messages with message wrapper for handleClaudeOutput compatibility', () => {
    const fnBody = webBridge.slice(webBridge.indexOf('async function handleUnifyLoadHistory'));
    expect(fnBody).toContain("sendUnifyOutput({ type: 'user', message: { content: m.content } })");
  });

  it('sends assistant messages with text block format', () => {
    const fnBody = webBridge.slice(webBridge.indexOf('async function handleUnifyLoadHistory'));
    expect(fnBody).toContain("type: 'assistant'");
    expect(fnBody).toContain("type: 'text', text: m.content");
  });

  it('sends result after each assistant message to close the turn', () => {
    const fnBody = webBridge.slice(webBridge.indexOf('async function handleUnifyLoadHistory'));
    expect(fnBody).toContain("sendUnifyOutput({ type: 'result', result_text: '' })");
  });
});

describe('Unify History Loading — Message Router', () => {
  it('imports handleUnifyLoadHistory', () => {
    expect(messageRouter).toContain('handleUnifyLoadHistory');
  });

  it('has unify_load_history case', () => {
    expect(messageRouter).toContain("case 'unify_load_history':");
  });

  it('calls handleUnifyLoadHistory with msg', () => {
    expect(messageRouter).toContain('await handleUnifyLoadHistory(msg)');
  });
});

describe('Unify History Loading — Server (client-conversation.js)', () => {
  it('has unify_load_history case', () => {
    expect(clientConv).toContain("case 'unify_load_history':");
  });

  it('forwards to agent with type unify_load_history', () => {
    const idx = clientConv.indexOf("case 'unify_load_history':");
    const nextCase = clientConv.indexOf("case '", idx + 1);
    const block = clientConv.slice(idx, nextCase > 0 ? nextCase : idx + 500);
    expect(block).toContain('forwardToAgent');
    expect(block).toContain("type: 'unify_load_history'");
  });

  it('checks agent access before forwarding', () => {
    const idx = clientConv.indexOf("case 'unify_load_history':");
    const nextCase = clientConv.indexOf("case '", idx + 1);
    const block = clientConv.slice(idx, nextCase > 0 ? nextCase : idx + 500);
    expect(block).toContain('checkAgentAccess');
  });

  it('forwards limit parameter', () => {
    const idx = clientConv.indexOf("case 'unify_load_history':");
    const nextCase = clientConv.indexOf("case '", idx + 1);
    const block = clientConv.slice(idx, nextCase > 0 ? nextCase : idx + 500);
    expect(block).toContain('limit: msg.limit');
  });
});

describe('Unify History Loading — Frontend (chat.js)', () => {
  it('enterUnify sends unify_load_history request', () => {
    const idx = chatStore.indexOf('enterUnify(');
    const endIdx = chatStore.indexOf('leaveUnify()', idx);
    const block = chatStore.slice(idx, endIdx);
    expect(block).toContain("type: 'unify_load_history'");
  });

  it('only sends history request when messagesMap is empty (prevents duplicates)', () => {
    const idx = chatStore.indexOf('enterUnify(');
    const endIdx = chatStore.indexOf('leaveUnify()', idx);
    const block = chatStore.slice(idx, endIdx);
    expect(block).toContain('existing.length === 0');
  });

  it('handles history_loaded event in handleUnifyOutput', () => {
    expect(chatStore).toContain("case 'history_loaded':");
  });
});
