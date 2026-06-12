/**
 * skills-layered.test.js — Claude-Code-style layered SkillManager
 *
 * Covers tier override semantics:
 *   (a) Bundled-only setup → all bundled skills visible, tier=bundled
 *   (b) User adds same-name skill → user version wins (later-tier overrides)
 *   (c) Project adds same-name skill → project wins (highest priority)
 *   (d) save() always targets the user tier (not bundled, not project)
 *   (e) remove() refuses bundled/project tier files
 *   (f) createSkillManager wires the standard 3-tier list
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SkillManager, createSkillManager } from '../../../agent/yeaft/skills.js';

let bundledDir;
let userDir;
let projectDir;
let yeaftDir;
let workDir;
let originalEnv;

function writeSkill(root, name, body) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

function frontmatter(name, extra = '') {
  return `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\n`;
}

beforeEach(() => {
  // Bundled dir is wired via the env-override in `bundledYeaftSkillsDir()`.
  bundledDir = mkdtempSync(join(tmpdir(), 'yeaft-layered-bundled-'));
  yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-layered-yeaftdir-'));
  workDir = mkdtempSync(join(tmpdir(), 'yeaft-layered-workdir-'));
  userDir = join(yeaftDir, 'skills');
  projectDir = join(workDir, '.yeaft', 'skills');
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  originalEnv = process.env.YEAFT_SKILLS_BUNDLED_DIR;
  process.env.YEAFT_SKILLS_BUNDLED_DIR = bundledDir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.YEAFT_SKILLS_BUNDLED_DIR;
  else process.env.YEAFT_SKILLS_BUNDLED_DIR = originalEnv;
  for (const d of [bundledDir, yeaftDir, workDir]) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('SkillManager — bundled-only visibility', () => {
  it('loads every bundled skill when no user or project tier exists', () => {
    writeSkill(bundledDir, 'alpha', frontmatter('alpha') + 'bundled body A');
    writeSkill(bundledDir, 'beta', frontmatter('beta') + 'bundled body B');

    const mgr = createSkillManager(yeaftDir);  // no project dir
    const list = mgr.list();

    expect(list.map(s => s.name).sort()).toEqual(['alpha', 'beta']);
    expect(mgr.get('alpha').content).toBe('bundled body A');
    expect(mgr.get('beta').content).toBe('bundled body B');
    // tier label
    expect(mgr.list().find(s => s.name === 'alpha').tier).toBe('bundled');
  });
});

describe('SkillManager — user tier overrides bundled', () => {
  it('user version wins when user defines the same skill name', () => {
    writeSkill(bundledDir, 'alpha', frontmatter('alpha') + 'bundled body');
    writeSkill(userDir, 'alpha', frontmatter('alpha') + 'user body');

    const mgr = createSkillManager(yeaftDir);
    expect(mgr.get('alpha').content).toBe('user body');
    expect(mgr.list().find(s => s.name === 'alpha').tier).toBe('user');
  });

  it('user-only skill is loaded even when not in bundled', () => {
    writeSkill(userDir, 'only-user', frontmatter('only-user') + 'only here');
    const mgr = createSkillManager(yeaftDir);
    expect(mgr.has('only-user')).toBe(true);
    expect(mgr.get('only-user').content).toBe('only here');
  });
});

describe('SkillManager — project tier overrides everything', () => {
  it('project version wins over user + bundled', () => {
    writeSkill(bundledDir, 'alpha', frontmatter('alpha') + 'bundled body');
    writeSkill(userDir, 'alpha', frontmatter('alpha') + 'user body');
    writeSkill(projectDir, 'alpha', frontmatter('alpha') + 'project body');

    const mgr = createSkillManager(yeaftDir, workDir);
    expect(mgr.get('alpha').content).toBe('project body');
    expect(mgr.list().find(s => s.name === 'alpha').tier).toBe('project');
  });

  it('project-only skill appears even when bundled/user have nothing', () => {
    writeSkill(projectDir, 'project-only', frontmatter('project-only') + 'p body');
    const mgr = createSkillManager(yeaftDir, workDir);
    expect(mgr.get('project-only').content).toBe('p body');
  });
});

describe('SkillManager — save() targets user tier only', () => {
  it('writes to userDir even when bundled has the same name', () => {
    writeSkill(bundledDir, 'alpha', frontmatter('alpha') + 'bundled');
    const mgr = createSkillManager(yeaftDir);
    expect(mgr.get('alpha').content).toBe('bundled');  // bundled wins pre-save

    mgr.save({
      name: 'alpha',
      description: 'Alpha override',
      trigger: '',
      content: 'user fork',
    });

    // File written under userDir
    const userPath = join(userDir, 'alpha.md');
    expect(existsSync(userPath)).toBe(true);
    expect(readFileSync(userPath, 'utf8')).toContain('user fork');
    // Bundled file untouched
    expect(readFileSync(join(bundledDir, 'alpha', 'SKILL.md'), 'utf8')).toContain('bundled');

    // In-memory entry is now tagged user
    expect(mgr.get('alpha').content).toBe('user fork');
    expect(mgr.get('alpha')._tier).toBe('user');
  });
});

describe('SkillManager — remove() refuses non-user tier', () => {
  it('returns false when asked to remove a bundled skill (file stays)', () => {
    writeSkill(bundledDir, 'alpha', frontmatter('alpha') + 'bundled');
    const mgr = createSkillManager(yeaftDir);

    const result = mgr.remove('alpha');
    expect(result).toBe(false);
    // Bundled file MUST still exist
    expect(existsSync(join(bundledDir, 'alpha', 'SKILL.md'))).toBe(true);
    // And the in-memory entry should still be there (a future load would
    // bring it back anyway).
    expect(mgr.has('alpha')).toBe(true);
  });

  it('removes a user-tier file successfully', () => {
    writeSkill(userDir, 'mine', frontmatter('mine') + 'mine');
    const mgr = createSkillManager(yeaftDir);

    expect(mgr.has('mine')).toBe(true);
    const result = mgr.remove('mine');
    expect(result).toBe(true);
    // File gone from disk + index
    expect(existsSync(join(userDir, 'mine', 'SKILL.md'))).toBe(false);
    expect(mgr.has('mine')).toBe(false);
  });
});

describe('SkillManager — direct (non-factory) usage', () => {
  it('honours the dirs[] priority list and tags _tier from tierByDir', () => {
    writeSkill(bundledDir, 'one', frontmatter('one') + 'A');
    writeSkill(userDir, 'one', frontmatter('one') + 'B');
    writeSkill(projectDir, 'one', frontmatter('one') + 'C');

    const mgr = new SkillManager([bundledDir, userDir, projectDir], {
      userDir,
      tierByDir: { [bundledDir]: 'bundled', [userDir]: 'user', [projectDir]: 'project' },
    });
    mgr.load();

    expect(mgr.get('one').content).toBe('C');
    expect(mgr.get('one')._tier).toBe('project');
  });

  it('returns load() result shape with loaded count + errors array', () => {
    writeSkill(bundledDir, 'alpha', frontmatter('alpha') + 'a');
    const mgr = new SkillManager([bundledDir], { userDir: bundledDir });
    const res = mgr.load();
    expect(res.loaded).toBe(1);
    expect(Array.isArray(res.errors)).toBe(true);
  });
});
