/**
 * task-223: AskUserQuestion expired state should NOT block user input.
 *
 * Tests:
 * 1. markAllToolsCompleted expires unanswered AskUserQuestion messages (source analysis + inline eval)
 * 2. Already-answered AskUserQuestion messages are NOT expired
 * 3. ChatInput textarea is never disabled by AskUserQuestion state
 * 4. cancelExecution calls markAllToolsCompleted to expire pending asks
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

// Load source for analysis
const conversationHandlerSrc = read('web/stores/helpers/handlers/conversationHandler.js');
const conversationSrc = read('web/stores/helpers/conversation.js');
const chatInputSrc = read('web/components/ChatInput.js');
const askCardSrc = read('web/components/AskCard.js');

/**
 * Extract and eval the markAllToolsCompleted function body for behavioral testing.
 * We avoid dynamic import because module depends on globals (Pinia, etc).
 */
function createMarkAllToolsCompleted() {
  // Extract function body from source
  const fnStart = conversationHandlerSrc.indexOf('export function markAllToolsCompleted(store, convId)');
  const openBrace = conversationHandlerSrc.indexOf('{', fnStart);
  let depth = 0;
  let fnEnd = openBrace;
  for (let i = openBrace; i < conversationHandlerSrc.length; i++) {
    if (conversationHandlerSrc[i] === '{') depth++;
    if (conversationHandlerSrc[i] === '}') depth--;
    if (depth === 0) { fnEnd = i + 1; break; }
  }
  const fnBody = conversationHandlerSrc.slice(openBrace + 1, fnEnd - 1);
  // eslint-disable-next-line no-new-func
  return new Function('store', 'convId', fnBody);
}

describe('markAllToolsCompleted expires AskUserQuestion', () => {
  const markAllToolsCompleted = createMarkAllToolsCompleted();

  it('expires unanswered AskUserQuestion tool-use messages', () => {
    const store = {
      messagesMap: {
        'conv-1': [
          { type: 'user', content: 'hello' },
          {
            type: 'tool-use',
            toolName: 'AskUserQuestion',
            askRequestId: 'req-123',
            askAnswered: false,
            selectedAnswers: null,
            hasResult: false,
            isHistory: false
          },
          { type: 'assistant', content: 'waiting...' }
        ]
      }
    };

    markAllToolsCompleted(store, 'conv-1');

    const askMsg = store.messagesMap['conv-1'][1];
    expect(askMsg.hasResult).toBe(true);
    expect(askMsg.isHistory).toBe(true);
    expect(askMsg.askRequestId).toBeNull();
  });

  it('does NOT expire already-answered AskUserQuestion messages', () => {
    const store = {
      messagesMap: {
        'conv-1': [
          {
            type: 'tool-use',
            toolName: 'AskUserQuestion',
            askRequestId: 'req-456',
            askAnswered: true,
            selectedAnswers: { q: 'answer' },
            hasResult: false,
            isHistory: false
          }
        ]
      }
    };

    markAllToolsCompleted(store, 'conv-1');

    const askMsg = store.messagesMap['conv-1'][0];
    expect(askMsg.hasResult).toBe(true);
    // Should NOT be expired because it was already answered
    expect(askMsg.isHistory).toBe(false);
    expect(askMsg.askRequestId).toBe('req-456');
  });

  it('does NOT expire AskUserQuestion with selectedAnswers', () => {
    const store = {
      messagesMap: {
        'conv-1': [
          {
            type: 'tool-use',
            toolName: 'AskUserQuestion',
            askRequestId: 'req-789',
            askAnswered: false,
            selectedAnswers: { q: 'choice' },
            hasResult: false,
            isHistory: false
          }
        ]
      }
    };

    markAllToolsCompleted(store, 'conv-1');

    const askMsg = store.messagesMap['conv-1'][0];
    expect(askMsg.hasResult).toBe(true);
    // Should NOT be expired because selectedAnswers exist
    expect(askMsg.askRequestId).toBe('req-789');
  });

  it('handles non-AskUserQuestion tool-use messages normally', () => {
    const store = {
      messagesMap: {
        'conv-1': [
          {
            type: 'tool-use',
            toolName: 'Read',
            hasResult: false,
            isHistory: false
          }
        ]
      }
    };

    markAllToolsCompleted(store, 'conv-1');

    const toolMsg = store.messagesMap['conv-1'][0];
    expect(toolMsg.hasResult).toBe(true);
    // isHistory should NOT be set for non-AskUserQuestion tools
    expect(toolMsg.isHistory).toBe(false);
  });

  it('handles empty or missing messagesMap gracefully', () => {
    const store = { messagesMap: {} };
    expect(() => markAllToolsCompleted(store, 'conv-missing')).not.toThrow();
  });

  it('only expires messages that have not yet completed (hasResult=false)', () => {
    const store = {
      messagesMap: {
        'conv-1': [
          {
            type: 'tool-use',
            toolName: 'AskUserQuestion',
            askRequestId: 'req-already-done',
            askAnswered: false,
            selectedAnswers: null,
            hasResult: true, // already completed
            isHistory: false
          }
        ]
      }
    };

    markAllToolsCompleted(store, 'conv-1');

    const askMsg = store.messagesMap['conv-1'][0];
    // Should be skipped because hasResult was already true
    expect(askMsg.isHistory).toBe(false);
    expect(askMsg.askRequestId).toBe('req-already-done');
  });
});

describe('cancelExecution calls markAllToolsCompleted', () => {
  it('conversation.js imports markAllToolsCompleted', () => {
    expect(conversationSrc).toContain("import { markAllToolsCompleted } from './handlers/conversationHandler.js'");
  });

  it('cancelExecution calls markAllToolsCompleted for immediate AskCard expiry', () => {
    const cancelBlock = conversationSrc.slice(
      conversationSrc.indexOf('export function cancelExecution(store)'),
      conversationSrc.indexOf('export function answerUserQuestion')
    );
    expect(cancelBlock).toContain('markAllToolsCompleted(store, convId)');
  });

  it('cancelExecutionForConversation also calls markAllToolsCompleted', () => {
    const cancelForBlock = conversationSrc.slice(
      conversationSrc.indexOf('export function cancelExecutionForConversation')
    );
    expect(cancelForBlock).toContain('markAllToolsCompleted(store, conversationId)');
  });
});

describe('ChatInput is independent of AskUserQuestion', () => {
  it('textarea disabled binding only depends on isCompacting', () => {
    expect(chatInputSrc).toContain(':disabled="isCompacting"');
    // Should NOT have any other disabled binding on textarea
    const textareaIdx = chatInputSrc.indexOf('<textarea');
    const textareaEnd = chatInputSrc.indexOf('></textarea>', textareaIdx);
    const textareaTag = chatInputSrc.slice(textareaIdx, textareaEnd);
    const disabledMatches = textareaTag.match(/:disabled="[^"]*"/g) || [];
    expect(disabledMatches).toHaveLength(1);
    expect(disabledMatches[0]).toBe(':disabled="isCompacting"');
  });

  it('canSend does not check isProcessing or askUserQuestion', () => {
    const canSendIdx = chatInputSrc.indexOf('const canSend = Vue.computed');
    const canSendBlock = chatInputSrc.slice(canSendIdx, chatInputSrc.indexOf('});', canSendIdx) + 3);
    expect(canSendBlock).not.toContain('isProcessing');
    expect(canSendBlock).not.toContain('askUserQuestion');
    expect(canSendBlock).not.toContain('askRequestId');
  });

  it('send() does not check for pending AskUserQuestion', () => {
    const sendIdx = chatInputSrc.indexOf('const send = () =>');
    const sendBlock = chatInputSrc.slice(sendIdx, chatInputSrc.indexOf('};', sendIdx + 100) + 2);
    expect(sendBlock).not.toContain('askUserQuestion');
    expect(sendBlock).not.toContain('askRequestId');
    expect(sendBlock).not.toContain('isProcessing');
  });
});

describe('AskCard isExpired computed', () => {
  it('isExpired requires isHistory=true, no requestId, not answered', () => {
    expect(askCardSrc).toContain('!ask.askRequestId && !ask.askAnswered && !ask.selectedAnswers && !!ask.isHistory');
  });

  it('expired card shows disabled options and expired hint', () => {
    expect(askCardSrc).toContain('v-else-if="isExpired"');
    expect(askCardSrc).toContain('ask-expired');
    expect(askCardSrc).toContain('ask-expired-hint');
  });

  it('markAllToolsCompleted sets exactly the fields AskCard.isExpired checks', () => {
    // isExpired checks: !askRequestId && !askAnswered && !selectedAnswers && isHistory
    // markAllToolsCompleted sets: isHistory = true, askRequestId = null
    // This should trigger isExpired for unanswered asks
    expect(conversationHandlerSrc).toContain('msg.isHistory = true');
    expect(conversationHandlerSrc).toContain('msg.askRequestId = null');
  });
});
