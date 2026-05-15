/**
 * VP block split on turnId boundary (v0.1.776).
 *
 * Bug context: in a group conversation, when VP_A (Jobs) forwards to
 * VP_B (Linus), VP_B's first message chunks used to get appended into
 * VP_A's still-open turn block. The UI showed Linus's text inside
 * Jobs's bubble with Jobs's avatar — visually wrong.
 *
 * Root cause: MessageList.turnGroups (the flat-message → turn-blocks
 * aggregator) called `if (!currentTurn) startTurn()` on every
 * assistant / tool-use / chat-image without checking whether the
 * incoming message's `turnId` differed from the open turn's `turnId`.
 *
 * Fix: before opening (or reusing) the current turn, close it if the
 * incoming message carries a DIFFERENT turnId than the currently-open
 * turn. Each VP gets a fresh turnId at delivery time (the web-bridge
 * mints `${randomUUID().slice(0,8)}:${vpId}` per delivery), so turnId
 * inequality is the precise VP-boundary signal.
 *
 * This test exercises the aggregator's behaviour through a logic
 * replica — the same approach used by `forward-only-suppression.test.js`
 * to avoid spinning up a Vue runtime. The source-level pins below
 * guarantee the boundary check lives in the right place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf-8');

// ─── Layer 1: source pins ───────────────────────────────────────────

describe('MessageList.turnGroups — VP block split (source)', () => {
  const src = read('web/components/MessageList.js');

  it('defines a `breakOnTurnBoundary` helper', () => {
    expect(src).toMatch(/const\s+breakOnTurnBoundary\s*=/);
  });

  it('breakOnTurnBoundary only triggers when both sides carry a turnId AND they differ', () => {
    // The helper must be a no-op for Chat-mode messages that lack
    // turnId — otherwise we'd break the legacy "single open turn"
    // behavior used by 1:1 chat.
    const re = /const\s+breakOnTurnBoundary\s*=\s*\(msg\)\s*=>\s*\{[\s\S]*?\};/;
    const m = src.match(re);
    expect(m).not.toBeNull();
    const body = m[0];
    expect(body).toContain('if (!currentTurn) return;');
    expect(body).toContain('if (!currentTurn.turnId || !msg.turnId) return;');
    expect(body).toContain('if (currentTurn.turnId === msg.turnId) return;');
    expect(body).toContain('finishTurn();');
  });

  it('boundary check fires in all three append branches', () => {
    // assistant, tool-use, chat-image — each must call
    // breakOnTurnBoundary BEFORE the "if (!currentTurn) startTurn()"
    // line, so the close-and-reopen happens cleanly.
    expect(src).toMatch(/msg\.type === 'assistant'[\s\S]{0,200}breakOnTurnBoundary\(msg\);\s*\n\s*if\s*\(!currentTurn\)\s*startTurn\(\);/);
    expect(src).toMatch(/msg\.type === 'tool-use'[\s\S]{0,200}breakOnTurnBoundary\(msg\);\s*\n\s*if\s*\(!currentTurn\)\s*startTurn\(\);/);
    expect(src).toMatch(/msg\.type === 'chat-image'[\s\S]{0,200}breakOnTurnBoundary\(msg\);\s*\n\s*if\s*\(!currentTurn\)\s*startTurn\(\);/);
  });
});

// ─── Layer 2: logic replica ─────────────────────────────────────────

/**
 * Replicates the essential turnGroups loop just enough to assert the
 * boundary behaviour. We model only the bits relevant to the bug:
 *
 *   - currentTurn opens lazily on the first assistant/tool-use/image.
 *   - latchSpeakerFromMsg fills speakerVpId and turnId, idempotent.
 *   - breakOnTurnBoundary closes the open turn when turnIds differ.
 *   - finishTurn pushes the turn if it has any surface.
 *
 * If MessageList drifts from this shape, the source-level pins above
 * fail first.
 */
function aggregate(messages) {
  const result = [];
  let currentTurn = null;
  const finishTurn = () => {
    if (!currentTurn) return;
    const hasVisible = !!(currentTurn.textContent || currentTurn.imageMsgs.length > 0);
    const hasTools = currentTurn.toolMsgs.length > 0;
    const hasHandoff = currentTurn.handoffHints.length > 0;
    const forwardOnly = hasHandoff && !hasVisible;
    if (forwardOnly) currentTurn.toolMsgs = [];
    if (hasVisible || hasTools || hasHandoff) {
      currentTurn.showSpeakerHeader = !!currentTurn.speakerVpId;
      result.push(currentTurn);
    }
    currentTurn = null;
  };
  const startTurn = () => {
    currentTurn = {
      textContent: '',
      toolMsgs: [],
      imageMsgs: [],
      handoffHints: [],
      speakerVpId: null,
      turnId: null,
      showSpeakerHeader: false,
    };
  };
  const latch = (msg) => {
    if (!currentTurn) return;
    if (!currentTurn.speakerVpId) {
      const vp = msg.speakerVpId || msg.vpId;
      if (vp) currentTurn.speakerVpId = vp;
    }
    if (!currentTurn.turnId && msg.turnId) currentTurn.turnId = msg.turnId;
  };
  const breakOnTurnBoundary = (msg) => {
    if (!currentTurn) return;
    if (!currentTurn.turnId || !msg.turnId) return;
    if (currentTurn.turnId === msg.turnId) return;
    finishTurn();
  };
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      breakOnTurnBoundary(msg);
      if (!currentTurn) startTurn();
      if (msg.content) currentTurn.textContent += msg.content;
      latch(msg);
      if (Array.isArray(msg.handoffHints)) currentTurn.handoffHints.push(...msg.handoffHints);
      continue;
    }
    if (msg.type === 'tool-use') {
      breakOnTurnBoundary(msg);
      if (!currentTurn) startTurn();
      latch(msg);
      currentTurn.toolMsgs.push(msg);
      continue;
    }
    if (msg.type === 'chat-image') {
      breakOnTurnBoundary(msg);
      if (!currentTurn) startTurn();
      latch(msg);
      currentTurn.imageMsgs.push(msg);
    }
  }
  finishTurn();
  return result;
}

describe('MessageList.turnGroups — VP block split (logic)', () => {
  it('splits two consecutive assistant chunks from different VP turnIds into separate blocks', () => {
    // The exact bug: Jobs streams a chunk (turnId T1), then Linus
    // streams a chunk (turnId T2). Result must be two blocks.
    const blocks = aggregate([
      { type: 'assistant', content: 'hello from Jobs', vpId: 'jobs', turnId: 'aaaa:jobs' },
      { type: 'assistant', content: 'hello from Linus', vpId: 'linus', turnId: 'bbbb:linus' },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].speakerVpId).toBe('jobs');
    expect(blocks[0].textContent).toBe('hello from Jobs');
    expect(blocks[1].speakerVpId).toBe('linus');
    expect(blocks[1].textContent).toBe('hello from Linus');
  });

  it('two assistant chunks with the SAME turnId stay in one block', () => {
    // Same VP, same turnId: streaming continuation. Must merge.
    const blocks = aggregate([
      { type: 'assistant', content: 'part one ', vpId: 'jobs', turnId: 'aaaa:jobs' },
      { type: 'assistant', content: 'part two', vpId: 'jobs', turnId: 'aaaa:jobs' },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toBe('part one part two');
  });

  it('boundary trips on tool-use too (Linus opens with a tool, not text)', () => {
    // Reported scenario: Jobs sends a text+forward, then Linus's
    // first message is a tool-use (e.g. read_file). The tool-use
    // must NOT land in Jobs's block.
    const blocks = aggregate([
      { type: 'assistant', content: 'forwarding', vpId: 'jobs', turnId: 'aaaa:jobs',
        handoffHints: [{ to: 'linus' }] },
      { type: 'tool-use', toolName: 'read_file', vpId: 'linus', turnId: 'bbbb:linus' },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].speakerVpId).toBe('jobs');
    expect(blocks[0].handoffHints).toHaveLength(1);
    expect(blocks[1].speakerVpId).toBe('linus');
    expect(blocks[1].toolMsgs).toHaveLength(1);
  });

  it('boundary trips on chat-image too', () => {
    const blocks = aggregate([
      { type: 'assistant', content: 'see this', vpId: 'jobs', turnId: 'aaaa:jobs' },
      { type: 'chat-image', vpId: 'linus', turnId: 'bbbb:linus', url: 'x.png' },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].speakerVpId).toBe('jobs');
    expect(blocks[1].speakerVpId).toBe('linus');
    expect(blocks[1].imageMsgs).toHaveLength(1);
  });

  it('messages without turnId fall through to legacy single-open-turn behavior', () => {
    // Chat mode never stamps turnId. Two assistant chunks without
    // turnId must still merge — we MUST NOT regress Chat.
    const blocks = aggregate([
      { type: 'assistant', content: 'a' },
      { type: 'assistant', content: 'b' },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toBe('ab');
  });

  it('mixed legacy (no turnId) + turn-stamped messages do not falsely split', () => {
    // If one side lacks turnId, the boundary check is a no-op — we
    // fall back to the legacy single-turn merge rather than
    // accidentally splitting on a missing field.
    const blocks = aggregate([
      { type: 'assistant', content: 'a' }, // legacy, no turnId
      { type: 'assistant', content: 'b', turnId: 'aaaa:jobs' }, // stamped
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toBe('ab');
  });

  it('the exact reported scenario: Jobs forwards to Linus → two distinct blocks', () => {
    // Jobs's turn: a forward (no visible text — pure forward-only).
    // Linus's turn: actual work.
    // Both must render; Jobs as a body-less pill, Linus as a real block.
    const blocks = aggregate([
      { type: 'assistant', vpId: 'jobs', turnId: 'aaaa:jobs',
        handoffHints: [{ to: 'linus', reason: 'kernel question' }] },
      { type: 'assistant', content: 'OK, looking at it', vpId: 'linus', turnId: 'bbbb:linus' },
      { type: 'tool-use', toolName: 'bash', vpId: 'linus', turnId: 'bbbb:linus' },
    ]);
    expect(blocks).toHaveLength(2);
    // Jobs's block: forward pill, no body content, no tools.
    expect(blocks[0].speakerVpId).toBe('jobs');
    expect(blocks[0].handoffHints).toHaveLength(1);
    expect(blocks[0].textContent).toBe('');
    expect(blocks[0].toolMsgs).toHaveLength(0);
    // Linus's block: real text + tool.
    expect(blocks[1].speakerVpId).toBe('linus');
    expect(blocks[1].textContent).toBe('OK, looking at it');
    expect(blocks[1].toolMsgs).toHaveLength(1);
  });
});
