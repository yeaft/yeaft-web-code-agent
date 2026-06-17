import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSkillManager } from '../../../agent/yeaft/skills.js';

// Project-tier skill loading: <workDir>/.claude/skills (Claude Code assets)
// and <workDir>/.yeaft/skills (yeaft-native), plus their priority ordering.
//
// The bundled tier is redirected to an empty temp dir so these assertions
// only see the tiers under test — no interference from the repo's real
// bundled skill set.

let yeaftDir;        // user tier root (~/.yeaft analog)
let workDir;         // project tier root
let emptyBundledDir; // isolated empty bundled dir
let previousBundledDir;

function writeSkill(baseDir, relSkillsDir, name, description) {
  const dir = join(baseDir, relSkillsDir, name);
  mkdirSync(dir, { recursive: true });
  const body = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
  writeFileSync(join(dir, 'SKILL.md'), body);
}

beforeEach(() => {
  yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-tier-user-'));
  workDir = mkdtempSync(join(tmpdir(), 'yeaft-tier-project-'));
  emptyBundledDir = mkdtempSync(join(tmpdir(), 'yeaft-tier-bundled-'));
  previousBundledDir = process.env.YEAFT_SKILLS_BUNDLED_DIR;
  process.env.YEAFT_SKILLS_BUNDLED_DIR = emptyBundledDir;
});

afterEach(() => {
  if (previousBundledDir === undefined) {
    delete process.env.YEAFT_SKILLS_BUNDLED_DIR;
  } else {
    process.env.YEAFT_SKILLS_BUNDLED_DIR = previousBundledDir;
  }
  rmSync(yeaftDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  rmSync(emptyBundledDir, { recursive: true, force: true });
});

describe('createSkillManager — project .claude/skills tier', () => {
  it('loads a skill from <workDir>/.claude/skills with tier project-claude', () => {
    writeSkill(workDir, '.claude/skills', 'playwright-cli', 'Drive a browser.');

    const manager = createSkillManager(yeaftDir, workDir);
    const skill = manager.list().find(s => s.name === 'playwright-cli');
    expect(skill).toBeTruthy();
    expect(skill.tier).toBe('project-claude');
  });

  it('does not load project skills when workDir is omitted', () => {
    writeSkill(workDir, '.claude/skills', 'playwright-cli', 'Drive a browser.');

    const manager = createSkillManager(yeaftDir);
    expect(manager.list().find(s => s.name === 'playwright-cli')).toBeFalsy();
  });

  it('loads .yeaft/skills and .claude/skills simultaneously', () => {
    writeSkill(workDir, '.claude/skills', 'claude-only', 'From claude assets.');
    writeSkill(workDir, '.yeaft/skills', 'yeaft-only', 'From yeaft assets.');

    const manager = createSkillManager(yeaftDir, workDir);
    const names = manager.list().map(s => s.name).sort();
    expect(names).toContain('claude-only');
    expect(names).toContain('yeaft-only');
    expect(manager.list().find(s => s.name === 'claude-only').tier).toBe('project-claude');
    expect(manager.list().find(s => s.name === 'yeaft-only').tier).toBe('project');
  });
});

describe('createSkillManager — tier priority (deterministic)', () => {
  it('.yeaft/skills overrides a same-named .claude/skills skill', () => {
    writeSkill(workDir, '.claude/skills', 'shared', 'Claude version.');
    writeSkill(workDir, '.yeaft/skills', 'shared', 'Yeaft version.');

    const manager = createSkillManager(yeaftDir, workDir);
    const shared = manager.list().find(s => s.name === 'shared');
    // Highest tier wins: project (.yeaft/skills) over project-claude (.claude/skills).
    expect(shared.tier).toBe('project');
    expect(shared.description).toBe('Yeaft version.');
  });

  it('.claude/skills overrides a same-named user-tier skill', () => {
    writeSkill(yeaftDir, 'skills', 'shared', 'User version.');
    writeSkill(workDir, '.claude/skills', 'shared', 'Claude version.');

    const manager = createSkillManager(yeaftDir, workDir);
    const shared = manager.list().find(s => s.name === 'shared');
    // project-claude ranks above user (project-local beats user-global).
    expect(shared.tier).toBe('project-claude');
    expect(shared.description).toBe('Claude version.');
  });

  it('full chain: user < project-claude < project', () => {
    writeSkill(yeaftDir, 'skills', 'shared', 'User version.');
    writeSkill(workDir, '.claude/skills', 'shared', 'Claude version.');
    writeSkill(workDir, '.yeaft/skills', 'shared', 'Yeaft version.');

    const manager = createSkillManager(yeaftDir, workDir);
    const shared = manager.list().find(s => s.name === 'shared');
    expect(shared.tier).toBe('project');
    expect(shared.description).toBe('Yeaft version.');
  });

  it('user-tier skill survives when no project override exists', () => {
    writeSkill(yeaftDir, 'skills', 'user-skill', 'User version.');

    const manager = createSkillManager(yeaftDir, workDir);
    const skill = manager.list().find(s => s.name === 'user-skill');
    expect(skill.tier).toBe('user');
  });
});
