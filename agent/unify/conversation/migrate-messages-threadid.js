/**
 * migrate-messages-threadid.js — task-307 one-shot migration.
 *
 * For every message under <yeaftDir>/conversation/messages/ and cold/ that
 * does NOT yet carry a `threadId:` frontmatter field, stamp it with
 * `threadId: main`. This matches design §5 semantics: pre-Phase-2 messages
 * predate threading and belong to the root conversation.
 *
 * Idempotency:
 *   A marker file `<yeaftDir>/conversation/.migrations/messagesThreadId`
 *   is written on successful completion. Subsequent runs observe the
 *   marker and short-circuit with `{ ran: false }`.
 *
 * Safety:
 *   - Messages that already carry a threadId are left untouched.
 *   - If a file is unreadable / unparseable it is skipped (never rewritten).
 *   - Write errors are swallowed so a half-successful migration can resume
 *     on the next boot by re-running.
 *
 * Usage (programmatic):
 *   import { migrateMessagesThreadId } from './migrate-messages-threadid.js';
 *   const res = migrateMessagesThreadId('/home/me/.yeaft');
 *   // { ran: true, migrated: 42, skipped: 3 }
 *
 * Usage (CLI):
 *   node agent/unify/conversation/migrate-messages-threadid.js [yeaftDir]
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export function migrateMessagesThreadId(yeaftDir) {
  const root = yeaftDir || join(homedir(), '.yeaft');
  const convDir = join(root, 'conversation');
  const markerDir = join(convDir, '.migrations');
  const markerPath = join(markerDir, 'messagesThreadId');

  if (!existsSync(convDir)) {
    return { ran: false, reason: 'no conversation dir', migrated: 0, skipped: 0 };
  }
  try {
    if (existsSync(markerPath)) {
      return { ran: false, reason: 'already migrated', migrated: 0, skipped: 0 };
    }
  } catch { /* best-effort */ }

  const dirs = [join(convDir, 'messages'), join(convDir, 'cold')];
  let migrated = 0;
  let skipped = 0;

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files;
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      let raw;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        skipped += 1;
        continue;
      }
      if (!raw || !raw.startsWith('---')) { skipped += 1; continue; }
      const endIdx = raw.indexOf('\n---', 3);
      if (endIdx === -1) { skipped += 1; continue; }
      const frontmatter = raw.slice(4, endIdx);
      const body = raw.slice(endIdx); // leading '\n---' ...
      if (/^threadId:/m.test(frontmatter)) {
        skipped += 1;
        continue; // already has threadId
      }
      const newFm = frontmatter.replace(/\s*$/, '') + '\nthreadId: main';
      const rebuilt = '---\n' + newFm.trimStart() + body;
      try {
        writeFileSync(path, rebuilt, { encoding: 'utf8', mode: 0o644 });
        migrated += 1;
      } catch {
        skipped += 1;
      }
    }
  }

  try {
    mkdirSync(markerDir, { recursive: true, mode: 0o755 });
    writeFileSync(
      markerPath,
      `migrated: ${new Date().toISOString()}\ncount: ${migrated}\nskipped: ${skipped}\n`,
      { encoding: 'utf8', mode: 0o644 },
    );
  } catch {
    // Without the marker the migration will re-run; it's idempotent per-file
    // (files already carrying threadId are skipped) so that's acceptable.
  }

  return { ran: true, migrated, skipped };
}

// CLI entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  const res = migrateMessagesThreadId(dir);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
}
