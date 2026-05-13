#!/usr/bin/env node
/**
 * yeaft-stats — CLI entry for tool-call usage statistics.
 *
 * Reads `~/.yeaft/stats/tool-usage.json` and renders a table (default),
 * lists tools that have never been called (`--unused`), or dumps raw
 * JSON (`--json`).
 *
 * Usage:
 *   yeaft-stats               # ranked table by call count (desc)
 *   yeaft-stats --unused      # tools registered but never called
 *   yeaft-stats --json        # raw snapshot (pipe-friendly)
 *   yeaft-stats --reset       # delete the stats file
 *   yeaft-stats --yeaft-dir=/path
 *   yeaft-stats --help
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { ToolUsageStats } from '../unify/stats/tool-usage.js';
import { allTools } from '../unify/tools/index.js';
import { formatMs, formatPct, formatLastCalled } from '../unify/stats/format.js';

function parseArgs(argv) {
  const opts = {
    unused: false,
    json: false,
    reset: false,
    yeaftDir: null,
    help: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--unused') opts.unused = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--reset') opts.reset = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--yeaft-dir=')) opts.yeaftDir = arg.slice('--yeaft-dir='.length);
  }
  return opts;
}

function printHelp() {
  console.log(`yeaft-stats — tool-call usage statistics

Usage:
  yeaft-stats               Ranked table by call count (desc)
  yeaft-stats --unused      Tools registered but never called
  yeaft-stats --json        Raw JSON snapshot (pipe-friendly)
  yeaft-stats --reset       Delete the stats file
  yeaft-stats --yeaft-dir=/path
  yeaft-stats --help        Show this message`);
}

function padRight(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function padLeft(s, n) {
  const str = String(s);
  return str.length >= n ? str : ' '.repeat(n - str.length) + str;
}

function printTable(snapshot) {
  const entries = Object.entries(snapshot)
    .sort((a, b) => b[1].callCount - a[1].callCount);
  if (entries.length === 0) {
    console.log('(no tool calls recorded yet)');
    return;
  }
  const cols = [
    { key: 'name', label: 'name', width: 28, align: 'l' },
    { key: 'calls', label: 'calls', width: 7, align: 'r' },
    { key: 'errors', label: 'errors', width: 7, align: 'r' },
    { key: 'errRate', label: 'err%', width: 6, align: 'r' },
    { key: 'p50', label: 'p50', width: 8, align: 'r' },
    { key: 'p95', label: 'p95', width: 8, align: 'r' },
    { key: 'avg', label: 'avg', width: 8, align: 'r' },
    { key: 'last', label: 'last', width: 12, align: 'l' },
  ];
  const header = cols.map(c => (c.align === 'r' ? padLeft(c.label, c.width) : padRight(c.label, c.width))).join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const [name, rec] of entries) {
    const row = [
      padRight(name.slice(0, cols[0].width), cols[0].width),
      padLeft(rec.callCount, cols[1].width),
      padLeft(rec.errorCount, cols[2].width),
      padLeft(formatPct(rec.errorRate), cols[3].width),
      padLeft(formatMs(rec.p50Ms), cols[4].width),
      padLeft(formatMs(rec.p95Ms), cols[5].width),
      padLeft(formatMs(rec.avgMs), cols[6].width),
      padRight(formatLastCalled(rec.lastCalledAt), cols[7].width),
    ].join('  ');
    console.log(row);
  }
}

async function getRegisteredToolNames() {
  // Pull names directly from the static `allTools` export. MCP/skill
  // dynamic tools aren't covered here — the unused list only flags
  // built-in tools that have a definition in the source tree.
  try {
    if (Array.isArray(allTools)) {
      return allTools
        .filter(t => t && typeof t.name === 'string' && t.name)
        .map(t => t.name);
    }
  } catch {
    // fall through
  }
  return [];
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const yeaftDir = opts.yeaftDir || join(homedir(), '.yeaft');
  const statsPath = join(yeaftDir, 'stats', 'tool-usage.json');
  const stats = new ToolUsageStats({ path: statsPath });

  if (opts.reset) {
    await stats.reset();
    console.log(`reset: ${statsPath}`);
    process.exit(0);
  }

  stats.loadSync();
  const snapshot = stats.snapshot();

  if (opts.json) {
    console.log(JSON.stringify({ path: statsPath, tools: snapshot }, null, 2));
    process.exit(0);
  }

  if (opts.unused) {
    const registered = await getRegisteredToolNames();
    if (registered.length === 0) {
      console.error('(could not enumerate registered tools — pass --json for raw stats)');
      process.exit(1);
    }
    const unused = stats.getRegisteredButUncalled(registered);
    console.log(`Registered: ${registered.length}   Called at least once: ${registered.length - unused.length}   Unused: ${unused.length}`);
    console.log('-'.repeat(60));
    if (unused.length === 0) {
      console.log('(every registered tool has been called at least once)');
    } else {
      for (const name of unused) console.log(name);
    }
    process.exit(0);
  }

  console.log(`stats: ${statsPath}`);
  console.log('');
  printTable(snapshot);
}

main().catch(err => {
  console.error(`yeaft-stats failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
