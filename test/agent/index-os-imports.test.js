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
//
// Scope/limits (read before trusting this as a general guard): this is a
// TEXTUAL scan of one file (agent/index.js), not a real import resolver.
// It only covers the curated OS_FUNCTIONS names below, only `import { ... }
// from 'os'|'node:os'` syntax (not `import * as os` / `require`), and it
// strips comments but not string literals. It is a targeted regression net
// for THIS bug, not a substitute for an eslint `no-undef` rule.

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '../../agent/index.js');
const src = readFileSync(indexPath, 'utf-8');

/**
 * Canonical `os` export names brought in via `import { ... } from 'os'`
 * (or `'node:os'`). For aliased imports (`homedir as hd`) this returns the
 * source name `homedir`, since that is the export we want to confirm is
 * imported. Only the first such import block is parsed (index.js has one).
 */
function osNamedImports(source) {
  const m = source.match(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?os['"]/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

// Curated set of `os` functions whose bare names are unambiguous. We do NOT
// enumerate Object.keys(os) on purpose: names like `type`/`release`/`version`/
// `arch` collide with ordinary identifiers and would cause false positives.
// CONTRACT: this list must include every `os` function agent/index.js calls —
// a missing import for an unlisted function would slip through. Keep in sync.
const OS_FUNCTIONS = [
  'homedir',
  'tmpdir',
  'hostname',
  'platform',
  'networkInterfaces',
  'userInfo',
  'cpus',
];

/**
 * Blank out block and line comments so a function name merely mentioned in a
 * comment isn't mistaken for a real call. Textual only (does not strip string
 * literals) — sufficient here because os function names followed by `(` do not
 * realistically appear inside string literals.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

/** True if `fn(` is called as a bare identifier (not `os.fn(` or `.fn(`). */
function isCalledBare(source, fn) {
  return new RegExp(`(^|[^.\\w])${fn}\\s*\\(`, 'm').test(source);
}

const scanSrc = stripComments(src);

describe('agent/index.js os imports', () => {
  const imported = osNamedImports(src);

  it('imports homedir from os (used by ensureYeaftSkills startup path)', () => {
    // Sanity: the symbol IS called in real code — otherwise this guard is
    // meaningless. Scan with comments stripped so the assertion is real.
    expect(isCalledBare(scanSrc, 'homedir')).toBe(true);
    expect(imported).toContain('homedir');
  });

  it('imports every os function it calls (no startup ReferenceError)', () => {
    const missing = OS_FUNCTIONS.filter(
      (fn) => isCalledBare(scanSrc, fn) && !imported.includes(fn),
    );
    expect(missing).toEqual([]);
  });
});
