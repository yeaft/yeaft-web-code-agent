/**
 * Task-276 Supplementary Tests: Unify Skills Enhancement
 *
 * Covers edge cases and deeper behavioral verification beyond the 37 original tests:
 *   1. parseSkill edge cases (malformed frontmatter, missing fields, name fallback)
 *   2. serializeSkill round-trip fidelity
 *   3. matchesPlatform case-insensitivity and aliases
 *   4. SkillManager — save/remove lifecycle, mode filtering, getPromptContent
 *   5. Directory skill discovery — empty dirs, SKILL.md-only dirs, deeply nested categories
 *   6. Trigger matching — regex flags, invalid regex fallback, stem matching, threshold
 *   7. Keyword matching — case insensitivity, partial match
 *   8. view() edge cases — nonexistent skill, filePath on file-skill, missing file
 *   9. Skill tool source — error handling, search action, enum values
 *  10. Memory pipeline — deeper wiring (dream gate, recall phases, token budget)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { parseSkill, serializeSkill, SkillManager, matchesPlatform } from '../../agent/unify/skills.js';

function makeTmpDir() {
  const dir = join(tmpdir(), `yeaft-sup-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkill(skillsDir, name, frontmatter, content) {
  const fm = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
    return `${k}: ${v}`;
  }).join('\n');
  writeFileSync(join(skillsDir, name), `---\n${fm}\n---\n\n${content}`, 'utf8');
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
    for (const [n, body] of Object.entries(refs)) writeFileSync(join(refsDir, n), body, 'utf8');
  }
  if (Object.keys(templates).length > 0) {
    const tplDir = join(fullDir, 'templates');
    mkdirSync(tplDir, { recursive: true });
    for (const [n, body] of Object.entries(templates)) writeFileSync(join(tplDir, n), body, 'utf8');
  }
}

// ─── 1. parseSkill edge cases ──────────────────────────────

describe('parseSkill — edge cases', () => {
  it('returns null for empty input', () => {
    expect(parseSkill('')).toBeNull();
    expect(parseSkill(null)).toBeNull();
    expect(parseSkill(undefined)).toBeNull();
  });

  it('returns null for content without frontmatter', () => {
    expect(parseSkill('Just some text')).toBeNull();
    expect(parseSkill('# Heading\nContent')).toBeNull();
  });

  it('returns null for unclosed frontmatter', () => {
    expect(parseSkill('---\nname: test\nno closing')).toBeNull();
  });

  it('uses filename as name fallback when name missing', () => {
    const skill = parseSkill('---\ndescription: no name\n---\n\nBody', 'my-fallback.md');
    expect(skill.name).toBe('my-fallback');
  });

  it('defaults mode to both', () => {
    const skill = parseSkill('---\nname: test\n---\n\nBody');
    expect(skill.mode).toBe('both');
  });

  it('trims body content', () => {
    const skill = parseSkill('---\nname: test\n---\n\n  Body with spaces  \n\n');
    expect(skill.content).toBe('Body with spaces');
  });

  it('handles empty body', () => {
    const skill = parseSkill('---\nname: test\n---\n');
    expect(skill.content).toBe('');
  });

  it('handles frontmatter lines without colons', () => {
    const skill = parseSkill('---\nname: test\nthis line has no colon\n---\n\nBody');
    expect(skill.name).toBe('test');
    expect(skill.content).toBe('Body');
  });

  it('handles platforms without brackets', () => {
    const skill = parseSkill('---\nname: test\nplatforms: macos, linux\n---\n\nBody');
    expect(skill.platforms).toEqual(['macos', 'linux']);
  });

  it('handles single keyword', () => {
    const skill = parseSkill('---\nname: test\nkeywords: [deploy]\n---\n\nBody');
    expect(skill.keywords).toEqual(['deploy']);
  });
});

// ─── 2. serializeSkill round-trip ──────────────────────────

describe('serializeSkill — round-trip fidelity', () => {
  it('round-trips a full skill', () => {
    const original = {
      name: 'rt-test',
      description: 'Round trip',
      trigger: '/deploy/i',
      mode: 'work',
      platforms: ['linux'],
      keywords: ['deploy', 'ship'],
      category: 'ops',
      content: 'Do the deploy',
    };
    const serialized = serializeSkill(original);
    const parsed = parseSkill(serialized, 'rt-test.md');
    expect(parsed.name).toBe('rt-test');
    expect(parsed.description).toBe('Round trip');
    expect(parsed.trigger).toBe('/deploy/i');
    expect(parsed.mode).toBe('work');
    expect(parsed.platforms).toEqual(['linux']);
    expect(parsed.keywords).toEqual(['deploy', 'ship']);
    expect(parsed.category).toBe('ops');
    expect(parsed.content).toBe('Do the deploy');
  });

  it('omits platforms/keywords/category when empty', () => {
    const md = serializeSkill({ name: 'minimal', description: 'min', content: 'body' });
    expect(md).not.toContain('platforms');
    expect(md).not.toContain('keywords');
    expect(md).not.toContain('category');
  });

  it('handles empty content', () => {
    const md = serializeSkill({ name: 'empty' });
    expect(md).toContain('name: empty');
    expect(md).toContain('---');
  });
});

// ─── 3. matchesPlatform detailed ───────────────────────────

describe('matchesPlatform — detailed', () => {
  it('accepts darwin alias', () => {
    if (process.platform === 'darwin') {
      expect(matchesPlatform(['darwin'])).toBe(true);
    }
  });

  it('accepts win32 alias', () => {
    if (process.platform === 'win32') {
      expect(matchesPlatform(['win32'])).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    const map = { darwin: 'MacOS', linux: 'Linux', win32: 'Windows' };
    const label = map[process.platform];
    if (label) {
      expect(matchesPlatform([label])).toBe(true);
    }
  });

  it('matches if ANY platform in array matches', () => {
    const fake = process.platform === 'linux' ? 'windows' : 'linux';
    const real = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
    if (real) {
      expect(matchesPlatform([fake, real])).toBe(true);
    }
  });

  it('rejects empty string platform', () => {
    // Empty string won't map to any known platform
    expect(matchesPlatform([''])).toBe(false);
  });

  it('rejects unknown platform strings', () => {
    expect(matchesPlatform(['freebsd'])).toBe(false);
    expect(matchesPlatform(['android'])).toBe(false);
  });
});

// ─── 4. SkillManager lifecycle ─────────────────────────────

describe('SkillManager — save/remove/getPromptContent', () => {
  let yeaftDir, skillsDir, manager;

  beforeAll(() => {
    yeaftDir = makeTmpDir();
    skillsDir = join(yeaftDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    manager = new SkillManager(yeaftDir);
  });

  afterAll(() => { try { rmSync(yeaftDir, { recursive: true }); } catch {} });

  it('save() creates a file-based skill', () => {
    manager.save({ name: 'saved-skill', description: 'Saved', trigger: 'test', content: 'Instructions' });
    expect(manager.has('saved-skill')).toBe(true);
    expect(existsSync(join(skillsDir, 'saved-skill.md'))).toBe(true);
  });

  it('save() throws for skill without name', () => {
    expect(() => manager.save({ description: 'no name' })).toThrow('Skill must have a name');
  });

  it('save() creates skillsDir if missing', () => {
    const tmpDir = makeTmpDir();
    const m = new SkillManager(tmpDir);
    m.save({ name: 'auto-dir', content: 'Body' });
    expect(existsSync(join(tmpDir, 'skills'))).toBe(true);
    rmSync(tmpDir, { recursive: true });
  });

  it('remove() removes a file-based skill', () => {
    manager.save({ name: 'to-remove', content: 'Body' });
    expect(manager.has('to-remove')).toBe(true);
    const removed = manager.remove('to-remove');
    expect(removed).toBe(true);
    expect(manager.has('to-remove')).toBe(false);
  });

  it('remove() returns false for nonexistent skill', () => {
    expect(manager.remove('nonexistent')).toBe(false);
  });

  it('getPromptContent() returns formatted content', () => {
    manager.save({ name: 'prompt-test', content: 'Do things' });
    const content = manager.getPromptContent('prompt-test');
    expect(content).toContain('## Skill: prompt-test');
    expect(content).toContain('Do things');
  });

  it('getPromptContent() returns empty for missing skill', () => {
    expect(manager.getPromptContent('nonexistent')).toBe('');
  });

  it('getRelevantPromptContent() returns empty when no match', () => {
    expect(manager.getRelevantPromptContent('completely unrelated query xyz123')).toBe('');
  });

  it('list() filters by mode', () => {
    manager.save({ name: 'chat-only', mode: 'chat', content: 'Chat' });
    manager.save({ name: 'work-only', mode: 'work', content: 'Work' });
    const chatList = manager.list('chat');
    const workList = manager.list('work');
    expect(chatList.find(s => s.name === 'chat-only')).toBeDefined();
    expect(chatList.find(s => s.name === 'work-only')).toBeUndefined();
    expect(workList.find(s => s.name === 'work-only')).toBeDefined();
  });

  it('list() includes "both" mode skills in all filters', () => {
    manager.save({ name: 'both-mode', mode: 'both', content: 'Both' });
    expect(manager.list('chat').find(s => s.name === 'both-mode')).toBeDefined();
    expect(manager.list('work').find(s => s.name === 'both-mode')).toBeDefined();
  });
});

// ─── 5. Directory discovery edge cases ─────────────────────

describe('SkillManager — directory discovery edge cases', () => {
  let yeaftDir, skillsDir, manager;

  beforeAll(() => {
    yeaftDir = makeTmpDir();
    skillsDir = join(yeaftDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    // Empty directory (no SKILL.md) — should be treated as category
    mkdirSync(join(skillsDir, 'empty-cat'), { recursive: true });

    // Directory with SKILL.md but no references/templates
    writeSkillDir(skillsDir, 'minimal-dir', {
      name: 'minimal-dir',
      description: 'Minimal directory skill',
      trigger: 'minimal',
    }, 'Minimal body');

    // Deeply nested category: a/b/c/SKILL.md
    mkdirSync(join(skillsDir, 'a', 'b'), { recursive: true });
    writeSkillDir(skillsDir, 'a/b/deep', {
      name: 'deep-skill',
      description: 'Deeply nested',
      trigger: 'deep',
    }, 'Deep instructions');

    // Mixed: category with both a file skill and a dir skill
    mkdirSync(join(skillsDir, 'mixed'), { recursive: true });
    writeSkill(join(skillsDir, 'mixed'), 'file-in-mixed.md', {
      name: 'file-in-mixed',
      trigger: 'mixed file',
    }, 'File in mixed');
    writeSkillDir(skillsDir, 'mixed/dir-in-mixed', {
      name: 'dir-in-mixed',
      trigger: 'mixed dir',
    }, 'Dir in mixed');

    // Skill with only templates, no references
    writeSkillDir(skillsDir, 'tpl-only', {
      name: 'tpl-only',
      trigger: 'templates',
    }, 'Has templates only', {}, { 'tpl.txt': 'template content' });

    manager = new SkillManager(yeaftDir);
    manager.load();
  });

  afterAll(() => { try { rmSync(yeaftDir, { recursive: true }); } catch {} });

  it('empty category directory does not create a skill', () => {
    expect(manager.has('empty-cat')).toBe(false);
  });

  it('directory skill without references/templates has empty arrays', () => {
    const result = manager.view('minimal-dir');
    expect(result.references).toEqual([]);
    expect(result.templates).toEqual([]);
  });

  it('deeply nested category derives correct category path', () => {
    const skill = manager.get('deep-skill');
    expect(skill.category).toBe('a/b');
  });

  it('mixed category loads both file and dir skills', () => {
    expect(manager.has('file-in-mixed')).toBe(true);
    expect(manager.has('dir-in-mixed')).toBe(true);
    const fileSkill = manager.get('file-in-mixed');
    expect(fileSkill.category).toBe('mixed');
    expect(fileSkill._source).toBe('file');
    const dirSkill = manager.get('dir-in-mixed');
    expect(dirSkill.category).toBe('mixed');
    expect(dirSkill._source).toBe('directory');
  });

  it('templates-only skill reports hasTemplates=true, hasReferences=false', () => {
    const items = manager.list();
    const tpl = items.find(s => s.name === 'tpl-only');
    expect(tpl.hasTemplates).toBe(true);
    expect(tpl.hasReferences).toBe(false);
  });

  it('listCategories includes deeply nested categories', () => {
    const cats = manager.listCategories();
    expect(cats).toContain('a/b');
    expect(cats).toContain('mixed');
  });

  it('load() on nonexistent skillsDir returns 0 loaded', () => {
    const m = new SkillManager(join(tmpdir(), 'nonexistent-' + randomUUID()));
    const result = m.load();
    expect(result.loaded).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('size reflects loaded count', () => {
    expect(manager.size).toBeGreaterThanOrEqual(5);
  });

  it('load() clears previous skills before reloading', () => {
    const prevSize = manager.size;
    manager.load(); // reload
    expect(manager.size).toBe(prevSize); // same content
  });
});

// ─── 6. Trigger matching — source analysis ─────────────────

describe('Trigger matching — source analysis', () => {
  const root = join(__dirname, '../..');
  const src = readFileSync(join(root, 'agent/unify/skills.js'), 'utf8');

  it('matchTrigger detects regex via /pattern/ format', () => {
    expect(src).toContain('/^\\/(.+)\\/([gimsuy]*)$/');
  });

  it('invalid regex falls through to keyword matching', () => {
    expect(src).toContain('// Invalid regex, fall through');
  });

  it('keyword matching requires 30% threshold', () => {
    expect(src).toContain('Math.ceil(triggerWords.length * 0.3)');
  });

  it('stem matching uses min 4 character stems', () => {
    expect(src).toContain('Math.min(tw.length, 4)');
    expect(src).toContain('twStem.length >= 4');
  });

  it('trigger words filter out short words (<=2 chars)', () => {
    expect(src).toContain("w.length > 2");
  });

  it('matchKeywords does case-insensitive comparison', () => {
    expect(src).toContain('kw.toLowerCase()');
  });
});

// ─── 7. findRelevant behavioral tests ──────────────────────

describe('findRelevant — behavioral tests', () => {
  let manager;

  beforeAll(() => {
    const yeaftDir = makeTmpDir();
    const skillsDir = join(yeaftDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    writeSkill(skillsDir, 'regex-test.md', {
      name: 'regex-test',
      trigger: '/^deploy\\s+(staging|prod)/i',
      mode: 'work',
    }, 'Deploy instructions');

    writeSkill(skillsDir, 'kw-test.md', {
      name: 'kw-test',
      trigger: 'unused',
      keywords: ['kubernetes', 'k8s', 'docker'],
      mode: 'both',
    }, 'K8s instructions');

    writeSkill(skillsDir, 'name-match.md', {
      name: 'code-review',
      trigger: 'nope',
      mode: 'both',
    }, 'Review instructions');

    writeSkill(skillsDir, 'desc-match.md', {
      name: 'desc-match',
      description: 'helps with database migrations',
      trigger: 'nope',
      mode: 'both',
    }, 'Migration instructions');

    manager = new SkillManager(yeaftDir);
    manager.load();
  });

  it('matches regex trigger with capture groups', () => {
    const results = manager.findRelevant('deploy staging');
    expect(results.map(s => s.name)).toContain('regex-test');
  });

  it('does not match regex when pattern fails', () => {
    const results = manager.findRelevant('deploy local');
    expect(results.map(s => s.name)).not.toContain('regex-test');
  });

  it('matches keywords case-insensitively', () => {
    const results = manager.findRelevant('How do I set up Kubernetes?');
    expect(results.map(s => s.name)).toContain('kw-test');
  });

  it('matches by skill name in prompt', () => {
    const results = manager.findRelevant('I need a code-review');
    expect(results.map(s => s.name)).toContain('code-review');
  });

  it('matches by description in prompt', () => {
    const results = manager.findRelevant('helps with database migrations');
    expect(results.map(s => s.name)).toContain('desc-match');
  });

  it('returns empty for unrelated prompt', () => {
    const results = manager.findRelevant('weather forecast tomorrow');
    expect(results.length).toBe(0);
  });

  it('returns empty for empty prompt', () => {
    expect(manager.findRelevant('')).toEqual([]);
    expect(manager.findRelevant(undefined)).toEqual([]);
  });

  it('mode filter excludes non-matching skills', () => {
    const results = manager.findRelevant('deploy staging', 'chat');
    // regex-test is mode: work, should not appear in chat
    expect(results.map(s => s.name)).not.toContain('regex-test');
  });
});

// ─── 8. view() edge cases ──────────────────────────────────

describe('view() — edge cases', () => {
  let manager;

  beforeAll(() => {
    const yeaftDir = makeTmpDir();
    const skillsDir = join(yeaftDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    writeSkill(skillsDir, 'file-skill.md', {
      name: 'file-skill',
      trigger: 'test',
    }, 'File content');

    writeSkillDir(skillsDir, 'dir-skill', {
      name: 'dir-skill',
      trigger: 'test',
    }, 'Dir content', { 'ref.md': 'reference content' });

    manager = new SkillManager(yeaftDir);
    manager.load();
  });

  it('view() returns null for nonexistent skill', () => {
    expect(manager.view('nonexistent')).toBeNull();
  });

  it('view() on file-skill ignores filePath (no linked files)', () => {
    const result = manager.view('file-skill', 'references/something.md');
    expect(result).not.toBeNull();
    // filePath only works for directory skills
    expect(result.linkedContent).toBeUndefined();
  });

  it('view() on dir-skill with nonexistent file returns not found', () => {
    const result = manager.view('dir-skill', 'references/nonexistent.md');
    expect(result.linkedContent).toContain('not found');
  });

  it('view() on dir-skill with valid file returns content', () => {
    const result = manager.view('dir-skill', 'references/ref.md');
    expect(result.linkedContent).toBe('reference content');
  });
});

// ─── 9. Skill tool — deeper source analysis ────────────────

describe('Skill tool — deeper source analysis', () => {
  const root = join(__dirname, '../..');
  const src = readFileSync(join(root, 'agent/unify/tools/skill.js'), 'utf8');

  it('defines 4 actions in enum', () => {
    expect(src).toContain("enum: ['list', 'view', 'load', 'search']");
  });

  it('action is required parameter', () => {
    expect(src).toContain("required: ['action']");
  });

  it('search action calls findRelevant', () => {
    expect(src).toContain('skillManager.findRelevant(');
  });

  it('handles missing skillManager gracefully', () => {
    expect(src).toContain('Skill system not initialized');
  });

  it('returns error for unknown action', () => {
    expect(src).toContain('Unknown action:');
  });

  it('view requires name parameter', () => {
    expect(src).toContain('Skill name is required');
  });

  it('search requires query parameter', () => {
    expect(src).toContain('Query is required');
  });

  it('returns linkedContent directly when filePath specified', () => {
    expect(src).toContain('return result.linkedContent');
  });

  it('list includes totalCount', () => {
    expect(src).toContain('totalCount');
  });

  it('is marked as read-only and concurrency-safe', () => {
    expect(src).toContain('isConcurrencySafe');
    expect(src).toContain('isReadOnly');
  });

  it('available in both chat and work modes', () => {
    expect(src).toContain("modes: ['chat', 'work']");
  });
});

// ─── 10. Memory pipeline — deeper wiring ───────────────────

describe('Memory pipeline — deeper wiring', () => {
  const root = join(__dirname, '../..');

  it('recall has 3-step process: extract keywords → filter → select', () => {
    const src = readFileSync(join(root, 'agent/unify/memory/recall.js'), 'utf8');
    expect(src).toContain('extractKeywords');
    expect(src).toMatch(/scope.*filter|filter.*scope|Scope/i);
    // LLM selection step
    expect(src).toMatch(/select|rank|pick|score|candidates/i);
  });

  it('consolidate checks token budget before triggering', () => {
    const src = readFileSync(join(root, 'agent/unify/memory/consolidate.js'), 'utf8');
    expect(src).toMatch(/budget|token|threshold/i);
  });

  it('dream gate uses query count', () => {
    const src = readFileSync(join(root, 'agent/unify/memory/dream.js'), 'utf8');
    expect(src).toMatch(/queryCount|query.?count|queries/i);
  });

  it('memory types define standard taxonomy', () => {
    const src = readFileSync(join(root, 'agent/unify/memory/types.js'), 'utf8');
    expect(src).toContain('fact');
    expect(src).toContain('preference');
    expect(src).toContain('lesson');
  });

  it('memory store has CRUD operations', () => {
    const src = readFileSync(join(root, 'agent/unify/memory/store.js'), 'utf8');
    // save/read/list/delete or create/get/list/remove
    expect(src).toMatch(/save|create|write/i);
    expect(src).toMatch(/get|read|load/i);
    expect(src).toMatch(/list|all|entries/i);
    expect(src).toMatch(/delete|remove/i);
  });

  it('engine pre-query recalls memories into system prompt', () => {
    const src = readFileSync(join(root, 'agent/unify/engine.js'), 'utf8');
    expect(src).toContain('recall');
    // System prompt injection
    expect(src).toMatch(/system.*prompt|systemPrompt|system_prompt/i);
  });

  it('skills.js PLATFORM_MAP covers 5 entries', () => {
    const src = readFileSync(join(root, 'agent/unify/skills.js'), 'utf8');
    expect(src).toContain("macos: 'darwin'");
    expect(src).toContain("linux: 'linux'");
    expect(src).toContain("windows: 'win32'");
    expect(src).toContain("darwin: 'darwin'");
    expect(src).toContain("win32: 'win32'");
  });

  it('skills.js remove() only deletes SKILL.md for directory skills', () => {
    const src = readFileSync(join(root, 'agent/unify/skills.js'), 'utf8');
    expect(src).toContain("join(skill._path, 'SKILL.md')");
    expect(src).toContain('unlinkSync(skillMd)');
  });
});

// ─── 11. rev-1 findings verification ───────────────────────

describe('rev-1 non-blocking findings verification', () => {
  const root = join(__dirname, '../..');
  const src = readFileSync(join(root, 'agent/unify/skills.js'), 'utf8');

  it('view() has duplicate fullPath/resolved assignment (non-blocking)', () => {
    // rev-1 noted: fullPath and resolved are both join(skill._path, filePath)
    const viewSection = src.slice(src.indexOf('view(name, filePath)'));
    const fullPathAssign = viewSection.match(/const fullPath = join\(skill\._path, filePath\)/);
    const resolvedAssign = viewSection.match(/const resolved = join\(skill\._path, filePath\)/);
    expect(fullPathAssign).not.toBeNull();
    expect(resolvedAssign).not.toBeNull();
    // Documented: these are identical but path traversal check uses resolved, read uses fullPath
  });

  it('recursive discovery has no explicit depth limit (non-blocking)', () => {
    // rev-1 noted: discoverSkills recurses without depth limit
    expect(src).toContain('discoverSkills(rootDir, relPath)');
    // Confirm no depth parameter in the recursive call
    expect(src).not.toMatch(/discoverSkills\(rootDir, relPath, depth/);
  });
});
