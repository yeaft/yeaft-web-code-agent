/**
 * web-bridge-post-turn-compact-wiring.test.js
 *
 * Lock the post-turn compact wiring in `handleYeaftSessionSend`. Why a
 * source-level test (instead of a full handler integration):
 *
 *   - The handler has a 200-line bootstrap (session load, yeaftDir
 *     resolution, coordinator hydrate, VP fanout, route promises). Booting
 *     all of that just to assert "did we call scheduleAfterTurn once" is
 *     a category error — the test would mostly exercise harness, not the
 *     wiring it claims to protect.
 *
 *   - The original bug (this entire PR's Part 2) was that commit
 *     `51e29a24` REMOVED the `scheduleAfterTurn` caller during the VP-thread
 *     refactor. The Compactor class survived intact, but the only thing
 *     that ever invoked it disappeared. A unit test against Compactor
 *     would have stayed green throughout that regression. The only
 *     defence against the same delete happening again is a test that
 *     specifically pins the caller's presence + shape.
 *
 *   - Source-level pinning matches how the bridge-watchdog escalation
 *     helper is tested (`web-bridge-escalation.test.js` uses an exported
 *     `__testRaceWithEscalation` to skirt the same bootstrap issue). The
 *     post-turn compact path doesn't have a natural extraction point —
 *     it's 6 lines threaded through the handler's epilogue — so source
 *     inspection is the proportionate tool.
 *
 * Invariants pinned:
 *   1. `handleYeaftSessionSend` exists and calls `session.compactor.scheduleAfterTurn`
 *      with a per-call `historyHandle` (NOT a frozen snapshot) AFTER the
 *      `waitForRoutePromises` await.
 *   2. The handle uses the bridge's session-keyed helpers
 *      (`getOrCreateSessionHistory` / `setGroupHistory`) — closing over a
 *      different array would defeat the race-guard.
 *   3. The call is guarded by `session?.compactor && sessionId` so test
 *      paths without a fully booted session don't crash.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeSource = readFileSync(
  join(__dirname, '..', '..', '..', 'agent', 'yeaft', 'web-bridge.js'),
  'utf-8'
);

/**
 * Extract the body of `handleYeaftSessionSend` (everything between its
 * `export async function ...` line and the next top-level `function` /
 * `export function`). Coarse, but sufficient — we only need to assert
 * a few statements are present in this function specifically (not
 * elsewhere in the file).
 */
function extractHandlerBody() {
  const startRe = /export async function handleYeaftSessionSend\s*\([^)]*\)\s*\{/;
  const startMatch = startRe.exec(bridgeSource);
  if (!startMatch) {
    throw new Error('handleYeaftSessionSend not found in web-bridge.js');
  }
  const start = startMatch.index + startMatch[0].length;
  // Walk the brace stack from the opening `{` to find the matching close.
  let depth = 1;
  let i = start;
  while (i < bridgeSource.length && depth > 0) {
    const ch = bridgeSource[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  if (depth !== 0) {
    throw new Error('handleYeaftSessionSend has unbalanced braces');
  }
  return bridgeSource.slice(start, i - 1);
}

describe('handleYeaftSessionSend — post-turn compact wiring', () => {
  const body = extractHandlerBody();

  it('calls session.compactor.scheduleAfterTurn exactly once', () => {
    const matches = body.match(/session\.compactor\.scheduleAfterTurn\s*\(/g) || [];
    expect(matches.length).toBe(1);
  });

  it('guards the call with `session?.compactor && sessionId`', () => {
    // Required so the early `return` paths (no VP, no yeaftDir, etc.)
    // don't crash if they reach the schedule block. Also makes the wiring
    // a no-op in test paths that exercise the handler without a fully
    // booted session.
    expect(body).toMatch(/if\s*\(\s*session\?\.compactor\s*&&\s*sessionId\s*\)/);
  });

  it('passes a per-call historyHandle (get + set closures over session helpers)', () => {
    // Critical: the handle must NOT be a frozen snapshot of the array.
    // Compactor depends on `get`/`set` being re-resolved each call so
    // that `consolidate` / reset / route_forward bursts can swap the
    // reference safely. Closing the wrong helpers here would silently
    // break the race-guard.
    expect(body).toMatch(/get:\s*\(\)\s*=>\s*getOrCreateSessionHistory\s*\(\s*sessionId\s*\)/);
    expect(body).toMatch(/set:\s*\(next\)\s*=>\s*setGroupHistory\s*\(\s*sessionId\s*,\s*next\s*\)/);
  });

  it('places the schedule AFTER waitForRoutePromises (post-turn, not pre-turn)', () => {
    const waitIdx = body.indexOf('await waitForRoutePromises');
    const scheduleIdx = body.indexOf('session.compactor.scheduleAfterTurn');
    expect(waitIdx).toBeGreaterThanOrEqual(0);
    expect(scheduleIdx).toBeGreaterThan(waitIdx);
  });

  it('does NOT await the schedule (fire-and-forget, must not block response)', () => {
    // The user-stated rule is that compact runs in the background after
    // the turn — never in the response critical path. A stray `await`
    // here would re-introduce the latency hit. Match only the local
    // call, not any earlier `awaitInFlight` (which is the entry-gate at
    // the TOP of the handler, an intentional and different await).
    const block = body.slice(body.indexOf('session.compactor.scheduleAfterTurn'));
    expect(block).not.toMatch(/await\s+session\.compactor\.scheduleAfterTurn/);
  });
});

describe('Compactor construction — 70 % default + model-aware context', () => {
  // Companion source-pin for `session.js`'s Compactor wiring. Same
  // motivation as above: the Compactor class would happily run with
  // wrong defaults; only the construction site decides the policy. The
  // user requirement ("70 % of model context, knob:
  // config.compactTriggerRatio, model-aware via resolveContextWindow")
  // is enforced here and only here.
  const sessionSource = readFileSync(
    join(__dirname, '..', '..', '..', 'agent', 'yeaft', 'session.js'),
    'utf-8'
  );

  it('imports resolveContextWindow from models.js', () => {
    expect(sessionSource).toMatch(/import\s*\{\s*resolveContextWindow\s*\}\s*from\s*['"]\.\/models\.js['"]/);
  });

  it('wires getMaxContextTokens through resolveContextWindow (model-aware)', () => {
    // Must NOT pin `config.maxContextTokens` flat — the 70 % threshold
    // has to track the model in use (GPT-5 256K vs Claude 200K), per
    // the user requirement.
    expect(sessionSource).toMatch(/getMaxContextTokens:\s*\(\)\s*=>\s*\n?\s*resolveContextWindow\s*\(/);
  });

  it('wires getTriggerRatio with a 0.7 default and (0, 1) validation', () => {
    // Match the structural shape: read config.compactTriggerRatio,
    // validate it's a finite number in (0, 1), fall back to 0.7.
    // Anything else means a typo could silently disable compact.
    expect(sessionSource).toMatch(/getTriggerRatio:\s*\(\)\s*=>/);
    expect(sessionSource).toMatch(/config\??\.compactTriggerRatio/);
    expect(sessionSource).toMatch(/0\.7/);
    expect(sessionSource).toMatch(/Number\.isFinite\s*\(\s*r\s*\)/);
  });
});
