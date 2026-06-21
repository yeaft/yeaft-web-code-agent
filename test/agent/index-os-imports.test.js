import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Regression guard for the v1.0.25~v1.0.29 startup crash:
// commit d7329980 dropped `homedir` from `import { platform } from 'os'`
// in agent/index.js, but ensureYeaftSkills() still calls homedir(). The
// result was `ReferenceError: homedir is not defined` thrown on every boot,
// which sent the systemd service into a crash-restart loop. `node --check`
// can't catch it (valid syntax, runtime ReferenceError) and there's no
// eslint, so it shipped. This test statically asserts that every `os`
// function the file calls is actually imported from `os`.

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '../../agent/index.js');
const src = readFileSync(indexPath, 'utf-8');

/** Names pulled in via `import { ... } from 'os'` (handles `x as y` aliases). */
function osNamedImports(source) {
  const m = source.match(/import\s*\{([^}]*)\}\s*from\s*['"]os['"]/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/).pop().trim())
    .filter(Boolean);
}

// Curated set of `os` exports that are realistically called bare (named-import
// style) and are unlikely to collide with local identifiers. Extend as needed.
const OS_FUNCTIONS = [
  'homedir',
  'tmpdir',
  'hostname',
  'platform',
  'networkInterfaces',
  'userInfo',
  'cpus',
];

/** True if `fn(` is called as a bare identifier (not `os.fn(` or `.fn(`). */
function isCalledBare(source, fn) {
  return new RegExp(`(^|[^.\\w])${fn}\\s*\\(`, 'm').test(source);
}

describe('agent/index.js os imports', () => {
  const imported = osNamedImports(src);

  it('imports homedir from os (used by ensureYeaftSkills startup path)', () => {
    // Sanity: the symbol IS used — otherwise this guard is meaningless.
    expect(src).toMatch(/homedir\s*\(/);
    expect(imported).toContain('homedir');
  });

  it('imports every os function it calls (no startup ReferenceError)', () => {
    const missing = OS_FUNCTIONS.filter(
      (fn) => isCalledBare(src, fn) && !imported.includes(fn),
    );
    expect(missing).toEqual([]);
  });
});
