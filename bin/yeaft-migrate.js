#!/usr/bin/env node
/**
 * yeaft-migrate — CLI entry for Yeaft storage migrations.
 *
 * Targets:
 *   --target v1  (default, back-compat)  v0 → v1 general tree migration
 *   --target r6                          R5 → R6 memory-shard + conversation rotation
 *
 * Usage:
 *   yeaft-migrate --dry-run              # preview v0→v1 (safe)
 *   yeaft-migrate                        # run v0→v1 for real
 *   yeaft-migrate --target r6 --dry-run  # preview R5→R6
 *   yeaft-migrate --target r6            # run R5→R6
 *   yeaft-migrate --target r6 --rollback # restore .legacy/r6-state.tar.gz
 *   yeaft-migrate --yeaft-dir=/path      # override ~/.yeaft
 *   yeaft-migrate --force                # clear migration-state and re-run
 */

import { homedir } from 'os';
import { join } from 'path';
import { runMigration } from '../agent/unify/migration/v0-to-v1.js';
import {
  applyR5ToR6Migration,
  rollbackR5ToR6Migration,
} from '../agent/unify/memory/migrate-r5-to-r6.js';

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    force: false,
    rollback: false,
    yeaftDir: null,
    target: 'v1',
    help: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--rollback') opts.rollback = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--yeaft-dir=')) opts.yeaftDir = arg.slice('--yeaft-dir='.length);
    else if (arg.startsWith('--target=')) opts.target = arg.slice('--target='.length);
    else {
      console.error(`Unknown argument: ${arg}`);
      opts._unknownArg = true;
      opts.help = true;
    }
  }
  return opts;
}

const HELP = `yeaft-migrate — migrate Yeaft storage to newer layouts.

  --target=v1|r6     Which migration track to run (default: v1).
                       v1 = v0 → v1 general tree migration (shipped)
                       r6 = R5 → R6 memory shard + conversation rotation
  --dry-run, -n      Preview changes, do not write.
  --force            Clear migration state and re-run from scratch (DANGER).
  --rollback         Reverse the target migration (r6 only). Restores legacy
                       archive and clears R6 state. R5 archive is never touched.
  --yeaft-dir=DIR    Override the Yeaft data directory (default: ~/.yeaft).
  --help, -h         Show this help.

Safe to re-run: state markers make both tracks idempotent. On failure the
legacy tree is never touched; the new tree is deleted (v1 target) or the
run can be resumed next invocation (r6 target).

Examples:
  yeaft-migrate                          # v0 → v1 for real
  yeaft-migrate --dry-run                # preview v0 → v1
  yeaft-migrate --target r6 --dry-run    # preview R5 → R6
  yeaft-migrate --target r6              # apply R5 → R6
  yeaft-migrate --target r6 --rollback   # restore R5 state from archive
`;

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(opts._unknownArg ? 1 : 0);
  }
  if (opts.target !== 'v1' && opts.target !== 'r6') {
    console.error(`--target must be 'v1' or 'r6' (got '${opts.target}')`);
    process.exit(2);
  }
  if (opts.rollback && opts.target !== 'r6') {
    console.error('--rollback is only supported for --target=r6 in this release.');
    process.exit(2);
  }

  const yeaftDir = opts.yeaftDir || process.env.YEAFT_DIR || join(homedir(), '.yeaft');
  if (opts.force && !opts.dryRun) {
    console.warn('[yeaft-migrate] --force will discard existing migration state.');
  }

  const onStep = (step, info) => {
    console.log(`[${step}]`, JSON.stringify(info, null, 2));
  };

  try {
    if (opts.target === 'r6' && opts.rollback) {
      const result = await rollbackR5ToR6Migration({ yeaftDir, onStep });
      console.log(`\nRollback ${result.status}`);
      process.exit(0);
    }
    if (opts.target === 'r6') {
      const result = await applyR5ToR6Migration({
        yeaftDir,
        dryRun: opts.dryRun,
        force: opts.force,
        onStep,
      });
      console.log(`\nR5→R6 migration ${result.status}`);
      if (result.dryRun) {
        console.log('Dry-run preview only. Re-run without --dry-run to apply.');
      }
      process.exit(0);
    }

    // default target v1 — back-compat
    const result = await runMigration({
      yeaftDir,
      dryRun: opts.dryRun,
      force: opts.force,
      onStep,
    });
    console.log(`\nMigration ${result.status}`);
    if (result.dryRun) {
      console.log('Dry-run preview only. Re-run without --dry-run to apply.');
    }
    process.exit(0);
  } catch (err) {
    console.error('[yeaft-migrate] FAILED:', err && err.stack || err);
    console.error('Legacy data is untouched. Investigate state file and re-run.');
    process.exit(1);
  }
}

main();
