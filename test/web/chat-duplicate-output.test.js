/**
 * Tests for PR #409 — Fix Chat mode duplicate output bug.
 *
 * Root cause: claudeOutput.js 'result' handler appended result_text even when
 * the text had already been streamed via 'assistant' messages.
 *
 * Fix: Walk backwards through messages; if an assistant message exists in the
 * current turn (before hitting a 'user' boundary), skip result_text.
 * Only append result_text for slash commands where no assistant was streamed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const claudeOutputSource = readFileSync(
  new URL('../../web/stores/helpers/claudeOutput.js', import.meta.url),
  'utf-8'
);

// =====================================================================
// 1. Replicate the core "hasAssistantInTurn" logic as a pure function
// =====================================================================
/**
 * Determines whether an assistant message already exists in the current turn.
 * Walks backwards from the end of msgs; stops at the first 'user' boundary.
 */
function hasAssistantInTurn(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === 'assistant') return true;
    if (msgs[i].type === 'user') return false;
  }
  return false;
}

// =====================================================================
// 2. Unit tests for hasAssistantInTurn logic
// =====================================================================
describe('hasAssistantInTurn — core duplicate-prevention logic', () => {
  it('should return false for empty messages array', () => {
    expect(hasAssistantInTurn([])).toBe(false);
  });

  it('should return false when only user messages exist', () => {
    const msgs = [
      { type: 'user', content: 'Hello' }
    ];
    expect(hasAssistantInTurn(msgs)).toBe(false);
  });

  it('should return true when assistant message is last (streaming finished)', () => {
    const msgs = [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi there' }
    ];
    expect(hasAssistantInTurn(msgs)).toBe(true);
  });

  it('should return true when assistant message is still streaming', () => {
    const msgs = [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi th', isStreaming: true }
    ];
    expect(hasAssistantInTurn(msgs)).toBe(true);
  });

  it('should return true when tool-use follows assistant in same turn', () => {
    // Normal flow: user → assistant → tool_use → (tool result) → result
    const msgs = [
      { type: 'user', content: 'Search for X' },
      { type: 'assistant', content: 'Let me search...' },
      { type: 'tool-use', toolName: 'WebSearch', hasResult: true }
    ];
    expect(hasAssistantInTurn(msgs)).toBe(true);
  });

  it('should return false for slash command (user only, no assistant)', () => {
    // Slash commands like /skills, /context: no assistant message is streamed
    const msgs = [
      { type: 'user', content: '/skills' }
    ];
    expect(hasAssistantInTurn(msgs)).toBe(false);
  });

  it('should only check current turn — previous turn assistant should not matter', () => {
    // Turn 1: user → assistant
    // Turn 2: user → (slash command, no assistant)
    const msgs = [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi!' },
      { type: 'user', content: '/context' }
    ];
    // The backwards walk should hit the 'user' at index 2 and stop → false
    expect(hasAssistantInTurn(msgs)).toBe(false);
  });

  it('should return true when multiple assistants exist in turn', () => {
    // Sometimes Claude sends multiple assistant chunks
    const msgs = [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'First chunk' },
      { type: 'assistant', content: 'Second chunk' }
    ];
    expect(hasAssistantInTurn(msgs)).toBe(true);
  });

  it('should handle system messages in between — they are not turn boundaries', () => {
    const msgs = [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi' },
      { type: 'system', content: 'System info' }
    ];
    // system is not 'user', so walk continues and finds assistant → true
    expect(hasAssistantInTurn(msgs)).toBe(true);
  });

  it('should handle error messages in between — they are not turn boundaries', () => {
    const msgs = [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Let me try...' },
      { type: 'error', content: 'Something failed' }
    ];
    expect(hasAssistantInTurn(msgs)).toBe(true);
  });

  it('should return false when only tool results exist after user (no assistant)', () => {
    // Edge case: tool result without preceding assistant
    const msgs = [
      { type: 'user', content: 'Run tool' },
      { type: 'tool-use', toolName: 'SomeTool', hasResult: true }
    ];
    expect(hasAssistantInTurn(msgs)).toBe(false);
  });
});

// =====================================================================
// 3. Scenario tests — simulating the full duplicate output bug
// =====================================================================
describe('result handler — duplicate prevention scenarios', () => {
  /**
   * Simulates what the result handler does:
   * Given msgs + resultText, returns true if resultText should be appended.
   */
  function shouldAppendResultText(msgs, resultText) {
    if (typeof resultText !== 'string' || !resultText.trim()) return false;
    return !hasAssistantInTurn(msgs);
  }

  it('SCENARIO: normal conversation — result_text should be SKIPPED (was the bug)', () => {
    // User sends message → assistant streams response → result arrives with same text
    const msgs = [
      { type: 'user', content: 'What is 2+2?' },
      { type: 'assistant', content: '2+2 equals 4.' }
    ];
    expect(shouldAppendResultText(msgs, '2+2 equals 4.')).toBe(false);
  });

  it('SCENARIO: slash command /skills — result_text should be APPENDED', () => {
    // Slash commands produce no assistant message, only result_text
    const msgs = [
      { type: 'user', content: '/skills' }
    ];
    expect(shouldAppendResultText(msgs, 'Available skills: ...')).toBe(true);
  });

  it('SCENARIO: slash command /context — result_text should be APPENDED', () => {
    const msgs = [
      { type: 'user', content: '/context' }
    ];
    expect(shouldAppendResultText(msgs, 'Context window: 50% used')).toBe(true);
  });

  it('SCENARIO: tool_use interrupts streaming, then result arrives', () => {
    // assistant streams → tool_use → tool result → result arrives
    // Assistant already exists in turn, so skip result_text
    const msgs = [
      { type: 'user', content: 'Search for Claude docs' },
      { type: 'assistant', content: 'Let me search for that...' },
      { type: 'tool-use', toolName: 'WebSearch', hasResult: true },
      { type: 'assistant', content: 'Here are the results...' }
    ];
    expect(shouldAppendResultText(msgs, 'Let me search for that...\nHere are the results...')).toBe(false);
  });

  it('SCENARIO: empty result_text should not be appended regardless', () => {
    const msgs = [{ type: 'user', content: 'Hello' }];
    expect(shouldAppendResultText(msgs, '')).toBe(false);
    expect(shouldAppendResultText(msgs, '   ')).toBe(false);
  });

  it('SCENARIO: result_text is undefined or null', () => {
    const msgs = [{ type: 'user', content: 'Hello' }];
    expect(shouldAppendResultText(msgs, undefined)).toBe(false);
    expect(shouldAppendResultText(msgs, null)).toBe(false);
  });

  it('SCENARIO: empty messages list with result_text', () => {
    // Edge: no messages at all but result_text exists
    expect(shouldAppendResultText([], 'Some output')).toBe(true);
  });

  it('SCENARIO: multi-turn — only current turn matters', () => {
    // Turn 1 had assistant, Turn 2 is slash command
    const msgs = [
      { type: 'user', content: 'What is AI?' },
      { type: 'assistant', content: 'AI is...' },
      { type: 'user', content: '/skills' }
    ];
    expect(shouldAppendResultText(msgs, 'Available skills')).toBe(true);
  });

  it('SCENARIO: assistant streaming still in progress when result arrives', () => {
    // This is the original bug scenario — assistant was streaming (isStreaming: true)
    // Old code only checked isStreaming on the LAST message, so this worked.
    // But if streaming finished before result arrived, isStreaming was false → duplicate.
    const msgs = [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi there!', isStreaming: false }
    ];
    // New code: assistant exists regardless of isStreaming → skip
    expect(shouldAppendResultText(msgs, 'Hi there!')).toBe(false);
  });
});

// =====================================================================
// 4. Source code structure verification
// =====================================================================
describe('claudeOutput.js — result handler structure', () => {
  it('should have the result type handler', () => {
    expect(claudeOutputSource).toContain("data.type === 'result'");
  });

  it('should use hasAssistantInTurn variable (not isStreaming)', () => {
    expect(claudeOutputSource).toContain('hasAssistantInTurn');
    // The old isStreaming-based check should be gone
    expect(claudeOutputSource).not.toContain('hasStreamingAssistant');
  });

  it('should walk backwards through messages with for loop', () => {
    expect(claudeOutputSource).toContain('for (let i = msgs.length - 1; i >= 0; i--)');
  });

  it('should check for assistant type in backward walk', () => {
    // Extract the result block — it spans ~1800 chars from the type check to the closing brace
    const resultStart = claudeOutputSource.indexOf("data.type === 'result'");
    const resultBlock = claudeOutputSource.substring(resultStart, resultStart + 1800);
    expect(resultBlock).toContain("msgs[i].type === 'assistant'");
  });

  it('should use user type as turn boundary', () => {
    const resultStart = claudeOutputSource.indexOf("data.type === 'result'");
    const resultBlock = claudeOutputSource.substring(resultStart, resultStart + 1800);
    expect(resultBlock).toContain("msgs[i].type === 'user'");
  });

  it('should only append when !hasAssistantInTurn', () => {
    expect(claudeOutputSource).toContain('if (!hasAssistantInTurn)');
  });

  it('should call appendToAssistantMessageForConversation when appending', () => {
    const resultStart = claudeOutputSource.indexOf("data.type === 'result'");
    const resultBlock = claudeOutputSource.substring(resultStart, resultStart + 1800);
    expect(resultBlock).toContain('appendToAssistantMessageForConversation');
  });

  it('should extract result_text from data', () => {
    expect(claudeOutputSource).toContain("data.result_text || ''");
  });

  it('should trim resultText before appending', () => {
    expect(claudeOutputSource).toContain('resultText.trim()');
  });

  it('should call finishStreamingForConversation after result handling', () => {
    const resultStart = claudeOutputSource.indexOf("data.type === 'result'");
    const resultBlock = claudeOutputSource.substring(resultStart, resultStart + 1800);
    expect(resultBlock).toContain('finishStreamingForConversation');
  });
});

// =====================================================================
// 5. Regression: old isStreaming-based check is removed
// =====================================================================
describe('regression — old isStreaming check removed', () => {
  it('should NOT check msgs[msgs.length - 1].isStreaming', () => {
    // The old buggy pattern
    expect(claudeOutputSource).not.toContain('msgs[msgs.length - 1].isStreaming');
  });

  it('should NOT use hasStreamingAssistant variable', () => {
    expect(claudeOutputSource).not.toContain('hasStreamingAssistant');
  });

  it('should NOT check only the last message for streaming state', () => {
    // The old code only checked the very last message
    expect(claudeOutputSource).not.toContain("msgs[msgs.length - 1].type === 'assistant'");
  });
});

// =====================================================================
// 6. Edge case: assistant message types in the walk
// =====================================================================
describe('edge cases — turn boundary detection', () => {
  it('tool-use messages should not stop the backward walk', () => {
    // The walk should continue past tool-use messages
    const msgs = [
      { type: 'user', content: 'Do something' },
      { type: 'assistant', content: 'Doing it' },
      { type: 'tool-use', toolName: 'Bash' },
      { type: 'tool-use', toolName: 'Read' }
    ];
    expect(hasAssistantInTurn(msgs)).toBe(true);
  });

  it('only user type is a turn boundary (not system, error, tool-use)', () => {
    // None of these should stop the walk before finding assistant
    const msgs = [
      { type: 'user', content: 'Start' },
      { type: 'assistant', content: 'Response' },
      { type: 'system', content: 'Info' },
      { type: 'error', content: 'Oops' },
      { type: 'tool-use', toolName: 'X' }
    ];
    expect(hasAssistantInTurn(msgs)).toBe(true);
  });

  it('messages from a different conversation should not interfere (messagesMap isolation)', () => {
    // The source uses store.messagesMap[conversationId], so each conversation is isolated.
    // Verify by checking source code.
    expect(claudeOutputSource).toContain('store.messagesMap[conversationId]');
  });

  it('result handler should still clear processing state', () => {
    const resultStart = claudeOutputSource.indexOf("data.type === 'result'");
    const resultBlock = claudeOutputSource.substring(resultStart, resultStart + 400);
    expect(resultBlock).toContain('delete store.processingConversations[conversationId]');
    expect(resultBlock).toContain('stopProcessingWatchdog');
  });

  it('result handler should still mark all tools completed', () => {
    const resultStart = claudeOutputSource.indexOf("data.type === 'result'");
    const resultBlock = claudeOutputSource.substring(resultStart, resultStart + 1800);
    expect(resultBlock).toContain('markAllToolsCompleted');
  });
});
