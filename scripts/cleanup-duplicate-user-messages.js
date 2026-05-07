#!/usr/bin/env node
/**
 * scripts/cleanup-duplicate-user-messages.js
 *
 * One-time cleanup for the multi-VP fan-out user-row duplication bug
 * (PR-fix-unify-group-history-dedup).
 *
 * What was wrong:
 *   When a user prompt fanned out to N VPs in a group, each VP's Engine
 *   independently called `runStopHooks` and persisted its own copy of
 *   the user message — producing N identical user-role .md files for a
 *   single prompt. On reload, history replay rendered the user prompt N
 *   times, with one VP's reply between two copies (it looked like
 *   "messages out of order").
 *
 * What this script does:
 *   Scans `~/.yeaft/conversation/messages/` (and optionally `cold/`),
 *   detects clusters of consecutive `role: user` records with identical
 *   `(content, groupId)` and timestamps within a short window (default
 *   30 s — the realistic upper bound on a single coordinator-ingest fan-
 *   out turn), and DELETES all but the EARLIEST in each cluster.
 *
 * Sequence-id integrity:
 *   The store's `#getNextSeq` scans the hot+cold dirs and picks the next
 *   id. Removing a few mNNNN.md files leaves gaps in the id space; this
 *   is harmless. The store does NOT re-mint ids and does NOT depend on
 *   contiguity. We sort by FILENAME (= chronological), not by id math,
 *   so gaps don't reorder anything.
 *
 * Safety:
 *   - DRY-RUN by default. Pass `--apply` to actually delete files.
 *   - Per-file backup written to `<msgDir>/.dedup-backup/` before deletion
 *     when `--apply` is used. Re-runnable.
 *   - Will NEVER delete a non-user record. Will NEVER delete the EARLIEST
 *     copy in a cluster (the canonical row).
 *   - Refuses to run on a directory it can't recognize (must contain
 *     `mNNNN.md` files matching the schema in agent/unify/conversation/persist.js).
 *
 * Usage:
 *   node scripts/cleanup-duplicate-user-messages.js               # dry-run, default ~/.yeaft
 *   node scripts/cleanup-duplicate-user-messages.js --apply       # actually delete
 *   node scripts/cleanup-duplicate-user-messages.js --dir /path/to/.yeaft
 *   node scripts/cleanup-duplicate-user-messages.js --window-ms 60000   # widen window
 *   node scripts/cleanup-duplicate-user-messages.js --include-cold      # also scan cold/
 *   node scripts/cleanup-duplicate-user-messages.js --verbose
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  copyFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { parseMessage } from '../agent/unify/conversation/persist.js';

// ─── CLI parsing ───────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    dir: join(homedir(), '.yeaft'),
    apply: false,
    windowMs: 30_000,
    includeCold: false,
    verbose: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--include-cold') args.includeCold = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dir') {
      if (i + 1 >= argv.length) {
        console.error('error: --dir requires a path');
        process.exit(2);
      }
      args.dir = argv[++i];
    }
    else if (a === '--window-ms') {
      if (i + 1 >= argv.length) {
        console.error('error: --window-ms requires a number');
        process.exit(2);
      }
      const v = parseInt(argv[++i], 10);
      if (!Number.isFinite(v) || v < 0) {
        console.error('error: --window-ms must be a non-negative integer');
        process.exit(2);
      }
      args.windowMs = v;
    }
    else {
      console.error(`Unknown arg: ${a}`);
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
cleanup-duplicate-user-messages.js — remove duplicate user .md rows from
multi-VP fan-out turns.

Options:
  --apply           actually delete (default: dry-run)
  --dir <path>      yeaft root (default: ~/.yeaft)
  --window-ms <n>   cluster window in ms (default: 30000)
  --include-cold    also scan conversation/cold/
  --verbose         per-cluster details
  --help            this message
`);
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Load every parseable mNNNN.md file from a dir, sorted by filename
 * (equals chronological order via mNNNN sequencing).
 */
function loadDir(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter(f => /^m\d{4,}\.md$/.test(f))
    .sort();
  const out = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const raw = readFileSync(path, 'utf8');
      const msg = parseMessage(raw);
      if (!msg) continue;
      out.push({ msg, path, filename: f });
    } catch {
      // Skip unreadable / corrupt files (don't touch them).
    }
  }
  return out;
}

/**
 * Group consecutive duplicate user rows.
 *
 * "Duplicate" = same (role:'user', content, groupId-or-undef) AND time
 * within `windowMs` of the previous row in the cluster. Multi-VP fan-
 * out writes are within a few seconds of each other on the same machine;
 * 30 s is comfortable headroom without absorbing genuinely separate
 * prompts.
 *
 * Note: we do NOT require positional adjacency — between the user copies,
 * one VP's assistant + tool rows often land. So we walk linearly and key
 * the cluster by content+groupId+near-time, regardless of what other
 * roles sit between them.
 */
function findClusters(records, windowMs) {
  const clusters = [];
  // For each user row, find any later user rows that match by content +
  // groupId AND are within windowMs of it. Greedy single-pass.
  const consumed = new Set(); // indices already attached to a cluster
  for (let i = 0; i < records.length; i++) {
    if (consumed.has(i)) continue;
    const head = records[i];
    if (head.msg.role !== 'user') continue;
    const headTime = Date.parse(head.msg.time);
    if (Number.isNaN(headTime)) continue;

    const cluster = [head];
    consumed.add(i);

    for (let j = i + 1; j < records.length; j++) {
      if (consumed.has(j)) continue;
      const r = records[j];
      if (r.msg.role !== 'user') continue;
      if (r.msg.content !== head.msg.content) continue;
      // groupId match (treat undefined === undefined)
      if ((r.msg.groupId || null) !== (head.msg.groupId || null)) continue;
      const t = Date.parse(r.msg.time);
      if (Number.isNaN(t)) continue;
      if (Math.abs(t - headTime) > windowMs) continue;

      cluster.push(r);
      consumed.add(j);
    }

    if (cluster.length > 1) clusters.push(cluster);
  }
  return clusters;
}

// ─── Main ─────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const yeaftDir = args.dir;
  const msgDir = join(yeaftDir, 'conversation', 'messages');
  const coldDir = join(yeaftDir, 'conversation', 'cold');

  if (!existsSync(msgDir)) {
    console.error(`error: ${msgDir} does not exist — is --dir correct?`);
    process.exit(2);
  }

  console.log(`yeaft dir:   ${yeaftDir}`);
  console.log(`hot dir:     ${msgDir}`);
  if (args.includeCold) console.log(`cold dir:    ${coldDir}`);
  console.log(`mode:        ${args.apply ? 'APPLY (will delete)' : 'DRY-RUN (no changes)'}`);
  console.log(`window-ms:   ${args.windowMs}`);
  console.log('');

  // Scan
  const records = loadDir(msgDir);
  if (args.includeCold) records.push(...loadDir(coldDir));
  console.log(`scanned ${records.length} message files`);

  if (records.length === 0) {
    console.log('nothing to do.');
    return;
  }

  const clusters = findClusters(records, args.windowMs);
  if (clusters.length === 0) {
    console.log('no duplicate user-row clusters found.');
    return;
  }

  let totalDuplicates = 0;
  for (const cluster of clusters) totalDuplicates += cluster.length - 1;

  console.log(`found ${clusters.length} duplicate cluster(s), ${totalDuplicates} extra row(s) to remove`);
  console.log('');

  // Backup dir for the apply path.
  const backupDir = join(msgDir, '.dedup-backup');
  if (args.apply && !existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true, mode: 0o755 });
  }

  let deleted = 0;
  let backedUp = 0;
  for (const cluster of clusters) {
    // Sort by filename — keep the EARLIEST (smallest mNNNN), delete the rest.
    cluster.sort((a, b) => a.filename.localeCompare(b.filename));
    const keep = cluster[0];
    const dups = cluster.slice(1);

    if (args.verbose || !args.apply) {
      const head = keep.msg;
      const preview = (head.content || '').slice(0, 60).replace(/\n/g, ' ');
      console.log(
        `cluster: ${cluster.length} copies | groupId=${head.groupId || '-'} | time=${head.time} | "${preview}"`
      );
      console.log(`  keep:   ${keep.filename}`);
      for (const d of dups) console.log(`  remove: ${d.filename}`);
    }

    if (args.apply) {
      for (const d of dups) {
        try {
          // Backup first (idempotent overwrite).
          const backupPath = join(backupDir, d.filename);
          copyFileSync(d.path, backupPath);
          backedUp++;
        } catch (err) {
          console.error(`  WARN: backup failed for ${d.filename}: ${err.message} — skipping delete`);
          continue;
        }
        try {
          unlinkSync(d.path);
          deleted++;
        } catch (err) {
          console.error(`  WARN: delete failed for ${d.filename}: ${err.message}`);
        }
      }
    }
  }

  console.log('');
  if (args.apply) {
    console.log(`backed up: ${backedUp} -> ${backupDir}`);
    console.log(`deleted:   ${deleted}`);
  } else {
    console.log(`(dry-run) would remove ${totalDuplicates} duplicate row(s). Re-run with --apply to perform deletion.`);
  }
}

main();
