/**
 * task-302 — ThreadPill component tests.
 *
 * Mix of two styles:
 *   1. Source-analysis tests (reading component source to verify contract)
 *      — matches existing test/web/unify-*.test.js patterns that don't
 *        require a JSDOM/Vue test harness.
 *   2. A pure-function shouldRender test that can be evaluated without
 *      mounting Vue, validating the render-skip logic.
 *
 * Spec (from task-302 ROUTE):
 *   - threadId='main' → not rendered
 *   - threadId='design' → renders "#design"
 *   - threadId null/undefined → not rendered
 *   - CSS class contains 'unify-thread-pill'
 *   - No border-left / no border-bottom (no colored vertical bar, no divider)
 *   - AssistantTurn mounts ThreadPill and passes turn.threadId
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');

const pillSrc = readFileSync(join(root, 'web/components/ThreadPill.js'), 'utf8');
const pillCss = readFileSync(join(root, 'web/styles/unify-thread-pill.css'), 'utf8');
const assistantTurnSrc = readFileSync(join(root, 'web/components/AssistantTurn.js'), 'utf8');
const messageListSrc = readFileSync(join(root, 'web/components/MessageList.js'), 'utf8');
const indexCssSrc = readFileSync(join(root, 'web/styles/index.css'), 'utf8');

// ─── Render-logic reconstruction ─────────────────────────────
// Mirror the shouldRender rule from ThreadPill.js so we can unit-test the
// rule without a Vue mount. This is kept in sync with the component via
// the source-analysis assertions below.
function shouldRenderPill(threadId) {
  if (!threadId) return false;
  if (threadId === 'main') return false;
  return true;
}

describe('ThreadPill — render rule', () => {
  it("does not render when threadId is 'main'", () => {
    expect(shouldRenderPill('main')).toBe(false);
  });

  it('does not render when threadId is null', () => {
    expect(shouldRenderPill(null)).toBe(false);
  });

  it('does not render when threadId is undefined', () => {
    expect(shouldRenderPill(undefined)).toBe(false);
  });

  it('does not render when threadId is empty string', () => {
    expect(shouldRenderPill('')).toBe(false);
  });

  it("renders when threadId is a non-main value like 'design'", () => {
    expect(shouldRenderPill('design')).toBe(true);
  });

  it('renders when threadId is any other arbitrary thread id', () => {
    expect(shouldRenderPill('t-abc123')).toBe(true);
  });
});

describe('ThreadPill — component source contract', () => {
  it('exports a Vue component named ThreadPill', () => {
    expect(pillSrc).toMatch(/name:\s*['"]ThreadPill['"]/);
  });

  it('uses CSS class "unify-thread-pill"', () => {
    expect(pillSrc).toContain('unify-thread-pill');
  });

  it("guards render with threadId === 'main' skip", () => {
    expect(pillSrc).toContain("=== 'main'");
  });

  it('prefixes display name with "#" in the template', () => {
    expect(pillSrc).toMatch(/#\{\{\s*displayName\s*\}\}/);
  });

  it('declares threadId and threadName props', () => {
    expect(pillSrc).toContain('threadId');
    expect(pillSrc).toContain('threadName');
  });

  it('falls back to threadId when threadName is not provided', () => {
    // displayName = threadName || threadId
    expect(pillSrc).toMatch(/threadName\s*\|\|\s*props\.threadId/);
  });
});

describe('ThreadPill — CSS design constraints', () => {
  it('defines .unify-thread-pill class', () => {
    expect(pillCss).toContain('.unify-thread-pill');
  });

  it('does NOT use border-left (no colored vertical bar)', () => {
    expect(pillCss).not.toMatch(/border-left\s*:/);
  });

  it('does NOT use border-bottom (no horizontal divider)', () => {
    expect(pillCss).not.toMatch(/border-bottom\s*:/);
  });

  it('does NOT use any border shorthand (no border: ...)', () => {
    // Matches "border:" but not "border-radius:" / "border-left:" etc.
    expect(pillCss).not.toMatch(/(^|\s)border\s*:/m);
  });

  it('uses a small font-size (11px) per spec', () => {
    expect(pillCss).toMatch(/font-size:\s*11px/);
  });

  it('uses muted text colour (var(--text-muted))', () => {
    expect(pillCss).toContain('var(--text-muted)');
  });

  it('uses a subtle background (not a strong accent)', () => {
    // The variable we chose is --bg-user-msg which is the same subtle
    // surface used for user message bubbles — verifies we did not pick
    // a primary/accent colour.
    expect(pillCss).toContain('var(--bg-user-msg)');
    expect(pillCss).not.toMatch(/background\s*:\s*(red|blue|#[0-9a-f]{3,6})/i);
  });

  it('is imported from the global CSS entry point', () => {
    expect(indexCssSrc).toContain("@import './unify-thread-pill.css'");
  });
});

describe('AssistantTurn — ThreadPill integration', () => {
  it('imports ThreadPill component', () => {
    expect(assistantTurnSrc).toContain("import ThreadPill from './ThreadPill.js'");
  });

  it('registers ThreadPill in components', () => {
    expect(assistantTurnSrc).toMatch(/components:\s*\{[^}]*ThreadPill[^}]*\}/);
  });

  it('mounts <ThreadPill> inside the turn header', () => {
    // Header block contains the pill before the copy button
    const headerSlice = assistantTurnSrc.slice(
      assistantTurnSrc.indexOf('class="turn-header"'),
      assistantTurnSrc.indexOf('class="turn-text'),
    );
    expect(headerSlice).toContain('ThreadPill');
    expect(headerSlice).toContain(':thread-id="turn.threadId"');
  });

  it('passes a threadDisplayName computed to ThreadPill', () => {
    expect(assistantTurnSrc).toContain('threadDisplayName');
    expect(assistantTurnSrc).toMatch(/:thread-name="threadDisplayName"/);
  });

  it('threadDisplayName falls back to threadId (Phase 1)', () => {
    // Returns '' for main/empty, otherwise the id itself
    expect(assistantTurnSrc).toMatch(/const\s+threadDisplayName\s*=\s*Vue\.computed/);
    expect(assistantTurnSrc).toMatch(/id\s*===\s*'main'/);
  });
});

describe('MessageList — captures threadId on turns', () => {
  it('initializes turn.threadId to null in startTurn()', () => {
    const startTurnSlice = messageListSrc.slice(
      messageListSrc.indexOf('const startTurn ='),
      messageListSrc.indexOf('};', messageListSrc.indexOf('const startTurn =')) + 2,
    );
    expect(startTurnSlice).toContain('threadId: null');
  });

  it('latches the first assistant message threadId onto the turn', () => {
    // In the `msg.type === 'assistant'` branch we copy msg.threadId
    const assistantBranch = messageListSrc.slice(
      messageListSrc.indexOf("msg.type === 'assistant'"),
      messageListSrc.indexOf("msg.type === 'tool-use'"),
    );
    expect(assistantBranch).toMatch(/currentTurn\.threadId\s*=\s*msg\.threadId/);
  });
});
