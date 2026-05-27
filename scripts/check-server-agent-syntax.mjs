#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)));
const roots = ['server', 'agent'];
const ignoredDirs = new Set(['node_modules', 'coverage', 'dist', '.git']);

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ignoredDirs.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(fullPath);
    }
  }
  return out;
}

const files = roots.flatMap((root) => collectJsFiles(join(repoRoot, root))).sort();
const failures = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error) {
    const rel = relative(repoRoot, file);
    const stderr = error.stderr || error.message || String(error);
    failures.push({ file: rel, stderr });
  }
}

if (failures.length > 0) {
  console.error(`server/agent syntax check failed for ${failures.length} file(s):`);
  for (const failure of failures) {
    console.error(`\n--- ${failure.file} ---`);
    console.error(failure.stderr.trim());
  }
  process.exit(1);
}

console.log(`Checked ${files.length} server/agent JavaScript modules with node --check.`);

// Guard against accidental empty coverage if paths move.
for (const root of roots) {
  const rootPath = join(repoRoot, root);
  if (!statSync(rootPath).isDirectory()) {
    console.error(`Expected ${root}/ directory to exist.`);
    process.exit(1);
  }
}
