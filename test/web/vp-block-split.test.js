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
 * mints a unique-per-VP-delivery string), so turnId inequality is the
 * precise VP-boundary signal.
 *
 * This test exercises the aggregator's behaviour through a logic
 * replica to avoid spinning up a Vue runtime. The source-level pins
 * below guarantee the boundary check lives in the right place and
 * exercises the right call sites; they're written as behaviour-shaped
 * contains checks rather than exact source regexes so cosmetic refactors
 * don't break them.
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

  it('defines a `closeTurnIfTurnIdChanged` helper', () => {
    expect(src).toContain('closeTurnIfTurnIdChanged');
  });

  it('the helper is invoked in all three append branches', () => {
    // assistant / tool-use / chat-image must each call the helper
    // before opening (or reusing) a turn. We use a contains check
    // rather than a positional regex so cosmetic edits don't break
    // the test.
    const assistantSegment = src.slice(src.indexOf("msg.type === 'assistant'"));
    expect(assistantSegment.slice(0, 200)).toContain('closeTurnIfTurnIdChanged(msg);');

    const toolUseSegment = src.slice(src.indexOf("msg.type === 'tool-use'"));
    expect(toolUseSegment.slice(0, 200)).toContain('closeTurnIfTurnIdChanged(msg);');

    const imageSegment = src.slice(src.indexOf("msg.type === 'chat-image'"));
    expect(imageSegment.slice(0, 200)).toContain('closeTurnIfTurnIdChanged(msg);');
  });

  it('helper splits on turnId mismatch or fallback speaker mismatch', () => {
    const idx = src.indexOf('const closeTurnIfTurnIdChanged');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 1200);
    expect(body).toContain('currentTurn');
    expect(body).toContain('msg.turnId');
    expect(body).toContain('currentTurn.speakerVpId');
    expect(body).toContain('msg.speakerVpId || msg.vpId');
    expect(body).toContain('finishTurn();');
  });
});

// ─── Layer 2: logic replica ─────────────────────────────────────────

/**
 * Replicates the essential turnGroups loop just enough to assert the
 * boundary behaviour. We model only the bits relevant to the bug:
 *
 *   - currentTurn opens lazily on the first assistant/tool-use/image.
 *   - latchSpeakerFromMsg fills speakerVpId and turnId, idempotent.
 *   - closeTurnIfTurnIdChanged closes the open turn when turnIds differ.
 *   - finishTurn pushes the turn if it has any surface
 *     (visible content OR tools — route_forward shows up as a tool chip
 *     so forward-only turns pass through the `hasTools` gate).
 */
function aggregate(messages) {
  const result = [];
  let currentTurn = null;
  const finishTurn = () => {
    if (!currentTurn) return;
    const hasVisible = !!(
      currentTurn.textContent
      || currentTurn.todoMsg
      || currentTurn.askMsg
      || currentTurn.imageMsgs.length > 0
    );
    const hasTools = currentTurn.toolMsgs.length > 0;
    if (hasVisible || hasTools) {
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
      todoMsg: null,
      askMsg: null,
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
  const closeTurnIfTurnIdChanged = (msg) => {
    if (!currentTurn) return;
    const curTurnId = currentTurn.turnId;
    const msgTurnId = msg.turnId;
    if (curTurnId && msgTurnId) {
      if (typeof curTurnId !== 'string' || typeof msgTurnId !== 'string') return;
      if (curTurnId === msgTurnId) return;
      finishTurn();
      return;
    }

    const curSpeaker = currentTurn.speakerVpId;
    const msgSpeaker = msg.speakerVpId || msg.vpId;
    if (!curSpeaker || !msgSpeaker) return;
    if (curSpeaker === msgSpeaker) return;
    finishTurn();
  };
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      closeTurnIfTurnIdChanged(msg);
      if (!currentTurn) startTurn();
      if (msg.content) currentTurn.textContent += msg.content;
      latch(msg);
      continue;
    }
    if (msg.type === 'tool-use') {
      closeTurnIfTurnIdChanged(msg);
      if (!currentTurn) startTurn();
      latch(msg);
      currentTurn.toolMsgs.push(msg);
      continue;
    }
    if (msg.type === 'chat-image') {
      closeTurnIfTurnIdChanged(msg);
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
    const blocks = aggregate([
      { type: 'assistant', content: 'part one ', vpId: 'jobs', turnId: 'aaaa:jobs' },
      { type: 'assistant', content: 'part two', vpId: 'jobs', turnId: 'aaaa:jobs' },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toBe('part one part two');
  });

  it('boundary trips on tool-use too (Linus opens with a tool, not text)', () => {
    const blocks = aggregate([
      { type: 'assistant', content: 'forwarding', vpId: 'jobs', turnId: 'aaaa:jobs' },
      { type: 'tool-use', toolName: 'read_file', vpId: 'linus', turnId: 'bbbb:linus' },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].speakerVpId).toBe('jobs');
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

  it('messages without turnId and without speaker attribution keep legacy single-open-turn behavior', () => {
    const blocks = aggregate([
      { type: 'assistant', content: 'a' },
      { type: 'assistant', content: 'b' },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toBe('ab');
  });

  it('mixed legacy unstamped + turn-stamped messages do not falsely split', () => {
    const blocks = aggregate([
      { type: 'assistant', content: 'a' },
      { type: 'assistant', content: 'b', turnId: 'aaaa:jobs' },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toBe('ab');
  });

  it('refresh replay: consecutive assistant rows without turnId split when speakerVpId changes', () => {
    const blocks = aggregate([
      { type: 'assistant', content: 'answer from A', speakerVpId: 'vp-a' },
      { type: 'assistant', content: 'answer from B', speakerVpId: 'vp-b' },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].speakerVpId).toBe('vp-a');
    expect(blocks[0].textContent).toBe('answer from A');
    expect(blocks[1].speakerVpId).toBe('vp-b');
    expect(blocks[1].textContent).toBe('answer from B');
  });

  it('refresh replay: same-speaker assistant rows without turnId still merge', () => {
    const blocks = aggregate([
      { type: 'assistant', content: 'part one ', speakerVpId: 'vp-a' },
      { type: 'assistant', content: 'part two', speakerVpId: 'vp-a' },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].speakerVpId).toBe('vp-a');
    expect(blocks[0].textContent).toBe('part one part two');
  });

  it('empty-string turnId on either side is treated as no-turnId; unstamped legacy rows still merge', () => {
    const blocks1 = aggregate([
      { type: 'assistant', content: 'a', turnId: '' },
      { type: 'assistant', content: 'b', turnId: 'aaaa:jobs' },
    ]);
    expect(blocks1).toHaveLength(1);
    const blocks2 = aggregate([
      { type: 'assistant', content: 'a', turnId: 'aaaa:jobs' },
      { type: 'assistant', content: 'b', turnId: '' },
    ]);
    expect(blocks2).toHaveLength(1);
  });

  it('the exact reported scenario: Jobs forwards to Linus → two distinct blocks', () => {
    // Jobs's turn: a route_forward tool call (no visible text — the
    // forward IS the surface, rendered as a Route tool chip).
    // Linus's turn: actual work.
    // Both must render; Jobs as a tool-only block whose only surface is
    // the Route chip, Linus as a real block with tools.
    const blocks = aggregate([
      { type: 'tool-use', toolName: 'route_forward', vpId: 'jobs', turnId: 'aaaa:jobs',
        input: { to: 'linus', text: 'kernel question' } },
      { type: 'assistant', content: 'OK, looking at it', vpId: 'linus', turnId: 'bbbb:linus' },
      { type: 'tool-use', toolName: 'bash', vpId: 'linus', turnId: 'bbbb:linus' },
    ]);
    expect(blocks).toHaveLength(2);
    // Jobs's block: route_forward tool chip, no visible text.
    expect(blocks[0].speakerVpId).toBe('jobs');
    expect(blocks[0].textContent).toBe('');
    expect(blocks[0].toolMsgs).toHaveLength(1);
    expect(blocks[0].toolMsgs[0].toolName).toBe('route_forward');
    // Linus's block: real text + tool.
    expect(blocks[1].speakerVpId).toBe('linus');
    expect(blocks[1].textContent).toBe('OK, looking at it');
    expect(blocks[1].toolMsgs).toHaveLength(1);
  });
});
