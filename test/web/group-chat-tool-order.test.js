/**
 * Regression: Group-chat tool action displays inside the VP message block
 * with the avatar header on top — not in a duplicate orphan block AFTER
 * the tool-bearing real turn.
 *
 * Bug shape (reported by user with a screenshot):
 *   ┌─ tool action: "功能 Let me check…"           ← orphan block
 *   ├─ Steve Jobs / Product Strategist (avatar)    ← typing-placeholder
 *   …
 * vs. expected:
 *   ┌─ Steve Jobs / Product Strategist (avatar)    ← speaker header
 *   ├─ tool action: "功能 Let me check…"           ← inside same block
 *   …
 *
 * Root cause: the typing-placeholder synthesis at the bottom of
 * `MessageList.turnGroups` walked the tail run of `result` looking for
 * VPs already covered by an in-flight bubble, but the predicate was
 * `r.isStreaming && r.speakerVpId`. A turn that OPENS with a tool_call
 * (no preceding `assistant` text-delta) never sets `currentTurn.isStreaming`
 * — only `type==='assistant'` deltas flip that flag — so the predicate
 * evaluated false and the placeholder was synthesized AFTER the
 * tool-bearing real turn, producing a duplicate avatar block.
 *
 * Fix: broaden the predicate to "any non-empty assistant-turn for this
 * VP in the tail run carries the speaker", regardless of `isStreaming`.
 * The placeholder is only meaningful when there is NO real turn yet for
 * the VP — bridging the gap between `vp_typing_start` and the first
 * inbound chunk.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

describe('MessageList — orphan typing-placeholder must not appear AFTER a tool-bearing turn', () => {
  const src = read('web/components/MessageList.js');

  it('placeholder walk-back no longer requires r.isStreaming', () => {
    // Pre-fix predicate `r.isStreaming && r.speakerVpId` skipped tool-only
    // turns (which never flip isStreaming) and produced a duplicate
    // placeholder AFTER them. The new predicate only requires a
    // speakerVpId — meaning any covered VP suppresses the placeholder.
    //
    // Strip line/block comments before matching so an explanatory
    // "the previous predicate was `r.isStreaming && r.speakerVpId`"
    // doesn't trip the assertion.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(codeOnly).not.toMatch(/if\s*\(\s*r\.isStreaming\s*&&\s*r\.speakerVpId\s*\)/);
  });

  it('uses a "covered VPs" set, not a "streaming VPs" set', () => {
    // The variable rename signals the broadened semantics. Using grep
    // against the comment is brittle; assert the variable name itself.
    expect(src).toContain('coveredVps');
    expect(src).toMatch(/coveredVps\.has\(vpId\)/);
  });

  it('still walks the tail run of assistant-turns and breaks on the first non-assistant row', () => {
    // The structural shape (tail walk + early break on user/system rows)
    // is what makes the placeholder cheap to compute. Confirm it remains.
    expect(src).toMatch(/if \(r\.type !== 'assistant-turn'\) break;/);
  });

  it('placeholder is suppressed for any VP whose speakerVpId is in the tail run', () => {
    // The check is the inverse of "does this VP need a placeholder":
    //   if (coveredVps.has(vpId)) continue;
    // Walking past this means there is NO real turn for the VP yet, so
    // the placeholder pseudo-turn fills the visual gap between
    // vp_typing_start and the first chunk.
    expect(src).toMatch(/if \(coveredVps\.has\(vpId\)\) continue;/);
  });
});

describe('MessageList — tool-use messages stay inside the same turn as their speaker header', () => {
  const src = read('web/components/MessageList.js');

  it('latches speakerVpId on tool-use BEFORE pushing the toolEntry', () => {
    // The order matters — if latch ran AFTER the toolMsgs.push, a
    // finishTurn() that fired between two tool-only deltas would still
    // see speakerVpId === null and the avatar would render below the
    // tools (or not at all). The latch sits at the top of the tool-use
    // branch, immediately after the optional startTurn().
    const toolUseBlock = src.match(
      /if \(msg\.type === 'tool-use'\) \{[\s\S]+?continue;\s*\}/
    );
    expect(toolUseBlock).toBeTruthy();
    const block = toolUseBlock[0];
    // latch must precede toolMsgs.push
    const latchIdx = block.indexOf('latchSpeakerFromMsg(msg)');
    const pushIdx = block.indexOf('toolMsgs.push');
    expect(latchIdx).toBeGreaterThan(0);
    expect(pushIdx).toBeGreaterThan(latchIdx);
  });

  it('finishTurn renders the speaker header on every VP-attributed turn', () => {
    // Same invariant as task-708 — re-asserted here so a future change
    // that re-introduces consecutive-collapse fails this specific test
    // alongside the original.
    expect(src).toContain('currentTurn.showSpeakerHeader = !!currentTurn.speakerVpId');
  });
});
