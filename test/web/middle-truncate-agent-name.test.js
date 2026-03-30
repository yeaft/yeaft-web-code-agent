import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for PR #392 (task-172 + task-173 + task-176):
 *   Part 1: middleTruncate function in ToolLine.js
 *   Part 2: ChatHeader agentName in split-mode
 *   Part 3: Vertical alignment fix (task-176)
 *
 * 10 test areas:
 *   1. middleTruncate — pure function behavioral tests
 *   2. ToolLine Bash truncation uses middleTruncate(cmd, 80)
 *   3. ToolLine WebFetch truncation uses middleTruncate(pathname, 20)
 *   4. ToolLine Task truncation uses middleTruncate(prompt, 40)
 *   5. ChatHeader agentName computed logic
 *   6. ChatHeader template — isSplitMode && agentName condition
 *   7. CSS .chat-title-agent style exists
 *   8. CSS .chat-title-path flex alignment (task-176)
 *   9. CSS .chat-title-path-text ellipsis (task-176)
 *  10. ChatHeader folderPath wrapped in span.chat-title-path-text (task-176)
 */

const webDir = path.resolve(__dirname, '../../web');

function readFile(relativePath) {
  return fs.readFileSync(path.join(webDir, relativePath), 'utf-8');
}

// =====================================================================
// Replicate middleTruncate for behavioral testing
// =====================================================================
function middleTruncate(text, maxLen = 80) {
  if (!text || text.length <= maxLen) return text || '';
  const headLen = Math.ceil(maxLen * 0.6);
  const tailLen = maxLen - headLen - 3;
  return text.slice(0, headLen) + '...' + text.slice(-tailLen);
}

// =====================================================================
// 1. middleTruncate — pure function behavioral tests
// =====================================================================
describe('middleTruncate function', () => {
  it('should return empty string for null input', () => {
    expect(middleTruncate(null)).toBe('');
  });

  it('should return empty string for undefined input', () => {
    expect(middleTruncate(undefined)).toBe('');
  });

  it('should return empty string for empty string input', () => {
    expect(middleTruncate('')).toBe('');
  });

  it('should return text unchanged when length <= maxLen', () => {
    expect(middleTruncate('short text', 80)).toBe('short text');
  });

  it('should return text unchanged when length == maxLen', () => {
    const exact = 'x'.repeat(80);
    expect(middleTruncate(exact, 80)).toBe(exact);
  });

  it('should truncate in the middle when text exceeds maxLen', () => {
    const long = 'A'.repeat(50) + 'B'.repeat(50);
    const result = middleTruncate(long, 80);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result).toContain('...');
  });

  it('should preserve head (60%) and tail portions', () => {
    // maxLen=80: headLen=ceil(80*0.6)=48, tailLen=80-48-3=29
    const text = 'H'.repeat(60) + 'T'.repeat(40);
    const result = middleTruncate(text, 80);
    expect(result.startsWith('H'.repeat(48))).toBe(true);
    expect(result.endsWith('T'.repeat(29))).toBe(true);
    expect(result).toContain('...');
  });

  it('should produce result of exactly maxLen characters when text is longer', () => {
    const long = 'x'.repeat(200);
    const result = middleTruncate(long, 80);
    expect(result.length).toBe(80);
  });

  it('should work with maxLen=20 for WebFetch pathname', () => {
    const pathname = '/api/v2/users/profile/settings/advanced';
    const result = middleTruncate(pathname, 20);
    expect(result.length).toBe(20);
    expect(result).toContain('...');
    // Head: ceil(20*0.6)=12, Tail: 20-12-3=5
    expect(result.startsWith(pathname.slice(0, 12))).toBe(true);
    expect(result.endsWith(pathname.slice(-5))).toBe(true);
  });

  it('should work with maxLen=40 for Task prompt', () => {
    const prompt = 'Analyze the codebase and find all security vulnerabilities in the authentication module';
    const result = middleTruncate(prompt, 40);
    expect(result.length).toBe(40);
    expect(result).toContain('...');
    // Head: ceil(40*0.6)=24, Tail: 40-24-3=13
    expect(result.startsWith(prompt.slice(0, 24))).toBe(true);
    expect(result.endsWith(prompt.slice(-13))).toBe(true);
  });

  it('should handle text exactly 1 character over maxLen', () => {
    const text = 'x'.repeat(81);
    const result = middleTruncate(text, 80);
    expect(result.length).toBe(80);
    expect(result).toContain('...');
  });

  it('should handle very small maxLen', () => {
    const result = middleTruncate('hello world test', 10);
    expect(result.length).toBe(10);
    expect(result).toContain('...');
  });
});

// =====================================================================
// 2. ToolLine source — Bash uses middleTruncate(cmd, 80)
// =====================================================================
describe('ToolLine Bash truncation', () => {
  const toolLineJs = readFile('components/ToolLine.js');

  it('should define middleTruncate function', () => {
    expect(toolLineJs).toContain('const middleTruncate = (text, maxLen = 80)');
  });

  it('should use middleTruncate for Bash commands', () => {
    expect(toolLineJs).toContain('return middleTruncate(cmd, 80)');
  });

  it('should NOT use old slice(0, 80) for Bash commands', () => {
    expect(toolLineJs).not.toContain("cmd.slice(0, 80) + '...'");
  });
});

// =====================================================================
// 3. ToolLine source — WebFetch uses middleTruncate(pathname, 20)
// =====================================================================
describe('ToolLine WebFetch truncation', () => {
  const toolLineJs = readFile('components/ToolLine.js');

  it('should use middleTruncate for WebFetch pathname', () => {
    expect(toolLineJs).toContain('middleTruncate(url.pathname, 20)');
  });

  it('should NOT use old pathname.slice(0, 20) for WebFetch', () => {
    expect(toolLineJs).not.toContain("url.pathname.slice(0, 20) + '...'");
  });
});

// =====================================================================
// 4. ToolLine source — Task uses middleTruncate(prompt, 40)
// =====================================================================
describe('ToolLine Task truncation', () => {
  const toolLineJs = readFile('components/ToolLine.js');

  it('should use middleTruncate for Task prompt', () => {
    expect(toolLineJs).toContain("middleTruncate(input.prompt || '', 40)");
  });

  it('should NOT use old prompt?.slice(0, 40) for Task', () => {
    expect(toolLineJs).not.toContain("input.prompt?.slice(0, 40)");
  });
});

// =====================================================================
// 5. ChatHeader agentName computed logic
// =====================================================================
describe('ChatHeader agentName computed', () => {
  const chatHeaderJs = readFile('components/ChatHeader.js');

  it('should define agentName as a Vue.computed', () => {
    expect(chatHeaderJs).toContain('const agentName = Vue.computed(');
  });

  it('should return empty string when no effectiveConvId', () => {
    expect(chatHeaderJs).toContain("if (!effectiveConvId.value) return ''");
  });

  it('should find conversation by effectiveConvId', () => {
    expect(chatHeaderJs).toContain('store.conversations.find(c => c.id === effectiveConvId.value)');
  });

  it('should return empty string when no agentId', () => {
    expect(chatHeaderJs).toContain("if (!aid) return ''");
  });

  it('should find agent by id and return name', () => {
    expect(chatHeaderJs).toContain('store.agents.find(a => a.id === aid)');
    expect(chatHeaderJs).toContain("return agent?.name || ''");
  });

  it('should include agentName in the return object', () => {
    // Check that agentName is in the return statement
    const returnMatch = chatHeaderJs.match(/return\s*\{[^}]+agentName[^}]+\}/s);
    expect(returnMatch).not.toBeNull();
  });
});

// =====================================================================
// 6. ChatHeader template — isSplitMode && agentName condition
// =====================================================================
describe('ChatHeader template agentName rendering', () => {
  const chatHeaderJs = readFile('components/ChatHeader.js');

  it('should show chat-title-path when folderPath or (isSplitMode && agentName)', () => {
    expect(chatHeaderJs).toContain('v-if="folderPath || (store.isSplitMode && agentName)"');
  });

  it('should render chat-title-agent span only when isSplitMode && agentName', () => {
    expect(chatHeaderJs).toContain('v-if="store.isSplitMode && agentName"');
    expect(chatHeaderJs).toContain('class="chat-title-agent"');
  });

  it('should display agentName text inside the span', () => {
    expect(chatHeaderJs).toContain('{{ agentName }}');
  });
});

// =====================================================================
// 7. CSS .chat-title-agent style
// =====================================================================
describe('CSS .chat-title-agent style', () => {
  const css = readFile('styles/sidebar.css');

  it('should define .chat-title-agent rule', () => {
    expect(css).toMatch(/\.chat-title-agent\s*\{/);
  });

  it('should use accent color for background and text', () => {
    const rule = css.match(/\.chat-title-agent\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('var(--accent)');
  });

  it('should have inline-block display for badge appearance', () => {
    const rule = css.match(/\.chat-title-agent\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('display: inline-block');
  });

  it('should have border-radius for badge shape', () => {
    const rule = css.match(/\.chat-title-agent\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('border-radius: 4px');
  });

  it('should have font-size 11px for compact badge', () => {
    const rule = css.match(/\.chat-title-agent\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('font-size: 11px');
  });

  it('should have margin-right for spacing from folderPath', () => {
    const rule = css.match(/\.chat-title-agent\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('margin-right: 6px');
  });

  it('should NOT have vertical-align: middle (flex child does not need it)', () => {
    const rule = css.match(/\.chat-title-agent\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).not.toContain('vertical-align');
  });
});

// =====================================================================
// 8. CSS .chat-title-path — flex alignment (task-176)
// =====================================================================
describe('CSS .chat-title-path flex alignment', () => {
  const css = readFile('styles/sidebar.css');

  it('should define .chat-title-path rule', () => {
    expect(css).toMatch(/\.chat-title-path\s*\{/);
  });

  it('should use display: flex for vertical alignment', () => {
    const rule = css.match(/\.chat-title-path\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('display: flex');
  });

  it('should use align-items: center for vertical centering', () => {
    const rule = css.match(/\.chat-title-path\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('align-items: center');
  });

  it('should have overflow: hidden to prevent overflow', () => {
    const rule = css.match(/\.chat-title-path\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('overflow: hidden');
  });

  it('should have white-space: nowrap to prevent wrapping', () => {
    const rule = css.match(/\.chat-title-path\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('white-space: nowrap');
  });
});

// =====================================================================
// 9. CSS .chat-title-path-text — ellipsis for folderPath (task-176)
// =====================================================================
describe('CSS .chat-title-path-text ellipsis', () => {
  const css = readFile('styles/sidebar.css');

  it('should define .chat-title-path-text rule', () => {
    expect(css).toMatch(/\.chat-title-path-text\s*\{/);
  });

  it('should have overflow: hidden for text truncation', () => {
    const rule = css.match(/\.chat-title-path-text\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('overflow: hidden');
  });

  it('should have text-overflow: ellipsis for truncated text', () => {
    const rule = css.match(/\.chat-title-path-text\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('text-overflow: ellipsis');
  });

  it('should have min-width: 0 to allow flex shrinking', () => {
    const rule = css.match(/\.chat-title-path-text\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('min-width: 0');
  });

  it('should have white-space: nowrap to prevent wrapping', () => {
    const rule = css.match(/\.chat-title-path-text\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('white-space: nowrap');
  });
});

// =====================================================================
// 10. ChatHeader template — folderPath wrapped in span.chat-title-path-text (task-176)
// =====================================================================
describe('ChatHeader folderPath wrapped in span', () => {
  const chatHeaderJs = readFile('components/ChatHeader.js');

  it('should wrap folderPath in a span with class chat-title-path-text', () => {
    expect(chatHeaderJs).toContain('class="chat-title-path-text"');
    expect(chatHeaderJs).toContain('{{ folderPath }}</span>');
  });

  it('should have both chat-title-agent and chat-title-path-text as children of chat-title-path', () => {
    // Both spans should appear within the chat-title-path div
    const pathBlock = chatHeaderJs.match(/class="chat-title-path"[\s\S]*?<\/div>/);
    expect(pathBlock).not.toBeNull();
    expect(pathBlock[0]).toContain('chat-title-agent');
    expect(pathBlock[0]).toContain('chat-title-path-text');
  });
});
