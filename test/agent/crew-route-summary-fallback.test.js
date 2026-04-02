/**
 * task-233: ROUTE empty summary fallback + template update
 *
 * Tests:
 * 1. parseRoutes returns fallback text when summary is empty
 * 2. parseRoutes preserves normal summary when provided
 * 3. processRoleOutput auto-extracts tail when summary is empty placeholder
 * 4. role-query.js template emphasizes summary is required
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

// Load source files
const routingSrc = read('agent/crew/routing.js');
const roleOutputSrc = read('agent/crew/role-output.js');
const roleQuerySrc = read('agent/crew/role-query.js');

/**
 * Extract and eval parseRoutes for behavioral testing.
 * We avoid dynamic import because the module has side effects.
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
  // eslint-disable-next-line no-new-func
  return new Function('text', fnBody);
}

describe('parseRoutes empty summary fallback', () => {
  const parseRoutes = createParseRoutes();

  it('returns fallback text when summary field is missing entirely', () => {
    const text = `---ROUTE---
to: pm
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('pm');
    expect(routes[0].summary).toBe('[该角色未提供消息摘要]');
  });

  it('returns fallback text when summary is empty string', () => {
    const text = `---ROUTE---
to: dev-1
summary:
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].summary).toBe('[该角色未提供消息摘要]');
  });

  it('returns fallback text when summary is only whitespace', () => {
    const text = `---ROUTE---
to: rev-1
summary:
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].summary).toBe('[该角色未提供消息摘要]');
  });

  it('preserves normal summary when provided', () => {
    const text = `---ROUTE---
to: pm
summary: Task completed, all tests passing
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].summary).toBe('Task completed, all tests passing');
  });

  it('preserves multi-line summary', () => {
    const text = `---ROUTE---
to: dev-1
summary: Changes made:
1. Fixed login bug
2. Added tests
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].summary).toContain('Changes made:');
    expect(routes[0].summary).toContain('1. Fixed login bug');
  });

  it('handles multiple routes with mixed empty/non-empty summaries', () => {
    const text = `---ROUTE---
to: rev-1
summary: Please review the PR
---END_ROUTE---

---ROUTE---
to: test-1
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(2);
    expect(routes[0].summary).toBe('Please review the PR');
    expect(routes[1].summary).toBe('[该角色未提供消息摘要]');
  });
});

describe('processRoleOutput auto-extract fallback', () => {
  it('source code checks for fallback placeholder and extracts tail', () => {
    // Verify the auto-extract logic is present in role-output.js
    expect(roleOutputSrc).toContain("route.summary === '[该角色未提供消息摘要]'");
    expect(roleOutputSrc).toContain('roleState.accumulatedText.slice(-500)');
    expect(roleOutputSrc).toContain('[auto-extracted]');
  });

  it('auto-extract only triggers when summary matches fallback placeholder', () => {
    // The code should check for the exact fallback string, not just any empty value
    const checkLine = roleOutputSrc.match(/if \(route\.summary === '(.+?)'/);
    expect(checkLine).not.toBeNull();
    expect(checkLine[1]).toBe('[该角色未提供消息摘要]');
  });
});

describe('role-query.js ROUTE template update', () => {
  it('template emphasizes summary is mandatory', () => {
    expect(roleQuerySrc).toContain('summary: <必须填写具体内容');
    expect(roleQuerySrc).toContain('禁止留空');
  });

  it('does NOT contain old brief description placeholder', () => {
    expect(roleQuerySrc).not.toContain('summary: <brief description>');
  });
});
