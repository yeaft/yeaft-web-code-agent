/**
 * detect.js — Scan a legacy Yeaft directory to determine migration scope.
 *
 * Spec: .crew/context/task-334i-migration-spec.md §M1
 *
 * Returns a report describing which generations of the old layout are
 * present, whether the new tree already exists, and which files the
 * migration will touch.
 *
 *   const report = detect(yeaftDir);
 *   // {
 *   //   yeaftDir, empty,
 *   //   hasGen1, hasGen2, hasNewTree,
 *   //   paths: {
 *   //     messages: [...],
 *   //     cold: [...],
 *   //     memoryEntries: [...],
 *   //     threads: [...],
 *   //     taskDirs: [{ id, dir, meta, coordinator }],
 *   //     userPreferences: string | null,
 *   //     memoryAggregate: string | null,
 *   //     scopes: string | null,
 *   //   },
 *   //   counts: { messages, cold, memoryEntries, threads, tasks },
 *   // }
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const MESSAGE_RE = /^m\d+\.md$/;
const CONV_META_RE = /^conv-\d+\.md$/;
const TASK_DIR_RE = /^task-[A-Za-z0-9_\-]+$/;

function safeListDir(dir) {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scan yeaftDir and return the migration report.
 */
export function detect(yeaftDir) {
  const paths = {
    messages: [],
    cold: [],
    memoryEntries: [],
    threads: [],
    taskDirs: [],
    userPreferences: null,
    memoryAggregate: null,
    scopes: null,
    conversationIndex: null,
    conversationCompact: null,
    threadsIndex: null,
    tasksIndex: null,
    tasksPlan: null,
  };

  // ─── Gen-1: conversation/ ────────────────────────────
  const convMessagesDir = join(yeaftDir, 'conversation', 'messages');
  for (const name of safeListDir(convMessagesDir)) {
    if (MESSAGE_RE.test(name)) {
      paths.messages.push(join(convMessagesDir, name));
    }
    // conv-NNNN.md are meta files we ignore (spec §M1.1 comment: "首行 md，不是消息")
  }
  paths.messages.sort();

  const convColdDir = join(yeaftDir, 'conversation', 'cold');
  for (const name of safeListDir(convColdDir)) {
    if (MESSAGE_RE.test(name)) paths.cold.push(join(convColdDir, name));
  }
  paths.cold.sort();

  const convIndex = join(yeaftDir, 'conversation', 'index.md');
  if (isFile(convIndex)) paths.conversationIndex = convIndex;
  const convCompact = join(yeaftDir, 'conversation', 'compact.md');
  if (isFile(convCompact)) paths.conversationCompact = convCompact;

  // ─── Gen-1: memory/ ────────────────────────────
  const memEntriesDir = join(yeaftDir, 'memory', 'entries');
  for (const name of safeListDir(memEntriesDir)) {
    if (name.endsWith('.md')) paths.memoryEntries.push(join(memEntriesDir, name));
  }
  paths.memoryEntries.sort();

  const memAggregate = join(yeaftDir, 'memory', 'MEMORY.md');
  if (isFile(memAggregate)) paths.memoryAggregate = memAggregate;
  const userPrefs = join(yeaftDir, 'memory', 'user-preferences.md');
  if (isFile(userPrefs)) paths.userPreferences = userPrefs;
  const scopes = join(yeaftDir, 'memory', 'scopes.md');
  if (isFile(scopes)) paths.scopes = scopes;

  // ─── Gen-2: threads/ ────────────────────────────
  const threadsDir = join(yeaftDir, 'threads');
  for (const name of safeListDir(threadsDir)) {
    if (name === 'index.md') {
      paths.threadsIndex = join(threadsDir, name);
      continue;
    }
    if (name.endsWith('.md')) paths.threads.push(join(threadsDir, name));
  }
  paths.threads.sort();

  // ─── tasks/ (shared Gen-1/2) ────────────────────────────
  const tasksDir = join(yeaftDir, 'tasks');
  for (const name of safeListDir(tasksDir)) {
    const full = join(tasksDir, name);
    if (name === 'index.md' && isFile(full)) { paths.tasksIndex = full; continue; }
    if (name === 'plan.md' && isFile(full)) { paths.tasksPlan = full; continue; }
    if (!TASK_DIR_RE.test(name) || !isDir(full)) continue;
    const meta = join(full, 'meta.md');
    const coordinator = join(full, 'coordinator.md');
    paths.taskDirs.push({
      id: name.replace(/^task-/, ''),
      dir: full,
      meta: isFile(meta) ? meta : null,
      coordinator: isFile(coordinator) ? coordinator : null,
    });
  }
  paths.taskDirs.sort((a, b) => a.id.localeCompare(b.id));

  const hasGen1 = paths.messages.length > 0 || paths.memoryEntries.length > 0;
  const hasGen2 = paths.threads.length > 0 || paths.threadsIndex !== null;

  // ─── New tree already present? ────────────────────────────
  const hasNewTree =
    isDir(join(yeaftDir, 'groups')) ||
    isDir(join(yeaftDir, 'virtual-persons')) ||
    isDir(join(yeaftDir, 'user', 'memory'));

  const counts = {
    messages: paths.messages.length,
    cold: paths.cold.length,
    memoryEntries: paths.memoryEntries.length,
    threads: paths.threads.length,
    tasks: paths.taskDirs.length,
  };

  const empty =
    !hasGen1 && !hasGen2 && !hasNewTree &&
    paths.taskDirs.length === 0 &&
    !paths.conversationIndex && !paths.conversationCompact &&
    !paths.memoryAggregate && !paths.userPreferences;

  return {
    yeaftDir,
    empty,
    hasGen1,
    hasGen2,
    hasNewTree,
    paths,
    counts,
  };
}
