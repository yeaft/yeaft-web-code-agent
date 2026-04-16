/**
 * skills.js — Skill loading and management
 *
 * Skills can be:
 *   1. Single .md files:  skills/my-skill.md  (legacy, still supported)
 *   2. Directories:       skills/my-skill/SKILL.md  + references/ + templates/
 *
 * Directory-based skills support progressive disclosure:
 *   - list()  → metadata only (name, description, trigger, mode, category, platforms)
 *   - view()  → full SKILL.md content + linked files from references/ and templates/
 *
 * Categories are derived from nested directories:
 *   skills/coding/review/SKILL.md  → category = "coding/review"
 *
 * Frontmatter fields:
 *   name, description, trigger, mode, platforms, keywords
 *
 * - trigger: string (keyword list) OR /regex/ pattern
 * - keywords: array of match keywords (alternative to trigger)
 * - platforms: array of ["macos", "linux", "windows"]
 *
 * Reference: yeaft-unify-design.md §8, yeaft-unify-core-systems.md
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { join, basename, relative, dirname, sep } from 'path';
import { platform } from 'os';

// ─── Platform Matching ────────────────────────────────────

const PLATFORM_MAP = {
  macos: 'darwin',
  linux: 'linux',
  windows: 'win32',
  darwin: 'darwin',
  win32: 'win32',
};

/**
 * Check if a skill matches the current platform.
 * @param {string[]} [platforms] — e.g. ['macos', 'linux']
 * @returns {boolean}
 */
export function matchesPlatform(platforms) {
  if (!platforms || platforms.length === 0) return true;
  const currentPlatform = platform();
  return platforms.some(p => PLATFORM_MAP[p.toLowerCase()] === currentPlatform);
}

// ─── Skill Parsing ─────────────────────────────────────────

/**
 * @typedef {Object} Skill
 * @property {string} name — unique skill name
 * @property {string} description — human-readable description
 * @property {string} trigger — when this skill should be invoked (keyword string or /regex/)
 * @property {string[]} [keywords] — explicit match keywords
 * @property {string} mode — 'chat' | 'work' | 'both'
 * @property {string[]} [platforms] — platform filter e.g. ['macos', 'linux']
 * @property {string} [category] — derived from directory path
 * @property {string} content — full skill instructions (markdown body)
 * @property {string} _source — 'file' | 'directory'
 * @property {string} _path — full path to skill file or directory
 * @property {string[]} [_references] — filenames in references/ dir
 * @property {string[]} [_templates] — filenames in templates/ dir
 */

/**
 * Parse YAML-like frontmatter from a skill .md file.
 *
 * @param {string} raw — raw file content
 * @param {string} [filename] — source filename (for name fallback)
 * @returns {Skill|null}
 */
export function parseSkill(raw, filename = '') {
  if (!raw || !raw.startsWith('---')) return null;

  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const frontmatter = raw.slice(4, endIdx).trim();
  const body = raw.slice(endIdx + 4).trim();

  const skill = {
    content: body,
    mode: 'both',
    _source: 'file',
    _path: '',
  };

  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    switch (key) {
      case 'name': skill.name = value; break;
      case 'description': skill.description = value; break;
      case 'trigger': skill.trigger = value; break;
      case 'mode': skill.mode = value; break;
      case 'platforms': {
        // Parse [macos, linux] or macos, linux
        const cleaned = value.replace(/^\[|\]$/g, '');
        skill.platforms = cleaned.split(',').map(t => t.trim()).filter(Boolean);
        break;
      }
      case 'keywords': {
        const cleaned = value.replace(/^\[|\]$/g, '');
        skill.keywords = cleaned.split(',').map(t => t.trim()).filter(Boolean);
        break;
      }
      case 'category': skill.category = value; break;
    }
  }

  // Use filename as name fallback
  if (!skill.name) {
    skill.name = basename(filename, '.md');
  }

  return skill;
}

/**
 * Serialize a skill to .md format.
 *
 * @param {Skill} skill
 * @returns {string}
 */
export function serializeSkill(skill) {
  const fm = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description || ''}`,
    `trigger: ${skill.trigger || ''}`,
    `mode: ${skill.mode || 'both'}`,
  ];

  if (skill.platforms && skill.platforms.length > 0) {
    fm.push(`platforms: [${skill.platforms.join(', ')}]`);
  }

  if (skill.keywords && skill.keywords.length > 0) {
    fm.push(`keywords: [${skill.keywords.join(', ')}]`);
  }

  if (skill.category) {
    fm.push(`category: ${skill.category}`);
  }

  fm.push('---');

  return fm.join('\n') + '\n\n' + (skill.content || '');
}

// ─── Directory Scanning ───────────────────────────────────

/**
 * List files in a subdirectory (non-recursive).
 * @param {string} dir
 * @returns {string[]}
 */
function listSubdirFiles(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(f => {
      try { return statSync(join(dir, f)).isFile(); } catch { return false; }
    });
  } catch { return []; }
}

/**
 * Recursively discover skills in a directory.
 * Supports:
 *   - skills/foo.md  (single-file skill)
 *   - skills/foo/SKILL.md  (directory-based skill)
 *   - skills/category/foo/SKILL.md  (nested category)
 *
 * @param {string} rootDir — skills root directory
 * @param {string} [subPath] — relative path from root (for category derivation)
 * @returns {{ skills: Skill[], errors: string[] }}
 */
function discoverSkills(rootDir, subPath = '') {
  const dir = subPath ? join(rootDir, subPath) : rootDir;
  const skills = [];
  const errors = [];

  if (!existsSync(dir)) return { skills, errors };

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    errors.push(`Cannot read directory ${dir}: ${err.message}`);
    return { skills, errors };
  }

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    const relPath = subPath ? join(subPath, entry.name) : entry.name;

    if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
      // Single-file skill (legacy format)
      try {
        const raw = readFileSync(entryPath, 'utf8');
        const skill = parseSkill(raw, entry.name);
        if (skill && skill.name) {
          skill._source = 'file';
          skill._path = entryPath;
          // Category from parent directory path
          if (subPath) {
            skill.category = skill.category || subPath.split(sep).join('/');
          }
          skills.push(skill);
        } else {
          errors.push(`Failed to parse skill: ${relPath}`);
        }
      } catch (err) {
        errors.push(`Error loading ${relPath}: ${err.message}`);
      }
    } else if (entry.isDirectory()) {
      // Check for SKILL.md inside this directory
      const skillMdPath = join(entryPath, 'SKILL.md');
      if (existsSync(skillMdPath)) {
        // Directory-based skill
        try {
          const raw = readFileSync(skillMdPath, 'utf8');
          const skill = parseSkill(raw, entry.name);
          if (skill && skill.name) {
            skill._source = 'directory';
            skill._path = entryPath;
            // Derive category from parent path
            if (subPath) {
              skill.category = skill.category || subPath.split(sep).join('/');
            }
            // Discover linked files
            skill._references = listSubdirFiles(join(entryPath, 'references'));
            skill._templates = listSubdirFiles(join(entryPath, 'templates'));
            skills.push(skill);
          } else {
            errors.push(`Failed to parse skill: ${relPath}/SKILL.md`);
          }
        } catch (err) {
          errors.push(`Error loading ${relPath}/SKILL.md: ${err.message}`);
        }
      } else {
        // No SKILL.md — treat as category directory, recurse
        const sub = discoverSkills(rootDir, relPath);
        skills.push(...sub.skills);
        errors.push(...sub.errors);
      }
    }
  }

  return { skills, errors };
}

// ─── Trigger Matching ─────────────────────────────────────

/**
 * Test if a trigger string matches a prompt.
 * Supports:
 *   - /regex/ patterns (trigger starts and ends with /)
 *   - keyword-based matching (word overlap with stem matching)
 *
 * @param {string} trigger
 * @param {string} prompt — lowercase prompt
 * @param {string[]} promptWords — cleaned prompt words
 * @returns {boolean}
 */
function matchTrigger(trigger, prompt, promptWords) {
  // Regex trigger: /pattern/flags
  const regexMatch = trigger.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try {
      const re = new RegExp(regexMatch[1], regexMatch[2] || 'i');
      return re.test(prompt);
    } catch {
      // Invalid regex, fall through to keyword matching
    }
  }

  // Keyword-based matching
  const triggerWords = trigger.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  if (triggerWords.length === 0) return false;

  const cleanPrompt = prompt.replace(/[^\w\s]/g, '');
  const matchCount = triggerWords.filter(tw => {
    if (cleanPrompt.includes(tw)) return true;
    const twStem = tw.slice(0, Math.min(tw.length, 4));
    return promptWords.some(pw => {
      if (pw.includes(tw) || tw.includes(pw)) return true;
      const pwStem = pw.slice(0, Math.min(pw.length, 4));
      return twStem.length >= 4 && pwStem.length >= 4 && twStem === pwStem;
    });
  }).length;

  return matchCount >= 1 && matchCount >= Math.ceil(triggerWords.length * 0.3);
}

/**
 * Test if keywords list matches a prompt.
 * Any keyword found in prompt = match.
 *
 * @param {string[]} keywords
 * @param {string} prompt — lowercase prompt
 * @returns {boolean}
 */
function matchKeywords(keywords, prompt) {
  return keywords.some(kw => prompt.includes(kw.toLowerCase()));
}

// ─── SkillManager ──────────────────────────────────────────

/**
 * SkillManager — loads, indexes, and queries skills.
 * Supports both single-file and directory-based skills.
 */
export class SkillManager {
  /** @type {Map<string, Skill>} */
  #skills = new Map();

  /** @type {string} */
  #skillsDir;

  /**
   * @param {string} yeaftDir — Yeaft root directory (e.g. ~/.yeaft)
   */
  constructor(yeaftDir) {
    this.#skillsDir = join(yeaftDir, 'skills');
  }

  /** The skills root directory path. */
  get skillsDir() {
    return this.#skillsDir;
  }

  /**
   * Load all skills from the skills directory (recursive).
   *
   * @returns {{ loaded: number, errors: string[] }}
   */
  load() {
    this.#skills.clear();

    if (!existsSync(this.#skillsDir)) {
      return { loaded: 0, errors: [] };
    }

    const { skills, errors } = discoverSkills(this.#skillsDir);

    for (const skill of skills) {
      // Platform filtering at load time
      if (matchesPlatform(skill.platforms)) {
        this.#skills.set(skill.name, skill);
      }
    }

    return { loaded: this.#skills.size, errors };
  }

  /**
   * Get a skill by name.
   *
   * @param {string} name
   * @returns {Skill|null}
   */
  get(name) {
    return this.#skills.get(name) || null;
  }

  /**
   * Check if a skill exists.
   *
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.#skills.has(name);
  }

  /**
   * List all skills (metadata only — no content), optionally filtered by mode.
   * This is the "progressive disclosure" list tier.
   *
   * @param {string} [mode] — 'chat' | 'work' | undefined (all)
   * @returns {Array<{ name: string, description: string, trigger: string, mode: string, category?: string, platforms?: string[], keywords?: string[], source: string, hasReferences: boolean, hasTemplates: boolean }>}
   */
  list(mode) {
    const skills = [...this.#skills.values()];
    const filtered = mode ? skills.filter(s => s.mode === 'both' || s.mode === mode) : skills;

    return filtered.map(s => ({
      name: s.name,
      description: s.description || '',
      trigger: s.trigger || '',
      mode: s.mode || 'both',
      category: s.category || undefined,
      platforms: s.platforms || undefined,
      keywords: s.keywords || undefined,
      source: s._source,
      hasReferences: (s._references && s._references.length > 0) || false,
      hasTemplates: (s._templates && s._templates.length > 0) || false,
    }));
  }

  /**
   * View a skill's full content + linked files (progressive disclosure view tier).
   *
   * @param {string} name — skill name
   * @param {string} [filePath] — specific linked file to read (e.g. "references/style-guide.md")
   * @returns {{ skill: Skill, references: string[], templates: string[], linkedContent?: string } | null}
   */
  view(name, filePath) {
    const skill = this.#skills.get(name);
    if (!skill) return null;

    const result = {
      skill,
      references: skill._references || [],
      templates: skill._templates || [],
    };

    // Read a specific linked file if requested
    if (filePath && skill._source === 'directory') {
      const fullPath = join(skill._path, filePath);
      // Security: ensure path doesn't escape skill directory
      const resolved = join(skill._path, filePath);
      if (!resolved.startsWith(skill._path)) {
        result.linkedContent = 'Error: path traversal not allowed';
      } else if (existsSync(fullPath)) {
        try {
          result.linkedContent = readFileSync(fullPath, 'utf8');
        } catch (err) {
          result.linkedContent = `Error reading file: ${err.message}`;
        }
      } else {
        result.linkedContent = `File not found: ${filePath}`;
      }
    }

    return result;
  }

  /**
   * Find skills relevant to a prompt.
   * Enhanced matching: regex triggers, keyword lists, name/description match.
   *
   * @param {string} prompt — user's prompt
   * @param {string} [mode] — filter by mode
   * @returns {Skill[]}
   */
  findRelevant(prompt, mode) {
    if (!prompt) return [];

    const lowerPrompt = prompt.toLowerCase();
    const cleanPrompt = lowerPrompt.replace(/[^\w\s]/g, '');
    const promptWords = cleanPrompt.split(/\s+/).filter(w => w.length > 2);
    const allSkills = [...this.#skills.values()];
    const filtered = mode ? allSkills.filter(s => s.mode === 'both' || s.mode === mode) : allSkills;

    return filtered.filter(skill => {
      // 1. Regex or keyword trigger match
      if (skill.trigger && matchTrigger(skill.trigger, lowerPrompt, promptWords)) {
        return true;
      }

      // 2. Explicit keywords match
      if (skill.keywords && skill.keywords.length > 0 && matchKeywords(skill.keywords, lowerPrompt)) {
        return true;
      }

      // 3. Name match
      if (lowerPrompt.includes(skill.name.toLowerCase())) {
        return true;
      }

      // 4. Description match
      if (skill.description && lowerPrompt.includes(skill.description.toLowerCase())) {
        return true;
      }

      return false;
    });
  }

  /**
   * Add or update a skill (single-file format).
   *
   * @param {Skill} skill
   * @returns {string} — filename
   */
  save(skill) {
    if (!skill.name) throw new Error('Skill must have a name');

    const filename = `${skill.name}.md`;
    const filePath = join(this.#skillsDir, filename);

    if (!existsSync(this.#skillsDir)) {
      mkdirSync(this.#skillsDir, { recursive: true });
    }

    writeFileSync(filePath, serializeSkill(skill), 'utf8');
    this.#skills.set(skill.name, { ...skill, _source: 'file', _path: filePath });

    return filename;
  }

  /**
   * Remove a skill (supports both file and directory skills).
   *
   * @param {string} name
   * @returns {boolean}
   */
  remove(name) {
    const skill = this.#skills.get(name);
    if (!skill) return false;

    if (skill._source === 'directory' && skill._path) {
      // For directory skills, we only delete the SKILL.md to "deactivate"
      // Full directory removal is left to the user (too dangerous to rm -rf)
      const skillMd = join(skill._path, 'SKILL.md');
      try { unlinkSync(skillMd); } catch { /* noop */ }
    } else {
      const filePath = skill._path || join(this.#skillsDir, `${name}.md`);
      try { unlinkSync(filePath); } catch { /* noop */ }
    }

    this.#skills.delete(name);
    return true;
  }

  /**
   * Get the skill content formatted for system prompt injection.
   *
   * @param {string} name
   * @returns {string}
   */
  getPromptContent(name) {
    const skill = this.#skills.get(name);
    if (!skill) return '';

    return `## Skill: ${skill.name}\n\n${skill.content}`;
  }

  /**
   * Get all relevant skill contents for a prompt.
   *
   * @param {string} prompt
   * @param {string} [mode]
   * @returns {string}
   */
  getRelevantPromptContent(prompt, mode) {
    const relevant = this.findRelevant(prompt, mode);
    if (relevant.length === 0) return '';

    return relevant.map(s => this.getPromptContent(s.name)).join('\n\n');
  }

  /**
   * List unique categories across all loaded skills.
   *
   * @returns {string[]}
   */
  listCategories() {
    const categories = new Set();
    for (const skill of this.#skills.values()) {
      if (skill.category) categories.add(skill.category);
    }
    return [...categories].sort();
  }

  /** Number of loaded skills. */
  get size() {
    return this.#skills.size;
  }
}

/**
 * Create a SkillManager and load skills.
 *
 * @param {string} yeaftDir
 * @returns {SkillManager}
 */
export function createSkillManager(yeaftDir) {
  const manager = new SkillManager(yeaftDir);
  manager.load();
  return manager;
}
