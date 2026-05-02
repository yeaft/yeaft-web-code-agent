/**
 * prompts-active-scope.test.js — DESIGN-PROMPT §3 ④ Active Scope.
 *
 * The Active Scope block is a structured, deterministic, bounded section
 * of the system prompt that tells the LLM what scope this turn lives in:
 *   - feature (nullable; T4 placeholder per DESIGN-PROMPT §5.1)
 *   - group
 *   - vp
 *   - envelope (compressed routing summary)
 *
 * Long-form scope content lives in AMS Memory; Active Scope only carries
 * IDs + tiny labels. These tests pin the contract so future refactors do
 * not silently drop or duplicate fields.
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../agent/unify/prompts.js';

describe('Active Scope rendering (DESIGN-PROMPT §3 ④)', () => {
  it('emits ## active_scope header when any field is present', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      activeScope: { groupId: 'team-x' },
    });
    expect(out).toMatch(/## active_scope\ngroup: team-x/);
  });

  it('omits the block entirely when all fields are empty', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      activeScope: {},
    });
    expect(out).not.toMatch(/active_scope/);
  });

  it('omits the block when activeScope is undefined', () => {
    const out = buildSystemPrompt({ language: 'en', toolNames: ['bash'] });
    expect(out).not.toMatch(/active_scope/);
  });

  it('renders feature with optional title', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      activeScope: { featureId: 'feat-42', featureTitle: 'Onboarding' },
    });
    expect(out).toMatch(/feature: feat-42 "Onboarding"/);
  });

  it('renders feature without title when title missing', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      activeScope: { featureId: 'feat-42' },
    });
    expect(out).toMatch(/feature: feat-42(?!\s*")/);
    expect(out).not.toMatch(/feature: feat-42 "/);
  });

  it('omits feature line when featureId is null (T4 placeholder)', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      activeScope: { featureId: null, groupId: 'g1' },
    });
    expect(out).toMatch(/## active_scope\ngroup: g1/);
    expect(out).not.toMatch(/feature:/);
  });

  it('renders all fields together in stable order', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      activeScope: {
        featureId: 'f1',
        featureTitle: 'T',
        groupId: 'g1',
        vpId: 'alice',
        envelope: { fromVpId: 'bob', intent: 'ask' },
      },
    });
    const block = out.split('## active_scope\n')[1];
    expect(block).toBeTruthy();
    const lines = block.split('\n').slice(0, 4);
    expect(lines[0]).toBe('feature: f1 "T"');
    expect(lines[1]).toBe('group: g1');
    expect(lines[2]).toBe('vp: alice');
    expect(lines[3]).toBe('envelope: from=bob intent=ask');
  });

  it('envelope: compresses sender, intent, and originating user', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      activeScope: {
        envelope: { senderVpId: 'bob', fromUserId: 'u-1', intent: 'handoff' },
      },
    });
    expect(out).toMatch(/envelope: from=bob user=u-1 intent=handoff/);
  });

  it('envelope: omitted entirely when no recognized field', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      activeScope: { groupId: 'g1', envelope: {} },
    });
    expect(out).not.toMatch(/envelope:/);
  });

  it('whitespace-only IDs are treated as missing', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      activeScope: { groupId: '   ', vpId: 'alice' },
    });
    expect(out).toMatch(/## active_scope\nvp: alice/);
    expect(out).not.toMatch(/group:/);
  });
});

describe('Memory section single outlet (DESIGN-PROMPT §3 ③)', () => {
  it('memoryInjection content is rendered verbatim (no extra header wrapping)', () => {
    const block = '## Active Memory Set\n### Resident\n- **user**: hi';
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      memoryInjection: block,
    });
    expect(out).toContain(block);
  });

  it('user_profile / core_memory sections are no longer present', () => {
    // These sections were retired in DESIGN-PROMPT v1: the same data flows
    // through AMS Resident now. Even if a caller tried to set them, they
    // should not appear in the output.
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      // Pass legacy params; they should be silently ignored by the new
      // signature.
      userProfile: 'User uses zsh.',
      coreMemory: { entries: [{ body: 'Likes haskell', shard: 'lang' }] },
      memoryTraceAvailable: true,
    });
    expect(out).not.toMatch(/## user_profile/);
    expect(out).not.toMatch(/## core_memory/);
  });

  it('compact summary header is no longer present in system prompt', () => {
    // DESIGN-PROMPT §4.3: compact summary moved to messages array head.
    // Even if a caller tried to set it, the system prompt builder should
    // not render it.
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      compactSummary: 'Earlier we discussed X.',
    });
    expect(out).not.toMatch(/Conversation History Summary/);
    expect(out).not.toMatch(/对话历史摘要/);
    expect(out).not.toContain('Earlier we discussed X.');
  });
});
