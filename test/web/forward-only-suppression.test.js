/**
 * Forward-only VP turn suppression (v0.1.757).
 *
 * Issue: when a VP (e.g. Jobs) receives a task and immediately
 * `route_forward`s it to another VP (Linus) without producing any
 * user-visible content of its own — even if it ran a tool like `bash`
 * privately before deciding to forward — its turn used to render as
 * a bubble with the VP's avatar header + tool rows. Users found that
 * confusing ("Jobs is showing tool actions, but Linus is the one
 * actually doing the work?"). The user explicitly chose: forward-only
 * senders should NOT appear in the message stream.
 *
 * The persisted record stays on disk (audit-safe); only the visual is
 * suppressed.
 *
 * Two layers of tests:
 *
 *   1. Source-level: assert the MessageList.turnGroups predicate
 *      uses the `forwardOnly` flag and the right "user-visible
 *      content" definition. This catches a future refactor that
 *      accidentally re-introduces tool-as-visible.
 *
 *   2. Logic-level: replicate the exact predicate inline and run it
 *      against fixture turns. This catches a logic bug that source
 *      regex would miss.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf-8');

// ─── Layer 1: source pins ───────────────────────────────────────────

describe('MessageList.turnGroups — forward-only suppression (source)', () => {
  const src = read('web/components/MessageList.js');

  it('defines a `forwardOnly` flag inside finishTurn', () => {
    // The predicate must be named so future readers (and reviewers)
    // can find the rule. A literal `forwardOnly` substring proves the
    // suppression lives in finishTurn rather than being inlined.
    expect(src).toMatch(/const\s+forwardOnly\s*=/);
  });

  it('forwardOnly = handoffHints present AND no user-visible content', () => {
    // Tools are explicitly NOT user-visible. This is the rule the user
    // asked for: a VP that ran internal bash before forwarding is still
    // forward-only.
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

  it('finishTurn pushes only if (hasVisible || hasTools || hasHandoff) AND not forwardOnly', () => {
    expect(src).toMatch(
      /\(hasVisible\s*\|\|\s*hasTools\s*\|\|\s*hasHandoff\)\s*&&\s*!forwardOnly/
    );
  });
});

// ─── Layer 2: logic replica ─────────────────────────────────────────

/**
 * Mirrors the predicate from MessageList.turnGroups.finishTurn exactly.
 * Kept in sync via the source-level tests above; if the predicate in
 * MessageList drifts, layer 1 fails first.
 */
function shouldPushTurn(turn) {
  const hasVisible = !!(
    turn.textContent
    || turn.todoMsg
    || turn.askMsg
    || (turn.imageMsgs && turn.imageMsgs.length > 0)
  );
  const hasTools = !!(turn.toolMsgs && turn.toolMsgs.length > 0);
  const hasHandoff = !!(turn.handoffHints && turn.handoffHints.length > 0);
  const forwardOnly = hasHandoff && !hasVisible;
  return (hasVisible || hasTools || hasHandoff) && !forwardOnly;
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

describe('MessageList.turnGroups — forward-only suppression (logic)', () => {
  it('HIDES a turn whose only output is a route_forward hint', () => {
    expect(shouldPushTurn(turn({ handoffHints: [{ to: 'linus' }] }))).toBe(false);
  });

  it('HIDES a turn that ran internal bash and then forwarded (no text)', () => {
    // The exact reported scenario: Jobs ran `git fetch` privately,
    // then route_forward to Linus. From the user's POV, Jobs said
    // nothing — Linus is doing the work. The internal tool calls are
    // suppressed along with the hand-off.
    expect(shouldPushTurn(turn({
      toolMsgs: [{ toolName: 'bash', toolInput: { command: 'git fetch origin main' } }],
      handoffHints: [{ to: 'linus' }],
    }))).toBe(false);
  });

  it('SHOWS a turn that has text AND a route_forward hint', () => {
    // If Jobs DID say something ("OK, asking Linus to check…") and
    // ALSO forwarded, the bubble must show — the text is information
    // the user benefits from seeing.
    expect(shouldPushTurn(turn({
      textContent: 'OK, asking Linus to check the deploy.',
      handoffHints: [{ to: 'linus' }],
    }))).toBe(true);
  });

  it('SHOWS a turn with only tools (no hand-off) — Linus working visibly', () => {
    // Symmetric: Linus running bash with no text and no hand-off is
    // legitimate work and must appear.
    expect(shouldPushTurn(turn({
      speakerVpId: 'linus',
      toolMsgs: [{ toolName: 'bash', toolInput: { command: 'npm test' } }],
    }))).toBe(true);
  });

  it('SHOWS a turn with only text', () => {
    expect(shouldPushTurn(turn({ textContent: 'hello' }))).toBe(true);
  });

  it('SHOWS a turn with todo (todo list updates count as visible)', () => {
    expect(shouldPushTurn(turn({ todoMsg: { items: [] } }))).toBe(true);
  });

  it('SHOWS a turn with askMsg (interactive prompt)', () => {
    expect(shouldPushTurn(turn({ askMsg: { questions: [] } }))).toBe(true);
  });

  it('SHOWS a turn with images', () => {
    expect(shouldPushTurn(turn({ imageMsgs: [{ url: 'x' }] }))).toBe(true);
  });

  it('HIDES an entirely empty turn', () => {
    // No content of any kind. Always skipped (same as before).
    expect(shouldPushTurn(turn())).toBe(false);
  });

  it('SHOWS a turn whose only output is tools, but no hand-off', () => {
    // Edge case: a VP that runs only tools (no text, no forward) is
    // still doing visible work — must appear so the user can see what
    // happened. forwardOnly only kicks in when handoffHints are
    // present.
    expect(shouldPushTurn(turn({
      toolMsgs: [{ toolName: 'web_search' }],
    }))).toBe(true);
  });
});
