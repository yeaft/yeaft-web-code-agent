#!/usr/bin/env node
/**
 * migrate/project-sessions-to-user.js — copy workDir-backed Yeaft Sessions into
 * the agent-local user Yeaft directory so normal startup discovers them from
 * `<userYeaftDir>/sessions/` without depending on the workDir registry.
 *
 * Usage:
 *   node agent/yeaft/migrate/project-sessions-to-user.js <projectDir> [userYeaftDir]
 *   node agent/yeaft/migrate/project-sessions-to-user.js --dry-run <projectDir>
 *   node agent/yeaft/migrate/project-sessions-to-user.js --overwrite <projectDir>
 *
 * Default userYeaftDir is `~/.yeaft`.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  loadSessionMeta,
} from '../sessions/session-store.js';
import {
  normalizeWorkDir,
  scanWorkdirSessions,
  sessionsRoot,
  unregisterSessionWorkDir,
  yeaftDirForWorkDir,
} from '../sessions/session-crud.js';

/**
 * @typedef {Object} MigrationOptions
 * @property {boolean} [dryRun]
 * @property {boolean} [overwrite]
 * @property {boolean} [deleteSource]
 */

/**
 * Copy every readable Session under `<projectDir>/.yeaft/sessions/` into
 * `<userYeaftDir>/sessions/` and copy matching memory scopes. Existing
 * destination Sessions are skipped unless `overwrite` is true.
 *
 * We deliberately unregister migrated Session ids from the legacy workDir
 * registry after a successful copy. Otherwise startup would still prefer the
 * project-backed copy over the newly local copy.
 *
 * @param {string} projectDir
 * @param {string} [userYeaftDir]
 * @param {MigrationOptions} [options]
 * @returns {{ok:boolean, projectDir:string, userYeaftDir:string, scanned:number, copied:number, skipped:number, overwritten:number, removedSources:number, sessions:Array<object>, warnings:string[]}}
 */
export function migrateProjectSessionsToUser(projectDir, userYeaftDir = join(homedir(), '.yeaft'), options = {}) {
  const normalizedProjectDir = normalizeWorkDir(projectDir);
  const normalizedUserYeaftDir = normalizeWorkDir(userYeaftDir || join(homedir(), '.yeaft'));
  const dryRun = !!options.dryRun;
  const overwrite = !!options.overwrite;
  const deleteSource = !!options.deleteSource;
  const warnings = [];
  const sessions = [];

  if (!normalizedProjectDir) {
    throw new Error('projectDir required');
  }
  if (!normalizedUserYeaftDir) {
    throw new Error('userYeaftDir required');
  }

  const projectYeaftDir = yeaftDirForWorkDir(normalizedProjectDir);
  const projectSessionsRoot = sessionsRoot(projectYeaftDir);
  const userSessionsRoot = sessionsRoot(normalizedUserYeaftDir);
  const found = scanWorkdirSessions(normalizedProjectDir);

  let copied = 0;
  let skipped = 0;
  let overwritten = 0;
  let removedSources = 0;

  if (!dryRun) {
    mkdirSync(userSessionsRoot, { recursive: true });
  }

  for (const meta of found) {
    const sessionId = meta.id;
    const sourceDir = join(projectSessionsRoot, sessionId);
    const destDir = join(userSessionsRoot, sessionId);
    const row = {
      id: sessionId,
      name: meta.name || sessionId,
      sourceDir,
      destDir,
      status: 'pending',
    };

    if (!existsSync(sourceDir) || !loadSessionMeta(sourceDir)) {
      row.status = 'skipped';
      row.reason = 'source_missing_or_corrupt';
      skipped += 1;
      sessions.push(row);
      continue;
    }

    if (existsSync(destDir)) {
      if (!overwrite) {
        row.status = 'skipped';
        row.reason = 'destination_exists';
        skipped += 1;
        sessions.push(row);
        continue;
      }
      if (!dryRun) rmSync(destDir, { recursive: true, force: true });
      overwritten += 1;
      row.overwritten = true;
    }

    if (!dryRun) {
      cpSync(sourceDir, destDir, { recursive: true, errorOnExist: false });
      copySessionMemory(projectYeaftDir, normalizedUserYeaftDir, sessionId, { overwrite, dryRun, warnings });
      unregisterSessionWorkDir(normalizedUserYeaftDir, sessionId);
      markMigrated(destDir, normalizedProjectDir);
      if (deleteSource) {
        rmSync(sourceDir, { recursive: true, force: true });
        removeSessionMemory(projectYeaftDir, sessionId, warnings);
        removedSources += 1;
      }
    }

    row.status = dryRun ? 'would_copy' : 'copied';
    copied += 1;
    sessions.push(row);
  }

  return {
    ok: true,
    projectDir: normalizedProjectDir,
    userYeaftDir: normalizedUserYeaftDir,
    scanned: found.length,
    copied,
    skipped,
    overwritten,
    removedSources,
    sessions,
    warnings,
  };
}

function copySessionMemory(projectYeaftDir, userYeaftDir, sessionId, { overwrite, dryRun, warnings }) {
  const pairs = [
    [join(projectYeaftDir, 'memory', 'session', sessionId), join(userYeaftDir, 'memory', 'session', sessionId)],
    [join(projectYeaftDir, 'memory', 'sessions', sessionId), join(userYeaftDir, 'memory', 'sessions', sessionId)],
  ];
  for (const [src, dst] of pairs) {
    if (!existsSync(src)) continue;
    if (existsSync(dst)) {
      if (!overwrite) {
        warnings.push(`memory destination exists; skipping ${dst}`);
        continue;
      }
      if (!dryRun) rmSync(dst, { recursive: true, force: true });
    }
    if (!dryRun) {
      mkdirSync(join(dst, '..'), { recursive: true });
      cpSync(src, dst, { recursive: true, errorOnExist: false });
    }
  }
}

function removeSessionMemory(projectYeaftDir, sessionId, warnings) {
  for (const dir of [
    join(projectYeaftDir, 'memory', 'session', sessionId),
    join(projectYeaftDir, 'memory', 'sessions', sessionId),
  ]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      warnings.push(`failed to remove source memory ${dir}: ${err?.message || err}`);
    }
  }
}

function markMigrated(destDir, projectDir) {
  const markerDir = join(destDir, '.migrations');
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(
    join(markerDir, 'project-sessions-to-user.json'),
    `${JSON.stringify({ migratedAt: new Date().toISOString(), sourceProjectDir: projectDir }, null, 2)}\n`,
  );
}

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const options = { dryRun: false, overwrite: false, deleteSource: false };
  const positional = [];
  for (const arg of args) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--overwrite') options.overwrite = true;
    else if (arg === '--delete-source') options.deleteSource = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else positional.push(arg);
  }
  return { options, positional };
}

function printUsage() {
  console.log('Usage: node agent/yeaft/migrate/project-sessions-to-user.js [--dry-run] [--overwrite] [--delete-source] <projectDir> [userYeaftDir]');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { options, positional } = parseCliArgs(process.argv);
  if (options.help || positional.length < 1) {
    printUsage();
    process.exitCode = options.help ? 0 : 1;
  } else {
    try {
      const result = migrateProjectSessionsToUser(positional[0], positional[1], options);
      console.log(JSON.stringify(result, null, 2));
      if (result.scanned === 0) process.exitCode = 2;
    } catch (err) {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    }
  }
}
