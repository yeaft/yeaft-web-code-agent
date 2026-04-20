/**
 * task-334-ui-b — VP speaker header on message bubbles.
 *
 * Source-level acceptance for:
 *   S-b1  VpSpeakerHeader component exists and renders VpBadge (24px, with
 *         subtitle) — reuses 334-ui-a primitives, does NOT reinvent them.
 *   S-b2  AssistantTurn conditionally renders VpSpeakerHeader (gated on
 *         `turn.speakerVpId` + `turn.showSpeakerHeader`).
 *   S-b3  MessageList turnGroups: latches `speakerVpId` from the first
 *         assistant msg in the turn; wires `lastStateChangeCause` + timestamp.
 *   S-b4  MessageList collapse-on-consecutive: same speaker → header hidden
 *         on later turns until a non-VP row (user/system/error) breaks the streak.
 *   S-b5  Multi-VP gate: speaker header only emitted when
 *         `store.unifyStatus.multiVp` is truthy (feature flag). Legacy 1:1
 *         turns never render the header.
 *   S-b6  chat store mirrors `multiVp` onto unifyStatus from session_ready.
 *   S-b7  CSS tokens: .vp-speaker-header defined in unify-vp.css with dark-
 *         mode coverage via --text-secondary / --vp-status-busy.
 *   S-b8  i18n: en + zh-CN both carry `unify.vp.speaker.stateCauseAria`.
 *   S-b9  @ routing UI is untouched (hard constraint from PM).
 *   S-b10 vp live-diff store mechanism is untouched (hard constraint).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const speakerHeaderSrc = read('web/components/VpSpeakerHeader.js');
const assistantTurnSrc = read('web/components/AssistantTurn.js');
const messageListSrc   = read('web/components/MessageList.js');
const chatStoreSrc     = read('web/stores/chat.js');
const unifyVpCssSrc    = read('web/styles/unify-vp.css');
const enI18nSrc        = read('web/i18n/en.js');
const zhI18nSrc        = read('web/i18n/zh-CN.js');
const vpStoreSrc       = read('web/stores/vp.js');

// ─────────────────────────────────────────────────────────────
// S-b1 — VpSpeakerHeader component
// ─────────────────────────────────────────────────────────────
describe('VpSpeakerHeader — reuses 334-ui-a primitives (S-b1)', () => {
  it('imports VpBadge (does NOT import VpAvatar directly — goes through VpBadge)', () => {
    expect(speakerHeaderSrc).toMatch(/import\s+VpBadge\s+from\s+['"]\.\/VpBadge\.js['"]/);
    // Speaker header should NOT reach around VpBadge to VpAvatar — VpBadge
    // is the composite wrapper and our consumption point.
    expect(speakerHeaderSrc).not.toMatch(/import\s+VpAvatar/);
  });

  it('renders VpBadge at 24px with subtitle (avatar + name + role two-liner)', () => {
    expect(speakerHeaderSrc).toMatch(/<VpBadge[^>]*:vp-id="vpId"[^>]*:size="24"[^>]*:show-subtitle="true"/s);
  });

  it('conditional state-cause dot uses native `title` for the tooltip', () => {
    expect(speakerHeaderSrc).toMatch(/v-if="stateCause"/);
    expect(speakerHeaderSrc).toMatch(/:title="stateCause"/);
  });

  it('short time is derived from props.timestamp (HH:MM, locale-driven)', () => {
    expect(speakerHeaderSrc).toMatch(/toLocaleTimeString/);
    expect(speakerHeaderSrc).toMatch(/hour:\s*['"]2-digit['"]/);
    expect(speakerHeaderSrc).toMatch(/minute:\s*['"]2-digit['"]/);
  });

  it('vpId is required — the header has no meaning without one', () => {
    expect(speakerHeaderSrc).toMatch(/vpId:\s*\{\s*type:\s*String,\s*required:\s*true/);
  });
});

// ─────────────────────────────────────────────────────────────
// S-b2 — AssistantTurn gating
// ─────────────────────────────────────────────────────────────
describe('AssistantTurn — conditional speaker header (S-b2)', () => {
  it('imports and registers VpSpeakerHeader', () => {
    expect(assistantTurnSrc).toMatch(/import\s+VpSpeakerHeader\s+from\s+['"]\.\/VpSpeakerHeader\.js['"]/);
    expect(assistantTurnSrc).toMatch(/components:\s*\{[^}]*VpSpeakerHeader[^}]*\}/);
  });

  it('renders VpSpeakerHeader only when BOTH flags are true (speakerVpId + showSpeakerHeader)', () => {
    expect(assistantTurnSrc).toMatch(/v-if="turn\.showSpeakerHeader\s*&&\s*turn\.speakerVpId"/);
  });

  it('passes speakerVpId, timestamp and stateCause to the header', () => {
    expect(assistantTurnSrc).toMatch(/:vp-id="turn\.speakerVpId"/);
    expect(assistantTurnSrc).toMatch(/:timestamp="turn\.speakerTimestamp\s*\|\|\s*0"/);
    expect(assistantTurnSrc).toMatch(/:state-cause="turn\.speakerStateCause\s*\|\|\s*''"/);
  });

  it('adds a `has-vp-speaker` root modifier class for CSS to tighten spacing', () => {
    expect(assistantTurnSrc).toMatch(/'has-vp-speaker':\s*!!turn\.speakerVpId/);
  });
});

// ─────────────────────────────────────────────────────────────
// S-b3 + S-b4 — MessageList turn aggregation / collapse logic
// ─────────────────────────────────────────────────────────────
describe('MessageList — turn aggregation + collapse (S-b3, S-b4)', () => {
  it('latches speakerVpId from the FIRST assistant message that carries one', () => {
    // "!currentTurn.speakerVpId && msg.speakerVpId" means we only latch once
    expect(messageListSrc).toMatch(/!currentTurn\.speakerVpId\s*&&\s*msg\.speakerVpId/);
  });

  it('captures lastStateChangeCause (334c O2) when present', () => {
    expect(messageListSrc).toMatch(/msg\.lastStateChangeCause/);
    expect(messageListSrc).toMatch(/speakerStateCause\s*=\s*msg\.lastStateChangeCause/);
  });

  it('initializes speakerVpId/speakerTimestamp/speakerStateCause/showSpeakerHeader on turn start', () => {
    expect(messageListSrc).toMatch(/speakerVpId:\s*null/);
    expect(messageListSrc).toMatch(/speakerTimestamp:\s*0/);
    expect(messageListSrc).toMatch(/speakerStateCause:\s*''/);
    expect(messageListSrc).toMatch(/showSpeakerHeader:\s*false/);
  });

  it('resolves showSpeakerHeader at finishTurn() — compares against lastShownSpeakerVpId', () => {
    expect(messageListSrc).toMatch(/lastShownSpeakerVpId/);
    expect(messageListSrc).toMatch(/currentTurn\.speakerVpId\s*!==\s*lastShownSpeakerVpId/);
  });

  it('resets the streak when a user / system / error row breaks the sequence', () => {
    // Two reset sites (one for user, one for system|error).
    const matches = messageListSrc.match(/lastShownSpeakerVpId\s*=\s*null/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps header hidden for legacy Chat turns (no speakerVpId field)', () => {
    // When multiVp is off OR speakerVpId is null, showSpeakerHeader MUST be false.
    expect(messageListSrc).toMatch(/else\s*\{\s*currentTurn\.showSpeakerHeader\s*=\s*false;\s*\}/);
  });
});

// ─────────────────────────────────────────────────────────────
// S-b5 — feature flag gating in MessageList
// ─────────────────────────────────────────────────────────────
describe('MessageList — multi-VP feature flag gate (S-b5)', () => {
  it('reads multiVp flag via store.unifyStatus.multiVp', () => {
    expect(messageListSrc).toMatch(/store\.unifyStatus\s*&&\s*store\.unifyStatus\.multiVp/);
  });

  it('header only emitted when multiVpEnabled AND speakerVpId are both truthy', () => {
    expect(messageListSrc).toMatch(/if\s*\(multiVpEnabled\.value\s*&&\s*currentTurn\.speakerVpId\)/);
  });
});

// ─────────────────────────────────────────────────────────────
// S-b6 — chat store mirrors multiVp flag
// ─────────────────────────────────────────────────────────────
describe('chat store — session_ready mirrors multiVp (S-b6)', () => {
  it('unifyStatus contains multiVp boolean', () => {
    expect(chatStoreSrc).toMatch(/multiVp:\s*!!event\.multiVp/);
  });
});

// ─────────────────────────────────────────────────────────────
// S-b7 — CSS
// ─────────────────────────────────────────────────────────────
describe('unify-vp.css — speaker header styles (S-b7)', () => {
  it('defines .vp-speaker-header with light visual weight (no border/rule)', () => {
    expect(unifyVpCssSrc).toMatch(/\.vp-speaker-header\s*\{/);
    // CLAUDE.md Unify rule: no horizontal dividers / borders.
    const block = unifyVpCssSrc.match(/\.vp-speaker-header\s*\{[^}]*\}/);
    expect(block).toBeTruthy();
    expect(block[0]).not.toMatch(/border(-top|-bottom)?\s*:\s*(?!none)/);
  });

  it('time uses --text-secondary (dark-mode friendly)', () => {
    expect(unifyVpCssSrc).toMatch(/\.vp-speaker-time[\s\S]*var\(--text-secondary/);
  });

  it('state-cause dot uses --vp-status-busy (already dark-mode-aware from 334-ui-a)', () => {
    expect(unifyVpCssSrc).toMatch(/\.vp-speaker-state-cause[\s\S]*--vp-status-busy/);
  });

  it('dark-mode selector tunes the timestamp color', () => {
    expect(unifyVpCssSrc).toMatch(/\[data-theme="dark"\][\s\S]*\.vp-speaker-time/);
  });

  it('tightens top padding on assistant turn when speaker header is present', () => {
    expect(unifyVpCssSrc).toMatch(/\.assistant-turn\.has-vp-speaker[\s\S]*margin-top/);
  });
});

// ─────────────────────────────────────────────────────────────
// S-b8 — i18n coverage
// ─────────────────────────────────────────────────────────────
describe('i18n — speaker header keys (S-b8)', () => {
  it('en provides unify.vp.speaker.stateCauseAria', () => {
    expect(enI18nSrc).toMatch(/['"]unify\.vp\.speaker\.stateCauseAria['"]/);
  });
  it('zh-CN provides unify.vp.speaker.stateCauseAria', () => {
    expect(zhI18nSrc).toMatch(/['"]unify\.vp\.speaker\.stateCauseAria['"]/);
  });
});

// ─────────────────────────────────────────────────────────────
// S-b9 / S-b10 — hard constraints
// ─────────────────────────────────────────────────────────────
describe('hard constraints — untouched scope (S-b9, S-b10)', () => {
  it('does NOT introduce any @-route UI in the speaker-header path (334d scope)', () => {
    // Speaker-header component must not bake @ routing into its surface.
    expect(speakerHeaderSrc).not.toMatch(/route_forward|@all\b/);
  });

  it('does NOT add vp live-diff handling in MessageList (334h scope)', () => {
    // MessageList is presentation only — live-diff goes through the vp store.
    expect(messageListSrc).not.toMatch(/vp_updated|vp_removed/);
  });

  it('does NOT reinvent VpAvatar / VpBadge — the speaker header imports the existing ones', () => {
    // Guard: we never duplicate the store's color palette or avatar letter
    // helpers into the speaker header.
    expect(speakerHeaderSrc).not.toMatch(/VP_PALETTE|fallbackColor/);
    // vp store remains the single source of VP-derived visuals.
    expect(vpStoreSrc).toMatch(/VP_PALETTE/);
  });
});
