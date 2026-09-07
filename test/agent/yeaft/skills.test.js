import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bundledYeaftSkillsDir,
  bundledYeaftSkillsDirs,
  createManagedProjectSkill,
  createManagedSkill,
  createSkillManager,
  parseSkill,
  removeManagedProjectSkill,
  removeManagedSkill,
  SkillManager,
} from '../../../agent/yeaft/skills.js';
import { buildPluginCatalog } from '../../../agent/yeaft/plugins.js';
import { seedBundledSkills } from '../../../agent/yeaft/init.js';

const roots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-skills-'));
  roots.push(root);
  return root;
}

function write(root, relativePath, content) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function skill(name, body = '# Instructions') {
  return `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('parseSkill', () => {
  it('accepts leading HTML attribution comments before frontmatter', () => {
    const raw = `<!-- Adapted from example.test (MIT License) -->\n${skill('brainstorming')}`;

    expect(parseSkill(raw, 'SKILL.md')).toMatchObject({
      name: 'brainstorming',
      description: 'brainstorming description',
      content: '# Instructions',
    });
  });

  it('does not accept arbitrary prose before frontmatter', () => {
    expect(parseSkill(`not metadata\n${skill('hidden')}`, 'hidden.md')).toBeNull();
  });
});

describe('SkillManager discovery', () => {
  it('ignores ordinary Markdown documents while loading valid legacy and directory skills', () => {
    const root = tempRoot();
    write(root, 'README.md', '# Skill collection\n');
    write(root, 'personas/README.md', '# Persona guide\n');
    write(root, 'legacy.md', skill('legacy'));
    write(root, 'brainstorming/SKILL.md', `<!-- License notice -->\n${skill('brainstorming')}`);

    const manager = new SkillManager(root);
    const result = manager.load();

    expect(result.errors).toEqual([]);
    expect(manager.list().map(item => item.name).sort()).toEqual(['brainstorming', 'legacy']);
  });

  it('still reports malformed Skill candidates instead of silently ignoring them', () => {
    const root = tempRoot();
    write(root, 'broken/SKILL.md', '# Missing frontmatter\n');
    write(root, 'broken-legacy.md', '---\nname: broken\n');

    const result = new SkillManager(root).load();

    expect(result.errors).toEqual([
      'Failed to parse skill: broken/SKILL.md',
      'Failed to parse skill: broken-legacy.md',
    ]);
  });

  it('applies the same document and attribution rules to secure project Skill roots', () => {
    const workspace = tempRoot();
    const projectSkills = join(workspace, '.yeaft', 'skills');
    write(workspace, '.yeaft/skills/personas/README.md', '# Persona guide\n');
    write(workspace, '.yeaft/skills/brainstorming/SKILL.md', `<!-- License notice -->\n${skill('brainstorming')}`);
    write(workspace, '.yeaft/skills/broken/SKILL.md', '# Missing frontmatter\n');

    const manager = new SkillManager(projectSkills, {
      tierByDir: { [projectSkills]: 'project' },
      secureWorkspaceByDir: {
        [projectSkills]: { workspaceRoot: workspace, relativeRoot: '.yeaft/skills' },
      },
    });
    const result = manager.load();

    expect(result.errors).toEqual(['Failed to parse skill: broken/SKILL.md']);
    expect(manager.list().map(item => item.name)).toEqual(['brainstorming']);
  });

  it('does not follow linked project Skill directories in a secure workspace', () => {
    const workspace = tempRoot();
    const projectSkills = join(workspace, '.yeaft', 'skills');
    const external = tempRoot();
    write(external, 'SKILL.md', skill('escaped-dir', 'EXTERNAL_SKILL_SENTINEL'));
    write(workspace, '.yeaft/skills/local/SKILL.md', skill('local'));

    try {
      symlinkSync(external, join(projectSkills, 'linked-directory-skill'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      // Windows can deny junction/symlink creation under restricted policies.
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return;
      throw error;
    }

    const manager = new SkillManager(projectSkills, {
      tierByDir: { [projectSkills]: 'project' },
      secureWorkspaceByDir: {
        [projectSkills]: { workspaceRoot: workspace, relativeRoot: '.yeaft/skills' },
      },
    });

    expect(manager.load()).toMatchObject({ loaded: 1, errors: [] });
    expect(manager.list().map(item => item.name)).toEqual(['local']);
    expect(manager.get('escaped-dir')).toBeNull();
    expect(manager.getRelevantPromptContent('escaped-dir')).not.toContain('EXTERNAL_SKILL_SENTINEL');
  });

  it('does not follow a project Skill link to another directory inside the workspace', () => {
    const workspace = tempRoot();
    const projectSkills = join(workspace, '.yeaft', 'skills');
    const internalTarget = join(workspace, 'shared-skill-content');
    write(internalTarget, 'SKILL.md', skill('escaped-internal', 'INTERNAL_LINK_SENTINEL'));
    write(workspace, '.yeaft/skills/local/SKILL.md', skill('local'));

    try {
      symlinkSync(internalTarget, join(projectSkills, 'linked-internal-skill'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return;
      throw error;
    }

    const manager = new SkillManager(projectSkills, {
      tierByDir: { [projectSkills]: 'project' },
      secureWorkspaceByDir: {
        [projectSkills]: { workspaceRoot: workspace, relativeRoot: '.yeaft/skills' },
      },
    });

    expect(manager.load()).toMatchObject({ loaded: 1, errors: [] });
    expect(manager.list().map(item => item.name)).toEqual(['local']);
    expect(manager.get('escaped-internal')).toBeNull();
    expect(manager.getRelevantPromptContent('escaped-internal')).not.toContain('INTERNAL_LINK_SENTINEL');
  });

  it('does not follow a linked SKILL.md file in a secure workspace', () => {
    const workspace = tempRoot();
    const projectSkills = join(workspace, '.yeaft', 'skills');
    const external = join(tempRoot(), 'external-skill.md');
    writeFileSync(external, skill('escaped-file', 'EXTERNAL_FILE_SENTINEL'));
    mkdirSync(join(projectSkills, 'ordinary-skill'), { recursive: true });

    try {
      symlinkSync(external, join(projectSkills, 'ordinary-skill', 'SKILL.md'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return;
      throw error;
    }

    const manager = new SkillManager(projectSkills, {
      tierByDir: { [projectSkills]: 'project' },
      secureWorkspaceByDir: {
        [projectSkills]: { workspaceRoot: workspace, relativeRoot: '.yeaft/skills' },
      },
    });

    expect(manager.load()).toMatchObject({ loaded: 0, errors: [] });
    expect(manager.get('escaped-file')).toBeNull();
    expect(manager.getRelevantPromptContent('escaped-file')).not.toContain('EXTERNAL_FILE_SENTINEL');
  });

  it('does not read linked Skill references in a secure workspace', () => {
    const workspace = tempRoot();
    const projectSkills = join(workspace, '.yeaft', 'skills');
    const external = join(tempRoot(), 'external-reference.md');
    write(workspace, '.yeaft/skills/local/SKILL.md', skill('local'));
    writeFileSync(external, 'EXTERNAL_REFERENCE_SENTINEL', 'utf8');
    mkdirSync(join(projectSkills, 'local', 'references'), { recursive: true });

    try {
      symlinkSync(external, join(projectSkills, 'local', 'references', 'escape.md'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return;
      throw error;
    }

    const manager = new SkillManager(projectSkills, {
      tierByDir: { [projectSkills]: 'project' },
      secureWorkspaceByDir: {
        [projectSkills]: { workspaceRoot: workspace, relativeRoot: '.yeaft/skills' },
      },
    });

    manager.load();
    expect(manager.view('local')).toMatchObject({ references: [] });
    expect(manager.view('local', 'references/escape.md').linkedContent)
      .toBe('Error reading file: secure workspace read failed');
  });

  it('loads identical valid skills from layered roots without duplicate parse errors', () => {
    const bundled = tempRoot();
    const user = tempRoot();
    const raw = `<!-- Adapted under MIT -->\n${skill('brainstorming')}`;
    write(bundled, 'brainstorming/SKILL.md', raw);
    write(user, 'brainstorming/SKILL.md', raw);

    const manager = new SkillManager([bundled, user], {
      userDir: user,
      tierByDir: { [bundled]: 'bundled', [user]: 'user' },
    });
    const result = manager.load();

    expect(result).toMatchObject({ loaded: 1, errors: [] });
    expect(manager.get('brainstorming')).toMatchObject({ name: 'brainstorming', _tier: 'user' });
  });
});

describe('managed native Skills', () => {
  it('creates and removes only a native single-file Skill in the selected root', () => {
    const root = tempRoot();

    const created = createManagedSkill(root, {
      name: 'release-check',
      description: 'Checks a release candidate',
      trigger: 'release candidate',
      content: 'Verify tests and deployment inputs.',
    });

    expect(created.name).toBe('release-check');
    expect(parseSkill(readFileSync(created.path, 'utf8'), 'release-check.md')).toMatchObject({
      name: 'release-check',
      description: 'Checks a release candidate',
    });
    expect(removeManagedSkill(root, 'release-check')).toEqual({ name: 'release-check', removed: true });
    expect(removeManagedSkill(root, 'release-check')).toEqual({ name: 'release-check', removed: false });
    expect(removeManagedSkill(join(root, 'missing-scope'), 'release-check')).toEqual({ name: 'release-check', removed: false });
  });

  it('rejects traversal, invalid names, duplicate writes, directories, and symlink targets', () => {
    const root = tempRoot();
    expect(() => createManagedSkill(root, {
      name: '../escape', description: 'escape', content: 'never write outside the root',
    })).toThrow('skill name');
    expect(() => createManagedSkill(root, {
      name: 'unsafe-frontmatter', description: 'line one\ntrigger: forged', content: 'never serialize forged fields',
    })).toThrow('single-line');

    createManagedSkill(root, { name: 'safe', description: 'safe', content: 'safe content' });
    expect(() => createManagedSkill(root, { name: 'safe', description: 'safe', content: 'again' }))
      .toThrow('already exists');

    mkdirSync(join(root, 'directory-skill.md'));
    expect(() => removeManagedSkill(root, 'directory-skill')).toThrow('only native single-file skills');

    const external = join(tempRoot(), 'outside.md');
    writeFileSync(external, skill('outside'));
    const linked = join(root, 'linked.md');
    try {
      symlinkSync(external, linked, 'file');
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(() => removeManagedSkill(root, 'linked')).toThrow('symbolic link');
    } catch (error) {
      // Some Windows policies refuse symlink creation for unprivileged users;
      // the traversal/duplicate/directory assertions above remain portable.
      if (!String(error?.code || '').includes('EPERM')) throw error;
    }
  });

  it('rejects create and remove when a project .yeaft ancestor is a symlink or junction', () => {
    const workDir = tempRoot();
    const externalYeaftDir = join(tempRoot(), 'external-yeaft');
    const projectYeaftDir = join(workDir, '.yeaft');
    mkdirSync(externalYeaftDir, { recursive: true });

    try {
      symlinkSync(externalYeaftDir, projectYeaftDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      // Windows can deny junction/symlink creation under restricted policies.
      // Do not mask a real filesystem error on platforms where links work.
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return;
      throw error;
    }

    const externalSkill = join(externalYeaftDir, 'skills', 'parent-link.md');
    expect(() => createManagedProjectSkill(workDir, {
      name: 'parent-link', description: 'Must remain inside the project', content: 'Do not follow links.',
    })).toThrow('symbolic link');
    expect(existsSync(externalSkill)).toBe(false);

    mkdirSync(dirname(externalSkill), { recursive: true });
    writeFileSync(externalSkill, skill('parent-link'));
    expect(() => removeManagedProjectSkill(workDir, 'parent-link')).toThrow('symbolic link');
    expect(existsSync(externalSkill)).toBe(true);
  });

  it('marks only Yeaft native user and project files as manageable', () => {
    const bundled = tempRoot();
    const user = tempRoot();
    const project = tempRoot();
    const borrowed = tempRoot();
    write(bundled, 'bundled.md', skill('bundled'));
    write(user, 'user.md', skill('user'));
    write(project, 'project.md', skill('project'));
    write(borrowed, 'borrowed/SKILL.md', skill('borrowed'));

    const manager = new SkillManager([bundled, user, borrowed, project], {
      userDir: user,
      tierByDir: { [bundled]: 'bundled', [user]: 'user', [borrowed]: 'project-claude', [project]: 'project' },
    });
    manager.load();
    const byName = Object.fromEntries(manager.list().map(item => [item.name, item]));

    expect(byName.bundled.managed).toBe(false);
    expect(byName.user.managed).toBe(true);
    expect(byName.project.managed).toBe(true);
    expect(byName.borrowed.managed).toBe(false);

    const sourceNames = manager.listSources().map(item => item.name).sort();
    expect(sourceNames).toEqual(['borrowed', 'bundled', 'project', 'user']);

    write(project, 'user.md', skill('user', '# Project override'));
    manager.load();
    expect(manager.get('user')).toMatchObject({ _tier: 'project', content: '# Project override' });
    expect(manager.listSources().filter(item => item.name === 'user')).toHaveLength(2);
    const catalog = buildPluginCatalog({ skillManager: manager });
    expect(catalog.skills.filter(item => item.label === 'user')).toHaveLength(1);
    expect(catalog.skillSources.filter(item => item.name === 'user')).toHaveLength(2);
  });
});

describe('bundled Agent skills distribution', () => {
  it('resolves the canonical workflow skill from the published Agent package root', () => {
    const agentRoot = join(process.cwd(), 'agent');
    const manifest = JSON.parse(readFileSync(join(agentRoot, 'package.json'), 'utf8'));
    const skillPath = join(agentRoot, 'skills', 'review-merge-tag', 'SKILL.md');
    const previousHome = process.env.HOME;
    const previousOverride = process.env.YEAFT_SKILLS_BUNDLED_DIR;
    process.env.HOME = tempRoot();
    delete process.env.YEAFT_SKILLS_BUNDLED_DIR;
    try {
      expect(manifest.files).toContain('skills/**/*.md');
      expect(parseSkill(readFileSync(skillPath, 'utf8'), skillPath)).toMatchObject({
        name: 'review-merge-tag',
      });
      expect(bundledYeaftSkillsDirs()).toEqual([join(agentRoot, 'skills')]);
      expect(bundledYeaftSkillsDir()).toBe(join(agentRoot, 'skills'));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOverride === undefined) delete process.env.YEAFT_SKILLS_BUNDLED_DIR;
      else process.env.YEAFT_SKILLS_BUNDLED_DIR = previousOverride;
    }
  });

  it('loads coexisting bundled roots with deterministic bundled, user, and project precedence', () => {
    const agentRoot = join(process.cwd(), 'agent');
    const home = tempRoot();
    const yeaftDir = tempRoot();
    const workDir = tempRoot();
    const external = join(home, '.claude', 'skills', 'yeaft-skills', 'skills');
    write(external, 'external-only/SKILL.md', skill('external-only', '# External'));
    write(external, 'review-merge-tag/SKILL.md', skill('review-merge-tag', '# Shadowed external'));
    write(external, 'user-overridden/SKILL.md', skill('user-overridden', '# Bundled user target'));
    write(external, 'project-overridden/SKILL.md', skill('project-overridden', '# Bundled project target'));
    write(yeaftDir, 'skills/user-overridden/SKILL.md', skill('user-overridden', '# User override'));
    write(workDir, '.yeaft/skills/project-overridden/SKILL.md', skill('project-overridden', '# Project override'));
    const previousHome = process.env.HOME;
    const previousOverride = process.env.YEAFT_SKILLS_BUNDLED_DIR;
    process.env.HOME = home;
    delete process.env.YEAFT_SKILLS_BUNDLED_DIR;
    try {
      const manager = createSkillManager(yeaftDir, workDir);

      expect(manager.skillsDirs.slice(0, 2)).toEqual([external, join(agentRoot, 'skills')]);
      expect(manager.get('external-only')).toMatchObject({ _tier: 'bundled', content: '# External' });
      expect(manager.get('review-merge-tag')).toMatchObject({
        _tier: 'bundled',
        _path: join(agentRoot, 'skills', 'review-merge-tag'),
      });
      expect(manager.get('review-merge-tag').content).not.toBe('# Shadowed external');
      expect(manager.get('user-overridden')).toMatchObject({ _tier: 'user', content: '# User override' });
      expect(manager.get('project-overridden')).toMatchObject({ _tier: 'project', content: '# Project override' });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOverride === undefined) delete process.env.YEAFT_SKILLS_BUNDLED_DIR;
      else process.env.YEAFT_SKILLS_BUNDLED_DIR = previousOverride;
    }
  });

  it('keeps external-only bundled skills runtime-visible after init seeds packaged built-ins', () => {
    const home = tempRoot();
    const yeaftDir = tempRoot();
    const external = join(home, '.claude', 'skills', 'yeaft-skills', 'skills');
    const userSkillsDir = join(yeaftDir, 'skills');
    write(external, 'external-only/SKILL.md', skill('external-only', '# External after seed'));
    const previousHome = process.env.HOME;
    const previousOverride = process.env.YEAFT_SKILLS_BUNDLED_DIR;
    process.env.HOME = home;
    delete process.env.YEAFT_SKILLS_BUNDLED_DIR;
    try {
      expect(seedBundledSkills(userSkillsDir).copied).toBeGreaterThan(0);
      expect(existsSync(join(userSkillsDir, 'external-only', 'SKILL.md'))).toBe(false);

      const manager = createSkillManager(yeaftDir);
      expect(manager.get('external-only')).toMatchObject({
        _tier: 'bundled',
        _path: join(external, 'external-only'),
        content: '# External after seed',
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOverride === undefined) delete process.env.YEAFT_SKILLS_BUNDLED_DIR;
      else process.env.YEAFT_SKILLS_BUNDLED_DIR = previousOverride;
    }
  });

  it('keeps Agent built-ins authoritative over an explicit bundled override', () => {
    const agentRoot = join(process.cwd(), 'agent');
    const home = tempRoot();
    const yeaftDir = tempRoot();
    const override = tempRoot();
    write(override, 'review-merge-tag/SKILL.md', skill('review-merge-tag', '# Shadowed override'));
    write(override, 'override-only/SKILL.md', skill('override-only', '# Override only'));
    const previousHome = process.env.HOME;
    const previousOverride = process.env.YEAFT_SKILLS_BUNDLED_DIR;
    process.env.HOME = home;
    process.env.YEAFT_SKILLS_BUNDLED_DIR = override;
    try {
      const manager = createSkillManager(yeaftDir);

      expect(manager.skillsDirs.slice(0, 2)).toEqual([override, join(agentRoot, 'skills')]);
      expect(bundledYeaftSkillsDir()).toBe(override);
      expect(manager.has('override-only')).toBe(true);
      expect(manager.get('review-merge-tag')._path).toBe(join(agentRoot, 'skills', 'review-merge-tag'));
      expect(manager.get('review-merge-tag').content).not.toBe('# Shadowed override');

      const seedDir = join(tempRoot(), 'skills');
      seedBundledSkills(seedDir);
      expect(readFileSync(join(seedDir, 'review-merge-tag', 'SKILL.md'), 'utf8'))
        .toBe(readFileSync(join(agentRoot, 'skills', 'review-merge-tag', 'SKILL.md'), 'utf8'));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOverride === undefined) delete process.env.YEAFT_SKILLS_BUNDLED_DIR;
      else process.env.YEAFT_SKILLS_BUNDLED_DIR = previousOverride;
    }
  });
});
