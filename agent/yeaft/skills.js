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
 * ─── Layered loading (Claude-Code-style) ─────────────────
 *
 * A `SkillManager` can scan multiple directories in priority order — later
 * directories OVERRIDE earlier ones for skills with the same `name`. This
 * mirrors Claude Code's plugin → user → project layering and lets a user
 * customise a bundled skill without touching the bundled file.
 *
 * The standard tier order set up by `createSkillManager` is:
 *
 *   tier 1 (bundled): wherever yeaft-skills is installed on disk — typically
 *           ~/.claude/skills/yeaft-skills/skills/. Read-only — `save()` and
 *           `remove()` never target this tier.
 *   tier 2 (user-claude): ~/.claude/skills. User-level Claude Code assets,
 *           loaded read-only for cross-tool compatibility.
 *   tier 3 (user-codex): ~/.codex/skills. User-level Codex assets, loaded
 *           read-only for cross-tool compatibility.
 *   tier 4 (user):    <yeaftDir>/skills (e.g. ~/.yeaft/skills). User edits
 *           land here. `save()` writes here. `init.js` seeds it from tier 1
 *           on first boot so users start with the full bundled set.
 *   tier 5 (project-claude): <workDir>/.claude/skills (if provided). Claude
 *           Code project assets, loaded so a Claude-Code-integrated project
 *           works out of the box. Higher than user (project-local beats
 *           user-global), lower than the yeaft-native project tier.
 *   tier 6 (project-codex): <workDir>/.agents/skills (if provided). Codex
 *           project assets, loaded with the same project-local precedence.
 *   tier 7 (project): <workDir>/.yeaft/skills (if provided). Highest
 *           priority — a project can pin a skill version without affecting
 *           the user's other projects, and overrides a borrowed
 *           `.claude/skills` / `.agents/skills` skill of the same name.
 *
 * Reference: yeaft-yeaft-design.md §8, yeaft-yeaft-core-systems.md
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { join, basename, sep, dirname, resolve, delimiter } from 'path';
import { platform, homedir } from 'os';
import { fileURLToPath } from 'url';

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
 * @property {string} [_tier] — 'bundled' | 'user' | 'project' — origin tier this skill was loaded from
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
function pathIsInside(childPath, parentPath) {
  const child = resolve(childPath);
  const parent = resolve(parentPath);
  return child === parent || child.startsWith(parent + sep);
}

function shouldIgnorePath(candidatePath, ignorePaths) {
  return ignorePaths.some(ignorePath => pathIsInside(candidatePath, ignorePath));
}

function discoverSkills(rootDir, subPath = '', opts = {}) {
  const dir = subPath ? join(rootDir, subPath) : rootDir;
  const ignorePaths = Array.isArray(opts.ignorePaths) ? opts.ignorePaths : [];
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

    if (shouldIgnorePath(entryPath, ignorePaths)) continue;

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
        const sub = discoverSkills(rootDir, relPath, opts);
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
 *
 * Layered loading: pass an array of directories (lowest priority → highest).
 * Skills with the same `name` in a later directory OVERRIDE earlier entries.
 * The user-writable tier (where `save()` / `remove()` operate) is configured
 * via the `userDir` option and must match one of the entries in `dirs` —
 * if it isn't given, the last entry in `dirs` is used as the user tier.
 */
export class SkillManager {
  /** @type {Map<string, Skill>} */
  #skills = new Map();

  /** @type {string[]} */
  #skillsDirs;

  /** @type {string} */
  #userDir;

  /** @type {Map<string, string>} — dir path → tier label */
  #tierByDir;

  /** @type {Map<string, string[]>} — dir path → resolved ignore paths */
  #ignorePathsByDir;

  /**
   * @param {string | string[]} dirs — single directory (back-compat) or array of
   *   directories in priority order (lowest → highest). Falsy entries are
   *   filtered out so callers can write `[bundled, user, projectOrNull]`.
   * @param {{ userDir?: string, tierByDir?: Record<string, string>, ignorePathsByDir?: Record<string, string[]> }} [opts]
   *   userDir: directory where `save()` and `remove()` write. Defaults to the
   *     last entry in `dirs` (typical case: user dir is highest priority that
   *     isn't a per-project layer).
   *   tierByDir: optional label map — dir path → 'bundled' | 'user' | 'project'.
   *     Decorates each discovered Skill with `_tier` for diagnostics (Settings
   *     UI uses this to show "where this skill came from").
   *   ignorePathsByDir: optional map of scan dir → subtrees to skip while
   *     recursively discovering skills in that dir.
   */
  constructor(dirs, opts = {}) {
    const list = Array.isArray(dirs)
      ? dirs.filter(d => typeof d === 'string' && d.length > 0)
      : (typeof dirs === 'string' && dirs.length > 0 ? [dirs] : []);
    this.#skillsDirs = list;
    // Default user-writable tier: explicit opt → last array entry → first
    // entry → empty string. Empty string disables write attempts but the
    // manager still loads.
    this.#userDir = (opts && typeof opts.userDir === 'string' && opts.userDir.length > 0)
      ? opts.userDir
      : (list.length > 0 ? list[list.length - 1] : '');
    this.#tierByDir = new Map();
    if (opts && opts.tierByDir && typeof opts.tierByDir === 'object') {
      for (const [d, tier] of Object.entries(opts.tierByDir)) {
        if (typeof d === 'string' && typeof tier === 'string') {
          this.#tierByDir.set(d, tier);
        }
      }
    }
    this.#ignorePathsByDir = new Map();
    if (opts && opts.ignorePathsByDir && typeof opts.ignorePathsByDir === 'object') {
      for (const [d, ignorePaths] of Object.entries(opts.ignorePathsByDir)) {
        if (typeof d !== 'string' || !Array.isArray(ignorePaths)) continue;
        this.#ignorePathsByDir.set(d, ignorePaths.filter(p => typeof p === 'string' && p.length > 0).map(p => resolve(p)));
      }
    }
  }

  /** The user-writable skills directory (save/remove target). */
  get skillsDir() {
    return this.#userDir;
  }

  /** All directories scanned, in priority order (lowest → highest). */
  get skillsDirs() {
    return [...this.#skillsDirs];
  }

  /**
   * Load all skills from all configured directories.
   *
   * Lower-priority directories load first; later (higher-priority) entries
   * with the same skill `name` overwrite earlier ones. Each loaded skill is
   * tagged with `_tier` (from the constructor's `tierByDir` map, or the dir
   * basename as fallback) so consumers can show provenance.
   *
   * @returns {{ loaded: number, errors: string[] }}
   */
  load() {
    this.#skills.clear();
    const allErrors = [];

    if (this.#skillsDirs.length === 0) {
      return { loaded: 0, errors: [] };
    }

    for (const dir of this.#skillsDirs) {
      if (!existsSync(dir)) continue;
      const { skills, errors } = discoverSkills(dir, '', { ignorePaths: this.#ignorePathsByDir.get(dir) || [] });
      const tier = this.#tierByDir.get(dir) || basename(dir);
      for (const skill of skills) {
        // Platform filtering at load time
        if (!matchesPlatform(skill.platforms)) continue;
        skill._tier = tier;
        // Later (higher-priority) tier overrides earlier entries with the
        // same name — this is the layered-load contract.
        this.#skills.set(skill.name, skill);
      }
      allErrors.push(...errors);
    }

    return { loaded: this.#skills.size, errors: allErrors };
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
   * List all skills (metadata only — no content).
   * This is the "progressive disclosure" list tier.
   *
   * task-311: the legacy `mode` parameter (chat/work filter) is accepted but
   * ignored — Yeaft no longer has mode distinction, so every skill is treated
   * as universally applicable. The `mode` field on each record is still
   * surfaced for historic YAML compatibility.
   *
   * @param {string} [_mode] — deprecated, ignored
   * @returns {Array<{ name: string, description: string, trigger: string, mode: string, category?: string, platforms?: string[], keywords?: string[], source: string, tier?: string, hasReferences: boolean, hasTemplates: boolean }>}
   */
  list(_mode) {
    const skills = [...this.#skills.values()];

    return skills.map(s => ({
      name: s.name,
      description: s.description || '',
      trigger: s.trigger || '',
      mode: s.mode || 'both',
      category: s.category || undefined,
      platforms: s.platforms || undefined,
      keywords: s.keywords || undefined,
      source: s._source,
      tier: s._tier || undefined,
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
      // Security: resolve both ends to absolute paths and require fullPath to
      // sit under the skill root (separator-anchored so /foo-evil isn't seen
      // as a child of /foo). `path.join` alone collapses `..` but does not
      // detect symlink-escapes or absolute-path overrides.
      const fullPath = resolve(skill._path, filePath);
      const root = resolve(skill._path) + sep;
      if (fullPath !== resolve(skill._path) && !fullPath.startsWith(root)) {
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
   * task-311: the `mode` parameter is accepted but ignored (all skills are
   * considered universally applicable since mode distinction was removed).
   *
   * @param {string} prompt — user's prompt
   * @param {string} [_mode] — deprecated, ignored
   * @returns {Skill[]}
   */
  findRelevant(prompt, _mode) {
    if (!prompt) return [];

    const lowerPrompt = prompt.toLowerCase();
    const cleanPrompt = lowerPrompt.replace(/[^\w\s]/g, '');
    const promptWords = cleanPrompt.split(/\s+/).filter(w => w.length > 2);
    const allSkills = [...this.#skills.values()];

    return allSkills.filter(skill => {
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
   * Always writes to the USER tier (`#userDir`) regardless of where the
   * existing skill (if any) came from. This matches Claude Code: editing a
   * bundled skill produces a user-tier override, leaving the bundled file
   * untouched. Calling `load()` after a `save()` will then surface the
   * user version (higher priority).
   *
   * @param {Skill} skill
   * @returns {string} — filename
   */
  save(skill) {
    if (!skill.name) throw new Error('Skill must have a name');
    if (!this.#userDir) {
      throw new Error('SkillManager has no writable user directory configured');
    }

    const filename = `${skill.name}.md`;
    const filePath = join(this.#userDir, filename);

    if (!existsSync(this.#userDir)) {
      mkdirSync(this.#userDir, { recursive: true });
    }

    writeFileSync(filePath, serializeSkill(skill), 'utf8');
    const userTier = this.#tierByDir.get(this.#userDir) || basename(this.#userDir);
    this.#skills.set(skill.name, {
      ...skill,
      _source: 'file',
      _path: filePath,
      _tier: userTier,
    });

    return filename;
  }

  /**
   * Remove a skill (supports both file and directory skills).
   *
   * Only removes user-tier files. Bundled / project-tier skills are
   * read-only — attempting to remove one returns `false` and leaves the
   * file alone (the in-memory entry is also kept so a subsequent `load()`
   * still picks it up).
   *
   * @param {string} name
   * @returns {boolean}
   */
  remove(name) {
    const skill = this.#skills.get(name);
    if (!skill) return false;

    // Only allow removing files inside the user-writable directory. A
    // bundled or project-tier file would silently come back on the next
    // load() anyway; refusing here makes the failure obvious.
    if (!this.#userDir || !skill._path || !skill._path.startsWith(this.#userDir)) {
      return false;
    }

    if (skill._source === 'directory' && skill._path) {
      // For directory skills, we only delete the SKILL.md to "deactivate"
      // Full directory removal is left to the user (too dangerous to rm -rf)
      const skillMd = join(skill._path, 'SKILL.md');
      try { unlinkSync(skillMd); } catch { /* noop */ }
    } else {
      const filePath = skill._path || join(this.#userDir, `${name}.md`);
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
 * Create a SkillManager wired with the standard layered tier list and load it.
 *
 * Tier order (lowest → highest priority):
 *   1. bundled        — the yeaft-skills package on disk, located via
 *      `bundledYeaftSkillsDir()` (typically ~/.claude/skills/yeaft-skills/skills/).
 *   2. user-claude    — `~/.claude/skills`, read-only borrowed Claude Code assets.
 *   3. user-codex     — `~/.codex/skills`, read-only borrowed Codex assets.
 *   4. user           — `<yeaftDir>/skills` (e.g. ~/.yeaft/skills). User edits + saves.
 *   5. project-claude — `<workDir>/.claude/skills` when a workDir is provided.
 *      Claude Code project assets, loaded so a project that integrates Claude
 *      Code works out of the box. Ranks above `user` (project-local beats
 *      user-global) but below the yeaft-native project tier.
 *   6. project-codex  — `<workDir>/.agents/skills` when a workDir is provided.
 *      Codex project assets, loaded so Codex-integrated repositories work out
 *      of the box. Same precedence band as project Claude Code assets.
 *   7. project        — `<workDir>/.yeaft/skills` when a workDir is provided.
 *      Highest priority: a yeaft-native skill pinned in the project overrides
 *      a borrowed `.claude/skills` / `.agents/skills` skill of the same name.
 *
 * `save()` / `remove()` always target the USER tier, matching Claude Code.
 *
 * @param {string} yeaftDir — Yeaft data dir (user tier root)
 * @param {string} [workDir] — optional project working directory (project tier root)
 * @returns {SkillManager}
 */
export function createSkillManager(yeaftDir, workDir) {
  const bundled = bundledYeaftSkillsDir();
  const home = homedir();
  const claudeUserDir = home ? join(home, '.claude', 'skills') : null;
  const codexUserDir = home ? join(home, '.codex', 'skills') : null;
  const userDir = join(yeaftDir, 'skills');
  const projectRoots = [...new Set(String(workDir || '')
    .split(delimiter)
    .map(p => p.trim())
    .filter(Boolean))];
  const claudeProjectDirs = projectRoots.map(root => join(root, '.claude', 'skills'));
  const codexProjectDirs = projectRoots.map(root => join(root, '.agents', 'skills'));
  const projectDirs = projectRoots.map(root => join(root, '.yeaft', 'skills'));

  const dirs = [bundled, claudeUserDir, codexUserDir, userDir, ...claudeProjectDirs, ...codexProjectDirs, ...projectDirs].filter(Boolean);
  const tierByDir = {};
  if (bundled) tierByDir[bundled] = 'bundled';
  if (claudeUserDir) tierByDir[claudeUserDir] = 'user-claude';
  if (codexUserDir) tierByDir[codexUserDir] = 'user-codex';
  tierByDir[userDir] = 'user';
  for (const dir of claudeProjectDirs) tierByDir[dir] = 'project-claude';
  for (const dir of codexProjectDirs) tierByDir[dir] = 'project-codex';
  for (const dir of projectDirs) tierByDir[dir] = 'project';

  const ignorePathsByDir = {};
  if (claudeUserDir && bundled && pathIsInside(bundled, claudeUserDir)) {
    // Borrowed ~/.claude/skills must not recurse into the Yeaft bundled plugin
    // package; bundled skills have their own lower-priority tier/provenance.
    ignorePathsByDir[claudeUserDir] = [join(claudeUserDir, 'yeaft-skills')];
  }

  const manager = new SkillManager(dirs, { userDir, tierByDir, ignorePathsByDir });
  manager.load();
  return manager;
}

// ─── Bundled-skills resolver ──────────────────────────────

/**
 * Locate the bundled `yeaft-skills` package on disk.
 *
 * Resolution order (first existing directory wins):
 *   1. $YEAFT_SKILLS_BUNDLED_DIR — explicit env override (testing / packaging)
 *   2. ~/.claude/skills/yeaft-skills/skills/    — standard Claude Code plugin layout
 *   3. ~/.claude/plugins/yeaft-skills/skills/   — alternate plugin layout
 *   4. <agent-pkg>/skills/                       — bundled-with-agent fallback so
 *      a future npm release can ship its own skills directory
 *
 * Returns `null` when none exist — callers must tolerate this (Yeaft still
 * runs; the user just sees no pre-installed bundled skills). Co-located here
 * (rather than in init.js) so both `createSkillManager()` and init.js's seed
 * step can call it without a module cycle.
 *
 * @returns {string|null}
 */
export function bundledYeaftSkillsDir() {
  const candidates = [];

  const envOverride = process.env.YEAFT_SKILLS_BUNDLED_DIR;
  if (envOverride && typeof envOverride === 'string' && envOverride.length > 0) {
    candidates.push(envOverride);
  }

  const home = homedir();
  if (home) {
    candidates.push(join(home, '.claude', 'skills', 'yeaft-skills', 'skills'));
    candidates.push(join(home, '.claude', 'plugins', 'yeaft-skills', 'skills'));
  }

  // Bundled-with-agent fallback: <agent-pkg-root>/skills. The package root is
  // the directory containing agent/, so we walk up from this file.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // here = .../agent/yeaft
    const agentRoot = join(here, '..', '..');
    candidates.push(join(agentRoot, 'skills'));
  } catch {
    // fileURLToPath can throw on exotic loaders — non-fatal.
  }

  for (const c of candidates) {
    try {
      if (c && existsSync(c) && statSync(c).isDirectory()) {
        return c;
      }
    } catch {
      // permission errors etc. — try the next candidate.
    }
  }

  return null;
}
