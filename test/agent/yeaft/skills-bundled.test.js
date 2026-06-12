import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSkillManager } from '../../../agent/yeaft/skills.js';

const bundledSkillsDir = join(process.cwd(), 'skills');

let yeaftDir;
let previousBundledDir;

beforeEach(() => {
  yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-skills-test-'));
  previousBundledDir = process.env.YEAFT_SKILLS_BUNDLED_DIR;
  process.env.YEAFT_SKILLS_BUNDLED_DIR = bundledSkillsDir;
});

afterEach(() => {
  if (previousBundledDir === undefined) {
    delete process.env.YEAFT_SKILLS_BUNDLED_DIR;
  } else {
    process.env.YEAFT_SKILLS_BUNDLED_DIR = previousBundledDir;
  }
  rmSync(yeaftDir, { recursive: true, force: true });
});

describe('bundled skills', () => {
  it('loads the review merge tag workflow skill', () => {
    const manager = createSkillManager(yeaftDir);

    const listed = manager.list().find(skill => skill.name === 'review-merge-tag');
    expect(listed).toMatchObject({
      name: 'review-merge-tag',
      source: 'directory',
      tier: 'bundled',
    });

    const viewed = manager.view('review-merge-tag');
    expect(viewed?.skill.content).toContain('gh pr merge <pr> --merge --delete-branch');
    expect(viewed?.skill.content).toContain('git push origin <nextTag>');
    expect(viewed?.skill.content).toContain('ExitWorktree');
    expect(viewed?.skill.content).toContain('禁止 `git push origin HEAD:main`');
  });
});
