/**
 * Bug 3 + Bug 4 — VP persona injection into the system prompt and
 * Router/senderVpId injection into the tool ctx.
 *
 * These pin the wiring so we don't regress the silent fallbacks where:
 *   - the system prompt stayed as the generic "You are Yeaft" line even
 *     when an @VP-mention was the entire reason this turn ran
 *   - RouteForward returned `router_unavailable` because nothing built a
 *     Router and stuffed it into ctx.
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../agent/unify/prompts.js';
import RouteForwardTool from '../../../agent/unify/tools/route-forward.js';

describe('buildSystemPrompt — vpPersona block', () => {
  it('renders persona-as-identity H1 with display name + role + persona body', () => {
    const out = buildSystemPrompt({
      language: 'en',
      vpPersona: {
        displayName: 'Linus Torvalds',
        role: 'kernel hacker',
        persona: 'I prefer working code over working theories.',
      },
    });
    // Phase 8 wire-up: persona is the IDENTITY layer, emitted as
    // `# <name> — <role>` H1 (not the legacy `## active_persona` overlay).
    expect(out).toMatch(/# Linus Torvalds — kernel hacker/);
    expect(out).toMatch(/working code over working theories/);
    // The legacy Yeaft companion identity must NOT appear when a VP
    // persona is active.
    expect(out).not.toMatch(/Yeaft — AI Companion/);
  });

  it('omits the block when displayName is missing (no useful signal)', () => {
    const out = buildSystemPrompt({
      language: 'en',
      vpPersona: { persona: 'orphan persona body' },
    });
    expect(out).not.toMatch(/orphan persona body/);
  });

  it('keeps the intro line when persona body is empty (still tells LLM whose voice)', () => {
    const out = buildSystemPrompt({
      language: 'en',
      vpPersona: { displayName: 'Grace Hopper' },
    });
    expect(out).toMatch(/# Grace Hopper/);
    // First-person identity assertion.
    expect(out).toMatch(/You ARE \*\*Grace Hopper\*\*/);
  });

  it('zh language renders the zh persona intro', () => {
    const out = buildSystemPrompt({
      language: 'zh',
      vpPersona: {
        displayName: 'Linus Torvalds',
        role: 'kernel hacker',
        persona: '只看代码。',
      },
    });
    expect(out).toMatch(/# Linus Torvalds — kernel hacker/);
    expect(out).toMatch(/你就是/);
    expect(out).toMatch(/只看代码/);
  });
});

describe('RouteForward — ctx wiring', () => {
  it('returns router_unavailable when ctx.router is missing', async () => {
    const out = await RouteForwardTool.execute(
      { to: 'linus', text: 'hi' },
      { senderVpId: 'ken' },
    );
    expect(JSON.parse(out)).toEqual({ ok: false, error: 'router_unavailable' });
  });

  it('returns sender_unknown when senderVpId is missing', async () => {
    const fakeRouter = { forward: () => ({ ok: true, dispatched: ['linus'], report: {} }) };
    const out = await RouteForwardTool.execute(
      { to: 'linus', text: 'hi' },
      { router: fakeRouter },
    );
    expect(JSON.parse(out)).toEqual({ ok: false, error: 'sender_unknown' });
  });

  it('forwards through the supplied router with senderVpId as `from`', async () => {
    let captured = null;
    const fakeRouter = {
      forward: (args) => {
        captured = args;
        return { ok: true, dispatched: ['linus'], report: { broadcast: false } };
      },
    };
    const out = await RouteForwardTool.execute(
      { to: 'linus', text: 'over to you', reason: 'you own the kernel' },
      { router: fakeRouter, senderVpId: 'ken', taskId: 't_1' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.dispatched).toEqual(['linus']);
    expect(captured.from).toBe('ken');
    expect(captured.to).toBe('linus');
    expect(captured.text).toBe('over to you');
    expect(captured.reason).toBe('you own the kernel');
    expect(captured.taskId).toBe('t_1');
  });
});
