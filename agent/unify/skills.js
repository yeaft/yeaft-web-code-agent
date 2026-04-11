/**
 * skills.js — Skill loading and management
 *
 * Skills are markdown files in ~/.yeaft/skills/ that define
 * specialized behaviors or workflows. They are loaded at startup
 * and injected into the system prompt when relevant.
 *
 * Skill format (skills/my-skill.md):
 *   ---
 *   name: my-skill
 *   description: Does something useful
 *   trigger: "when user asks about X"
 *   mode: chat | work | both
 *   ---
 *   # Skill instructions here...
 *
 * Reference: yeaft-unify-design.md §8, yeaft-unify-core-systems.md
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, basename } from 'path';

// ─── Skill Parsing ─────────────────────────────────────────

/**
 * @typedef {Object} Skill
 * @property {string} name — unique skill name
 * @property {string} description — human-readable description
 * @property {string} trigger — when this skill should be invoked
 * @property {string} mode — 'chat' | 'work' | 'both'
 * @property {string} content — full skill instructions (markdown body)
 * @property {string} _filename — source filename
 */

/**
 * Parse a skill .md file.
 *
 * @param {string} raw — raw file content
 * @param {string} filename — source filename
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
    _filename: filename,
    mode: 'both',
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
    '---',
  ];

  return fm.join('\n') + '\n\n' + (skill.content || '');
}

// ─── SkillManager ──────────────────────────────────────────

/**
 * SkillManager — loads, indexes, and queries skills.
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

  /**
   * Load all skills from the skills directory.
   *
   * @returns {{ loaded: number, errors: string[] }}
   */
  load() {
    this.#skills.clear();
    const errors = [];

    if (!existsSync(this.#skillsDir)) {
      return { loaded: 0, errors: [] };
    }

    const files = readdirSync(this.#skillsDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.#skillsDir, file), 'utf8');
        const skill = parseSkill(raw, file);
        if (skill && skill.name) {
          this.#skills.set(skill.name, skill);
        } else {
          errors.push(`Failed to parse skill: ${file}`);
        }
      } catch (err) {
        errors.push(`Error loading ${file}: ${err.message}`);
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
   * List all skills, optionally filtered by mode.
   *
   * @param {string} [mode] — 'chat' | 'work' | undefined (all)
   * @returns {Skill[]}
   */
  list(mode) {
    const skills = [...this.#skills.values()];
    if (!mode) return skills;

    return skills.filter(s => s.mode === 'both' || s.mode === mode);
  }

  /**
   * Find skills relevant to a prompt (simple keyword matching).
   *
   * @param {string} prompt — user's prompt
   * @param {string} [mode] — filter by mode
   * @returns {Skill[]}
   */
  findRelevant(prompt, mode) {
    if (!prompt) return [];

    const lowerPrompt = prompt.toLowerCase();
    // Strip punctuation and split on whitespace for clean word matching
    const cleanPrompt = lowerPrompt.replace(/[^\w\s]/g, '');
    const promptWords = cleanPrompt.split(/\s+/).filter(w => w.length > 2);
    const skills = this.list(mode);

    return skills.filter(skill => {
      // Check trigger match — any trigger keyword found in prompt
      if (skill.trigger) {
        const triggerWords = skill.trigger.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
        // Count matches: exact word, substring, or shared stem (first 4 chars)
        const matchCount = triggerWords.filter(tw => {
          if (cleanPrompt.includes(tw)) return true;
          // Stem matching: if trigger word and prompt word share a 4+ char prefix
          const twStem = tw.slice(0, Math.min(tw.length, 4));
          return promptWords.some(pw => {
            if (pw.includes(tw) || tw.includes(pw)) return true;
            const pwStem = pw.slice(0, Math.min(pw.length, 4));
            return twStem.length >= 4 && pwStem.length >= 4 && twStem === pwStem;
          });
        }).length;
        // At least 1 meaningful match and ≥30% of trigger words
        if (matchCount >= 1 && matchCount >= Math.ceil(triggerWords.length * 0.3)) {
          return true;
        }
      }

      // Check name match
      if (lowerPrompt.includes(skill.name.toLowerCase())) {
        return true;
      }

      // Check description match
      if (skill.description && lowerPrompt.includes(skill.description.toLowerCase())) {
        return true;
      }

      return false;
    });
  }

  /**
   * Add or update a skill.
   *
   * @param {Skill} skill
   * @returns {string} — filename
   */
  save(skill) {
    if (!skill.name) throw new Error('Skill must have a name');

    const filename = `${skill.name}.md`;
    const filePath = join(this.#skillsDir, filename);

    writeFileSync(filePath, serializeSkill(skill), 'utf8');
    this.#skills.set(skill.name, { ...skill, _filename: filename });

    return filename;
  }

  /**
   * Remove a skill.
   *
   * @param {string} name
   * @returns {boolean}
   */
  remove(name) {
    const skill = this.#skills.get(name);
    if (!skill) return false;

    const filePath = join(this.#skillsDir, skill._filename || `${name}.md`);
    try {
      unlinkSync(filePath);
    } catch {
      // File might not exist
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
