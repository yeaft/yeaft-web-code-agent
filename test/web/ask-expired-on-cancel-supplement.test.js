/**
 * task-223 supplementary tests: edge cases for AskUserQuestion expiry on Stop/cancel.
 *
 * Supplements the dev-submitted ask-expired-on-cancel.test.js with:
 * 1. Multiple AskUserQuestion in same conversation (mixed answered/unanswered)
 * 2. isExpired computation truth table
 * 3. markAllToolsCompleted ordering — called after finishStreaming
 * 4. Non-AskUserQuestion tool-use types remain unaffected
 * 5. Conversation with only non-tool messages
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

const conversationHandlerSrc = read('web/stores/helpers/handlers/conversationHandler.js');
const conversationSrc = read('web/stores/helpers/conversation.js');
const askCardSrc = read('web/components/AskCard.js');

/**
 * Extract markAllToolsCompleted function for behavioral testing (same approach as dev tests).
 */
function createMarkAllToolsCompleted() {
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
  return new Function('store', 'convId', fnBody);
}

const markAllToolsCompleted = createMarkAllToolsCompleted();

// =============================================================================
// 1. Mixed AskUserQuestion messages — answered + unanswered in same conversation
// =============================================================================
describe('task-223 supplement: mixed Ask messages in same conversation', () => {
  it('expires only the unanswered Ask, leaves answered Ask intact', () => {
    const store = {
      messagesMap: {
        'conv-1': [
          {
            type: 'tool-use',
            toolName: 'AskUserQuestion',
            askRequestId: 'req-answered',
            askAnswered: true,
            selectedAnswers: { q: 'yes' },
            hasResult: false,
            isHistory: false
          },
          {
            type: 'tool-use',
            toolName: 'AskUserQuestion',
            askRequestId: 'req-pending',
            askAnswered: false,
            selectedAnswers: null,
            hasResult: false,
            isHistory: false
          }
        ]
      }
    };

    markAllToolsCompleted(store, 'conv-1');

    const answered = store.messagesMap['conv-1'][0];
    const pending = store.messagesMap['conv-1'][1];

    // Answered Ask: hasResult=true but NOT expired
    expect(answered.hasResult).toBe(true);
    expect(answered.isHistory).toBe(false);
    expect(answered.askRequestId).toBe('req-answered');

    // Pending Ask: hasResult=true AND expired
    expect(pending.hasResult).toBe(true);
    expect(pending.isHistory).toBe(true);
    expect(pending.askRequestId).toBeNull();
  });

  it('handles interleaved Ask and regular tool-use messages', () => {
    const store = {
      messagesMap: {
        'conv-1': [
          { type: 'tool-use', toolName: 'Read', hasResult: false, isHistory: false },
          {
            type: 'tool-use', toolName: 'AskUserQuestion',
            askRequestId: 'req-1', askAnswered: false, selectedAnswers: null,
            hasResult: false, isHistory: false
          },
          { type: 'tool-use', toolName: 'Edit', hasResult: false, isHistory: false },
          {
            type: 'tool-use', toolName: 'AskUserQuestion',
            askRequestId: 'req-2', askAnswered: true, selectedAnswers: { q: 'a' },
            hasResult: false, isHistory: false
          },
          { type: 'tool-use', toolName: 'Bash', hasResult: true, isHistory: false }
        ]
      }
    };

    markAllToolsCompleted(store, 'conv-1');

    const msgs = store.messagesMap['conv-1'];

    // Read: completed but not expired
    expect(msgs[0].hasResult).toBe(true);
    expect(msgs[0].isHistory).toBe(false);

    // Ask (unanswered): expired
    expect(msgs[1].hasResult).toBe(true);
    expect(msgs[1].isHistory).toBe(true);
    expect(msgs[1].askRequestId).toBeNull();

    // Edit: completed but not expired
    expect(msgs[2].hasResult).toBe(true);
    expect(msgs[2].isHistory).toBe(false);

    // Ask (answered): NOT expired
    expect(msgs[3].hasResult).toBe(true);
    expect(msgs[3].isHistory).toBe(false);
    expect(msgs[3].askRequestId).toBe('req-2');

    // Bash: already had hasResult=true, unchanged
    expect(msgs[4].hasResult).toBe(true);
    expect(msgs[4].isHistory).toBe(false);
  });

  it('multiple unanswered Asks all get expired', () => {
    const store = {
      messagesMap: {
        'conv-1': [
          {
            type: 'tool-use', toolName: 'AskUserQuestion',
            askRequestId: 'req-a', askAnswered: false, selectedAnswers: null,
            hasResult: false, isHistory: false
          },
          {
            type: 'tool-use', toolName: 'AskUserQuestion',
            askRequestId: 'req-b', askAnswered: false, selectedAnswers: null,
            hasResult: false, isHistory: false
          },
          {
            type: 'tool-use', toolName: 'AskUserQuestion',
            askRequestId: 'req-c', askAnswered: false, selectedAnswers: null,
            hasResult: false, isHistory: false
          }
        ]
      }
    };

    markAllToolsCompleted(store, 'conv-1');

    for (const msg of store.messagesMap['conv-1']) {
      expect(msg.hasResult).toBe(true);
      expect(msg.isHistory).toBe(true);
      expect(msg.askRequestId).toBeNull();
    }
  });
});

// =============================================================================
// 2. isExpired truth table — verify AskCard.isExpired logic
// =============================================================================
describe('task-223 supplement: isExpired truth table', () => {
  // isExpired = !askRequestId && !askAnswered && !selectedAnswers && !!isHistory
  function isExpired(msg) {
    return !msg.askRequestId && !msg.askAnswered && !msg.selectedAnswers && !!msg.isHistory;
  }

  it('isExpired = true: no requestId, not answered, no selections, has history', () => {
    expect(isExpired({ askRequestId: null, askAnswered: false, selectedAnswers: null, isHistory: true })).toBe(true);
  });

  it('isExpired = false: has requestId (still active)', () => {
    expect(isExpired({ askRequestId: 'req-1', askAnswered: false, selectedAnswers: null, isHistory: true })).toBe(false);
  });

  it('isExpired = false: askAnswered=true', () => {
    expect(isExpired({ askRequestId: null, askAnswered: true, selectedAnswers: null, isHistory: true })).toBe(false);
  });

  it('isExpired = false: has selectedAnswers', () => {
    expect(isExpired({ askRequestId: null, askAnswered: false, selectedAnswers: { q: 'a' }, isHistory: true })).toBe(false);
  });

  it('isExpired = false: isHistory=false (fresh, not yet from history)', () => {
    expect(isExpired({ askRequestId: null, askAnswered: false, selectedAnswers: null, isHistory: false })).toBe(false);
  });

  it('isExpired = false: undefined isHistory (fresh card)', () => {
    expect(isExpired({ askRequestId: null, askAnswered: false, selectedAnswers: null, isHistory: undefined })).toBe(false);
  });

  it('after markAllToolsCompleted, unanswered Ask matches isExpired=true', () => {
    const msg = {
      type: 'tool-use', toolName: 'AskUserQuestion',
      askRequestId: 'req-x', askAnswered: false, selectedAnswers: null,
      hasResult: false, isHistory: false
    };
    const store = { messagesMap: { 'c1': [msg] } };
    markAllToolsCompleted(store, 'c1');
    expect(isExpired(msg)).toBe(true);
  });

  it('after markAllToolsCompleted, answered Ask does NOT match isExpired', () => {
    const msg = {
      type: 'tool-use', toolName: 'AskUserQuestion',
      askRequestId: 'req-y', askAnswered: true, selectedAnswers: { q: 'a' },
      hasResult: false, isHistory: false
    };
    const store = { messagesMap: { 'c1': [msg] } };
    markAllToolsCompleted(store, 'c1');
    expect(isExpired(msg)).toBe(false);
  });
});

// =============================================================================
// 3. Call ordering: markAllToolsCompleted is called after finishStreaming
// =============================================================================
describe('task-223 supplement: call ordering in cancelExecution', () => {
  it('markAllToolsCompleted is called after finishStreamingForConversation', () => {
    const cancelBlock = conversationSrc.slice(
      conversationSrc.indexOf('export function cancelExecution(store)'),
      conversationSrc.indexOf('export function answerUserQuestion')
    );
    const finishIdx = cancelBlock.indexOf('store.finishStreamingForConversation');
    const markIdx = cancelBlock.indexOf('markAllToolsCompleted');
    expect(finishIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeGreaterThan(finishIdx);
  });

  it('cancelExecutionForConversation: markAllToolsCompleted after finishStreaming', () => {
    const cancelForBlock = conversationSrc.slice(
      conversationSrc.indexOf('export function cancelExecutionForConversation')
    );
    const finishIdx = cancelForBlock.indexOf('store.finishStreamingForConversation');
    const markIdx = cancelForBlock.indexOf('markAllToolsCompleted');
    expect(finishIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeGreaterThan(finishIdx);
  });
});

// =============================================================================
// 4. Non-tool messages are completely unaffected
// =============================================================================
describe('task-223 supplement: non-tool messages unaffected', () => {
  it('user and assistant messages are not touched', () => {
    const store = {
      messagesMap: {
        'conv-1': [
          { type: 'user', content: 'hello', isHistory: false },
          { type: 'assistant', content: 'hi there', isHistory: false },
          { type: 'system', content: 'cancelled', isHistory: false }
        ]
      }
    };

    markAllToolsCompleted(store, 'conv-1');

    // None of these should have hasResult set
    for (const msg of store.messagesMap['conv-1']) {
      expect(msg.hasResult).toBeUndefined();
      expect(msg.isHistory).toBe(false);
    }
  });

  it('conversation with zero tool-use messages is a no-op', () => {
    const msgs = [
      { type: 'user', content: 'test' },
      { type: 'assistant', content: 'response' }
    ];
    const store = { messagesMap: { 'conv-1': msgs } };
    markAllToolsCompleted(store, 'conv-1');
    // Messages should be identical (no mutation)
    expect(msgs[0]).toEqual({ type: 'user', content: 'test' });
    expect(msgs[1]).toEqual({ type: 'assistant', content: 'response' });
  });
});

// =============================================================================
// 5. AskCard template: expired branch renders correct UI
// =============================================================================
describe('task-223 supplement: AskCard expired UI structure', () => {
  it('expired branch uses v-else-if after answered branch', () => {
    // The order should be: isAnswered first, then isExpired
    const answeredIdx = askCardSrc.indexOf('v-if="isAnswered"');
    const expiredIdx = askCardSrc.indexOf('v-else-if="isExpired"');
    expect(answeredIdx).toBeGreaterThan(-1);
    expect(expiredIdx).toBeGreaterThan(answeredIdx);
  });

  it('expired section has ask-expired class', () => {
    expect(askCardSrc).toContain('class="ask-card ask-expired"');
  });

  it('expired section still shows the question icon and label', () => {
    // Within the expired section, there should be icon and label
    const expiredIdx = askCardSrc.indexOf('v-else-if="isExpired"');
    const nextSectionIdx = askCardSrc.indexOf('<div v-else', expiredIdx + 1);
    const expiredSection = askCardSrc.slice(expiredIdx, nextSectionIdx > -1 ? nextSectionIdx : expiredIdx + 500);
    expect(expiredSection).toContain('ask-icon');
    expect(expiredSection).toContain('ask-label');
  });
});

// =============================================================================
// 6. Source structure: markAllToolsCompleted condition is precise
// =============================================================================
describe('task-223 supplement: markAllToolsCompleted condition precision', () => {
  it('AskUserQuestion check is inside the !hasResult guard', () => {
    // The AskUserQuestion-specific logic should be inside the if (msg.type === "tool-use" && !msg.hasResult) block
    const fnStart = conversationHandlerSrc.indexOf('export function markAllToolsCompleted');
    const fnBlock = conversationHandlerSrc.slice(fnStart, conversationHandlerSrc.indexOf('\n}', fnStart + 10) + 2);

    // The AskUserQuestion check must come after msg.hasResult = true
    const hasResultSet = fnBlock.indexOf('msg.hasResult = true');
    const askCheck = fnBlock.indexOf("msg.toolName === 'AskUserQuestion'");
    expect(hasResultSet).toBeGreaterThan(-1);
    expect(askCheck).toBeGreaterThan(hasResultSet);
  });

  it('checks both askAnswered and selectedAnswers before expiring', () => {
    const fnStart = conversationHandlerSrc.indexOf('export function markAllToolsCompleted');
    const fnBlock = conversationHandlerSrc.slice(fnStart, conversationHandlerSrc.indexOf('\n}', fnStart + 10) + 2);
    expect(fnBlock).toContain('!msg.askAnswered');
    expect(fnBlock).toContain('!msg.selectedAnswers');
  });
});
