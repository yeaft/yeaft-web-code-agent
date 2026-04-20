#!/usr/bin/env node
/**
 * yeaft-migrate — CLI entry for task-334i legacy storage migration.
 *
 * Usage:
 *   yeaft-migrate --dry-run              # preview only (safe)
 *   yeaft-migrate                        # run for real
 *   yeaft-migrate --yeaft-dir=/path      # override ~/.yeaft
 *   yeaft-migrate --force                # clear .migration-state.json and re-run
 */

import { homedir } from 'os';
import { join } from 'path';
import { runMigration } from '../agent/unify/migration/v0-to-v1.js';

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, yeaftDir: null, help: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--yeaft-dir=')) opts.yeaftDir = arg.slice('--yeaft-dir='.length);
    else {
      console.error(`Unknown argument: ${arg}`);
      opts.help = true;
    }
  }
  return opts;
}

const HELP = `yeaft-migrate — migrate legacy ~/.yeaft/ layout to R6 group-chat tree.

  --dry-run, -n      Preview changes, do not write.
  --force            Clear migration state and re-run from scratch (DANGER).
  --yeaft-dir=DIR    Override the Yeaft data directory (default: ~/.yeaft).
  --help, -h         Show this help.

Safe to re-run: state marker (.migration-state.json) makes the process
idempotent. On failure the legacy tree is never touched; the new tree
is deleted and the next invocation retries.
`;

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const yeaftDir = opts.yeaftDir || process.env.YEAFT_DIR || join(homedir(), '.yeaft');
  if (opts.force && !opts.dryRun) {
    console.warn('[yeaft-migrate] --force will discard existing migration state.');
  }
  try {
    const result = await runMigration({
      yeaftDir,
      dryRun: opts.dryRun,
      force: opts.force,
      onStep: (step, info) => {
        console.log(`[${step}]`, JSON.stringify(info));
      },
    });
    console.log(`\nMigration ${result.status}`);
    if (result.dryRun) {
      console.log('Dry-run preview only. Re-run without --dry-run to apply.');
    }
    process.exit(0);
  } catch (err) {
    console.error('[yeaft-migrate] FAILED:', err && err.stack || err);
    console.error('New tree was rolled back. Legacy data is untouched. Investigate and re-run.');
    process.exit(1);
  }
}

main();
