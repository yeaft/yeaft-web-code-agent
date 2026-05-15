/**
 * group-workdir-web-bridge-scope.test.js — PR #776 regression guard.
 *
 * Work-dir backed groups resolve their storage root at runtime. The group chat
 * auto-roster/default-heal path closes and reopens the group after mutations;
 * those reopen calls must use the outer resolved `groupRoot`, not the old
 * block-scoped `root` local from the initial open path. Otherwise mentioned-VP
 * auto-add and defaultVpId healing can mutate storage but fail to refresh the
 * live group handle with `ReferenceError: root is not defined`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const bridgeSrc = readFileSync(join(ROOT, 'agent/unify/web-bridge.js'), 'utf8');

function extractHandleUnifyGroupChat() {
  const start = bridgeSrc.indexOf('export async function handleUnifyGroupChat');
  const end = bridgeSrc.indexOf('\nexport function handleUnifyModeSwitch', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return bridgeSrc.slice(start, end);
}

describe('handleUnifyGroupChat workDir group root scope', () => {
  it('reopens mutated groups with the outer resolved groupRoot', () => {
    const src = extractHandleUnifyGroupChat();

    expect(src).toMatch(/let\s+groupRoot\s*=\s*null/);
    expect(src).toMatch(/groupRoot\s*=\s*groupsRoot\(groupYeaftDir\)/);
    expect(src.match(/openGroup\(groupRoot,\s*groupId\)/g) || []).toHaveLength(3);
    expect(src).not.toMatch(/openGroup\(root,\s*groupId\)/);
  });
});
