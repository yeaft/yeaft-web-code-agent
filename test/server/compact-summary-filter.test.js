/**
 * Tests for PR #419 — Fix compact summary displayed as user message after refresh.
 *
 * Root cause: bulkAddHistory() in message-db.js stored compact summary messages
 * (type:'user' but containing AI-generated context summaries) as real user messages.
 * After page refresh, these appeared as user-sent messages.
 *
 * Fix: Added isCompactSummary() detection function that checks 4 patterns:
 * 1. <context> + </context> XML wrapping
 * 2. "Here is a summary of the conversation" prefix
 * 3. <compact-summary> tag
 * 4. "This session is being continued from a previous conversation" marker
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const messageDbSource = readFileSync(
  new URL('../../server/db/message-db.js', import.meta.url),
  'utf-8'
);

// =====================================================================
// 1. Replicate the isCompactSummary logic as a pure function for unit testing
// =====================================================================
function isCompactSummary(text) {
  if (!text) return false;
  return (text.includes('<context>') && text.includes('</context>'))
    || text.startsWith('Here is a summary of the conversation')
    || text.includes('<compact-summary>')
    || text.includes('This session is being continued from a previous conversation');
}

// =====================================================================
// 2. Unit tests for isCompactSummary — the 4 detection patterns
// =====================================================================
describe('isCompactSummary — pattern 1: <context> + </context> XML wrapping', () => {
  it('should detect text wrapped in <context>...</context>', () => {
    const text = '<context>\n<open-files>\nfile1.js\n</open-files>\n<instructions>\nDo something\n</instructions>\n</context>';
    expect(isCompactSummary(text)).toBe(true);
  });

  it('should detect when <context> and </context> are embedded in longer text', () => {
    const text = 'Some preamble\n<context>\nSummary content here\n</context>\nSome epilogue';
    expect(isCompactSummary(text)).toBe(true);
  });

  it('should NOT match <context> without closing </context>', () => {
    const text = 'User mentioned <context> in their message but never closed it';
    expect(isCompactSummary(text)).toBe(false);
  });

  it('should NOT match </context> without opening <context>', () => {
    const text = 'The user wrote </context> randomly';
    expect(isCompactSummary(text)).toBe(false);
  });
});

describe('isCompactSummary — pattern 2: "Here is a summary" prefix', () => {
  it('should detect exact prefix', () => {
    const text = 'Here is a summary of the conversation so far:\n\nThe user asked about...';
    expect(isCompactSummary(text)).toBe(true);
  });

  it('should NOT match if prefix is not at the start', () => {
    // startsWith check means embedded occurrence should NOT match
    const text = 'The AI said: Here is a summary of the conversation';
    expect(isCompactSummary(text)).toBe(false);
  });

  it('should detect with varied continuation text', () => {
    const text = 'Here is a summary of the conversation up to this point. Key topics discussed include...';
    expect(isCompactSummary(text)).toBe(true);
  });
});

describe('isCompactSummary — pattern 3: <compact-summary> tag', () => {
  it('should detect <compact-summary> tag', () => {
    const text = '<compact-summary>\nThis is the compressed conversation context.\n</compact-summary>';
    expect(isCompactSummary(text)).toBe(true);
  });

  it('should detect <compact-summary> anywhere in text', () => {
    const text = 'Previous context:\n<compact-summary>Summary data</compact-summary>\nEnd';
    expect(isCompactSummary(text)).toBe(true);
  });
});

describe('isCompactSummary — pattern 4: "This session is being continued"', () => {
  it('should detect the continuation marker', () => {
    const text = 'This session is being continued from a previous conversation that ran out of context. Here is a summary...';
    expect(isCompactSummary(text)).toBe(true);
  });

  it('should detect when marker is embedded in text', () => {
    const text = 'Note: This session is being continued from a previous conversation. The user was working on...';
    expect(isCompactSummary(text)).toBe(true);
  });
});

// =====================================================================
// 3. Normal user messages — should NOT be filtered
// =====================================================================
describe('isCompactSummary — normal user messages (false negatives prevention)', () => {
  it('should NOT filter simple text messages', () => {
    expect(isCompactSummary('Hello, how are you?')).toBe(false);
  });

  it('should NOT filter code-containing messages', () => {
    expect(isCompactSummary('Can you help me fix this function?\nfunction add(a, b) { return a + b; }')).toBe(false);
  });

  it('should NOT filter messages with generic XML tags', () => {
    expect(isCompactSummary('Please wrap the output in <div> tags')).toBe(false);
  });

  it('should NOT filter messages mentioning "summary"', () => {
    expect(isCompactSummary('Can you write a summary of this article?')).toBe(false);
  });

  it('should NOT filter messages mentioning "context"', () => {
    expect(isCompactSummary('What is the context of this function?')).toBe(false);
  });

  it('should NOT filter messages with partial compact markers', () => {
    expect(isCompactSummary('I want to compact this data')).toBe(false);
  });

  it('should NOT filter messages mentioning "session"', () => {
    expect(isCompactSummary('My session keeps disconnecting')).toBe(false);
  });

  it('should NOT filter long user messages', () => {
    const longMsg = 'A'.repeat(5000);
    expect(isCompactSummary(longMsg)).toBe(false);
  });

  it('should NOT filter messages with HTML-like content', () => {
    expect(isCompactSummary('<html><body>Please review this template</body></html>')).toBe(false);
  });

  it('should NOT filter messages containing "continued"', () => {
    expect(isCompactSummary('I continued working on the project yesterday')).toBe(false);
  });

  it('should NOT filter slash commands', () => {
    expect(isCompactSummary('/skills')).toBe(false);
    expect(isCompactSummary('/context')).toBe(false);
    expect(isCompactSummary('/compact')).toBe(false);
  });
});

// =====================================================================
// 4. Boundary conditions
// =====================================================================
describe('isCompactSummary — boundary conditions', () => {
  it('should return false for empty string', () => {
    expect(isCompactSummary('')).toBe(false);
  });

  it('should return false for null', () => {
    expect(isCompactSummary(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isCompactSummary(undefined)).toBe(false);
  });

  it('should return false for whitespace-only string', () => {
    expect(isCompactSummary('   \n\t  ')).toBe(false);
  });

  it('should NOT match lone <context> without </context>', () => {
    expect(isCompactSummary('Give me more <context> about the issue')).toBe(false);
  });

  it('should NOT match lone </context> without <context>', () => {
    expect(isCompactSummary('End of </context> here')).toBe(false);
  });

  it('should match when both <context> and </context> exist even with other content', () => {
    expect(isCompactSummary('prefix <context> middle </context> suffix')).toBe(true);
  });

  it('should handle "Here is a summary" as exact startsWith match', () => {
    // Leading whitespace should NOT match startsWith
    expect(isCompactSummary(' Here is a summary of the conversation')).toBe(false);
  });
});

// =====================================================================
// 5. Source code structure verification
// =====================================================================
describe('message-db.js — isCompactSummary function structure', () => {
  it('should define isCompactSummary function', () => {
    expect(messageDbSource).toContain('function isCompactSummary(text)');
  });

  it('should check for null/falsy text first', () => {
    expect(messageDbSource).toContain('if (!text) return false');
  });

  it('should check <context> + </context> pair', () => {
    expect(messageDbSource).toContain("text.includes('<context>')");
    expect(messageDbSource).toContain("text.includes('</context>')");
  });

  it('should use AND for context tag pair (both must exist)', () => {
    // The pattern is: text.includes('<context>') && text.includes('</context>')
    expect(messageDbSource).toContain("text.includes('<context>') && text.includes('</context>')");
  });

  it('should check "Here is a summary" with startsWith', () => {
    expect(messageDbSource).toContain("text.startsWith('Here is a summary of the conversation')");
  });

  it('should check <compact-summary> tag', () => {
    expect(messageDbSource).toContain("text.includes('<compact-summary>')");
  });

  it('should check "This session is being continued" marker', () => {
    expect(messageDbSource).toContain("text.includes('This session is being continued from a previous conversation')");
  });
});

// =====================================================================
// 6. bulkAddHistory integration — skip and log behavior
// =====================================================================
describe('bulkAddHistory — compact summary skip behavior', () => {
  it('should call isCompactSummary before inserting user messages', () => {
    // In the source, isCompactSummary is called inside the msg.type === 'user' branch
    const userBranch = messageDbSource.substring(
      messageDbSource.indexOf("if (msg.type === 'user')"),
      messageDbSource.indexOf("} else if (msg.type === 'assistant')")
    );
    expect(userBranch).toContain('isCompactSummary(text)');
  });

  it('should use continue to skip compact summary messages', () => {
    const userBranch = messageDbSource.substring(
      messageDbSource.indexOf("if (msg.type === 'user')"),
      messageDbSource.indexOf("} else if (msg.type === 'assistant')")
    );
    expect(userBranch).toContain('isCompactSummary(text)');
    expect(userBranch).toContain('continue');
  });

  it('should log when skipping compact summary', () => {
    expect(messageDbSource).toContain('[bulkAddHistory] Skipping compact summary message');
  });

  it('should log the character count of skipped message', () => {
    expect(messageDbSource).toContain('text.length');
    expect(messageDbSource).toContain('chars');
  });

  it('should log the sessionId of skipped message', () => {
    // The log line includes sessionId
    expect(messageDbSource).toContain('for ${sessionId}');
  });

  it('should check isCompactSummary AFTER extractUserText', () => {
    // extractUserText must be called first, then isCompactSummary checks the extracted text
    const userBranch = messageDbSource.substring(
      messageDbSource.indexOf("if (msg.type === 'user')"),
      messageDbSource.indexOf("} else if (msg.type === 'assistant')")
    );
    const extractPos = userBranch.indexOf('extractUserText(msg)');
    const compactPos = userBranch.indexOf('isCompactSummary(text)');
    expect(extractPos).toBeGreaterThan(-1);
    expect(compactPos).toBeGreaterThan(-1);
    expect(compactPos).toBeGreaterThan(extractPos);
  });

  it('should check isCompactSummary BEFORE insertMessage', () => {
    const userBranch = messageDbSource.substring(
      messageDbSource.indexOf("if (msg.type === 'user')"),
      messageDbSource.indexOf("} else if (msg.type === 'assistant')")
    );
    const compactPos = userBranch.indexOf('isCompactSummary(text)');
    const insertPos = userBranch.indexOf('stmts.insertMessage.run');
    expect(compactPos).toBeGreaterThan(-1);
    expect(insertPos).toBeGreaterThan(-1);
    expect(compactPos).toBeLessThan(insertPos);
  });

  it('should only check isCompactSummary when text is truthy', () => {
    // The check is inside `if (text) { if (isCompactSummary(text)) { ... } }`
    const userBranch = messageDbSource.substring(
      messageDbSource.indexOf("if (msg.type === 'user')"),
      messageDbSource.indexOf("} else if (msg.type === 'assistant')")
    );
    const textCheckPos = userBranch.indexOf('if (text)');
    const compactPos = userBranch.indexOf('isCompactSummary(text)');
    expect(textCheckPos).toBeGreaterThan(-1);
    expect(compactPos).toBeGreaterThan(textCheckPos);
  });
});

// =====================================================================
// 7. Real-world compact summary examples
// =====================================================================
describe('isCompactSummary — real-world compact summary examples', () => {
  it('should detect Claude CLI compact summary with full context structure', () => {
    const realSummary = `<context>
<open-files>
web/stores/helpers/claudeOutput.js
server/db/message-db.js
</open-files>
<instructions>
The user is working on a web chat application. They want to fix a bug where compact summaries appear as user messages.
</instructions>
<conversation-summary>
The user has been debugging an issue with message display after page refresh...
</conversation-summary>
</context>`;
    expect(isCompactSummary(realSummary)).toBe(true);
  });

  it('should detect Claude continuation summary', () => {
    const realSummary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

Summary:
1. The user is working on claude-web-chat, a web application for chatting with Claude.
2. They identified a bug where compact summaries appear as user messages after refresh.`;
    expect(isCompactSummary(realSummary)).toBe(true);
  });

  it('should detect "Here is a summary" format', () => {
    const realSummary = `Here is a summary of the conversation so far:

The user has been working on fixing several bugs in their web chat application. Key changes include:
1. Fixed duplicate output in Chat mode
2. Added session health indicators
3. Implemented pin-to-top for sessions`;
    expect(isCompactSummary(realSummary)).toBe(true);
  });

  it('should detect compact-summary tagged content', () => {
    const realSummary = `<compact-summary>
Previous conversation context:
- User was implementing a typing health indicator
- Three views (MessageList, SplitPane, CrewChatView) needed consistent waitingStatus
- Watchdog was rewritten to use ping/pong model
</compact-summary>`;
    expect(isCompactSummary(realSummary)).toBe(true);
  });
});

// =====================================================================
// 8. Regression: extractUserText is not affected
// =====================================================================
describe('extractUserText — unchanged by this PR', () => {
  it('should still exist in message-db.js', () => {
    expect(messageDbSource).toContain('function extractUserText(msg)');
  });

  it('should handle string content', () => {
    expect(messageDbSource).toContain("typeof content === 'string'");
  });

  it('should handle array content', () => {
    expect(messageDbSource).toContain('Array.isArray(content)');
  });

  it('should extract text from message.content', () => {
    expect(messageDbSource).toContain('msg.message?.content');
  });
});
