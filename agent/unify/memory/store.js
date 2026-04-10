/**
 * store.js — Memory CRUD (read/write entries/*.md + MEMORY.md + scopes.md)
 *
 * Memory 3D Model:
 *   Kind  = WHAT — 6 types: fact, preference, skill, lesson, context, relation
 *   Scope = WHERE — dynamic tree path: global / work/project / tech/typescript
 *   Tags  = HOW — free keywords: [typescript, generics, covariance]
 *
 * Entry format (entries/*.md):
 *   ---
 *   name: auth-null-check-pattern
 *   kind: lesson
 *   scope: work/claude-web-chat/auth
 *   tags: [null-check, typescript, auth]
 *   importance: high
 *   frequency: 1
 *   created_at: 2026-04-09T14:30:00Z
 *   updated_at: 2026-04-09T15:00:00Z
 *   ---
 *   # Auth Null Check Pattern
 *   ...content...
 *
 * Reference: yeaft-unify-design.md §5.1, yeaft-unify-core-systems.md §2.2
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join, basename } from 'path';

// ─── Constants ──────────────────────────────────────────────────

/** Valid memory kinds. */
export const MEMORY_KINDS = ['fact', 'preference', 'skill', 'lesson', 'context', 'relation'];

/** Maximum entries allowed (Dream prunes beyond this). */
export const MAX_ENTRIES = 200;

/** Maximum MEMORY.md line count. */
export const MAX_MEMORY_LINES = 200;

// ─── Entry Parsing ──────────────────────────────────────────────

/**
 * Parse a memory entry .md file into an object.
 * @param {string} raw — raw file content
 * @returns {object|null}
 */
export function parseEntry(raw) {
  if (!raw || !raw.startsWith('---')) return null;

  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const frontmatter = raw.slice(4, endIdx).trim();
  const body = raw.slice(endIdx + 4).trim();

  const entry = { content: body };

  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    switch (key) {
      case 'name': entry.name = value; break;
      case 'kind': entry.kind = value; break;
      case 'scope': entry.scope = value; break;
      case 'importance': entry.importance = value; break;
      case 'frequency': entry.frequency = parseInt(value, 10); break;
      case 'created_at': entry.created_at = value; break;
      case 'updated_at': entry.updated_at = value; break;
      case 'tags': {
        // Parse [tag1, tag2, tag3] or tag1, tag2, tag3
        value = value.replace(/^\[|\]$/g, '');
        entry.tags = value.split(',').map(t => t.trim()).filter(Boolean);
        break;
      }
      case 'related': {
        value = value.replace(/^\[|\]$/g, '');
        entry.related = value.split(',').map(t => t.trim()).filter(Boolean);
        break;
      }
    }
  }

  return entry;
}

/**
 * Serialize a memory entry to .md format.
 * @param {object} entry
 * @returns {string}
 */
export function serializeEntry(entry) {
  const fm = [
    '---',
    `name: ${entry.name}`,
    `kind: ${entry.kind || 'fact'}`,
    `scope: ${entry.scope || 'global'}`,
    `tags: [${(entry.tags || []).join(', ')}]`,
    `importance: ${entry.importance || 'normal'}`,
    `frequency: ${entry.frequency || 1}`,
  ];

  if (entry.related && entry.related.length > 0) {
    fm.push(`related: [${entry.related.join(', ')}]`);
  }

  fm.push(`created_at: ${entry.created_at || new Date().toISOString()}`);
  fm.push(`updated_at: ${entry.updated_at || new Date().toISOString()}`);
  fm.push('---');
  fm.push('');
  fm.push(entry.content || '');

  return fm.join('\n');
}

/**
 * Generate a filename-safe slug from a name.
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')  // allow CJK chars
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ─── MemoryStore ────────────────────────────────────────────────

/**
 * MemoryStore — CRUD for memory entries, MEMORY.md, and scopes.md.
 *
 * Directory layout:
 *   memory/
 *     MEMORY.md       — user profile / knowledge map (<200 lines)
 *     scopes.md       — scope index (markdown table)
 *     entries/        — individual memory entries (flat)
 */
export class MemoryStore {
  #dir;          // root dir (e.g. ~/.yeaft)
  #memoryDir;    // ~/.yeaft/memory
  #entriesDir;   // ~/.yeaft/memory/entries
  #memoryPath;   // ~/.yeaft/memory/MEMORY.md
  #scopesPath;   // ~/.yeaft/memory/scopes.md

  /**
   * @param {string} dir — Yeaft root directory (e.g. ~/.yeaft)
   */
  constructor(dir) {
    this.#dir = dir;
    this.#memoryDir = join(dir, 'memory');
    this.#entriesDir = join(dir, 'memory', 'entries');
    this.#memoryPath = join(dir, 'memory', 'MEMORY.md');
    this.#scopesPath = join(dir, 'memory', 'scopes.md');

    // Ensure directories exist
    for (const d of [this.#memoryDir, this.#entriesDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }
  }

  // ─── MEMORY.md (User Profile / Knowledge Map) ──────────

  /**
   * Read the full MEMORY.md content.
   * @returns {string}
   */
  readProfile() {
    if (!existsSync(this.#memoryPath)) return '';
    return readFileSync(this.#memoryPath, 'utf8');
  }

  /**
   * Write (overwrite) MEMORY.md.
   * @param {string} content
   */
  writeProfile(content) {
    writeFileSync(this.#memoryPath, content, 'utf8');
  }

  /**
   * Read a specific section from MEMORY.md.
   * Sections are delimited by ## headers.
   * @param {string} section — e.g. "Facts", "Preferences"
   * @returns {string}
   */
  readSection(section) {
    const content = this.readProfile();
    if (!content) return '';

    const regex = new RegExp(`^## ${section}\\b[^\\n]*\\n`, 'im');
    const match = content.match(regex);
    if (!match) return '';

    const startIdx = match.index + match[0].length;
    const nextSection = content.indexOf('\n## ', startIdx);
    const endIdx = nextSection !== -1 ? nextSection : content.length;

    return content.slice(startIdx, endIdx).trim();
  }

  /**
   * Add a line to a section in MEMORY.md. Creates the section if it doesn't exist.
   * @param {string} section — e.g. "Facts"
   * @param {string} line — e.g. "- User prefers TypeScript"
   */
  addToSection(section, line) {
    let content = this.readProfile();

    const sectionHeader = `## ${section}`;
    const headerIdx = content.indexOf(sectionHeader);

    if (headerIdx === -1) {
      // Section doesn't exist — append it
      content = content.trimEnd() + `\n\n${sectionHeader}\n\n${line}\n`;
    } else {
      // Find end of section
      const afterHeader = headerIdx + sectionHeader.length;
      const nextSectionIdx = content.indexOf('\n## ', afterHeader);
      const insertIdx = nextSectionIdx !== -1 ? nextSectionIdx : content.length;

      // Insert before next section
      content = content.slice(0, insertIdx).trimEnd() + '\n' + line + '\n' + content.slice(insertIdx);
    }

    this.writeProfile(content);
  }

  // ─── Scopes Index ─────────────────────────────────────

  /**
   * Read scopes.md as a list of { scope, count, lastUpdated }.
   * @returns {object[]}
   */
  readScopes() {
    if (!existsSync(this.#scopesPath)) return [];

    const content = readFileSync(this.#scopesPath, 'utf8');
    const lines = content.split('\n');
    const scopes = [];

    for (const line of lines) {
      // Parse markdown table rows: | scope | count | lastUpdated |
      const match = line.match(/^\|\s*([^|]+)\s*\|\s*(\d+)\s*\|\s*([^|]+)\s*\|$/);
      if (match && match[1].trim() !== 'scope' && !match[1].includes('---')) {
        scopes.push({
          scope: match[1].trim(),
          count: parseInt(match[2].trim(), 10),
          lastUpdated: match[3].trim(),
        });
      }
    }

    return scopes;
  }

  /**
   * Rebuild scopes.md from current entries.
   */
  rebuildScopes() {
    const entries = this.listEntries();
    const scopeMap = new Map();

    for (const entry of entries) {
      const scope = entry.scope || 'global';
      const existing = scopeMap.get(scope) || { count: 0, lastUpdated: '' };
      existing.count++;
      if (entry.updated_at > existing.lastUpdated) {
        existing.lastUpdated = entry.updated_at;
      }
      scopeMap.set(scope, existing);
    }

    const lines = [
      '# Scope Index',
      '',
      '| scope | count | lastUpdated |',
      '| --- | --- | --- |',
    ];

    for (const [scope, info] of [...scopeMap.entries()].sort()) {
      lines.push(`| ${scope} | ${info.count} | ${info.lastUpdated} |`);
    }

    writeFileSync(this.#scopesPath, lines.join('\n') + '\n', 'utf8');
  }

  // ─── Entries CRUD ─────────────────────────────────────

  /**
   * List all entries with their frontmatter (no content body).
   * @returns {object[]}
   */
  listEntries() {
    if (!existsSync(this.#entriesDir)) return [];

    const files = readdirSync(this.#entriesDir).filter(f => f.endsWith('.md')).sort();
    const entries = [];

    for (const file of files) {
      const raw = readFileSync(join(this.#entriesDir, file), 'utf8');
      const entry = parseEntry(raw);
      if (entry) {
        entry._filename = file;
        entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * Read a specific entry by name (slug).
   * @param {string} name — entry name slug (without .md)
   * @returns {object|null}
   */
  readEntry(name) {
    const filePath = join(this.#entriesDir, `${name}.md`);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf8');
    return parseEntry(raw);
  }

  /**
   * Write (create or overwrite) an entry.
   * @param {object} entry — { name, kind, scope, tags, importance, content, ... }
   * @returns {string} — the filename slug used
   */
  writeEntry(entry) {
    const slug = entry.name ? slugify(entry.name) : `entry-${Date.now()}`;
    const now = new Date().toISOString();

    const fullEntry = {
      ...entry,
      name: entry.name || slug,
      created_at: entry.created_at || now,
      updated_at: now,
    };

    const filePath = join(this.#entriesDir, `${slug}.md`);
    writeFileSync(filePath, serializeEntry(fullEntry), 'utf8');

    return slug;
  }

  /**
   * Write multiple entries at once.
   * @param {object[]} entries
   * @returns {string[]} — slugs
   */
  writeEntries(entries) {
    return entries.map(e => this.writeEntry(e));
  }

  /**
   * Delete an entry by name (slug).
   * @param {string} name — entry slug (without .md)
   * @returns {boolean} — true if deleted
   */
  deleteEntry(name) {
    const filePath = join(this.#entriesDir, `${name}.md`);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  }

  /**
   * Increment the frequency counter of an entry.
   * @param {string} name — entry slug
   */
  bumpFrequency(name) {
    const entry = this.readEntry(name);
    if (!entry) return;
    entry.frequency = (entry.frequency || 1) + 1;
    entry.updated_at = new Date().toISOString();
    const filePath = join(this.#entriesDir, `${name}.md`);
    writeFileSync(filePath, serializeEntry(entry), 'utf8');
  }

  // ─── Search / Filter ──────────────────────────────────

  /**
   * Find entries matching scope + tags.
   * Scoring: exact scope match = 3, ancestor scope = 2, tag overlap = 1 per tag.
   *
   * @param {{ scope?: string, tags?: string[], limit?: number }} filters
   * @returns {object[]} — entries sorted by score descending
   */
  findByFilter({ scope, tags = [], limit = 15 } = {}) {
    const entries = this.listEntries();

    const scored = entries.map(entry => {
      let score = 0;

      // Scope scoring
      if (scope && entry.scope) {
        if (entry.scope === scope) {
          score += 3; // exact match
        } else if (scope.startsWith(entry.scope + '/') || entry.scope.startsWith(scope + '/')) {
          score += 2; // ancestor or descendant
        } else if (entry.scope === 'global') {
          score += 1; // global always partially relevant
        }
      }

      // Tag scoring
      if (tags.length > 0 && entry.tags) {
        const entryTagSet = new Set(entry.tags.map(t => t.toLowerCase()));
        for (const tag of tags) {
          if (entryTagSet.has(tag.toLowerCase())) {
            score += 1;
          }
        }
      }

      return { ...entry, _score: score };
    });

    return scored
      .filter(e => e._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);
  }

  /**
   * Keyword search across all entries.
   * @param {string} keyword
   * @param {number} [limit=20]
   * @returns {object[]}
   */
  search(keyword, limit = 20) {
    if (!keyword || !keyword.trim()) return [];

    const lowerKeyword = keyword.toLowerCase();
    const entries = this.listEntries();
    const results = [];

    for (const entry of entries) {
      if (results.length >= limit) break;

      const searchable = [
        entry.name,
        entry.kind,
        entry.scope,
        (entry.tags || []).join(' '),
        entry.content,
      ].join(' ').toLowerCase();

      if (searchable.includes(lowerKeyword)) {
        results.push(entry);
      }
    }

    return results;
  }

  // ─── Stats ────────────────────────────────────────────

  /**
   * Get memory statistics.
   * @returns {{ entryCount: number, scopes: string[], kinds: object }}
   */
  stats() {
    const entries = this.listEntries();
    const kinds = {};
    const scopeSet = new Set();

    for (const entry of entries) {
      kinds[entry.kind] = (kinds[entry.kind] || 0) + 1;
      if (entry.scope) scopeSet.add(entry.scope);
    }

    return {
      entryCount: entries.length,
      scopes: [...scopeSet].sort(),
      kinds,
    };
  }

  /**
   * Clear all memory data.
   */
  clear() {
    // Clear entries
    if (existsSync(this.#entriesDir)) {
      for (const file of readdirSync(this.#entriesDir)) {
        if (file.endsWith('.md')) {
          unlinkSync(join(this.#entriesDir, file));
        }
      }
    }

    // Clear MEMORY.md
    if (existsSync(this.#memoryPath)) {
      writeFileSync(this.#memoryPath, '', 'utf8');
    }

    // Clear scopes.md
    if (existsSync(this.#scopesPath)) {
      unlinkSync(this.#scopesPath);
    }
  }
}
