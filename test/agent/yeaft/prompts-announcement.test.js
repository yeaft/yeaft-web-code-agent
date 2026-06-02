/**
 * prompts-announcement.test.js — group announcement → system prompt.
 *
 * The announcement is a CLAUDE.md-style shared prefix injected near the
 * top of the system prompt so every VP in the group sees it before tools
 * or memory blocks. Empty/whitespace announcement = no block emitted.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildWorkerPrompt } from '../../../agent/yeaft/prompts.js';

describe('group announcement injection', () => {
  it('buildSystemPrompt emits [Group Announcement] block when non-empty', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      groupAnnouncement: 'Be concise.',
    });
    expect(out).toMatch(/\[Group Announcement\]\nBe concise\./);
  });

  it('buildSystemPrompt omits the block when announcement is empty/missing', () => {
    const out = buildSystemPrompt({ language: 'en', toolNames: ['bash'] });
    expect(out).not.toMatch(/Group Announcement/);
    const out2 = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      groupAnnouncement: '   ',
    });
    expect(out2).not.toMatch(/Group Announcement/);
  });

  it('buildWorkerPrompt forwards groupAnnouncement to base layer', () => {
    const out = buildWorkerPrompt({
      language: 'en',
      toolNames: ['bash'],
      groupAnnouncement: 'Cite sources.',
    });
    expect(out).toMatch(/\[Group Announcement\]\nCite sources\./);
  });

  it('announcement appears before tools section (high priority)', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash_xyz_marker'],
      groupAnnouncement: 'TEAM_RULE_MARKER',
    });
    const annPos = out.indexOf('TEAM_RULE_MARKER');
    const toolPos = out.indexOf('bash_xyz_marker');
    expect(annPos).toBeGreaterThan(0);
    expect(toolPos).toBeGreaterThan(0);
    expect(annPos).toBeLessThan(toolPos);
  });
});
