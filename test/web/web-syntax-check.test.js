/**
 * Web JS syntax-check smoke test.
 *
 * Catches parser-level bugs in `web/**\/*.js` BEFORE they hit the Dev
 * Release build pipeline. The recurring class of bug this guards against:
 * an HTML comment inside a Vue template-literal containing backticks (e.g.
 * `\`hide-speaker-header\``), which terminates the outer template literal
 * early and breaks esbuild bundling. This has bitten us in PR #738, #744,
 * and #747 — each time the failure surfaced only at production build time,
 * after the PR had already merged.
 *
 * Strategy: run esbuild's `transform` (parse-only, no bundling) over every
 * `.js` file under web/ that isn't a vendor lib or build artefact. Anything
 * `esbuild.buildSync({ entryPoints: ['web/app.js'] })` would reject also
 * fails this test. Per-file parse is ~10ms × ~150 files = under a second,
 * and gives the offending file in the assertion message.
 */
import { describe, it, expect } from 'vitest';
import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { glob } from 'tinyglobby';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const WEB_DIR = path.join(ROOT, 'web');

describe('web JS syntax check', () => {
  it('all web/**/*.js files parse cleanly with esbuild', async () => {
    const files = await glob(['**/*.js'], {
      cwd: WEB_DIR,
      ignore: [
        'vendor/**',
        'dist/**',
        'node_modules/**',
        // Build script itself is CommonJS Node code, not part of the bundle —
        // skip to keep this test focused on browser-shipped code.
        'build.js',
      ],
      dot: false,
      absolute: false,
    });

    expect(files.length, 'expected to find some web/*.js files').toBeGreaterThan(10);

    const errors = [];
    for (const rel of files) {
      const abs = path.join(WEB_DIR, rel);
      const src = readFileSync(abs, 'utf8');
      try {
        // `transform` does a full parse but no bundling. Same target as the
        // production build (web/build.js: target: ['es2020']).
        transformSync(src, {
          loader: 'js',
          format: 'esm',
          target: 'es2020',
          sourcefile: rel,
        });
      } catch (err) {
        // esbuild attaches structured `errors[]` with line/column. Surface
        // them — a bare `err.message` strips the location and forces the
        // dev to grep around to find the broken line.
        const detail = (err && Array.isArray(err.errors) && err.errors.length)
          ? err.errors.map((e) => {
              const loc = e.location;
              const where = loc ? `:${loc.line}:${loc.column}` : '';
              return `${e.text}${where}${loc?.lineText ? ` — ${loc.lineText.trim()}` : ''}`;
            }).join('; ')
          : (err && err.message ? err.message.split('\n')[0] : String(err));
        errors.push(`web/${rel}: ${detail}`);
      }
    }

    expect(
      errors,
      `\n${errors.length} web JS file(s) failed to parse — these would break the Dev Release build:\n  - ${errors.join('\n  - ')}\n\nIf this is a backtick-inside-template-literal issue (the recurring case), replace the backticks in the offending HTML comment with single quotes.`
    ).toEqual([]);
  });
});
