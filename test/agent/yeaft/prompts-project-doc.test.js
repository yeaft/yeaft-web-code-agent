/**
 * prompts-project-doc.test.js — CLAUDE.md / AGENTS.md → system prompt.
 *
 * The project-doc block is a CLAUDE.md-style verbatim insertion drawn
 * from the group's working directory. It sits ABOVE the group
 * announcement (user-authored project files outrank group-level
 * announcements) and explains in a one-liner intro what these files
 * mean, so the model treats them as authoritative project context.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildWorkerPrompt } from '../../../agent/yeaft/prompts.js';

describe('project doc injection', () => {
  it('buildSystemPrompt emits [Project Doc] block when non-empty', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      projectDoc: '# Project\n\nUse pnpm, not npm.',
    });
    expect(out).toMatch(/\[Project Doc\]/);
    expect(out).toMatch(/Use pnpm, not npm\./);
    // Intro line mentions both filenames so the model knows what the
    // block represents and how the user maintains it.
    expect(out).toMatch(/CLAUDE\.md/);
    expect(out).toMatch(/AGENTS\.md/);
  });

  it('buildSystemPrompt omits the block when projectDoc is empty/whitespace/missing', () => {
    const empty = buildSystemPrompt({ language: 'en', toolNames: ['bash'] });
    expect(empty).not.toMatch(/Project Doc/);

    const whitespace = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      projectDoc: '   \n\n  ',
    });
    expect(whitespace).not.toMatch(/Project Doc/);
  });

  it('buildWorkerPrompt forwards projectDoc to base layer', () => {
    const out = buildWorkerPrompt({
      language: 'en',
      toolNames: ['bash'],
      projectDoc: 'PROJECT_DOC_MARKER',
    });
    expect(out).toMatch(/PROJECT_DOC_MARKER/);
    expect(out).toMatch(/\[Project Doc\]/);
  });

  it('project doc appears ABOVE the group announcement', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      projectDoc: 'DOC_MARKER',
      groupAnnouncement: 'ANN_MARKER',
    });
    const docPos = out.indexOf('DOC_MARKER');
    const annPos = out.indexOf('ANN_MARKER');
    expect(docPos).toBeGreaterThan(0);
    expect(annPos).toBeGreaterThan(0);
    expect(docPos).toBeLessThan(annPos);
  });

  it('project doc appears before the tools section (high priority)', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash_xyz_tool_marker'],
      projectDoc: 'DOC_MARKER',
    });
    const docPos = out.indexOf('DOC_MARKER');
    const toolPos = out.indexOf('bash_xyz_tool_marker');
    expect(docPos).toBeGreaterThan(0);
    expect(toolPos).toBeGreaterThan(0);
    expect(docPos).toBeLessThan(toolPos);
  });

  it('zh locale renders [项目文档] header', () => {
    const out = buildSystemPrompt({
      language: 'zh-CN',
      toolNames: ['bash'],
      projectDoc: '使用 pnpm 而不是 npm。',
    });
    expect(out).toMatch(/\[项目文档\]/);
    expect(out).toMatch(/CLAUDE\.md/);
    expect(out).toMatch(/AGENTS\.md/);
    expect(out).toMatch(/使用 pnpm 而不是 npm。/);
  });

  it('docHeader + intro + body are joined with blank-line spacing', () => {
    const out = buildSystemPrompt({
      language: 'en',
      toolNames: ['bash'],
      projectDoc: 'BODY_MARKER',
    });
    // Verify the block has the shape: header\nintro\n\nbody
    // (a blank line between intro paragraph and body content).
    const block = out.match(/\[Project Doc\][\s\S]*?BODY_MARKER/);
    expect(block).not.toBeNull();
    expect(block[0]).toMatch(/\n\nBODY_MARKER$/);
  });
});
