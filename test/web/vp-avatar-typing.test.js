/**
 * task-708 — VpAvatar / VpBadge / VpSpeakerHeader typing-as-badge contract.
 *
 * The fix moves the typing indicator from a standalone pre-turn row + an
 * inline dot row inside the speaker header onto the AVATAR ITSELF, as a
 * small absolute-positioned badge. This guarantees:
 *
 *   • The avatar is visible from the moment `vp_typing_start` fires
 *     until the VP's last text chunk lands — no flash, no disappearance.
 *   • Consecutive turns from the same VP no longer collapse the header
 *     (`MessageList.js` aggregator drops `lastShownSpeakerVpId`).
 *   • Typing reads as "this VP is mid-typing" via a badge ON the
 *     avatar — distinct from the green/orange status dot, which keeps
 *     priority when both `status` and `typing` are passed.
 *
 * The components are Vue Options API string-template files using a CDN
 * Vue at runtime. We don't run a full Vue render here — instead we
 * assert against the static template / props contract by reading the
 * source file. This is the same shape some existing helpers tests use
 * (no DOM, no Pinia, no Vue mount overhead) and gives us a fast
 * regression net for the prop / class wiring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

describe('VpAvatar — typing prop + badge contract', () => {
  const src = read('web/components/VpAvatar.js');

  it('declares a typing prop (Boolean, default false)', () => {
    // Looking for the literal prop declaration. Format mirrors the
    // existing `status: { type: String, default: null }` line.
    expect(src).toMatch(/typing:\s*\{\s*type:\s*Boolean,\s*default:\s*false/);
  });

  it('renders .vp-avatar-typing-badge when typing is true and status is unset', () => {
    // The template uses `v-else-if="typing"` after the status-dot
    // branch — that's the precedence rule (status > typing).
    expect(src).toContain('vp-avatar-typing-badge');
    expect(src).toMatch(/v-else-if="typing"/);
  });

  it('renders three .vp-avatar-typing-dot children inside the badge', () => {
    // Three dots is the minimum for the bouncing animation; fewer
    // would break the existing `:nth-child(1|2|3)` keyframe stagger.
    const dotMatches = src.match(/vp-avatar-typing-dot/g) || [];
    expect(dotMatches.length).toBeGreaterThanOrEqual(3);
  });

  it('does NOT render the typing badge when status is set (status wins)', () => {
    // The template structure must place the typing branch under
    // v-else-if so the status-dot v-if takes precedence.
    expect(src).toMatch(/v-if="status === 'online' \|\| status === 'busy'"[\s\S]+?v-else-if="typing"/);
  });
});

describe('VpBadge — text-only VP identity', () => {
  const src = read('web/components/VpBadge.js');

  it('keeps the typing prop for API compatibility but no longer renders VpAvatar', () => {
    expect(src).toMatch(/typing:\s*\{\s*type:\s*Boolean,\s*default:\s*false/);
    expect(src).not.toMatch(/<VpAvatar\b/);
    expect(src).toMatch(/class="vp-badge-name"\s+:style="nameStyle"/);
  });
});

describe('VpSpeakerHeader — passes :typing to VpBadge, drops inline dot row', () => {
  const src = read('web/components/VpSpeakerHeader.js');

  it('forwards :typing="isTyping" to VpBadge', () => {
    expect(src).toMatch(/<VpBadge[\s\S]*?:typing="isTyping"/);
  });

  it('no longer renders the inline <span class="vp-speaker-typing"> dot row', () => {
    // The pre-fix template had `<span v-if="isTyping" class="vp-speaker-typing">`
    // with three .dot children. Moving typing to the avatar badge means
    // this row should be gone — leaving it would show TWO typing
    // indicators (badge + inline dots) for the same VP.
    expect(src).not.toContain('vp-speaker-typing');
  });

  it('still computes isTyping from chat.isVpTypingInCurrentConv', () => {
    // The store getter is the source of truth — keep that wiring.
    expect(src).toContain('isVpTypingInCurrentConv');
  });
});

describe('MessageList — standalone vp-typing-row removed', () => {
  const src = read('web/components/MessageList.js');

  it('no longer renders <div ... class="vp-typing-row">', () => {
    // The standalone pre-turn row flashed in/out — removed in
    // task-708. The avatar on the in-flight AssistantTurn carries the
    // typing badge instead.
    //
    // The class name still appears in the explanatory comment we left
    // for future readers, so we look specifically for the rendering
    // shape: a <div ... class="vp-typing-row"> tag, not a bare string.
    expect(src).not.toMatch(/<div[^>]*class="vp-typing-row"/);
  });

  it('does not iterate vpTypingIds in the template', () => {
    // The computed itself may still exist as long as nothing in the
    // rendered template references it. The bug was the template
    // `v-for="vpId in vpTypingIds"` — that must be gone.
    expect(src).not.toMatch(/v-for="vpId in vpTypingIds"/);
  });
});

describe('MessageList aggregator — every VP turn keeps its avatar (no collapse)', () => {
  const src = read('web/components/MessageList.js');

  it('removed the lastShownSpeakerVpId tracking variable', () => {
    // The pre-fix aggregator hid the avatar on the 2nd+ consecutive
    // turn from the same VP — that's the "VP disappears after the
    // first message" bug. Drop the variable entirely.
    expect(src).not.toContain('lastShownSpeakerVpId');
  });

  it('shows the speaker header on every VP-attributed turn', () => {
    // The new rule mirrors `web/stores/helpers/turn-groups.js:62`:
    //   showSpeakerHeader = !!currentTurn.speakerVpId
    // Stricter than a regex match, but a literal substring works
    // because we control the new code.
    expect(src).toContain('currentTurn.showSpeakerHeader = !!currentTurn.speakerVpId');
  });

  it('does NOT call appendTypingPlaceholders from the active pipeline (v0.1.757)', () => {
    // Earlier (PR-720) MessageList synthesised a placeholder pseudo-turn
    // for any typing VP without an in-flight assistant-turn so the avatar
    // appeared the moment `vp_typing_start` fired. That placeholder
    // rendered as a *standalone* card at the bottom of the conversation,
    // which (a) duplicated the VP block once the first chunk landed and
    // (b) hung around as an orphan "typing dots" card after a
    // route_forward sender (Jobs) had finished but no longer had its own
    // streaming block. v0.1.757 removed the call from MessageList; the
    // VpTurnBlock's own typing badge (driven by
    // `isVpTypingInCurrentConv`) now carries the indicator.
    //
    // The pure helper at `web/stores/helpers/typing-placeholders.js` is
    // kept (its unit tests still pass) so the logic remains available
    // if we want to revive a placeholder pattern later — but the live
    // pipeline must not invoke it.
    expect(src).not.toContain('appendTypingPlaceholders(');
  });

  // task-vp-header-pos: the speaker latch must run for ANY message that
  // carries routing context, not just `type==='assistant'`. A turn that
  // opens with a tool_call (no preceding text_delta) used to be left
  // with `speakerVpId === null` → the placeholder synthesis pushed an
  // EXTRA turn AFTER the tool-bearing turn (avatar below tools), and
  // when typing-end cleared the placeholder the real turn never had a
  // header (avatar disappeared).
  it('factors out a latchSpeakerFromMsg helper used in every branch', () => {
    expect(src).toContain('const latchSpeakerFromMsg = (msg)');
  });

  it('calls the latch in the assistant, tool-use, and chat-image branches', () => {
    // Three call sites guarantee a turn that opens with any of the
    // three kinds of message still gets its speakerVpId latched.
    const calls = src.match(/latchSpeakerFromMsg\(msg\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('latch falls back to msg.vpId when speakerVpId is missing', () => {
    // Stored tool-use messages may carry only `vpId` (the routing tag),
    // not `speakerVpId` — the latch must still resolve to the VP.
    expect(src).toMatch(/msg\.speakerVpId\s*\|\|\s*msg\.vpId/);
  });
});

describe('CSS — typing badge styles + obsolete rules pruned', () => {
  const src = read('web/styles/yeaft-vp.css');

  it('defines .vp-avatar-typing-badge and .vp-avatar-typing-dot', () => {
    expect(src).toContain('.vp-avatar-typing-badge');
    expect(src).toContain('.vp-avatar-typing-dot');
  });

  it('pruned the .vp-typing-row standalone-row block', () => {
    // The block was only used by the now-deleted MessageList row.
    // Leaving it would be dead CSS.
    expect(src).not.toMatch(/^\.vp-typing-row\s*\{/m);
  });

  it('pruned the .vp-speaker-typing inline-row block', () => {
    expect(src).not.toMatch(/^\.vp-speaker-typing\s*\{/m);
    expect(src).not.toMatch(/^\.vp-speaker-typing \.dot/m);
  });

  it('keeps @keyframes vp-typing-bounce (reused by the new badge)', () => {
    expect(src).toContain('@keyframes vp-typing-bounce');
  });
});

describe('chat.js::changeLocale — propagates language to agent', () => {
  const src = read('web/stores/chat.js');

  it('calls sendWsMessage with type:update_llm_config when yeaftAgentId is set', () => {
    // The fix wraps the WS send in `if (this.yeaftAgentId) { ... }`.
    // Both the guard and the payload shape are part of the contract.
    expect(src).toMatch(/changeLocale\(locale\)\s*\{[\s\S]*?if\s*\(\s*this\.yeaftAgentId\s*\)/);
    expect(src).toMatch(/changeLocale\(locale\)\s*\{[\s\S]*?type:\s*['"]update_llm_config['"]/);
    expect(src).toMatch(/changeLocale\(locale\)\s*\{[\s\S]*?language:\s*locale/);
  });
});
