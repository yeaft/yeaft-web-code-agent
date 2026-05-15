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
 *     to forward are stripped from the rendered turn (kept on disk).
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
    // The predicate must remain named so future readers can find it.
    expect(src).toMatch(/const\s+forwardOnly\s*=/);
  });

  it('forwardOnly = handoffHints present AND no user-visible content', () => {
    // Tools are explicitly NOT user-visible. This is the rule the user
    // asked for: a VP that ran internal bash before forwarding is still
    // forward-only — but per v0.1.776 it's no longer suppressed; we
    // strip its tool list instead.
    expect(src).toMatch(/forwardOnly\s*=\s*hasHandoff\s*&&\s*!hasVisible/);
  });

  it('hasVisible excludes tools (textContent / todo / ask / images only)', () => {
    // The structural guarantee: changing this definition is the only
    // way to start counting tools as visible content, and any such
    // change must update the test.
    expect(src).toMatch(
      /hasVisible\s*=[\s\S]{0,200}textContent[\s\S]{0,200}todoMsg[\s\S]{0,200}askMsg[\s\S]{0,200}imageMsgs/
    );
  });

  it('forward-only turns strip toolMsgs at render time (but DON\'T hide the block)', () => {
    // The body-less rendering policy: clear toolMsgs so the pill is
    // the only surface in the block. The push-gate must NOT exclude
    // forwardOnly any more — pushing must happen on
    //   (hasVisible || hasTools || hasHandoff)
    // alone.
    expect(src).toMatch(/if\s*\(\s*forwardOnly\s*\)\s*\{[\s\S]{0,400}currentTurn\.toolMsgs\s*=\s*\[\s*\]/);
    expect(src).toMatch(/if\s*\(\s*hasVisible\s*\|\|\s*hasTools\s*\|\|\s*hasHandoff\s*\)\s*\{/);
    // And the OLD `&& !forwardOnly` push gate must be gone.
    expect(src).not.toMatch(/\(hasVisible\s*\|\|\s*hasTools\s*\|\|\s*hasHandoff\)\s*&&\s*!forwardOnly/);
  });
});

// ─── Layer 2: logic replica ─────────────────────────────────────────

/**
 * Mirrors finishTurn's decision exactly:
 *   1. Compute hasVisible / hasTools / hasHandoff / forwardOnly.
 *   2. If forwardOnly, strip toolMsgs (body-less render).
 *   3. Push the turn iff (hasVisible || hasTools || hasHandoff).
 *
 * Returns the mutated turn if pushed, null otherwise — so tests can
 * inspect what AssistantTurn would receive.
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
    turn.toolMsgs = [];
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
  ...overrides,
});

describe('MessageList.turnGroups — forward-only rendering policy (logic)', () => {
  it('RENDERS a turn whose only output is a route_forward hint (body-less)', () => {
    const result = pushOrSkipTurn(turn({ handoffHints: [{ to: 'linus' }] }));
    expect(result).not.toBeNull();
    expect(result.handoffHints).toHaveLength(1);
    // No body to render — pill is the only surface.
    expect(result.toolMsgs).toHaveLength(0);
    expect(result.textContent).toBe('');
  });

  it('RENDERS a turn that ran internal bash and then forwarded (tools stripped)', () => {
    // Jobs ran `git fetch` privately, then route_forward to Linus.
    // New policy: Jobs's block still appears so the user sees "↪
    // forwarded to Linus", but the internal bash chip is removed
    // because it's just decision-time noise.
    const result = pushOrSkipTurn(turn({
      toolMsgs: [{ toolName: 'bash', toolInput: { command: 'git fetch origin main' } }],
      handoffHints: [{ to: 'linus' }],
    }));
    expect(result).not.toBeNull();
    expect(result.handoffHints).toHaveLength(1);
    expect(result.toolMsgs).toHaveLength(0); // stripped
  });

  it('RENDERS a turn that has text AND a route_forward hint (tools NOT stripped)', () => {
    // If Jobs DID say something AND forwarded, the bubble must show
    // with the text intact — and forwardOnly is false (because text
    // counts as visible content), so tools survive.
    const result = pushOrSkipTurn(turn({
      textContent: 'OK, asking Linus to check the deploy.',
      toolMsgs: [{ toolName: 'bash' }],
      handoffHints: [{ to: 'linus' }],
    }));
    expect(result).not.toBeNull();
    expect(result.textContent).toBe('OK, asking Linus to check the deploy.');
    expect(result.toolMsgs).toHaveLength(1);
    expect(result.handoffHints).toHaveLength(1);
  });

  it('RENDERS a turn with only tools (no hand-off) — Linus working visibly', () => {
    // Symmetric: Linus running bash with no text and no hand-off is
    // legitimate work and must appear.
    const result = pushOrSkipTurn(turn({
      speakerVpId: 'linus',
      toolMsgs: [{ toolName: 'bash', toolInput: { command: 'npm test' } }],
    }));
    expect(result).not.toBeNull();
    expect(result.toolMsgs).toHaveLength(1);
  });

  it('RENDERS a turn with only text', () => {
    const result = pushOrSkipTurn(turn({ textContent: 'hello' }));
    expect(result).not.toBeNull();
    expect(result.textContent).toBe('hello');
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
    // remaining suppression case. Empty turns are an aggregator
    // artifact (latch ran, no body attached) and shouldn't render.
    expect(pushOrSkipTurn(turn())).toBeNull();
  });
});
