/**
 * Forward-only VP turn rendering — current policy (v0.1.776).
 *
 * History:
 *   - v0.1.757: a VP whose only product was a `route_forward` hand-off
 *     was HIDDEN from the message stream. The persisted record lived on
 *     disk for audit, but the bubble was suppressed so users wouldn't
 *     see Jobs's empty turn with leftover tool chips before Linus
 *     started talking.
 *   - v0.1.776 (this test): user reported that hiding Jobs entirely
 *     made Linus's appearance feel disconnected — there was no UI
 *     signal saying "Jobs handed off to Linus". New policy: the
 *     forward-source VP's block is STILL RENDERED, but body-less.
 *     Speaker header + a single hand-off pill ("↪ forwarded to Linus")
 *     is the entire surface. Internal tools the VP ran while deciding
 *     to forward are stripped at render time via the
 *     `renderHandoffOnly` flag — toolMsgs itself stays intact so the
 *     audit trail matches what's on disk.
 *
 * Layer 1 (source pins) — guarantee the policy stays declared at the
 *   right place with the right shape so future refactors don't
 *   accidentally re-hide forward-only turns.
 *
 * Layer 2 (logic replica) — exercises the predicate against fixtures.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf-8');

// ─── Layer 1: source pins ───────────────────────────────────────────

describe('MessageList.turnGroups — forward-only rendering policy (source)', () => {
  const src = read('web/components/MessageList.js');

  it('defines a `forwardOnly` flag inside finishTurn', () => {
    expect(src).toMatch(/const\s+forwardOnly\s*=/);
  });

  it('forwardOnly = handoffHints present AND no user-visible content', () => {
    expect(src).toMatch(/forwardOnly\s*=\s*hasHandoff\s*&&\s*!hasVisible/);
  });

  it('hasVisible excludes tools (textContent / todo / ask / images only)', () => {
    expect(src).toMatch(
      /hasVisible\s*=[\s\S]{0,200}textContent[\s\S]{0,200}todoMsg[\s\S]{0,200}askMsg[\s\S]{0,200}imageMsgs/
    );
  });

  it('forward-only turns get a `renderHandoffOnly` flag (NOT a toolMsgs mutation)', () => {
    // The flag is the contract AssistantTurn reads to skip its
    // `turn-actions` block. We pin BOTH:
    //   (a) finishTurn sets the flag on the turn record.
    //   (b) the OLD `toolMsgs = []` mutation is gone (audit trail
    //       must match what's on disk).
    expect(src).toMatch(/if\s*\(\s*forwardOnly\s*\)\s*\{[\s\S]{0,200}currentTurn\.renderHandoffOnly\s*=\s*true/);
    expect(src).not.toMatch(/currentTurn\.toolMsgs\s*=\s*\[\s*\]/);
  });

  it('push gate no longer excludes forwardOnly turns', () => {
    expect(src).toMatch(/if\s*\(\s*hasVisible\s*\|\|\s*hasTools\s*\|\|\s*hasHandoff\s*\)\s*\{/);
    expect(src).not.toMatch(/\(hasVisible\s*\|\|\s*hasTools\s*\|\|\s*hasHandoff\)\s*&&\s*!forwardOnly/);
  });

  it('startTurn seeds `renderHandoffOnly: false`', () => {
    // Default value must be set up-front so AssistantTurn's
    // computed sees a real boolean rather than undefined.
    expect(src).toMatch(/renderHandoffOnly:\s*false/);
  });
});

describe('AssistantTurn — forward-only render gate (source)', () => {
  const src = read('web/components/AssistantTurn.js');

  it('skips turn-actions when renderHandoffOnly is true', () => {
    // showToolActions is the v-if guard on the tool-actions block;
    // it must short-circuit to false for forward-only turns. We
    // pin via a behavioural contains check rather than the exact
    // expression shape.
    expect(src).toMatch(/renderHandoffOnly/);
  });
});

// ─── Layer 2: logic replica ─────────────────────────────────────────

/**
 * Replicates finishTurn's decision exactly:
 *   1. Compute hasVisible / hasTools / hasHandoff / forwardOnly.
 *   2. If forwardOnly, set the renderHandoffOnly flag on the turn.
 *   3. Push iff (hasVisible || hasTools || hasHandoff).
 *
 * Returns the mutated turn if pushed, null otherwise.
 *
 * NOTE: hasVisible MUST mirror all four arms (textContent / todoMsg /
 * askMsg / imageMsgs) — partial replicas mask exactly the kind of
 * drift the replica is here to catch.
 */
function pushOrSkipTurn(turn) {
  const hasVisible = !!(
    turn.textContent
    || turn.todoMsg
    || turn.askMsg
    || (turn.imageMsgs && turn.imageMsgs.length > 0)
  );
  const hasTools = !!(turn.toolMsgs && turn.toolMsgs.length > 0);
  const hasHandoff = !!(turn.handoffHints && turn.handoffHints.length > 0);
  const forwardOnly = hasHandoff && !hasVisible;
  if (forwardOnly) {
    turn.renderHandoffOnly = true;
  }
  if (hasVisible || hasTools || hasHandoff) return turn;
  return null;
}

const turn = (overrides = {}) => ({
  type: 'assistant-turn',
  speakerVpId: 'jobs',
  textContent: '',
  toolMsgs: [],
  imageMsgs: [],
  todoMsg: null,
  askMsg: null,
  handoffHints: [],
  renderHandoffOnly: false,
  ...overrides,
});

describe('MessageList.turnGroups — forward-only rendering policy (logic)', () => {
  it('RENDERS a turn whose only output is a route_forward hint, sets renderHandoffOnly', () => {
    const result = pushOrSkipTurn(turn({ handoffHints: [{ to: 'linus' }] }));
    expect(result).not.toBeNull();
    expect(result.handoffHints).toHaveLength(1);
    expect(result.renderHandoffOnly).toBe(true);
  });

  it('RENDERS a turn that ran internal bash and then forwarded (renderHandoffOnly, toolMsgs preserved)', () => {
    // Jobs ran `git fetch` privately, then route_forward to Linus.
    // New policy: Jobs's block appears with the hand-off pill;
    // AssistantTurn reads `renderHandoffOnly` and skips toolMsgs —
    // but the array stays intact so the audit trail is preserved.
    const result = pushOrSkipTurn(turn({
      toolMsgs: [{ toolName: 'bash', toolInput: { command: 'git fetch origin main' } }],
      handoffHints: [{ to: 'linus' }],
    }));
    expect(result).not.toBeNull();
    expect(result.handoffHints).toHaveLength(1);
    expect(result.renderHandoffOnly).toBe(true);
    // Audit-trail invariant: toolMsgs is NOT mutated.
    expect(result.toolMsgs).toHaveLength(1);
  });

  it('RENDERS a turn that has text AND a route_forward hint (renderHandoffOnly stays false)', () => {
    // Text counts as visible content → forwardOnly is false →
    // renderHandoffOnly stays false → toolMsgs render normally.
    const result = pushOrSkipTurn(turn({
      textContent: 'OK, asking Linus to check the deploy.',
      toolMsgs: [{ toolName: 'bash' }],
      handoffHints: [{ to: 'linus' }],
    }));
    expect(result).not.toBeNull();
    expect(result.textContent).toBe('OK, asking Linus to check the deploy.');
    expect(result.toolMsgs).toHaveLength(1);
    expect(result.handoffHints).toHaveLength(1);
    expect(result.renderHandoffOnly).toBe(false);
  });

  it('RENDERS a turn with todo + handoff (todo is visible content → not forwardOnly)', () => {
    const result = pushOrSkipTurn(turn({
      todoMsg: { items: [{ content: 'check deploy', status: 'pending' }] },
      handoffHints: [{ to: 'linus' }],
    }));
    expect(result).not.toBeNull();
    expect(result.renderHandoffOnly).toBe(false);
  });

  it('RENDERS a turn with askMsg + handoff (askMsg is visible content → not forwardOnly)', () => {
    const result = pushOrSkipTurn(turn({
      askMsg: { questions: [{ question: 'pick one' }] },
      handoffHints: [{ to: 'linus' }],
    }));
    expect(result).not.toBeNull();
    expect(result.renderHandoffOnly).toBe(false);
  });

  it('RENDERS a turn with images + handoff (images are visible content → not forwardOnly)', () => {
    const result = pushOrSkipTurn(turn({
      imageMsgs: [{ url: 'x' }],
      handoffHints: [{ to: 'linus' }],
    }));
    expect(result).not.toBeNull();
    expect(result.renderHandoffOnly).toBe(false);
  });

  it('RENDERS a turn with only tools (no hand-off) — Linus working visibly', () => {
    const result = pushOrSkipTurn(turn({
      speakerVpId: 'linus',
      toolMsgs: [{ toolName: 'bash', toolInput: { command: 'npm test' } }],
    }));
    expect(result).not.toBeNull();
    expect(result.toolMsgs).toHaveLength(1);
    expect(result.renderHandoffOnly).toBe(false);
  });

  it('RENDERS a turn with only text', () => {
    const result = pushOrSkipTurn(turn({ textContent: 'hello' }));
    expect(result).not.toBeNull();
  });

  it('RENDERS a turn with todo', () => {
    expect(pushOrSkipTurn(turn({ todoMsg: { items: [] } }))).not.toBeNull();
  });

  it('RENDERS a turn with askMsg', () => {
    expect(pushOrSkipTurn(turn({ askMsg: { questions: [] } }))).not.toBeNull();
  });

  it('RENDERS a turn with images', () => {
    expect(pushOrSkipTurn(turn({ imageMsgs: [{ url: 'x' }] }))).not.toBeNull();
  });

  it('HIDES an entirely empty turn', () => {
    // No content of any kind. Always skipped — this is the only
    // remaining suppression case.
    expect(pushOrSkipTurn(turn())).toBeNull();
  });
});
