/**
 * task-224 / task-241: Typing indicator — SVG fight scene replaces running cat.
 *
 * The running cat SVG was fully removed. The cat-dog fight scene is now the
 * sole SVG animation in the typing indicator.
 *
 * Test scenarios:
 * 1-3. All 3 components: typing indicator has 3 dots + fight scene, no text, no running cat
 * 4. Disconnected → dots + fight scene + "disconnected" text still displayed
 * 5. Old CSS cat classes fully removed from stylesheet
 * 6. Dot animation :not() selectors updated (no .svg-running-cat reference)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

let messageListSrc;
let splitPaneSrc;
let crewChatViewSrc;
let chatMessagesCss;

beforeAll(() => {
  messageListSrc = read('web/components/MessageList.js');
  splitPaneSrc = read('web/components/SplitPane.js');
  crewChatViewSrc = read('web/components/CrewChatView.js');
  chatMessagesCss = read('web/styles/chat-messages.css');
});

// Helper: extract the typing-indicator section from a component
function extractTypingIndicator(src) {
  const start = src.indexOf('class="typing-indicator"');
  if (start === -1) return '';
  let depth = 0;
  let divStart = src.lastIndexOf('<div', start);
  for (let i = divStart; i < src.length; i++) {
    if (src.slice(i).startsWith('<div')) depth++;
    if (src.slice(i).startsWith('</div>')) depth--;
    if (depth === 0) return src.slice(divStart, i + 6);
  }
  return src.slice(divStart, divStart + 2000);
}

// =============================================================================
// 1. Main chat (MessageList.js): 3 dots + fight scene, no running cat
// =============================================================================
describe('Scenario 1: MessageList.js typing indicator', () => {
  it('has typing-indicator div with showTypingDots condition', () => {
    expect(messageListSrc).toContain('v-if="showTypingDots"');
    expect(messageListSrc).toContain('class="typing-indicator"');
  });

  it('has 3 empty spans for dots', () => {
    const indicator = extractTypingIndicator(messageListSrc);
    const dotSpans = indicator.match(/<span><\/span>/g) || [];
    expect(dotSpans.length).toBeGreaterThanOrEqual(3);
  });

  it('has svg-fight-scene span (replaced running cat)', () => {
    expect(messageListSrc).toContain('class="svg-fight-scene"');
    expect(messageListSrc).toContain('viewBox="0 0 80 60"');
  });

  it('does NOT have old svg-running-cat', () => {
    expect(messageListSrc).not.toContain('class="svg-running-cat"');
    expect(messageListSrc).not.toContain('viewBox="0 0 34 28"');
  });

  it('does NOT have old running-cat class markup', () => {
    expect(messageListSrc).not.toContain('class="running-cat"');
    expect(messageListSrc).not.toContain('svg-cat-body');
    expect(messageListSrc).not.toContain('svg-cat-head');
    expect(messageListSrc).not.toContain('svg-cat-whisker');
  });

  it('does NOT show thinking text', () => {
    expect(messageListSrc).not.toContain("waitingStatus === 'thinking'");
    expect(messageListSrc).not.toContain('typing-status-thinking');
    expect(messageListSrc).not.toContain('chat.waiting.thinking');
  });
});

// =============================================================================
// 2. Split pane (SplitPane.js): same — fight scene, no running cat
// =============================================================================
describe('Scenario 2: SplitPane.js typing indicator', () => {
  it('has typing-indicator div', () => {
    expect(splitPaneSrc).toContain('class="typing-indicator"');
  });

  it('has svg-fight-scene (not svg-running-cat)', () => {
    expect(splitPaneSrc).toContain('class="svg-fight-scene"');
    expect(splitPaneSrc).not.toContain('class="svg-running-cat"');
    expect(splitPaneSrc).not.toContain('viewBox="0 0 34 28"');
  });

  it('does NOT show thinking text', () => {
    expect(splitPaneSrc).not.toContain("waitingStatus === 'thinking'");
    expect(splitPaneSrc).not.toContain('typing-status-thinking');
  });
});

// =============================================================================
// 3. Crew chat (CrewChatView.js): same — fight scene, no running cat
// =============================================================================
describe('Scenario 3: CrewChatView.js typing indicator', () => {
  it('has typing-indicator div', () => {
    expect(crewChatViewSrc).toContain('class="typing-indicator"');
  });

  it('has svg-fight-scene (not svg-running-cat)', () => {
    expect(crewChatViewSrc).toContain('class="svg-fight-scene"');
    expect(crewChatViewSrc).not.toContain('class="svg-running-cat"');
    expect(crewChatViewSrc).not.toContain('viewBox="0 0 34 28"');
  });

  it('does NOT show thinking text', () => {
    expect(crewChatViewSrc).not.toContain("waitingStatus === 'thinking'");
    expect(crewChatViewSrc).not.toContain('typing-status-thinking');
  });
});

// =============================================================================
// 4. Non-thinking status texts preserved
// =============================================================================
describe('Scenario 4: Non-thinking status texts preserved', () => {
  const components = [
    { name: 'MessageList.js', src: () => messageListSrc },
    { name: 'SplitPane.js', src: () => splitPaneSrc },
    { name: 'CrewChatView.js', src: () => crewChatViewSrc }
  ];

  for (const { name, src } of components) {
    it(`${name}: disconnected status text present`, () => {
      expect(src()).toContain("waitingStatus === 'disconnected'");
      expect(src()).toContain('chat.waiting.disconnected');
      expect(src()).toContain('typing-status-error');
    });

    it(`${name}: compacting status text present`, () => {
      expect(src()).toContain("waitingStatus === 'compacting'");
      expect(src()).toContain('chat.waiting.compacting');
    });

    it(`${name}: agent-offline status text present`, () => {
      expect(src()).toContain("waitingStatus === 'agent-offline'");
      expect(src()).toContain('chat.waiting.agentOffline');
    });

    it(`${name}: session-lost status text present`, () => {
      expect(src()).toContain("waitingStatus === 'session-lost'");
      expect(src()).toContain('chat.waiting.sessionLost');
    });

    it(`${name}: cli-exited status text present`, () => {
      expect(src()).toContain("waitingStatus === 'cli-exited'");
      expect(src()).toContain('chat.waiting.cliExited');
    });
  }
});

// =============================================================================
// 5. CSS: All old running cat styles fully removed
// =============================================================================
describe('CSS: Old running cat styles fully removed', () => {
  it('no .svg-running-cat class in CSS', () => {
    expect(chatMessagesCss).not.toContain('.svg-running-cat');
  });

  it('no .svg-cat-body / .svg-cat-head / .svg-cat-ear CSS rules', () => {
    expect(chatMessagesCss).not.toContain('.svg-cat-body');
    expect(chatMessagesCss).not.toContain('.svg-cat-head');
    expect(chatMessagesCss).not.toContain('.svg-cat-ear');
    expect(chatMessagesCss).not.toContain('.svg-cat-eye');
    expect(chatMessagesCss).not.toContain('.svg-cat-pupil');
    expect(chatMessagesCss).not.toContain('.svg-cat-nose');
    expect(chatMessagesCss).not.toContain('.svg-cat-mouth');
    expect(chatMessagesCss).not.toContain('.svg-cat-whisker');
    expect(chatMessagesCss).not.toContain('.svg-cat-tail');
    expect(chatMessagesCss).not.toContain('.svg-cat-leg');
  });

  it('no running cat keyframe animations', () => {
    expect(chatMessagesCss).not.toContain('@keyframes svg-cat-bounce');
    expect(chatMessagesCss).not.toContain('@keyframes svg-leg-front-l');
    expect(chatMessagesCss).not.toContain('@keyframes svg-leg-front-r');
    expect(chatMessagesCss).not.toContain('@keyframes svg-leg-back-l');
    expect(chatMessagesCss).not.toContain('@keyframes svg-leg-back-r');
    expect(chatMessagesCss).not.toContain('@keyframes svg-tail-wag');
    expect(chatMessagesCss).not.toContain('@keyframes svg-ear-twitch-l');
    expect(chatMessagesCss).not.toContain('@keyframes svg-ear-twitch-r');
  });

  it('old .running-cat class removed', () => {
    expect(chatMessagesCss).not.toMatch(/^\.running-cat\s*\{/m);
  });

  it('old cat-bounce, cat-leg-run, cat-tail-wag keyframes removed', () => {
    expect(chatMessagesCss).not.toContain('@keyframes cat-bounce');
    expect(chatMessagesCss).not.toContain('@keyframes cat-leg-run');
    expect(chatMessagesCss).not.toContain('@keyframes cat-tail-wag');
  });
});

// =============================================================================
// 6. Dot animation selectors — no .svg-running-cat, only .svg-fight-scene
// =============================================================================
describe('Dot animation selector updated', () => {
  it('dot animation excludes .svg-fight-scene', () => {
    expect(chatMessagesCss).toContain(':not(.svg-fight-scene)');
  });

  it('dot animation does NOT reference .svg-running-cat', () => {
    expect(chatMessagesCss).not.toContain(':not(.svg-running-cat)');
  });

  it('base dot selector has correct exclusions', () => {
    const baseSelector = chatMessagesCss.match(
      /\.typing-indicator > span:not\(\.typing-status-text\):not\(\.svg-fight-scene\)\s*\{/
    );
    expect(baseSelector).not.toBeNull();
  });

  it('nth-child(2) selector has correct exclusions', () => {
    const nthSelector = chatMessagesCss.match(
      /\.typing-indicator > span:not\(\.typing-status-text\):not\(\.svg-fight-scene\):nth-child\(2\)/
    );
    expect(nthSelector).not.toBeNull();
  });

  it('nth-child(3) selector has correct exclusions', () => {
    const nthSelector = chatMessagesCss.match(
      /\.typing-indicator > span:not\(\.typing-status-text\):not\(\.svg-fight-scene\):nth-child\(3\)/
    );
    expect(nthSelector).not.toBeNull();
  });
});
