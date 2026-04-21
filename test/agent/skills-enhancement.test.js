/**
 * Task-276: Skills Enhancement + Memory Verification tests.
 *
 * Tests:
 *   1. skills.js — directory-based loading, progressive disclosure, platform filtering,
 *      regex triggers, keyword lists, categories
 *   2. tools/skill.js — view action, filePath, category filter
 *   3. Memory pipeline wiring — extract, consolidate, dream in stop-hooks
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { parseSkill, serializeSkill, SkillManager, matchesPlatform } from '../../agent/unify/skills.js';

// ─── Helpers ─────────────────────────────────────────────

function makeTmpDir() {
  const dir = join(tmpdir(), `yeaft-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkillFile(skillsDir, name, frontmatter, content) {
  const fm = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
    return `${k}: ${v}`;
  }).join('\n');
  const raw = `---\n${fm}\n---\n\n${content}`;
  writeFileSync(join(skillsDir, name), raw, 'utf8');
}

function writeSkillDir(skillsDir, dirPath, frontmatter, content, refs = {}, templates = {}) {
  const fullDir = join(skillsDir, dirPath);
  mkdirSync(fullDir, { recursive: true });

  const fm = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
    return `${k}: ${v}`;
  }).join('\n');
  writeFileSync(join(fullDir, 'SKILL.md'), `---\n${fm}\n---\n\n${content}`, 'utf8');

  if (Object.keys(refs).length > 0) {
    const refsDir = join(fullDir, 'references');
    mkdirSync(refsDir, { recursive: true });
    for (const [name, body] of Object.entries(refs)) {
      writeFileSync(join(refsDir, name), body, 'utf8');
    }
  }

  if (Object.keys(templates).length > 0) {
    const tplDir = join(fullDir, 'templates');
    mkdirSync(tplDir, { recursive: true });
    for (const [name, body] of Object.entries(templates)) {
      writeFileSync(join(tplDir, name), body, 'utf8');
    }
  }
}

// ─── parseSkill Tests ────────────────────────────────────

describe('parseSkill — enhanced frontmatter', () => {
  it('parses platforms field', () => {
    const raw = '---\nname: test\nplatforms: [macos, linux]\n---\n\nBody';
    const skill = parseSkill(raw, 'test.md');
    expect(skill.platforms).toEqual(['macos', 'linux']);
  });

  it('parses keywords field', () => {
    const raw = '---\nname: test\nkeywords: [review, lint, format]\n---\n\nBody';
    const skill = parseSkill(raw, 'test.md');
    expect(skill.keywords).toEqual(['review', 'lint', 'format']);
  });

  it('parses category field', () => {
    const raw = '---\nname: test\ncategory: coding/review\n---\n\nBody';
    const skill = parseSkill(raw, 'test.md');
    expect(skill.category).toBe('coding/review');
  });
});

// ─── serializeSkill Tests ────────────────────────────────

describe('serializeSkill — new fields', () => {
  it('serializes platforms', () => {
    const md = serializeSkill({ name: 'x', platforms: ['macos', 'linux'] });
    expect(md).toContain('platforms: [macos, linux]');
  });

  it('serializes keywords', () => {
    const md = serializeSkill({ name: 'x', keywords: ['review'] });
    expect(md).toContain('keywords: [review]');
  });

  it('serializes category', () => {
    const md = serializeSkill({ name: 'x', category: 'coding' });
    expect(md).toContain('category: coding');
  });
});

// ─── matchesPlatform Tests ───────────────────────────────

describe('matchesPlatform', () => {
  it('returns true when platforms is empty', () => {
    expect(matchesPlatform([])).toBe(true);
    expect(matchesPlatform(undefined)).toBe(true);
  });

  it('matches current platform', () => {
    const { platform } = require('os');
    const current = platform();
    // Find a label that maps to current
    const map = { darwin: 'macos', linux: 'linux', win32: 'windows' };
    const label = map[current];
    if (label) {
      expect(matchesPlatform([label])).toBe(true);
    }
  });

  it('rejects non-matching platform', () => {
    // Use a platform that definitely doesn't match
    const fake = process.platform === 'linux' ? 'windows' : 'linux';
    expect(matchesPlatform([fake])).toBe(false);
  });
});

// ─── SkillManager — directory-based loading ──────────────

describe('SkillManager — directory-based skills', () => {
  let yeaftDir, skillsDir, manager;

  beforeAll(() => {
    yeaftDir = makeTmpDir();
    skillsDir = join(yeaftDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    // Legacy single-file skill
    writeSkillFile(skillsDir, 'legacy-skill.md', {
      name: 'legacy-skill',
      description: 'A legacy skill',
      trigger: 'legacy test',
      mode: 'both',
    }, 'Legacy instructions');

    // Directory-based skill with references and templates
    writeSkillDir(skillsDir, 'dir-skill', {
      name: 'dir-skill',
      description: 'A directory skill',
      trigger: 'directory test',
      mode: 'chat',
    }, 'Dir skill instructions', {
      'guide.md': '# Style Guide\nContent here',
    }, {
      'component.js': 'export default {}',
    });

    // Nested category skill
    mkdirSync(join(skillsDir, 'coding'), { recursive: true });
    writeSkillDir(skillsDir, 'coding/review', {
      name: 'code-review',
      description: 'Code review skill',
      trigger: 'review code pull request',
      mode: 'work',
    }, 'Review instructions');

    // Skill with regex trigger
    writeSkillFile(skillsDir, 'regex-skill.md', {
      name: 'regex-skill',
      description: 'Regex triggered',
      trigger: '/^(fix|debug|troubleshoot)/i',
      mode: 'both',
    }, 'Regex instructions');

    // Skill with keywords
    writeSkillFile(skillsDir, 'keyword-skill.md', {
      name: 'keyword-skill',
      description: 'Keyword triggered',
      trigger: 'some unused trigger',
      mode: 'both',
      keywords: ['deploy', 'release', 'ship'],
    }, 'Keyword instructions');

    manager = new SkillManager(yeaftDir);
    manager.load();
  });

  it('loads both file and directory skills', () => {
    expect(manager.size).toBeGreaterThanOrEqual(5);
    expect(manager.has('legacy-skill')).toBe(true);
    expect(manager.has('dir-skill')).toBe(true);
  });

  it('loads nested category skills', () => {
    expect(manager.has('code-review')).toBe(true);
    const skill = manager.get('code-review');
    expect(skill.category).toBe('coding');
  });

  it('list() returns metadata only (progressive disclosure)', () => {
    const items = manager.list();
    const dir = items.find(s => s.name === 'dir-skill');
    expect(dir).toBeDefined();
    expect(dir.source).toBe('directory');
    expect(dir.hasReferences).toBe(true);
    expect(dir.hasTemplates).toBe(true);
    // list items should NOT have content field
    expect(dir.content).toBeUndefined();
  });

  it('view() returns full content + linked files', () => {
    const result = manager.view('dir-skill');
    expect(result).not.toBeNull();
    expect(result.skill.content).toBe('Dir skill instructions');
    expect(result.references).toContain('guide.md');
    expect(result.templates).toContain('component.js');
  });

  it('view() with filePath reads a linked file', () => {
    const result = manager.view('dir-skill', 'references/guide.md');
    expect(result.linkedContent).toContain('# Style Guide');
  });

  it('view() prevents path traversal', () => {
    const result = manager.view('dir-skill', '../../../etc/passwd');
    expect(result.linkedContent).toMatch(/not allowed|not found/i);
  });

  it('listCategories() returns categories', () => {
    const cats = manager.listCategories();
    expect(cats).toContain('coding');
  });

  it('findRelevant() matches regex triggers', () => {
    const results = manager.findRelevant('fix the login bug');
    const names = results.map(s => s.name);
    expect(names).toContain('regex-skill');
  });

  it('findRelevant() matches keyword lists', () => {
    const results = manager.findRelevant('please deploy to production');
    const names = results.map(s => s.name);
    expect(names).toContain('keyword-skill');
  });

  it('findRelevant() returns all matching skills (mode filter removed by task-311)', () => {
    const results = manager.findRelevant('review code');
    const names = results.map(s => s.name);
    expect(names).toContain('code-review');
  });
});

// ─── Memory Pipeline Wiring (Static Analysis) ───────────

describe('Memory pipeline — wiring verification', () => {
  const { readFileSync } = require('fs');
  const { join: pjoin } = require('path');
  const root = pjoin(__dirname, '../..');

  const engineSrc = readFileSync(pjoin(root, 'agent/unify/engine.js'), 'utf8');
  const stopHooksSrc = readFileSync(pjoin(root, 'agent/unify/stop-hooks.js'), 'utf8');
  const consolidateSrc = readFileSync(pjoin(root, 'agent/unify/memory/consolidate.js'), 'utf8');
  const extractSrc = readFileSync(pjoin(root, 'agent/unify/memory/extract.js'), 'utf8');
  const dreamSrc = readFileSync(pjoin(root, 'agent/unify/memory/dream.js'), 'utf8');
  const sessionSrc = readFileSync(pjoin(root, 'agent/unify/session.js'), 'utf8');
  const toolsIndexSrc = readFileSync(pjoin(root, 'agent/unify/tools/index.js'), 'utf8');

  it('engine imports recall and consolidate', () => {
    expect(engineSrc).toContain("from './memory/recall-r6.js'");
    expect(engineSrc).toContain("from './memory/consolidate.js'");
  });

  it('engine calls runStopHooks after query', () => {
    expect(engineSrc).toContain('runStopHooks');
  });

  it('stop-hooks calls shouldConsolidate + consolidate', () => {
    expect(stopHooksSrc).toContain('shouldConsolidate');
    expect(stopHooksSrc).toContain('consolidate(');
  });

  it('stop-hooks calls checkDreamGate + dream', () => {
    expect(stopHooksSrc).toContain('checkDreamGate');
    expect(stopHooksSrc).toContain('dream(');
  });

  it('stop-hooks increments dream query counter', () => {
    expect(stopHooksSrc).toContain('incrementQueryCount');
  });

  it('consolidate imports extractMemories', () => {
    expect(consolidateSrc).toContain("from './extract.js'");
  });

  it('extract builds extraction prompt with MEMORY_KINDS', () => {
    expect(extractSrc).toContain('MEMORY_KINDS');
    expect(extractSrc).toContain('buildExtractionPrompt');
  });

  it('dream has 5-phase pipeline (orient, gather, merge, prune, promote)', () => {
    expect(dreamSrc).toContain('buildOrientPrompt');
    expect(dreamSrc).toContain('buildGatherPrompt');
    expect(dreamSrc).toContain('buildMergePrompt');
    expect(dreamSrc).toContain('buildPrunePrompt');
    expect(dreamSrc).toContain('buildPromotePrompt');
  });

  it('session wires memoryStore and skillManager into engine', () => {
    expect(sessionSrc).toContain('memoryStore');
    expect(sessionSrc).toContain('skillManager');
  });

  it('tools/index.js registers memory tools', () => {
    expect(toolsIndexSrc).toContain('memoryRead');
    expect(toolsIndexSrc).toContain('memoryWrite');
    expect(toolsIndexSrc).toContain('memorySearch');
  });

  it('tools/index.js registers skill tool', () => {
    expect(toolsIndexSrc).toContain('skillTool');
  });
});

// ─── Skill Tool — source analysis ───────────────────────

describe('Skill tool — enhanced actions', () => {
  const { readFileSync } = require('fs');
  const { join: pjoin } = require('path');
  const root = pjoin(__dirname, '../..');
  const toolSrc = readFileSync(pjoin(root, 'agent/unify/tools/skill.js'), 'utf8');

  it('supports view action', () => {
    expect(toolSrc).toContain("case 'view':");
  });

  it('supports load as alias for view', () => {
    expect(toolSrc).toContain("case 'load':");
  });

  it('supports filePath parameter', () => {
    expect(toolSrc).toContain('filePath');
  });

  it('supports category parameter for list filtering', () => {
    expect(toolSrc).toContain('input.category');
  });

  it('calls skillManager.view()', () => {
    expect(toolSrc).toContain('skillManager.view(');
  });

  it('calls skillManager.listCategories()', () => {
    expect(toolSrc).toContain('skillManager.listCategories()');
  });

  it('returns references and templates in view output', () => {
    expect(toolSrc).toContain('result.references');
    expect(toolSrc).toContain('result.templates');
  });
});
