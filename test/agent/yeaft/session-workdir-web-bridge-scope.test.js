/**
 * group-workdir-web-bridge-scope.test.js — PR #776 regression guard.
 *
 * Work-dir backed groups resolve their storage root at runtime. The group chat
 * auto-roster/default-heal path closes and reopens the group after mutations;
 * those reopen calls must use the outer resolved `sessionRoot`, not the old
 * block-scoped `root` local from the initial open path. Otherwise mentioned-VP
 * auto-add and defaultVpId healing can mutate storage but fail to refresh the
 * live group handle with `ReferenceError: root is not defined`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const bridgeSrc = readFileSync(join(ROOT, 'agent/yeaft/web-bridge.js'), 'utf8');

function extractHandleYeaftGroupChat() {
  const start = bridgeSrc.indexOf('export async function handleYeaftSessionSend');
  const end = bridgeSrc.indexOf('\nexport function handleYeaftModeSwitch', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return bridgeSrc.slice(start, end);
}

describe('handleYeaftSessionSend workDir group root scope', () => {
  it('reopens mutated groups with the outer resolved sessionRoot', () => {
    const src = extractHandleYeaftGroupChat();

    expect(src).toMatch(/let\s+sessionRoot\s*=\s*null/);
    expect(src).toMatch(/sessionRoot\s*=\s*sessionsRoot\(groupYeaftDir\)/);
    expect(src.match(/openSession\(sessionRoot,\s*sessionId\)/g) || []).toHaveLength(3);
    expect(src).not.toMatch(/openSession\(root,\s*sessionId\)/);
  });
});
