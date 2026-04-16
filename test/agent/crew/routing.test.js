import { describe, it, expect } from 'vitest';
import { parseRoutes } from '../../../agent/crew/routing.js';

describe('parseRoutes', () => {
  // ─── Standard ROUTE blocks (existing behavior) ──────────────

  it('should parse standard ROUTE block', () => {
    const text = `Some text
---ROUTE---
to: dev-1
summary: Please implement the feature
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('dev-1');
    expect(routes[0].summary).toBe('Please implement the feature');
  });

  it('should parse END ROUTE with space', () => {
    const text = `---ROUTE---
to: rev-1
summary: Review this PR
---END ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('rev-1');
  });

  it('should parse multiple ROUTE blocks', () => {
    const text = `---ROUTE---
to: dev-1
summary: Task A
---END_ROUTE---
---ROUTE---
to: dev-2
summary: Task B
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(2);
    expect(routes[0].to).toBe('dev-1');
    expect(routes[1].to).toBe('dev-2');
  });

  it('should parse task and taskTitle fields', () => {
    const text = `---ROUTE---
to: dev-1
summary: Implement feature
task: task-100
taskTitle: Add dark mode
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].taskId).toBe('task-100');
    expect(routes[0].taskTitle).toBe('Add dark mode');
  });

  it('should clean to field with parenthetical notes', () => {
    const text = `---ROUTE---
to: pm (决策者)
summary: Done
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].to).toBe('pm');
  });

  it('should skip blocks without to field', () => {
    const text = `---ROUTE---
summary: No target
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(0);
  });

  it('should default summary when missing', () => {
    const text = `---ROUTE---
to: pm
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes[0].summary).toBe('[该角色未提供消息摘要]');
  });

  // ─── Fallback: missing END_ROUTE ──────────────────────────────

  it('should parse ROUTE block without END_ROUTE (content to EOF)', () => {
    const text = `Some output here
---ROUTE---
to: pm
summary: Work is done, submitting for review`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('pm');
    expect(routes[0].summary).toContain('Work is done');
  });

  it('should parse unclosed ROUTE block ending at next ROUTE block', () => {
    const text = `---ROUTE---
to: dev-1
summary: First task
---ROUTE---
to: dev-2
summary: Second task
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(2);
    const targets = routes.map(r => r.to).sort();
    expect(targets).toEqual(['dev-1', 'dev-2']);
  });

  it('should not double-parse blocks that have END_ROUTE', () => {
    const text = `---ROUTE---
to: dev-1
summary: Has proper ending
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1); // not 2
  });

  // ─── Shorthand: ROUTE → target / ROUTE: target ───────────────

  it('should parse ROUTE → target shorthand', () => {
    const text = `Work completed.\nROUTE → pm: 已完成开发，请审查`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('pm');
    expect(routes[0].summary).toBe('已完成开发，请审查');
  });

  it('should parse ROUTE: target shorthand', () => {
    const text = `Done with work.\nROUTE: rev-1, Please review the PR`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('rev-1');
    expect(routes[0].summary).toBe('Please review the PR');
  });

  it('should parse ROUTE → target without summary', () => {
    const text = `ROUTE → pm`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('pm');
    expect(routes[0].summary).toBe('[该角色未提供消息摘要]');
  });

  it('should not parse shorthand inside a standard ROUTE block', () => {
    const text = `---ROUTE---
to: dev-1
summary: ROUTE → pm should not be parsed as shorthand
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('dev-1');
  });

  // ─── Mixed scenarios ──────────────────────────────────────────

  it('should handle standard block + shorthand in same text', () => {
    const text = `---ROUTE---
to: dev-1
summary: Main task
---END_ROUTE---

Additional note:
ROUTE → pm: FYI this is done`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(2);
    expect(routes[0].to).toBe('dev-1');
    expect(routes[1].to).toBe('pm');
  });

  it('should return empty for text with no routing', () => {
    const routes = parseRoutes('Just regular conversation text, nothing special.');
    expect(routes).toHaveLength(0);
  });

  it('should return empty for empty string', () => {
    expect(parseRoutes('')).toHaveLength(0);
  });
});
