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

  // ─── Code block handling (task-328 contract change) ──────────
  // Prior to task-328 the parser unconditionally ignored fenced ROUTE blocks.
  // That broke real-world dispatches where users (and the PM) wrap ROUTE in
  // ```…``` for visual clarity — the message would silently disappear.
  // task-328 §A.1 inverts the rule: a fence that CONTAINS `---ROUTE---` is
  // treated as carrying a real ROUTE and is parsed. A fence that does NOT
  // contain `---ROUTE---` is still masked, so example field lines inside it
  // are still ignored.

  it('parses fenced ROUTE blocks (task-328 §A.1) AND a sibling unfenced ROUTE', () => {
    const text = `Here is the routed message:
\`\`\`
---ROUTE---
to: dev-1
summary: First (fenced)
---END_ROUTE---
\`\`\`

The real second route is below:
---ROUTE---
to: rev-1
summary: Please review PR #499
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(2);
    const tos = routes.map(r => r.to).sort();
    expect(tos).toEqual(['dev-1', 'rev-1']);
  });

  it('parses fenced ROUTEs even when message has multiple of them', () => {
    const text = `PM dispatching two routes (both fenced):
\`\`\`
---ROUTE---
to: rev-1
summary: example one
---END_ROUTE---
\`\`\`

\`\`\`
ROUTE → dev-1: shorthand inside fence
\`\`\`

No more routes.`;
    const routes = parseRoutes(text);
    // Real ROUTE block inside the first fence is parsed (task-328).
    // Shorthand line inside the second fence (no `---ROUTE---` opener) is
    // still masked and ignored.
    expect(routes).toHaveLength(1);
    expect(routes[0].to).toBe('rev-1');
    expect(routes[0].summary).toBe('example one');
  });

  it('handles mixed: fenced ROUTE + unfenced ROUTE — both parse', () => {
    const text = `Demo block:
\`\`\`
---ROUTE---
to: dev-1
summary: first
---END_ROUTE---
\`\`\`

Now sending for real:
---ROUTE---
to: pm
task: task-275
summary: Work done, please check
---END_ROUTE---`;
    const routes = parseRoutes(text);
    expect(routes).toHaveLength(2);
    expect(routes.find(r => r.to === 'dev-1')?.summary).toBe('first');
    const real = routes.find(r => r.to === 'pm');
    expect(real?.taskId).toBe('task-275');
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

  // ─── task-328 — 12-case regression matrix ────────────────────
  // Two scopes:
  //   A. parser tolerance (markdown fence, END/to variants, multi-paragraph
  //      summary, Chinese colon, unclosed block)
  //   B. non-ROUTE body preservation (`displayBody` accuracy)
  describe('task-328 — robustness + displayBody', () => {
    // ── 1. ROUTE wrapped in a markdown fence is still parsed ──
    it('case 1: fence-wrapped ROUTE is parsed and fence is stripped', () => {
      const text =
`Here is my report:
\`\`\`
---ROUTE---
to: pm
summary: done
---END_ROUTE---
\`\`\`
Tail prose stays.`;
      const r = parseRoutes(text);
      expect(r).toHaveLength(1);
      expect(r[0].to).toBe('pm');
      expect(r[0].summary).toBe('done');
      // displayBody must NOT contain ```...``` leftovers around the ROUTE
      expect(r.displayBody).not.toMatch(/```/);
      expect(r.displayBody).toContain('Here is my report');
      expect(r.displayBody).toContain('Tail prose stays.');
      expect(r.displayBody).not.toContain('---ROUTE---');
    });

    // ── 2. Multi-paragraph summary survives blank lines ──
    it('case 2: summary spans multiple paragraphs without truncation', () => {
      const text = `---ROUTE---
to: dev-1
summary: First paragraph of the summary.

Second paragraph still part of summary.

Third paragraph too.
---END_ROUTE---`;
      const r = parseRoutes(text);
      expect(r).toHaveLength(1);
      expect(r[0].summary).toContain('First paragraph');
      expect(r[0].summary).toContain('Second paragraph');
      expect(r[0].summary).toContain('Third paragraph');
    });

    // ── 3. Body before AND after the ROUTE block is preserved ──
    it('case 3: prose before AND after ROUTE survives in displayBody', () => {
      const text = `Intro line one.
Intro line two.

---ROUTE---
to: pm
summary: routed
---END_ROUTE---

Outro paragraph after the route.`;
      const r = parseRoutes(text);
      expect(r).toHaveLength(1);
      expect(r.displayBody).toContain('Intro line one');
      expect(r.displayBody).toContain('Intro line two');
      expect(r.displayBody).toContain('Outro paragraph after the route');
      expect(r.displayBody).not.toContain('---ROUTE---');
      expect(r.displayBody).not.toContain('---END_ROUTE---');
    });

    // ── 4. Chinese full-width colon `to：` is accepted ──
    it('case 4: Chinese colon `to：dev-1` is accepted', () => {
      const text = `---ROUTE---
to：dev-1
summary：中文冒号也能解析
---END---`;
      const r = parseRoutes(text);
      expect(r).toHaveLength(1);
      expect(r[0].to).toBe('dev-1');
      expect(r[0].summary).toBe('中文冒号也能解析');
    });

    // ── 5. Unclosed ROUTE — Phase 2 fallback + displayBody bound ──
    it('case 5: unclosed ROUTE keeps post-block prose if separated by structural cutoff', () => {
      const text = `---ROUTE---
to: pm
summary: still parses

---
后续段落（属于 displayBody）`;
      const r = parseRoutes(text);
      expect(r).toHaveLength(1);
      expect(r[0].to).toBe('pm');
      // Structural cutoff (\n\n+---) ends the route; the following prose
      // must remain in displayBody.
      expect(r.displayBody).toContain('后续段落（属于 displayBody）');
    });

    // ── 6. Multiple ROUTE blocks with prose in between ──
    it('case 6: multiple ROUTEs with mid-prose all parse and prose survives', () => {
      const text = `Top prose.

---ROUTE---
to: dev-1
summary: first
---END_ROUTE---

Mid prose between routes.

---ROUTE---
to: rev-1
summary: second
---END_ROUTE---

Bottom prose.`;
      const r = parseRoutes(text);
      expect(r).toHaveLength(2);
      expect(r[0].to).toBe('dev-1');
      expect(r[1].to).toBe('rev-1');
      expect(r.displayBody).toContain('Top prose');
      expect(r.displayBody).toContain('Mid prose between routes');
      expect(r.displayBody).toContain('Bottom prose');
      expect(r.displayBody).not.toContain('---ROUTE---');
    });

    // ── 7. Quoted example inside non-ROUTE fence is NOT parsed ──
    it('case 7: ROUTE-looking text inside a non-ROUTE fence is ignored', () => {
      // The fence does NOT contain ---ROUTE--- inside, so masking applies.
      // We embed text that resembles fields but not a real opener.
      const text =
`Below is an example of how to write a ROUTE block:
\`\`\`
to: dev-1
summary: example only
\`\`\`
No actual ROUTE was sent.`;
      const r = parseRoutes(text);
      expect(r).toHaveLength(0);
      // The example text in the fence is preserved in displayBody.
      expect(r.displayBody).toContain('to: dev-1');
      expect(r.displayBody).toContain('example only');
    });

    // ── 8. END variants: bare END / END: / ENDROUTE ──
    it('case 8: bare END / END: / ENDROUTE all close a block', () => {
      const variants = [
        ['---END---', 'bare END'],
        ['---END:---', 'END with colon'],
        ['---ENDROUTE---', 'no separator'],
        ['---END-ROUTE---', 'hyphen separator'],
      ];
      for (const [end, label] of variants) {
        const text = `---ROUTE---
to: pm
summary: ${label}
${end}`;
        const r = parseRoutes(text);
        expect(r, label).toHaveLength(1);
        expect(r[0].summary, label).toBe(label);
      }
    });

    // ── 9. Mixed ASCII + Chinese colon in a single block ──
    it('case 9: mixed `:` and `：` in same block both parse', () => {
      const text = `---ROUTE---
to: pm
task：task-328
summary: 混合冒号
---END_ROUTE---`;
      const r = parseRoutes(text);
      expect(r).toHaveLength(1);
      expect(r[0].to).toBe('pm');
      expect(r[0].taskId).toBe('task-328');
      expect(r[0].summary).toBe('混合冒号');
    });

    // ── 10. displayBody is empty when message is purely a ROUTE ──
    it('case 10: pure-ROUTE message yields empty displayBody', () => {
      const text = `---ROUTE---
to: pm
summary: nothing else
---END_ROUTE---`;
      const r = parseRoutes(text);
      expect(r).toHaveLength(1);
      expect(r.displayBody).toBe('');
    });

    // ── 11. Backward compatibility: legacy Array consumers still work ──
    it('case 11: result is iterable as an Array (legacy callers)', () => {
      const text = `---ROUTE---
to: dev-1
summary: x
---END_ROUTE---
---ROUTE---
to: rev-1
summary: y
---END_ROUTE---`;
      const r = parseRoutes(text);
      // legacy: for..of, .length, numeric index
      expect(Array.isArray(r)).toBe(true);
      expect(r.length).toBe(2);
      expect(r[0].to).toBe('dev-1');
      expect(r[1].to).toBe('rev-1');
      const collected = [];
      for (const route of r) collected.push(route.to);
      expect(collected).toEqual(['dev-1', 'rev-1']);
      // new fields still attached
      expect(typeof r.displayBody).toBe('string');
      expect(Array.isArray(r.strippedRanges)).toBe(true);
    });

    // ── 12. Structural cutoff: <kanban> and <recent-routes> end soft block ──
    it('case 12: <kanban>/<recent-routes>/<task-context> end an unclosed ROUTE', () => {
      const text = `---ROUTE---
to: pm
summary: routed before kanban dump

<kanban file=".crew/context/kanban.md">
…lots of stuff…
</kanban>`;
      const r = parseRoutes(text);
      expect(r).toHaveLength(1);
      expect(r[0].summary).toContain('routed before kanban dump');
      // The kanban block must NOT be eaten into the summary.
      expect(r[0].summary).not.toContain('lots of stuff');
      // And it must survive in displayBody.
      expect(r.displayBody).toContain('<kanban');
      expect(r.displayBody).toContain('lots of stuff');
    });
  });
});
