/**
 * init.js — Yeaft directory structure initialization
 *
 * Ensures ~/.yeaft/ and all required subdirectories exist.
 * Creates default config.md, MEMORY.md, and chat/index.md if missing.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, accessSync, constants } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
// NOTE: migrateSessions runs at the end of initYeaftDir(). It collapses
// legacy groups/ + chats/ + memory/{group,chat}/ into the unified sessions/
// layout AND rewrites pre-rename per-message frontmatter (groupId → sessionId).
// Idempotent via the `.yeaft-migration.done` sentinel file.
import { migrateSessions } from './migrate/sessions.js';
import { readWorkDirRegistry, yeaftDirForWorkDir } from './sessions/session-crud.js';
import { bundledYeaftSkillsDir } from './skills.js';

/**
 * Check if an error is a permission error (EACCES or EPERM).
 * @param {Error} err
 * @returns {boolean}
 */
export function isPermissionError(err) {
  return err?.code === 'EACCES' || err?.code === 'EPERM';
}

/**
 * Try to write a file, catching permission errors gracefully.
 * @param {string} filePath
 * @param {string} content
 * @param {string[]} warnings — array to push warning messages into
 */
function safeWriteFile(filePath, content, warnings) {
  try {
    writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o644 });
  } catch (err) {
    if (isPermissionError(err)) {
      warnings.push(`Cannot write ${filePath}: ${err.code}`);
    } else {
      throw err;
    }
  }
}

/**
 * Try to create a directory, catching permission errors gracefully.
 * @param {string} dirPath
 * @param {string[]} warnings — array to push warning messages into
 * @returns {boolean} — true if directory exists (created or already existed)
 */
function safeMkdir(dirPath, warnings) {
  try {
    mkdirSync(dirPath, { recursive: true, mode: 0o755 });
    return true;
  } catch (err) {
    if (isPermissionError(err)) {
      warnings.push(`Cannot create directory ${dirPath}: ${err.code}`);
      return existsSync(dirPath);
    }
    throw err;
  }
}

/**
 * Check if a directory is writable.
 * @param {string} dirPath
 * @returns {boolean}
 */
export function isWritable(dirPath) {
  try {
    accessSync(dirPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Default directory for Yeaft data. */
export const DEFAULT_YEAFT_DIR = join(homedir(), '.yeaft');

/** Subdirectories that must exist inside the Yeaft data directory. */
const SUBDIRS = [
  'chat/messages',
  'chat/cold',
  'chat/blobs',
  'sessions',
  'memory/entries',
  'tasks',
  'skills',
];

/** Default config.json — generated on first init as default configuration. */
const DEFAULT_CONFIG_JSON = `{
  "providers": [
    {
      "name": "my-proxy",
      "baseUrl": "http://localhost:6628/v1",
      "apiKey": "proxy",
      "models": [
        "claude-sonnet-4-20250514",
        "claude-haiku-3-20250414",
        "gpt-5",
        "deepseek-chat"
      ]
    }
  ],
  "primaryModel": "my-proxy/claude-sonnet-4-20250514",
  "fastModel": "my-proxy/claude-sonnet-4-20250514",
  "language": "en",
  "debug": false,
  "maxContextTokens": 200000,
  "messageTokenBudget": 32768
}
`;

/** Default MEMORY.md content. */
const DEFAULT_MEMORY = `# Yeaft Memory

This file stores persistent memory entries. The agent will read and update this file.

## Facts

## Preferences

## Project Context

`;

/** Default mcp.json example — generated as reference for MCP server configuration. */
const DEFAULT_MCP_EXAMPLE = `{
  "_comment": "MCP server configuration. Rename to mcp.json to enable.",
  "_docs": "Each server needs 'name' + 'command'. Optional: 'args', 'env'.",
  "servers": [
    {
      "name": "example-github",
      "command": "npx",
      "args": ["@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  ]
}
`;

/** Default conversation/index.md content. */
const DEFAULT_CONVERSATION_INDEX = `---
lastMessageId: null
totalMessages: 0
---

# Conversation Index

This file tracks one Yeaft message-history mode.
`;

/**
 * Initialize the Yeaft data directory structure.
 *
 * @param {string} [dir] — Root directory path. Defaults to ~/.yeaft/
 * @returns {{ dir: string, created: string[], writable: boolean, warnings: string[], seededSkills?: number }} — The root dir, list of created paths, writability status, any warnings, and how many bundled skills were seeded
 */
export function initYeaftDir(dir) {
  const root = dir || DEFAULT_YEAFT_DIR;
  const created = [];
  const warnings = [];

  // Ensure root exists
  if (!existsSync(root)) {
    if (safeMkdir(root, warnings)) {
      created.push(root);
    }
  }

  // Check if root is writable early — if not, skip file creation
  const writable = isWritable(root);
  if (!writable) {
    warnings.push(`Directory ${root} is not writable — session will run in read-only mode`);
    return { dir: root, created, writable, warnings };
  }

  // Ensure all subdirectories exist
  for (const sub of SUBDIRS) {
    const fullPath = join(root, sub);
    if (!existsSync(fullPath)) {
      if (safeMkdir(fullPath, warnings)) {
        created.push(fullPath);
      }
    }
  }

  // Create default files if they don't exist
  // config.json — default configuration (user edits this directly)
  const configJsonPath = join(root, 'config.json');
  if (!existsSync(configJsonPath)) {
    safeWriteFile(configJsonPath, DEFAULT_CONFIG_JSON, warnings);
    created.push(configJsonPath);
  }

  const memoryPath = join(root, 'memory', 'MEMORY.md');
  if (!existsSync(memoryPath)) {
    safeWriteFile(memoryPath, DEFAULT_MEMORY, warnings);
    created.push(memoryPath);
  }

  const chatIndexPath = join(root, 'chat', 'index.md');
  if (!existsSync(chatIndexPath)) {
    safeWriteFile(chatIndexPath, DEFAULT_CONVERSATION_INDEX, warnings);
    created.push(chatIndexPath);
  }

  // mcp.json.example — reference template for MCP server configuration
  const mcpExamplePath = join(root, 'mcp.json.example');
  if (!existsSync(mcpExamplePath)) {
    safeWriteFile(mcpExamplePath, DEFAULT_MCP_EXAMPLE, warnings);
    created.push(mcpExamplePath);
  }

  // Seed bundled yeaft-skills into the user dir (Claude-Code-style). After
  // every successful boot the user dir mirrors the bundled set (modulo files
  // the user has hand-edited — those are detected via the manifest sha and
  // left alone). New bundled skills appear automatically; bundled-version
  // upgrades flow through; user edits are never clobbered.
  let seededSkills = 0;
  try {
    const seedResult = seedBundledSkills(join(root, 'skills'), warnings);
    seededSkills = seedResult.copied;
    if (seedResult.copied > 0 || seedResult.updated > 0) {
      console.log(`[yeaft] seeded ${seedResult.copied} new + ${seedResult.updated} updated bundled skills (${seedResult.preserved} user edits preserved)`);
    }
  } catch (err) {
    warnings.push(`Failed to seed bundled skills: ${err?.message || err}`);
  }

  // NOTE: sessions migration runs synchronously here. It MUST complete before
  // any LLM request fires, because step 7 (per-message frontmatter rewrite)
  // is what lets the persist.js parser drop the legacy `groupId:` row alias.
  // Idempotent (sentinel file) so re-running on a fully-migrated dir is a
  // no-op; on a partial-crash dir, each step is independently resumable.
  try {
    const res = migrateSessions(root);
    if (res && res.migrated) {
      console.log(`[yeaft] session migration complete (${res.moved} dirs moved, ${res.frontmatterRewrites} messages rewritten${res.warnings?.length ? `, ${res.warnings.length} warnings` : ''})`);
      if (res.warnings?.length) for (const w of res.warnings) console.warn(`[yeaft] migration: ${w}`);
    }
    migrateRegisteredWorkDirs(root);
  } catch (err) {
    console.warn(`[yeaft] session migration failed (continuing): ${err?.message || err}`);
  }

  return { dir: root, created, writable, warnings, seededSkills };
}

function migrateRegisteredWorkDirs(root) {
  let registry;
  try {
    registry = readWorkDirRegistry(root);
  } catch (err) {
    console.warn(`[yeaft] workdir registry migration skipped: ${err?.message || err}`);
    return;
  }

  const workDirs = new Set();
  for (const entry of Object.values(registry || {})) {
    if (typeof entry === 'string' && entry) workDirs.add(entry);
  }

  for (const workDir of workDirs) {
    const workYeaftDir = yeaftDirForWorkDir(workDir);
    if (!existsSync(workYeaftDir)) continue;
    try {
      const res = migrateSessions(workYeaftDir);
      if (res && res.migrated) {
        console.log(`[yeaft] workdir session migration complete for ${workYeaftDir} (${res.moved} dirs moved, ${res.frontmatterRewrites} messages rewritten${res.warnings?.length ? `, ${res.warnings.length} warnings` : ''})`);
        if (res.warnings?.length) for (const w of res.warnings) console.warn(`[yeaft] workdir migration: ${w}`);
      }
    } catch (err) {
      console.warn(`[yeaft] workdir session migration failed for ${workYeaftDir} (continuing): ${err?.message || err}`);
    }
  }
}

// ─── Bundled skills seeding ───────────────────────────────

/**
 * Filename inside the user skills directory that tracks which files we
 * previously installed from the bundled package, keyed by their sha256.
 * On re-seed, files whose CURRENT on-disk content matches a manifest entry
 * are considered "still bundled" and can be safely overwritten if the
 * bundled version has changed. Files whose sha doesn't match the manifest
 * are treated as user-modified and left alone — Claude Code uses the same
 * "user edits win" rule.
 */
const SEED_MANIFEST_FILE = '.bundled-manifest.json';

/**
 * sha256 of a string, hex encoded.
 * @param {string} content
 * @returns {string}
 */
function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Recursively walk a directory and yield relative file paths.
 * @param {string} root
 * @param {string} [sub]
 * @returns {string[]}
 */
function walkFiles(root, sub = '') {
  const dir = sub ? join(root, sub) : root;
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const rel = sub ? join(sub, entry.name) : entry.name;
    if (entry.isFile()) {
      out.push(rel);
    } else if (entry.isDirectory()) {
      out.push(...walkFiles(root, rel));
    }
  }
  return out;
}

/**
 * Read a tiny JSON file and return parsed value, or `{}` on missing/broken.
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function readManifest(filePath) {
  try {
    if (!existsSync(filePath)) return {};
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Seed bundled `yeaft-skills` into a user skills directory.
 *
 * Behavior (Claude-Code style):
 *   - Every file under the bundled dir is mirrored to the user dir at the
 *     same relative path.
 *   - If target doesn't exist → copy verbatim, record sha in manifest.
 *   - If target exists AND its current sha matches the manifest entry → the
 *     file is "still the version we installed", so overwrite with the new
 *     bundled version (= picks up a bundled upgrade) and refresh the sha.
 *   - If target exists AND its sha differs from manifest → the user edited
 *     it. Leave it alone. Do NOT touch the manifest (so future runs still
 *     see the divergence).
 *   - Manifest is per-relative-path → sha256 of the BUNDLED version we last
 *     installed at that path.
 *
 * Re-runs are idempotent: stable state on disk + manifest produces no
 * writes on the second pass.
 *
 * @param {string} userSkillsDir — absolute path to user-tier skills dir (e.g. ~/.yeaft/skills)
 * @param {string[]} warnings    — array to push warnings into
 * @returns {{ copied: number, updated: number, preserved: number, skipped: number }}
 */
export function seedBundledSkills(userSkillsDir, warnings = []) {
  const bundled = bundledYeaftSkillsDir();
  if (!bundled) {
    return { copied: 0, updated: 0, preserved: 0, skipped: 0 };
  }

  // Ensure user dir exists (no-op if already there from SUBDIRS).
  if (!existsSync(userSkillsDir)) {
    if (!safeMkdir(userSkillsDir, warnings)) {
      return { copied: 0, updated: 0, preserved: 0, skipped: 0 };
    }
  }

  const manifestPath = join(userSkillsDir, SEED_MANIFEST_FILE);
  const manifest = readManifest(manifestPath);
  const nextManifest = { ...manifest };

  let copied = 0;
  let updated = 0;
  let preserved = 0;
  let skipped = 0;

  const files = walkFiles(bundled);
  for (const rel of files) {
    const sourcePath = join(bundled, rel);
    const targetPath = join(userSkillsDir, rel);

    let bundledContent;
    try {
      bundledContent = readFileSync(sourcePath, 'utf8');
    } catch (err) {
      warnings.push(`Cannot read bundled skill ${rel}: ${err.message}`);
      skipped += 1;
      continue;
    }
    const bundledSha = sha256(bundledContent);

    if (!existsSync(targetPath)) {
      // First-time install — copy.
      if (!safeMkdir(dirname(targetPath), warnings)) {
        skipped += 1;
        continue;
      }
      safeWriteFile(targetPath, bundledContent, warnings);
      if (existsSync(targetPath)) {
        nextManifest[rel] = bundledSha;
        copied += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    // Target exists. Read it, sha it, decide.
    let currentContent;
    try {
      currentContent = readFileSync(targetPath, 'utf8');
    } catch (err) {
      warnings.push(`Cannot read existing skill ${rel}: ${err.message}`);
      skipped += 1;
      continue;
    }
    const currentSha = sha256(currentContent);

    if (currentSha === bundledSha) {
      // Already up to date — no write, but make sure the manifest knows.
      nextManifest[rel] = bundledSha;
      continue;
    }

    const manifestSha = manifest[rel];
    if (manifestSha && manifestSha === currentSha) {
      // The on-disk file is the version WE installed; user hasn't touched
      // it. The bundled version has changed (we passed the previous
      // currentSha === bundledSha check), so apply the upgrade.
      safeWriteFile(targetPath, bundledContent, warnings);
      nextManifest[rel] = bundledSha;
      updated += 1;
      continue;
    }

    // Either: (a) no manifest entry (= file pre-existed before we tracked
    // it) or (b) manifest sha doesn't match current sha (= user edited).
    // Either way the file is user-owned now — leave it alone, don't
    // overwrite, don't touch the manifest (so divergence stays visible).
    preserved += 1;
  }

  // Write manifest only if it actually changed (avoids needless disk
  // writes when nothing new happened).
  const manifestChanged = JSON.stringify(manifest) !== JSON.stringify(nextManifest);
  if (manifestChanged) {
    safeWriteFile(manifestPath, JSON.stringify(nextManifest, null, 2) + '\n', warnings);
  }

  return { copied, updated, preserved, skipped };
}
