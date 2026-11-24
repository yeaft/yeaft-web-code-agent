/**
 * workspace-folders.js — Bounded local workspace directory snapshot (<= 3 levels,
 * stop-at-project-root) for new-Session folder selection.
 *
 * Scans safe user/Agent roots up to `maxDepth` (default 3). Whenever a directory
 * already contains clear project markers (`.git`, `package.json`, `Cargo.toml`,
 * `pyproject.toml`, `go.mod`, `CLAUDE.md`, `AGENTS.md`, etc.), it is recorded as
 * a candidate workspace root and traversal stops descending into its children.
 *
 * Persisted once to `<yeaftDir>/workspace-folders.json` on startup when missing,
 * and refreshable on demand. Merged at query time with historical Session
 * `workDir` entries so recently used workspaces are always available and marked
 * `recent: true`.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { writeAtomic } from './storage/atomic.js';
import { snapshotSessions } from './sessions/session-crud.js';

export const WORKSPACE_FOLDERS_FILE = 'workspace-folders.json';
export const WORKSPACE_FOLDERS_VERSION = 1;
export const DEFAULT_MAX_FOLDER_DEPTH = 3;
const MAX_SCANNED_DIRS = 600;
const MAX_SNAPSHOT_FOLDERS = 120;
const MAX_LABEL_CHARS = 120;

const PROJECT_MARKERS = Object.freeze([
  '.git',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'CMakeLists.txt',
  'Makefile',
  'CLAUDE.md',
  'AGENTS.md',
]);

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.tox',
  '.cache',
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.cargo',
  '.rustup',
  '.gradle',
  '.m2',
  '.local',
  '.config',
  '.yeaft',
  '.claude',
  '.codex',
  '.ssh',
  '.gnupg',
  'Library',
  'Applications',
  'Pictures',
  'Music',
  'Movies',
  'Videos',
  'Public',
  'Templates',
  'Downloads',
  'Trash',
  '$Recycle.Bin',
  'AppData',
  'System Volume Information',
]);

function safeStatDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    const st = lstatSync(dirPath);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function normalizePath(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return '';
  try {
    return resolve(dirPath.trim());
  } catch {
    return '';
  }
}

function cleanLabel(text) {
  if (typeof text !== 'string') return '';
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return '';
  return line.length > MAX_LABEL_CHARS ? `${line.slice(0, MAX_LABEL_CHARS - 1)}…` : line;
}

function readPackageSummary(dirPath) {
  try {
    const pkgPath = join(dirPath, 'package.json');
    const st = lstatSync(pkgPath);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 128 * 1024) return '';
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const parts = [];
    if (typeof pkg?.name === 'string' && pkg.name.trim() && pkg.name.trim() !== basename(dirPath)) {
      parts.push(pkg.name.trim());
    }
    if (typeof pkg?.description === 'string' && pkg.description.trim()) {
      parts.push(pkg.description.trim());
    }
    return cleanLabel(parts.join(' — '));
  } catch {
    return '';
  }
}

function readReadmeHeading(dirPath, entryNames) {
  const readmeName = entryNames.find(name => /^readme(?:\.(?:md|txt|rst))?$/i.test(name));
  if (!readmeName) return '';
  try {
    const readmePath = join(dirPath, readmeName);
    const st = lstatSync(readmePath);
    if (!st.isFile() || st.isSymbolicLink() || st.size === 0) return '';
    const raw = readFileSync(readmePath, 'utf8').slice(0, 2048);
    for (const line of raw.split(/\r?\n/)) {
      const cleaned = line.replace(/^#+\s*/, '').trim();
      if (!cleaned || cleaned.startsWith('![') || cleaned.startsWith('[!') || cleaned.startsWith('<')) continue;
      return cleanLabel(cleaned);
    }
    return '';
  } catch {
    return '';
  }
}

function inspectDirectory(dirPath) {
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = new Set(entries.map(e => e.name));
  const markers = PROJECT_MARKERS.filter(marker => names.has(marker));
  const childDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    childDirs.push(entry.name);
  }
  childDirs.sort((a, b) => a.localeCompare(b));

  let label = '';
  if (markers.includes('package.json')) {
    label = readPackageSummary(dirPath);
  }
  if (!label && markers.length > 0) {
    label = readReadmeHeading(dirPath, [...names]);
  }
  return { markers, childDirs, label };
}

export function defaultWorkspaceScanRoots({ agentWorkDir = '', homeDir = homedir() } = {}) {
  const roots = [];
  const seen = new Set();
  const addRoot = (candidate) => {
    const norm = normalizePath(candidate);
    if (!norm || norm === '/' || /^[A-Za-z]:\\?$/.test(norm)) return;
    if (seen.has(norm) || !safeStatDirectory(norm)) return;
    seen.add(norm);
    roots.push(norm);
  };

  const normWork = normalizePath(agentWorkDir);
  const normHome = normalizePath(homeDir);
  if (normWork) {
    addRoot(normWork);
    // If the Agent started inside one project repo (e.g. ~/projects/yeaft), also
    // include its immediate parent container (~/projects) when it is not `/` or `$HOME`,
    // so sibling repositories on the same machine are discoverable.
    const parent = dirname(normWork);
    if (parent && parent !== normWork && parent !== normHome) {
      addRoot(parent);
    }
  }

  if (normHome && safeStatDirectory(normHome)) {
    // Common developer workspace containers under $HOME plus $HOME's own top-level
    // non-hidden project folders (bounded by maxDepth).
    for (const sub of ['projects', 'workspace', 'workspaces', 'repos', 'code', 'dev', 'src', 'git', 'work', 'Documents']) {
      addRoot(join(normHome, sub));
    }
    addRoot(normHome);
  }

  return roots;
}

/**
 * Scan workspace roots up to `maxDepth` (default 3) with stop-at-project-root.
 *
 * @param {object} [options]
 * @param {string[]} [options.roots]
 * @param {string} [options.agentWorkDir]
 * @param {string} [options.homeDir]
 * @param {number} [options.maxDepth=3]
 * @param {number} [options.maxFolders=120]
 * @returns {{ version: number, scannedAt: number, roots: string[], folders: Array<{ path: string, name: string, depth: number, markers: string[], label: string }> }}
 */
export function scanWorkspaceFolders({
  roots,
  agentWorkDir = '',
  homeDir = homedir(),
  maxDepth = DEFAULT_MAX_FOLDER_DEPTH,
  maxFolders = MAX_SNAPSHOT_FOLDERS,
} = {}) {
  const effectiveMaxDepth = Math.max(1, Math.min(3, Math.floor(Number(maxDepth) || DEFAULT_MAX_FOLDER_DEPTH)));
  const effectiveMaxFolders = Math.max(1, Math.min(300, Math.floor(Number(maxFolders) || MAX_SNAPSHOT_FOLDERS)));
  const scanRoots = Array.isArray(roots)
    ? roots.map(normalizePath).filter(p => p && safeStatDirectory(p))
    : defaultWorkspaceScanRoots({ agentWorkDir, homeDir });

  const normHome = normalizePath(homeDir);
  const found = new Map();
  const visited = new Set();
  let scannedCount = 0;

  const recordFolder = (dirPath, depth, info) => {
    if (found.has(dirPath) || found.size >= effectiveMaxFolders) return;
    found.set(dirPath, {
      path: dirPath,
      name: basename(dirPath) || dirPath,
      depth,
      markers: info.markers,
      ...(info.label ? { label: info.label } : {}),
    });
  };

  for (const rootPath of scanRoots) {
    const queue = [{ path: rootPath, depth: 0 }];
    while (queue.length > 0 && scannedCount < MAX_SCANNED_DIRS && found.size < effectiveMaxFolders) {
      const current = queue.shift();
      if (visited.has(current.path)) continue;
      if (!safeStatDirectory(current.path)) continue;
      visited.add(current.path);
      scannedCount += 1;

      const info = inspectDirectory(current.path);
      if (!info) continue;

      const isHomeRoot = normHome && current.path === normHome;
      // Stop-at-project-root: if a directory (other than $HOME itself) has explicit
      // project markers, capture it and do NOT descend into its source subdirectories.
      if (!isHomeRoot && info.markers.length > 0) {
        recordFolder(current.path, current.depth, info);
        continue;
      }

      // Also include explicit Agent workDir or leaf workspace folders that look
      // like active user directories when within depth <= 2, while descending up to maxDepth.
      if (!isHomeRoot && current.depth > 0 && info.childDirs.length === 0) {
        recordFolder(current.path, current.depth, info);
        continue;
      }

      if (current.depth >= effectiveMaxDepth) {
        if (!isHomeRoot) recordFolder(current.path, current.depth, info);
        continue;
      }

      // From $HOME itself, only descend 2 levels unless via dedicated workspace containers
      // already queued earlier, keeping noise minimal.
      const depthCeiling = isHomeRoot ? Math.min(effectiveMaxDepth, 2) : effectiveMaxDepth;
      if (current.depth >= depthCeiling) continue;

      for (const childName of info.childDirs) {
        queue.push({ path: join(current.path, childName), depth: current.depth + 1 });
      }
    }
  }

  // Always ensure an existing non-home agentWorkDir is present in the snapshot.
  const normWork = normalizePath(agentWorkDir);
  if (normWork && normWork !== normHome && safeStatDirectory(normWork) && !found.has(normWork)) {
    const info = inspectDirectory(normWork) || { markers: [], label: '' };
    found.set(normWork, {
      path: normWork,
      name: basename(normWork) || normWork,
      depth: 0,
      markers: info.markers,
      ...(info.label ? { label: info.label } : {}),
    });
  }

  return {
    version: WORKSPACE_FOLDERS_VERSION,
    scannedAt: Date.now(),
    roots: scanRoots,
    folders: [...found.values()],
  };
}

export function workspaceFoldersSnapshotPath(yeaftDir) {
  return join(yeaftDir, WORKSPACE_FOLDERS_FILE);
}

export function readWorkspaceFoldersSnapshot(yeaftDir) {
  if (!yeaftDir) return null;
  const filePath = workspaceFoldersSnapshotPath(yeaftDir);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || parsed.version !== WORKSPACE_FOLDERS_VERSION || !Array.isArray(parsed.folders)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Initialize or refresh `<yeaftDir>/workspace-folders.json`.
 * By default runs once when the snapshot file does not exist (`force: false`).
 */
export function ensureWorkspaceFoldersSnapshot(yeaftDir, {
  force = false,
  agentWorkDir = '',
  homeDir = homedir(),
  roots,
  maxDepth = DEFAULT_MAX_FOLDER_DEPTH,
} = {}) {
  if (!yeaftDir) return { scannedAt: null, folders: [] };
  if (!force) {
    const cached = readWorkspaceFoldersSnapshot(yeaftDir);
    if (cached) return cached;
  }
  const snapshot = scanWorkspaceFolders({ roots, agentWorkDir, homeDir, maxDepth });
  try {
    mkdirSync(yeaftDir, { recursive: true, mode: 0o700 });
    writeAtomic(workspaceFoldersSnapshotPath(yeaftDir), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn('[WorkspaceFolders] failed to persist workspace-folders.json:', err?.message || err);
  }
  return snapshot;
}

function lexicalScoreFolder(folder, queryTokens) {
  if (!queryTokens.length) return 0;
  const hay = `${folder.name || ''} ${folder.path || ''} ${folder.label || ''}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if ((folder.name || '').toLowerCase() === token) score += 10;
    else if ((folder.name || '').toLowerCase().includes(token)) score += 6;
    else if (hay.includes(token)) score += 2;
  }
  return score;
}

/**
 * Build a bounded candidate folder allowlist for `plan-new-session` Decision calls,
 * combining historical Session `workDir`s (`recent: true`), the Agent's default
 * `workDir`, and the persisted `<= 3` level workspace folder snapshot.
 */
export function selectCandidateWorkspaceFolders(yeaftDir, {
  query = '',
  agentWorkDir = '',
  allowedSessionIds = null,
  limit = 25,
} = {}) {
  const snapshot = ensureWorkspaceFoldersSnapshot(yeaftDir, { agentWorkDir });
  const byPath = new Map();

  for (const folder of snapshot.folders || []) {
    const norm = normalizePath(folder?.path);
    if (!norm || !safeStatDirectory(norm)) continue;
    byPath.set(norm, {
      path: norm,
      name: folder.name || basename(norm) || norm,
      markers: Array.isArray(folder.markers) ? folder.markers : [],
      ...(folder.label ? { label: folder.label } : {}),
      recent: false,
      recentRank: 0,
    });
  }

  // Merge historical Session workDirs authorized for this owner (when allowedSessionIds supplied).
  try {
    const allowedSet = Array.isArray(allowedSessionIds) ? new Set(allowedSessionIds) : null;
    const sessions = snapshotSessions(yeaftDir)
      .filter(meta => !allowedSet || allowedSet.has(meta.id));
    sessions.forEach((meta, idx) => {
      const norm = normalizePath(meta?.workDir);
      if (!norm || !safeStatDirectory(norm)) return;
      const existing = byPath.get(norm);
      const rankBoost = Math.max(1, sessions.length - idx);
      if (existing) {
        existing.recent = true;
        existing.recentRank = Math.max(existing.recentRank, rankBoost);
      } else {
        const info = inspectDirectory(norm) || { markers: [], label: '' };
        byPath.set(norm, {
          path: norm,
          name: basename(norm) || norm,
          markers: info.markers,
          ...(info.label ? { label: info.label } : {}),
          recent: true,
          recentRank: rankBoost,
        });
      }
    });
  } catch { /* best-effort session scan */ }

  const normAgentWork = normalizePath(agentWorkDir);
  if (normAgentWork && safeStatDirectory(normAgentWork) && !byPath.has(normAgentWork)) {
    const info = inspectDirectory(normAgentWork) || { markers: [], label: '' };
    byPath.set(normAgentWork, {
      path: normAgentWork,
      name: basename(normAgentWork) || normAgentWork,
      markers: info.markers,
      ...(info.label ? { label: info.label } : {}),
      recent: false,
      recentRank: 0,
    });
  }

  const queryTokens = [...new Set(
    String(query || '')
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]{2,}/gu) || [],
  )].slice(0, 16);

  const scored = [...byPath.values()].map(entry => ({
    entry,
    lexical: lexicalScoreFolder(entry, queryTokens),
    hasMarkers: entry.markers.length > 0 ? 1 : 0,
  }));

  scored.sort((a, b) => (
    b.lexical - a.lexical
    || (b.entry.recent ? 1 : 0) - (a.entry.recent ? 1 : 0)
    || b.entry.recentRank - a.entry.recentRank
    || b.hasMarkers - a.hasMarkers
    || a.entry.path.localeCompare(b.entry.path)
  ));

  const boundedLimit = Math.max(1, Math.min(30, Math.floor(Number(limit) || 25)));
  return scored.slice(0, boundedLimit).map(({ entry }) => ({
    path: entry.path,
    name: entry.name,
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.markers.length ? { markers: entry.markers } : {}),
    ...(entry.recent ? { recent: true } : {}),
  }));
}
