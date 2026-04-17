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

  // ─── Code block immunity ──────────────────────────────────────

  it('should ignore ROUTE blocks inside fenced code blocks', () => {
    const text = `Here is an example of ROUTE format:
\`\`\`
---ROUTE---
to: dev-1
summary: This is just an example
---END_ROUTE---
\`\`\`

The real route is below:
---ROUTE---
to: rev-1
summary: Please review PR #499
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('rev-1');
    expect(routes[0].summary).toBe('Please review PR #499');
  });

  it('should ignore all ROUTE content inside code blocks', () => {
    const text = `PM explaining ROUTE format to human:
\`\`\`
---ROUTE---
to: rev-1
summary: example
---END_ROUTE---

ROUTE → dev-1: another example
\`\`\`

No actual routes here.`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(0);
  });

  it('should handle mixed: real route outside + example inside code block', () => {
    const text = `I showed the format:
\`\`\`
---ROUTE---
to: dev-1
summary: fake
---END_ROUTE---
\`\`\`

Now sending for real:
---ROUTE---
to: pm
task: task-275
summary: Work done, please check
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('pm');
    expect(routes[0].taskId).toBe('task-275');
  });

  // ─── task-319: bare ---END--- closer + bare-body summary + blank-line cutoff ──

  describe('task-319 — bare ---END--- closer / bare-body / Phase 2 cutoff', () => {
    it('should accept bare ---END--- closer (not just ---END_ROUTE---)', () => {
      const text = `---ROUTE---
to: rev-1
summary: Please review
---END---`;
      const routes = parseRoutes(text);
      expect(routes).toHaveLength(1);
      expect(routes[0].to).toBe('rev-1');
      expect(routes[0].summary).toBe('Please review');
    });

    it('should use bare body as summary when `summary:` label is omitted', () => {
      const text = `---ROUTE---
to: pm
Work is done, please check and merge.
---END---`;
      const routes = parseRoutes(text);
      expect(routes).toHaveLength(1);
      expect(routes[0].to).toBe('pm');
      expect(routes[0].summary).toBe('Work is done, please check and merge.');
    });

    it('should collect multi-line bare body as summary', () => {
      const text = `---ROUTE---
to: dev-1
Line one of the message.
Line two of the message.
---END---`;
      const routes = parseRoutes(text);
      expect(routes).toHaveLength(1);
      expect(routes[0].summary).toBe('Line one of the message.\nLine two of the message.');
    });

    it('Phase 2 fallback: blank line stops summary so kanban/recent-routes are not swallowed', () => {
      const text = `---ROUTE---
to: pm
summary: Shipped v0.1.420

---
<kanban file=".crew/context/kanban.md">
| task-100 | Add dark mode | dev-1 | In Review |
</kanban>

---
<recent-routes>
[pm → dev-1] Please implement dark mode
</recent-routes>`;
      const routes = parseRoutes(text);
      expect(routes).toHaveLength(1);
      expect(routes[0].to).toBe('pm');
      expect(routes[0].summary).toBe('Shipped v0.1.420');
      expect(routes[0].summary).not.toContain('kanban');
      expect(routes[0].summary).not.toContain('recent-routes');
    });

    it('Phase 2 fallback with bare body: blank-line cutoff still applies', () => {
      const text = `---ROUTE---
to: pm
Work done, submitting.

---
<kanban>garbage context</kanban>`;
      const routes = parseRoutes(text);
      expect(routes).toHaveLength(1);
      expect(routes[0].to).toBe('pm');
      expect(routes[0].summary).toBe('Work done, submitting.');
    });

    it('should default summary placeholder when block has only `to:` and nothing else', () => {
      const text = `---ROUTE---
to: pm
---END---`;
      const routes = parseRoutes(text);
      expect(routes).toHaveLength(1);
      expect(routes[0].summary).toBe('[该角色未提供消息摘要]');
    });

    it('should not parse inline "ROUTE → x" shorthand inside a bare-END ROUTE block', () => {
      const text = `---ROUTE---
to: dev-1
summary: work mentions ROUTE → pm but that is content, not a shorthand
---END---`;
      const routes = parseRoutes(text);
      expect(routes).toHaveLength(1);
      expect(routes[0].to).toBe('dev-1');
    });

    it('bare-body fallback does not overwrite an explicit `summary:` label', () => {
      // When `summary:` is present, _parseRouteBlock captures it and the
      // bare-body branch must be skipped entirely — otherwise the labelled
      // summary could be replaced by whatever free text lives below.
      const text = `---ROUTE---
to: pm
summary: Real summary
task: task-42
---END---`;
      const routes = parseRoutes(text);
      expect(routes).toHaveLength(1);
      expect(routes[0].summary).toBe('Real summary');
      expect(routes[0].taskId).toBe('task-42');
    });
  });
});
