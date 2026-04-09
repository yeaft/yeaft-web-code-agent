/**
 * Fix crew route target resolution & session recovery
 *
 * Tests:
 * 1. parseRoutes strips trailing punctuation from `to` field
 * 2. resolveRoleName handles displayName matching (e.g. "乔布斯" → "pm")
 * 3. resolveRoleName handles name-displayName compound (e.g. "pm-乔布斯" → "pm")
 * 4. resolveRoleName existing behaviors still work (exact, roleType, prefix, groupIndex)
 * 5. Auto-resume pattern present in control.js, human-interaction.js, role-management.js
 * 6. Error logging includes available roles
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

// Load source files
const routingSrc = read('agent/crew/routing.js');
const controlSrc = read('agent/crew/control.js');
const humanInteractionSrc = read('agent/crew/human-interaction.js');
const roleManagementSrc = read('agent/crew/role-management.js');

/**
 * Extract parseRoutes from source for behavioral testing.
 */
function createParseRoutes() {
  const fnStart = routingSrc.indexOf('export function parseRoutes(text)');
  const openBrace = routingSrc.indexOf('{', fnStart);
  let depth = 0;
  let fnEnd = openBrace;
  for (let i = openBrace; i < routingSrc.length; i++) {
    if (routingSrc[i] === '{') depth++;
    if (routingSrc[i] === '}') depth--;
    if (depth === 0) { fnEnd = i + 1; break; }
  }
  const fnBody = routingSrc.slice(openBrace + 1, fnEnd - 1);
  return new Function('text', fnBody);
}

/**
 * Extract resolveRoleName from source for behavioral testing.
 */
function createResolveRoleName() {
  const fnStart = routingSrc.indexOf('export function resolveRoleName(to, session, fromRole)');
  const openBrace = routingSrc.indexOf('{', fnStart);
  let depth = 0;
  let fnEnd = openBrace;
  for (let i = openBrace; i < routingSrc.length; i++) {
    if (routingSrc[i] === '{') depth++;
    if (routingSrc[i] === '}') depth--;
    if (depth === 0) { fnEnd = i + 1; break; }
  }
  const fnBody = routingSrc.slice(openBrace + 1, fnEnd - 1);
  return new Function('to', 'session', 'fromRole', fnBody);
}

/**
 * Helper: create a mock session with given roles
 */
function mockSession(rolesMap) {
  const roles = new Map();
  for (const [name, config] of Object.entries(rolesMap)) {
    roles.set(name, { roleType: config.roleType || 'developer', displayName: config.displayName || name, groupIndex: config.groupIndex || 0, ...config });
  }
  return { roles };
}

// ──────────────────────────────────────────────
// 1. parseRoutes — trailing punctuation cleanup
// ──────────────────────────────────────────────
describe('parseRoutes trailing punctuation strip', () => {
  const parseRoutes = createParseRoutes();

  it('strips trailing comma from to field', () => {
    const text = `---ROUTE---
to: rev-3,
summary: Review complete
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('rev-3');
  });

  it('strips trailing semicolon', () => {
    const text = `---ROUTE---
to: dev-1;
summary: done
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].to).toBe('dev-1');
  });

  it('strips trailing colon', () => {
    const text = `---ROUTE---
to: pm:
summary: waiting
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].to).toBe('pm');
  });

  it('strips trailing Chinese punctuation', () => {
    const text = `---ROUTE---
to: dev-1。
summary: 完成
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].to).toBe('dev-1');
  });

  it('strips trailing 。，；：', () => {
    for (const punct of ['。', '，', '；', '：', '!', '？']) {
      const text = `---ROUTE---
to: pm${punct}
summary: test
---END_ROUTE---`;
      const routes = parseRoutes(text);
      expect(routes[0].to).toBe('pm');
    }
  });

  it('strips multiple trailing punctuation characters', () => {
    const text = `---ROUTE---
to: dev-1,,
summary: done
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].to).toBe('dev-1');
  });

  it('does not strip punctuation from the middle of a name', () => {
    const text = `---ROUTE---
to: dev-1
summary: normal
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].to).toBe('dev-1');
  });

  it('still strips parenthetical notes after name', () => {
    const text = `---ROUTE---
to: pm (决策者)
summary: ok
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].to).toBe('pm');
  });

  it('handles END ROUTE with space', () => {
    const text = `---ROUTE---
to: dev-1
summary: test
---END ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('dev-1');
  });
});

// ──────────────────────────────────────────────
// 2. resolveRoleName — existing behaviors
// ──────────────────────────────────────────────
describe('resolveRoleName existing behaviors', () => {
  const resolveRoleName = createResolveRoleName();

  it('resolves exact match', () => {
    const session = mockSession({ 'pm': { roleType: 'manager', displayName: '乔布斯' } });
    expect(resolveRoleName('pm', session)).toBe('pm');
  });

  it('resolves roleType match', () => {
    const session = mockSession({
      'dev-1': { roleType: 'developer', displayName: 'Dev 1' }
    });
    expect(resolveRoleName('developer', session)).toBe('dev-1');
  });

  it('resolves short prefix match (dev → dev-1)', () => {
    const session = mockSession({
      'dev-1': { roleType: 'developer', displayName: 'Dev 1' },
      'dev-2': { roleType: 'developer', displayName: 'Dev 2' }
    });
    const result = resolveRoleName('dev', session);
    expect(result).toMatch(/^dev-[12]$/);
  });

  it('prefers same groupIndex for prefix match', () => {
    const session = mockSession({
      'dev-1': { roleType: 'developer', displayName: 'Dev 1', groupIndex: 1 },
      'dev-2': { roleType: 'developer', displayName: 'Dev 2', groupIndex: 2 },
      'rev-1': { roleType: 'reviewer', displayName: 'Rev 1', groupIndex: 1 },
      'rev-2': { roleType: 'reviewer', displayName: 'Rev 2', groupIndex: 2 }
    });
    // dev-1 (groupIndex 1) routes to "reviewer" → should prefer rev-1 (same groupIndex)
    expect(resolveRoleName('reviewer', session, 'dev-1')).toBe('rev-1');
    expect(resolveRoleName('reviewer', session, 'dev-2')).toBe('rev-2');
  });

  it('returns null for completely unknown role', () => {
    const session = mockSession({
      'pm': { roleType: 'manager', displayName: 'PM' },
      'dev-1': { roleType: 'developer', displayName: 'Dev 1' }
    });
    expect(resolveRoleName('unknown-role', session)).toBeNull();
  });
});

// ──────────────────────────────────────────────
// 3. resolveRoleName — new displayName matching
// ──────────────────────────────────────────────
describe('resolveRoleName displayName matching', () => {
  const resolveRoleName = createResolveRoleName();

  it('resolves Chinese displayName (乔布斯 → pm)', () => {
    const session = mockSession({
      'pm': { roleType: 'manager', displayName: '乔布斯' },
      'dev-1': { roleType: 'developer', displayName: '开发者' }
    });
    expect(resolveRoleName('乔布斯', session)).toBe('pm');
  });

  it('resolves displayName case-insensitively', () => {
    const session = mockSession({
      'pm': { roleType: 'manager', displayName: 'Jobs' }
    });
    expect(resolveRoleName('jobs', session)).toBe('pm');
  });

  it('resolves English displayName', () => {
    const session = mockSession({
      'dev-1': { roleType: 'developer', displayName: 'Alice' },
      'dev-2': { roleType: 'developer', displayName: 'Bob' }
    });
    expect(resolveRoleName('alice', session)).toBe('dev-1');
    expect(resolveRoleName('bob', session)).toBe('dev-2');
  });
});

// ──────────────────────────────────────────────
// 4. resolveRoleName — name-displayName compound
// ──────────────────────────────────────────────
describe('resolveRoleName name-displayName compound matching', () => {
  const resolveRoleName = createResolveRoleName();

  it('resolves pm-乔布斯 → pm', () => {
    const session = mockSession({
      'pm': { roleType: 'manager', displayName: '乔布斯' },
      'dev-1': { roleType: 'developer', displayName: '开发者' }
    });
    expect(resolveRoleName('pm-乔布斯', session)).toBe('pm');
  });

  it('resolves dev-1-alice → dev-1', () => {
    const session = mockSession({
      'dev-1': { roleType: 'developer', displayName: 'Alice' },
      'rev-1': { roleType: 'reviewer', displayName: 'Bob' }
    });
    expect(resolveRoleName('dev-1-alice', session)).toBe('dev-1');
  });

  it('does not match partial name prefix (p-乔布斯 should NOT match pm)', () => {
    const session = mockSession({
      'pm': { roleType: 'manager', displayName: '乔布斯' }
    });
    expect(resolveRoleName('p-乔布斯', session)).toBeNull();
  });

  it('compound match only if to is longer than name + hyphen', () => {
    const session = mockSession({
      'pm': { roleType: 'manager', displayName: '乔布斯' }
    });
    // "pm-" is exactly name + hyphen, but no extra chars — should not match via compound
    expect(resolveRoleName('pm-', session)).toBeNull();
  });
});

// ──────────────────────────────────────────────
// 5. resolveRoleName — template placeholder
// ──────────────────────────────────────────────
describe('resolveRoleName template placeholder', () => {
  const resolveRoleName = createResolveRoleName();

  it('returns null for template placeholder "目标角色名"', () => {
    const session = mockSession({
      'pm': { roleType: 'manager', displayName: '乔布斯' },
      'dev-1': { roleType: 'developer', displayName: '开发者' }
    });
    expect(resolveRoleName('目标角色名', session)).toBeNull();
  });

  it('returns null for "target_role_name"', () => {
    const session = mockSession({
      'pm': { roleType: 'manager', displayName: 'PM' }
    });
    expect(resolveRoleName('target_role_name', session)).toBeNull();
  });
});

// ──────────────────────────────────────────────
// 6. Auto-resume pattern verification
// ──────────────────────────────────────────────
describe('auto-resume session pattern', () => {
  it('control.js imports resumeCrewSession', () => {
    expect(controlSrc).toContain('resumeCrewSession');
  });

  it('control.js attempts auto-resume on session not found', () => {
    expect(controlSrc).toContain('attempting auto-resume');
    expect(controlSrc).toContain('await resumeCrewSession({ sessionId })');
  });

  it('human-interaction.js imports resumeCrewSession', () => {
    expect(humanInteractionSrc).toContain('resumeCrewSession');
  });

  it('human-interaction.js attempts auto-resume on session not found', () => {
    expect(humanInteractionSrc).toContain('attempting auto-resume');
    expect(humanInteractionSrc).toContain('await resumeCrewSession({ sessionId })');
  });

  it('role-management.js addRoleToSession imports resumeCrewSession', () => {
    expect(roleManagementSrc).toContain('resumeCrewSession');
  });

  it('role-management.js has auto-resume in addRoleToSession', () => {
    // Both functions should have the pattern
    const addFn = roleManagementSrc.indexOf('export async function addRoleToSession');
    const removeFn = roleManagementSrc.indexOf('export async function removeRoleFromSession');
    const addSection = roleManagementSrc.slice(addFn, removeFn);
    expect(addSection).toContain('attempting auto-resume');
  });

  it('role-management.js has auto-resume in removeRoleFromSession', () => {
    const removeFn = roleManagementSrc.indexOf('export async function removeRoleFromSession');
    const removeSection = roleManagementSrc.slice(removeFn);
    expect(removeSection).toContain('attempting auto-resume');
  });

  it('all auto-resume sites use let instead of const for session', () => {
    // After applying auto-resume, session must be declared with `let` so it can be reassigned
    const controlMatch = controlSrc.match(/let session = crewSessions\.get\(sessionId\)/);
    expect(controlMatch).not.toBeNull();

    const humanMatch = humanInteractionSrc.match(/let session = crewSessions\.get\(sessionId\)/);
    expect(humanMatch).not.toBeNull();

    // role-management has two sites
    const rmMatches = roleManagementSrc.match(/let session = crewSessions\.get\(sessionId\)/g);
    expect(rmMatches).not.toBeNull();
    expect(rmMatches.length).toBeGreaterThanOrEqual(2);
  });
});

// ──────────────────────────────────────────────
// 7. Error logging includes available roles
// ──────────────────────────────────────────────
describe('error logging for unknown route target', () => {
  it('logs available roles in warning message', () => {
    expect(routingSrc).toContain("Array.from(session.roles.keys()).join(', ')");
  });

  it('sends available roles in error message to decision maker', () => {
    expect(routingSrc).toContain('可用角色:');
    expect(routingSrc).toContain('availableRoles');
  });

  it('error message includes fromRole and summary context', () => {
    expect(routingSrc).toContain('来自 ${fromRole} 的消息: ${summary}');
  });
});
