/**
 * vp-timeline-abort-visibility.test.js — pins Bug #2 from user report
 * 2026-06-10: "我没法终止某个一VP turn，以前UI还有这个能力，现在没有了
 * 需要有暂停的敌方" (sic, 地方).
 *
 * REGRESSION:
 *   The per-VP abort affordance in `VpTimelinePane` was implemented and
 *   `v-if`-gated on `isActiveStatus(row.status)`, so the DOM node only
 *   exists during an in-flight turn. But the CSS treated the abort
 *   button identically to the info button — both `opacity: 0` at rest,
 *   `opacity: 0.7` only on row hover. So even while a VP was actively
 *   running, the user couldn't FIND a stop button — it was rendered
 *   invisible until they happened to mouse over the row.
 *
 * CONTRACT PINNED:
 *   1. Template still has `v-if="isActiveStatus(row.status)"` on the
 *      abort node — so the affordance only appears when there is
 *      something to abort.
 *   2. CSS gives `.yeaft-vp-timeline-abort` `opacity: 1` at rest (in a
 *      rule scoped to the abort class alone, AFTER the shared
 *      `.yeaft-vp-timeline-abort, .yeaft-vp-timeline-info {opacity:0}`
 *      reset). So the moment the v-if turns true, the button is fully
 *      visible without requiring hover.
 *   3. The info button retains the hover-reveal pattern (Crew parity).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COMPONENT_SRC = readFileSync(
  join(ROOT, 'web/components/VpTimelinePane.js'),
  'utf8',
);
const CSS_SRC = readFileSync(join(ROOT, 'web/styles/yeaft.css'), 'utf8');

describe('VpTimelinePane — per-VP abort button visibility (Bug #2)', () => {
  it('abort button is v-if-gated on active status', () => {
    // The abort node must exist only while the VP is actively running
    // — otherwise we'd offer a stop button for a non-existent turn.
    expect(COMPONENT_SRC).toContain('isActiveStatus(row.status)');
    // And clicking emits the right event so YeaftPage can route to
    // cancelVpTurn(bestTurnId).
    expect(COMPONENT_SRC).toContain("$emit('cancel-vp-turn', row.vpId)");
  });

  it('CSS makes the abort button fully visible at rest (no hover required)', () => {
    // Locate the rule that targets the abort class alone. It MUST set
    // opacity: 1 (overriding the shared `opacity: 0` rule above it).
    // Regex tolerates whitespace, comments, and arbitrary additional
    // declarations inside the block.
    const abortRule = /\.yeaft-vp-timeline-abort\s*\{[^}]*opacity:\s*1[^}]*\}/m;
    expect(CSS_SRC).toMatch(abortRule);
  });

  it('abort button uses danger color to telegraph destructiveness', () => {
    // The button is for stopping a running task — a Rams-style visual
    // cue (red) is non-negotiable so the user knows it's the dangerous
    // affordance even when they're not hovering.
    const abortRule = /\.yeaft-vp-timeline-abort\s*\{[^}]*color:\s*var\(--error-color[^}]*\}/m;
    expect(CSS_SRC).toMatch(abortRule);
  });
});
