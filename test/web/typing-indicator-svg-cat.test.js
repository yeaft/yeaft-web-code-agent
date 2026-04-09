/**
 * task-224: Typing indicator — SVG cat animation + remove thinking text.
 *
 * Test scenarios:
 * 1. Main chat → typing indicator has 3 dots + SVG cat, no text
 * 2. Split pane → same
 * 3. Crew chat → same
 * 4. Disconnected → dots + cat + "disconnected" text still displayed
 * 5. Dark theme → cat uses CSS variables for correct color adaptation
 *
 * Also verifies:
 * - Old CSS cat classes fully removed
 * - SVG cat markup consistent across all 3 components
 * - All non-thinking status texts preserved
 * - CSS animations defined for SVG cat
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
  // Find the closing </div> of the typing-indicator
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
// 1. Main chat (MessageList.js): 3 dots + SVG cat, no thinking text
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

  it('has svg-running-cat span with inline SVG', () => {
    expect(messageListSrc).toContain('class="svg-running-cat"');
    expect(messageListSrc).toContain('<svg viewBox="0 0 36 28"');
  });

  it('SVG cat has body, head, legs, tail, eyes, whiskers', () => {
    expect(messageListSrc).toContain('class="svg-cat-body"');
    expect(messageListSrc).toContain('class="svg-cat-head"');
    expect(messageListSrc).toContain('class="svg-cat-leg"');
    expect(messageListSrc).toContain('class="svg-cat-tail"');
    expect(messageListSrc).toContain('class="svg-cat-eye"');
    expect(messageListSrc).toContain('class="svg-cat-whisker"');
  });

  it('SVG cat has ears, pupils, nose, mouth', () => {
    expect(messageListSrc).toContain('class="svg-cat-ear"');
    expect(messageListSrc).toContain('class="svg-cat-pupil"');
    expect(messageListSrc).toContain('class="svg-cat-nose"');
    expect(messageListSrc).toContain('class="svg-cat-mouth"');
  });

  it('does NOT show thinking text', () => {
    expect(messageListSrc).not.toContain("waitingStatus === 'thinking'");
    expect(messageListSrc).not.toContain('typing-status-thinking');
    expect(messageListSrc).not.toContain('chat.waiting.thinking');
  });

  it('does NOT use old CSS-only cat markup (non-SVG)', () => {
    // Old CSS cat used class="running-cat" (not svg-running-cat)
    expect(messageListSrc).not.toContain('class="running-cat"');
    // Old CSS cat used div-based legs: cat-leg-front, cat-leg-back (not svg-cat-leg-*)
    expect(messageListSrc).not.toContain('cat-leg-front');
    expect(messageListSrc).not.toContain('cat-leg-back');
    // Old CSS cat used div elements with class="cat-body" etc. — SVG uses svg-cat-* prefix
    expect(messageListSrc).not.toMatch(/class="cat-body"/);
    expect(messageListSrc).not.toMatch(/class="cat-head"/);
    expect(messageListSrc).not.toMatch(/class="cat-ear"/);
  });

  it('SVG cat has aria-hidden for accessibility', () => {
    expect(messageListSrc).toContain('aria-hidden="true"');
    expect(messageListSrc).toContain('class="svg-running-cat"');
  });
});

// =============================================================================
// 2. Split pane (SplitPane.js): same SVG cat, no thinking text
// =============================================================================
describe('Scenario 2: SplitPane.js typing indicator', () => {
  it('has typing-indicator div', () => {
    expect(splitPaneSrc).toContain('class="typing-indicator"');
  });

  it('has svg-running-cat with inline SVG', () => {
    expect(splitPaneSrc).toContain('class="svg-running-cat"');
    expect(splitPaneSrc).toContain('<svg viewBox="0 0 36 28"');
  });

  it('has all SVG cat parts', () => {
    expect(splitPaneSrc).toContain('svg-cat-body');
    expect(splitPaneSrc).toContain('svg-cat-head');
    expect(splitPaneSrc).toContain('svg-cat-tail');
    expect(splitPaneSrc).toContain('svg-cat-eye');
    expect(splitPaneSrc).toContain('svg-cat-whisker');
    expect(splitPaneSrc).toContain('svg-cat-ear');
    expect(splitPaneSrc).toContain('svg-cat-pupil');
  });

  it('does NOT show thinking text', () => {
    expect(splitPaneSrc).not.toContain("waitingStatus === 'thinking'");
    expect(splitPaneSrc).not.toContain('typing-status-thinking');
  });

  it('does NOT use old CSS cat markup', () => {
    expect(splitPaneSrc).not.toContain('class="running-cat"');
  });
});

// =============================================================================
// 3. Crew chat (CrewChatView.js): same SVG cat, no thinking text
// =============================================================================
describe('Scenario 3: CrewChatView.js typing indicator', () => {
  it('has typing-indicator div', () => {
    expect(crewChatViewSrc).toContain('class="typing-indicator"');
  });

  it('has svg-running-cat with inline SVG', () => {
    expect(crewChatViewSrc).toContain('class="svg-running-cat"');
    expect(crewChatViewSrc).toContain('<svg viewBox="0 0 36 28"');
  });

  it('has all SVG cat parts', () => {
    expect(crewChatViewSrc).toContain('svg-cat-body');
    expect(crewChatViewSrc).toContain('svg-cat-head');
    expect(crewChatViewSrc).toContain('svg-cat-tail');
    expect(crewChatViewSrc).toContain('svg-cat-eye');
    expect(crewChatViewSrc).toContain('svg-cat-whisker');
  });

  it('does NOT show thinking text', () => {
    expect(crewChatViewSrc).not.toContain("waitingStatus === 'thinking'");
    expect(crewChatViewSrc).not.toContain('typing-status-thinking');
  });

  it('does NOT use old CSS cat markup', () => {
    expect(crewChatViewSrc).not.toContain('class="running-cat"');
  });
});

// =============================================================================
// 4. SVG cat consistency — identical across all 3 components
// =============================================================================
describe('SVG cat consistency across components', () => {
  function extractCatSvg(src) {
    const match = src.match(/<svg viewBox="0 0 36 28"[\s\S]*?<\/svg>/);
    if (!match) return '';
    // Normalize: remove comments and whitespace
    return match[0].replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim();
  }

  it('all 3 components have the cat SVG', () => {
    expect(extractCatSvg(messageListSrc).length).toBeGreaterThan(100);
    expect(extractCatSvg(splitPaneSrc).length).toBeGreaterThan(100);
    expect(extractCatSvg(crewChatViewSrc).length).toBeGreaterThan(100);
  });

  it('SplitPane SVG is identical to MessageList SVG', () => {
    expect(extractCatSvg(splitPaneSrc)).toBe(extractCatSvg(messageListSrc));
  });

  it('CrewChatView SVG is identical to MessageList SVG', () => {
    expect(extractCatSvg(crewChatViewSrc)).toBe(extractCatSvg(messageListSrc));
  });
});

// =============================================================================
// 5. Disconnected + other status texts still displayed
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
// 6. CSS: Old CSS cat fully removed, new SVG cat styles present
// =============================================================================
describe('CSS: Old cat removed, new SVG cat styles', () => {
  it('old .running-cat class removed', () => {
    // Should NOT have the old class definition (not as substring of .svg-running-cat)
    expect(chatMessagesCss).not.toMatch(/^\.running-cat\s*\{/m);
  });

  it('old .cat-body class removed (only svg-cat-body remains)', () => {
    // Match .cat-body NOT preceded by "svg-" — the old standalone class
    expect(chatMessagesCss).not.toMatch(/(?<!svg-)\.cat-body/);
  });

  it('old .cat-head class removed (only svg-cat-head remains)', () => {
    expect(chatMessagesCss).not.toMatch(/(?<!svg-)\.cat-head/);
  });

  it('old .cat-ear class removed', () => {
    expect(chatMessagesCss).not.toMatch(/\.cat-ear[^-]/);
  });

  it('old .cat-tail class removed', () => {
    expect(chatMessagesCss).not.toMatch(/\.cat-tail[^-]/);
  });

  it('old .cat-leg class removed', () => {
    expect(chatMessagesCss).not.toMatch(/\.cat-leg[^-]/);
  });

  it('old cat-bounce keyframes removed', () => {
    expect(chatMessagesCss).not.toContain('@keyframes cat-bounce');
  });

  it('old cat-leg-run keyframes removed', () => {
    expect(chatMessagesCss).not.toContain('@keyframes cat-leg-run');
  });

  it('old cat-tail-wag keyframes removed', () => {
    expect(chatMessagesCss).not.toContain('@keyframes cat-tail-wag');
  });

  it('new .svg-running-cat class exists', () => {
    expect(chatMessagesCss).toContain('.svg-running-cat');
  });

  it('new SVG cat body styles exist', () => {
    expect(chatMessagesCss).toContain('.svg-cat-body');
    expect(chatMessagesCss).toContain('.svg-cat-head');
    expect(chatMessagesCss).toContain('.svg-cat-ear');
    expect(chatMessagesCss).toContain('.svg-cat-eye');
    expect(chatMessagesCss).toContain('.svg-cat-pupil');
    expect(chatMessagesCss).toContain('.svg-cat-nose');
    expect(chatMessagesCss).toContain('.svg-cat-mouth');
    expect(chatMessagesCss).toContain('.svg-cat-whisker');
    expect(chatMessagesCss).toContain('.svg-cat-tail');
    expect(chatMessagesCss).toContain('.svg-cat-leg');
  });
});

// =============================================================================
// 7. CSS animations for SVG cat
// =============================================================================
describe('CSS: SVG cat animations', () => {
  it('has bounce animation', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-cat-bounce');
  });

  it('has front leg animations (left + right)', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-leg-front-l');
    expect(chatMessagesCss).toContain('@keyframes svg-leg-front-r');
  });

  it('has back leg animations (left + right)', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-leg-back-l');
    expect(chatMessagesCss).toContain('@keyframes svg-leg-back-r');
  });

  it('has tail wag animation', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-tail-wag');
  });

  it('has ear twitch animations (left + right)', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-ear-twitch-l');
    expect(chatMessagesCss).toContain('@keyframes svg-ear-twitch-r');
  });

  it('legs use transform-origin for rotation pivot', () => {
    expect(chatMessagesCss).toContain('.svg-cat-leg-fl { transform-origin:');
    expect(chatMessagesCss).toContain('.svg-cat-leg-fr { transform-origin:');
    expect(chatMessagesCss).toContain('.svg-cat-leg-bl { transform-origin:');
    expect(chatMessagesCss).toContain('.svg-cat-leg-br { transform-origin:');
  });

  it('tail group has animation', () => {
    expect(chatMessagesCss).toContain('.svg-cat-tail-group { transform-origin:');
    expect(chatMessagesCss).toContain('animation: svg-tail-wag');
  });

  it('ears have independent animation timings', () => {
    const earL = chatMessagesCss.match(/\.svg-cat-ear-l\s*\{[^}]*animation:[^}]*(\d+\.?\d*)s/);
    const earR = chatMessagesCss.match(/\.svg-cat-ear-r\s*\{[^}]*animation:[^}]*(\d+\.?\d*)s/);
    expect(earL).toBeTruthy();
    expect(earR).toBeTruthy();
    // Ears should have different timings for natural look
    expect(earL[1]).not.toBe(earR[1]);
  });

  it('front legs alternate phases (alternate vs alternate-reverse)', () => {
    expect(chatMessagesCss).toMatch(/svg-cat-leg-fl[\s\S]*?infinite\s+alternate(?!-)/);
    expect(chatMessagesCss).toMatch(/svg-cat-leg-fr[\s\S]*?alternate-reverse/);
  });
});

// =============================================================================
// 8. Scenario 5: Dark theme — cat uses CSS variables
// =============================================================================
describe('Scenario 5: Dark theme color adaptation via CSS variables', () => {
  it('cat body uses var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-body\s*\{[^}]*fill:\s*var\(--text-secondary\)/);
  });

  it('cat head uses var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-head\s*\{[^}]*fill:\s*var\(--text-secondary\)/);
  });

  it('cat ear uses var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-ear\b[^{]*\{[^}]*fill:\s*var\(--text-secondary\)/);
  });

  it('cat eye uses var(--cat-eye-fill) for sclera (themed per light/dark)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-eye\s*\{[^}]*fill:\s*var\(--cat-eye-fill\)/);
  });

  it('cat pupil uses var(--cat-pupil-fill) for contrast (themed per light/dark)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-pupil\s*\{[^}]*fill:\s*var\(--cat-pupil-fill\)/);
  });

  it('cat whiskers use var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-whisker\s*\{[^}]*stroke:\s*var\(--text-secondary\)/);
  });

  it('cat tail uses var(--text-secondary) stroke', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-tail\b[^{]*\{[^}]*stroke:\s*var\(--text-secondary\)/);
  });

  it('cat legs use var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg\b[^{]*\{[^}]*fill:\s*var\(--text-secondary\)/);
  });

  it('no hardcoded colors — all fills/strokes use CSS variables', () => {
    // Extract all svg-cat rule blocks from CSS
    // Use line-start matching to capture full selectors including status prefixes
    const allLines = chatMessagesCss.split('\n');
    const catStyles = [];
    for (const line of allLines) {
      // Match lines that define svg-cat rules with { ... }
      const m = line.match(/^([^{]*\.svg-cat[^{]*)\{([^}]*)\}/);
      if (m) catStyles.push({ selector: m[1], body: m[2] });
    }
    // Exclude status-override rules which intentionally use hardcoded rgba colors
    const baseStyles = catStyles.filter(s => !s.selector.includes('.typing-indicator'));
    for (const { body } of baseStyles) {
      const fills = body.match(/fill:\s*[^;]+/g) || [];
      const strokes = body.match(/stroke:\s*[^;]+/g) || [];
      for (const decl of [...fills, ...strokes]) {
        // Each fill/stroke should use var() or 'none'
        expect(decl).toMatch(/var\(--|none/);
      }
    }
  });
});

// =============================================================================
// 9. Dot animation selector updated — excludes .svg-cat-walk (walk wrapper is direct child of typing-indicator)
// =============================================================================
describe('Dot animation selector updated', () => {
  it('dot animation excludes .svg-cat-walk (walk wrapper that is direct child)', () => {
    expect(chatMessagesCss).toContain(':not(.svg-cat-walk)');
    expect(chatMessagesCss).not.toContain(':not(.running-cat)');
  });

  it('nth-child selectors for dot delays use updated exclusion', () => {
    expect(chatMessagesCss).toContain(':not(.svg-cat-walk):nth-child(2)');
    expect(chatMessagesCss).toContain(':not(.svg-cat-walk):nth-child(3)');
  });
});

// =============================================================================
// 10. SVG cat sizing
// =============================================================================
describe('SVG cat sizing', () => {
  it('cat container width is 32px (within 24-32px range)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-running-cat\s*\{[^}]*width:\s*32px/);
  });

  it('cat container height is 26px (within 24-32px range)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-running-cat\s*\{[^}]*height:\s*26px/);
  });

  it('cat has margin-left for spacing from dots', () => {
    expect(chatMessagesCss).toMatch(/\.svg-running-cat\s*\{[^}]*margin-left:\s*8px/);
  });

  it('SVG overflow is visible (for animations that extend beyond viewBox)', () => {
    expect(chatMessagesCss).toContain('overflow: visible');
  });
});
