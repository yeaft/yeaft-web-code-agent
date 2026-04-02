/**
 * task-233 supplementary tests: edge cases for ROUTE empty summary fallback.
 *
 * Supplements dev's crew-route-summary-fallback.test.js with:
 * 1. parseRoutes: additional edge cases (tab-only, newline-only summary, to-field variants)
 * 2. Two-stage fallback pipeline: parseRoutes → processRoleOutput auto-extract
 * 3. processRoleOutput auto-extract behavioral tests (simulated)
 * 4. Fallback does NOT corrupt valid summaries
 * 5. Template: full format block verification
 * 6. taskId/taskTitle fields preserved through fallback
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

const routingSrc = read('agent/crew/routing.js');
const roleOutputSrc = read('agent/crew/role-output.js');
const roleQuerySrc = read('agent/crew/role-query.js');

/** Extract parseRoutes for behavioral testing (same approach as dev) */
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

const parseRoutes = createParseRoutes();

// =============================================================================
// 1. parseRoutes: additional edge cases for empty summary
// =============================================================================
describe('task-233 supplement: parseRoutes edge cases', () => {
  it('summary with only tabs produces fallback', () => {
    const text = `---ROUTE---
to: pm
summary: \t\t
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].summary).toBe('[该角色未提供消息摘要]');
  });

  it('no ROUTE block at all returns empty array', () => {
    const text = 'This is just a regular message with no route blocks.';
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(0);
  });

  it('ROUTE block without to field is skipped', () => {
    const text = `---ROUTE---
summary: orphan summary with no target
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(0);
  });

  it('valid summary is NOT overwritten with fallback', () => {
    const text = `---ROUTE---
to: dev-1
summary: 完成了 3 个文件的修改
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toBe('完成了 3 个文件的修改');
    expect(routes[0].summary).not.toContain('[该角色未提供消息摘要]');
  });

  it('summary with Chinese content preserved correctly', () => {
    const text = `---ROUTE---
to: test-1
summary: 请验证以下场景：分屏模式下 badge 数量独立显示
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toContain('请验证以下场景');
  });

  it('summary with special characters preserved', () => {
    const text = `---ROUTE---
to: pm
summary: Fixed bug #123 — emoji 🐛 + percent 100%
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toContain('Fixed bug #123');
    expect(routes[0].summary).toContain('100%');
  });
});

// =============================================================================
// 2. parseRoutes: taskId/taskTitle preserved through fallback
// =============================================================================
describe('task-233 supplement: task fields preserved with fallback', () => {
  it('empty summary with taskId still preserves taskId', () => {
    const text = `---ROUTE---
to: pm
task: task-229
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].summary).toBe('[该角色未提供消息摘要]');
    expect(routes[0].taskId).toBe('task-229');
  });

  it('empty summary with taskId and taskTitle preserves both', () => {
    const text = `---ROUTE---
to: dev-1
task: task-233
taskTitle: ROUTE 空 summary 防护
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toBe('[该角色未提供消息摘要]');
    expect(routes[0].taskId).toBe('task-233');
    expect(routes[0].taskTitle).toBe('ROUTE 空 summary 防护');
  });

  it('valid summary with taskId preserves both', () => {
    const text = `---ROUTE---
to: rev-1
summary: Code review requested
task: task-224
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toBe('Code review requested');
    expect(routes[0].taskId).toBe('task-224');
  });
});

// =============================================================================
// 3. Two-stage fallback pipeline: parseRoutes → processRoleOutput
// =============================================================================
describe('task-233 supplement: two-stage fallback pipeline', () => {
  it('Stage 1 (parseRoutes) sets placeholder for empty summary', () => {
    const text = `---ROUTE---
to: pm
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toBe('[该角色未提供消息摘要]');
  });

  it('Stage 2 (processRoleOutput) replaces placeholder with auto-extracted text', () => {
    // Simulate what processRoleOutput does
    function simulateAutoExtract(routes, accumulatedText) {
      for (const route of routes) {
        if (route.summary === '[该角色未提供消息摘要]' && accumulatedText) {
          const tail = accumulatedText.slice(-500).trim();
          if (tail) route.summary = `[auto-extracted]\n${tail}`;
        }
      }
      return routes;
    }

    const routes = [{ to: 'pm', summary: '[该角色未提供消息摘要]' }];
    const accumulated = 'Some long text output from the role that explains what was done.';
    simulateAutoExtract(routes, accumulated);

    expect(routes[0].summary).toContain('[auto-extracted]');
    expect(routes[0].summary).toContain('Some long text output');
  });

  it('Stage 2 preserves valid summary (no auto-extract)', () => {
    function simulateAutoExtract(routes, accumulatedText) {
      for (const route of routes) {
        if (route.summary === '[该角色未提供消息摘要]' && accumulatedText) {
          const tail = accumulatedText.slice(-500).trim();
          if (tail) route.summary = `[auto-extracted]\n${tail}`;
        }
      }
      return routes;
    }

    const routes = [{ to: 'pm', summary: 'Tests all passing, 33 new tests added' }];
    simulateAutoExtract(routes, 'lots of irrelevant accumulated text');

    expect(routes[0].summary).toBe('Tests all passing, 33 new tests added');
    expect(routes[0].summary).not.toContain('[auto-extracted]');
  });

  it('Stage 2 with empty accumulatedText keeps placeholder', () => {
    function simulateAutoExtract(routes, accumulatedText) {
      for (const route of routes) {
        if (route.summary === '[该角色未提供消息摘要]' && accumulatedText) {
          const tail = accumulatedText.slice(-500).trim();
          if (tail) route.summary = `[auto-extracted]\n${tail}`;
        }
      }
      return routes;
    }

    const routes = [{ to: 'pm', summary: '[该角色未提供消息摘要]' }];
    simulateAutoExtract(routes, '');

    expect(routes[0].summary).toBe('[该角色未提供消息摘要]');
  });

  it('Stage 2 with null accumulatedText keeps placeholder', () => {
    function simulateAutoExtract(routes, accumulatedText) {
      for (const route of routes) {
        if (route.summary === '[该角色未提供消息摘要]' && accumulatedText) {
          const tail = accumulatedText.slice(-500).trim();
          if (tail) route.summary = `[auto-extracted]\n${tail}`;
        }
      }
      return routes;
    }

    const routes = [{ to: 'pm', summary: '[该角色未提供消息摘要]' }];
    simulateAutoExtract(routes, null);

    expect(routes[0].summary).toBe('[该角色未提供消息摘要]');
  });

  it('Stage 2 truncates to last 500 characters', () => {
    function simulateAutoExtract(routes, accumulatedText) {
      for (const route of routes) {
        if (route.summary === '[该角色未提供消息摘要]' && accumulatedText) {
          const tail = accumulatedText.slice(-500).trim();
          if (tail) route.summary = `[auto-extracted]\n${tail}`;
        }
      }
      return routes;
    }

    const longText = 'A'.repeat(300) + 'B'.repeat(300) + 'C'.repeat(300);
    const routes = [{ to: 'pm', summary: '[该角色未提供消息摘要]' }];
    simulateAutoExtract(routes, longText);

    // Should only have last 500 chars (200 B's + 300 C's) + prefix
    const extracted = routes[0].summary.replace('[auto-extracted]\n', '');
    expect(extracted.length).toBe(500);
    expect(extracted).not.toContain('A');
    expect(extracted.startsWith('B')).toBe(true);
    expect(extracted.endsWith('C')).toBe(true);
  });
});

// =============================================================================
// 4. processRoleOutput source structure verification
// =============================================================================
describe('task-233 supplement: processRoleOutput source structure', () => {
  it('auto-extract loop is after parseRoutes call', () => {
    const parseIdx = roleOutputSrc.indexOf('const routes = parseRoutes(');
    const fallbackIdx = roleOutputSrc.indexOf("route.summary === '[该角色未提供消息摘要]'");
    expect(parseIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(parseIdx);
  });

  it('auto-extract uses for...of loop over routes', () => {
    expect(roleOutputSrc).toContain('for (const route of routes)');
  });

  it('auto-extract prepends [auto-extracted] prefix', () => {
    const fallbackIdx = roleOutputSrc.indexOf('[auto-extracted]');
    expect(fallbackIdx).toBeGreaterThan(-1);
    // Should be in a template literal with newline
    expect(roleOutputSrc).toContain('`[auto-extracted]\\n${tail}`');
  });

  it('auto-extract checks accumulatedText is truthy', () => {
    // Should guard: && roleState.accumulatedText
    expect(roleOutputSrc).toContain('&& roleState.accumulatedText');
  });

  it('auto-extract checks tail is non-empty after trim', () => {
    expect(roleOutputSrc).toContain('if (tail)');
  });
});

// =============================================================================
// 5. role-query.js template: full ROUTE format block
// =============================================================================
describe('task-233 supplement: role-query.js ROUTE template format', () => {
  it('template has ---ROUTE--- delimiter', () => {
    expect(roleQuerySrc).toContain('---ROUTE---');
  });

  it('template has ---END_ROUTE--- delimiter', () => {
    expect(roleQuerySrc).toContain('---END_ROUTE---');
  });

  it('template has to: field', () => {
    expect(roleQuerySrc).toContain('to: <roleName>');
  });

  it('updated summary line contains 完成了什么 and 需要对方做什么', () => {
    // The full line should guide the LLM on what to include
    const summaryLine = roleQuerySrc.match(/summary:\s*<(.+?)>/);
    expect(summaryLine).toBeTruthy();
    expect(summaryLine[1]).toContain('完成了什么');
    expect(summaryLine[1]).toContain('需要对方做什么');
  });

  it('ROUTE example block is surrounded by escaped backtick fences', () => {
    // In the raw file, the template literal uses \`\`\` to represent code fences
    const routeIdx = roleQuerySrc.indexOf('---ROUTE---');
    const before = roleQuerySrc.slice(Math.max(0, routeIdx - 100), routeIdx);
    // Escaped backticks appear as \` in the raw source
    expect(before).toContain('\\`\\`\\`');
  });
});

// =============================================================================
// 6. Consistency: fallback string matches between routing.js and role-output.js
// =============================================================================
describe('task-233 supplement: fallback string consistency', () => {
  it('routing.js and role-output.js use the same fallback placeholder string', () => {
    // Extract the fallback string from routing.js
    const routingMatch = routingSrc.match(/summary = '(\[.+?\])'/);
    expect(routingMatch).toBeTruthy();

    // Extract the check string from role-output.js
    const outputMatch = roleOutputSrc.match(/route\.summary === '(\[.+?\])'/);
    expect(outputMatch).toBeTruthy();

    // They must be identical for the two-stage pipeline to work
    expect(routingMatch[1]).toBe(outputMatch[1]);
  });

  it('fallback string is the Chinese message [该角色未提供消息摘要]', () => {
    const routingMatch = routingSrc.match(/summary = '(\[.+?\])'/);
    expect(routingMatch[1]).toBe('[该角色未提供消息摘要]');
  });
});

// =============================================================================
// 7. Multiple routes: mixed scenarios through full pipeline
// =============================================================================
describe('task-233 supplement: multiple routes mixed scenarios', () => {
  it('3 routes: valid, empty, valid → only middle gets fallback', () => {
    const text = `Some preamble text here.

---ROUTE---
to: rev-1
summary: Please review PR #450
task: task-232
---END_ROUTE---

---ROUTE---
to: test-1
---END_ROUTE---

---ROUTE---
to: pm
summary: All tasks completed
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(3);
    expect(routes[0].summary).toBe('Please review PR #450');
    expect(routes[0].taskId).toBe('task-232');
    expect(routes[1].summary).toBe('[该角色未提供消息摘要]');
    expect(routes[1].to).toBe('test-1');
    expect(routes[2].summary).toBe('All tasks completed');
  });

  it('routes to same target with different summaries are separate', () => {
    const text = `---ROUTE---
to: pm
summary: First update
---END_ROUTE---

---ROUTE---
to: pm
summary: Second update
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(2);
    expect(routes[0].summary).toBe('First update');
    expect(routes[1].summary).toBe('Second update');
  });

  it('all empty summaries in batch all get fallback', () => {
    const text = `---ROUTE---
to: rev-1
---END_ROUTE---

---ROUTE---
to: test-1
---END_ROUTE---

---ROUTE---
to: pm
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(3);
    for (const r of routes) {
      expect(r.summary).toBe('[该角色未提供消息摘要]');
    }
  });
});
