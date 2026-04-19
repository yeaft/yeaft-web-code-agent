/**
 * task-332c F3 — Unify assembled-prompt snapshot test + missing-template guard
 *
 * Goal: lock in the exact text of the assembled system prompt for every
 * (mode × language) combination the PM cares about, so any future edit to
 * templates or `buildSystemPrompt()` surfaces as a reviewable diff on the
 * snapshot file instead of sneaking into production.
 *
 * Matrix covered (per PM red line):
 *   - modes: unified, chat, work, worker, coordinator, dream
 *   - languages: en, zh
 *
 * Note on legacy modes: task-297 collapsed chat/work/worker/coordinator into
 * a single unified prompt. This test locks in that collapse — any of those
 * mode strings must produce the same assembled prompt as `mode: 'unified'`.
 * If someone ever re-introduces per-mode branching, this snapshot will fail
 * loudly and the reviewer will have to acknowledge the behavior change.
 *
 * Additionally verifies:
 *   - missing-template guard throws (not silent-skip) when a required
 *     template is absent/empty.
 *
 * Red line:
 *   - Deterministic: the date line is normalized so the snapshot is stable.
 *   - No mocks of internal logic — we exercise `buildSystemPrompt()` directly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', '..', 'agent', 'unify', 'templates');
const PROMPTS_PATH = join(__dirname, '..', '..', 'agent', 'unify', 'prompts.js');

/**
 * Re-import prompts.js fresh (bypassing Vite's module cache) by appending a
 * query string to the absolute file URL. Wrapped in /* @vite-ignore *\/ so
 * Vite does not refuse the dynamic-variable import at static-analysis time.
 */
async function freshImportPrompts() {
  const url = pathToFileURL(PROMPTS_PATH).href + `?t=${Date.now()}-${Math.random()}`;
  return import(/* @vite-ignore */ url);
}

// ─── Determinism: freeze the date line ──────────────────────────
//
// buildSystemPrompt() stamps today's date into the prompt. Snapshots need
// deterministic output, so we substitute the date line with a stable token
// before asserting. We do NOT monkey-patch Date globally — that would leak
// into other tests in the same worker.
function normalizeDate(prompt) {
  return prompt
    .replace(/^Date: \d{4}-\d{2}-\d{2}$/m, 'Date: 2026-04-19')
    .replace(/^日期：\d{4}-\d{2}-\d{2}$/m, '日期：2026-04-19');
}

// ─── Fixtures ───────────────────────────────────────────────────

const MODES = ['unified', 'chat', 'work', 'worker', 'coordinator', 'dream'];
const LANGUAGES = ['en', 'zh'];

// Representative fixed inputs — keep these minimal so the snapshot isolates
// mode/language assembly rather than memory/compact content.
const FIXED_TOOL_NAMES = ['bash', 'file_read', 'file_edit', 'memory_recall', 'web_search'];

// ─── Snapshot matrix ────────────────────────────────────────────

describe('task-332c F3 — assembled-prompt snapshot (mode × language)', () => {
  for (const mode of MODES) {
    for (const lang of LANGUAGES) {
      it(`produces a stable prompt for mode=${mode}, language=${lang}`, async () => {
        const { buildSystemPrompt } = await freshImportPrompts();
        const prompt = buildSystemPrompt({
          language: lang,
          mode,
          toolNames: FIXED_TOOL_NAMES,
        });
        const normalized = normalizeDate(prompt);

        // Basic shape assertions — if any of these fail, the snapshot
        // likely drifted in an unexpected way.
        expect(normalized).toBeTypeOf('string');
        expect(normalized.length).toBeGreaterThan(100);
        expect(normalized).toMatch(/Yeaft/);
        if (lang === 'en') {
          expect(normalized).toContain('Date: 2026-04-19');
          expect(normalized).toContain('Available tools:');
        } else {
          expect(normalized).toContain('日期：2026-04-19');
          expect(normalized).toContain('可用工具：');
        }
        // Freeze the full text.
        expect(normalized).toMatchSnapshot();
      });
    }
  }
});

// ─── Legacy mode collapse (task-297) ────────────────────────────

describe('task-332c F3 — legacy chat/work/worker/coordinator collapse into unified', () => {
  for (const lang of LANGUAGES) {
    it(`chat/work/worker/coordinator all equal unified for language=${lang}`, async () => {
      const { buildSystemPrompt } = await freshImportPrompts();
      const base = normalizeDate(buildSystemPrompt({
        language: lang, mode: 'unified', toolNames: FIXED_TOOL_NAMES,
      }));
      for (const legacyMode of ['chat', 'work', 'worker', 'coordinator']) {
        const got = normalizeDate(buildSystemPrompt({
          language: lang, mode: legacyMode, toolNames: FIXED_TOOL_NAMES,
        }));
        expect(got).toBe(base);
      }
    });
  }

  it('dream mode is DISTINCT from unified (only background-memory path)', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const unified = buildSystemPrompt({ language: 'en', mode: 'unified' });
    const dream = buildSystemPrompt({ language: 'en', mode: 'dream' });
    expect(dream).not.toBe(unified);
    expect(dream).toMatch(/[Dd]ream/);
  });
});

// ─── Missing-template guard ─────────────────────────────────────
//
// We temporarily rename one of the REQUIRED template files so the module
// re-import fails fast with a clear error message. We restore the file in
// afterAll regardless of test outcome, so a failed test never poisons the
// repo.
//
// Module caching note: Node's ESM loader caches modules by URL. To force a
// fresh read, we import with a cache-busting query string.

describe('task-332c F3 — missing-template guard', () => {
  const targets = ['base.md', 'mode-unified.md', 'mode-dream.md', 'tool-guidance.md'];

  for (const fname of targets) {
    it(`throws a clear error when ${fname} is missing`, async () => {
      const path = join(TEMPLATES_DIR, fname);
      const backup = path + '.__test_backup__';
      expect(existsSync(path)).toBe(true);
      renameSync(path, backup);
      try {
        await expect(freshImportPrompts())
          .rejects.toThrow(/Required template missing: /);
      } finally {
        renameSync(backup, path);
      }
    });

    it(`throws a clear error when ${fname} is empty`, async () => {
      const path = join(TEMPLATES_DIR, fname);
      const backup = path + '.__test_backup__';
      const original = readFileSync(path, 'utf8');
      renameSync(path, backup);
      writeFileSync(path, '   \n  \n', 'utf8');
      try {
        await expect(freshImportPrompts())
          .rejects.toThrow(/Required template is empty: /);
      } finally {
        unlinkSync(path);
        renameSync(backup, path);
        // Sanity: contents restored
        expect(readFileSync(path, 'utf8')).toBe(original);
      }
    });
  }

  it('error message points at the offending filename (diagnostic clarity)', async () => {
    const path = join(TEMPLATES_DIR, 'base.md');
    const backup = path + '.__test_backup__';
    renameSync(path, backup);
    try {
      let err;
      try {
        await freshImportPrompts();
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(String(err.message || err)).toContain('base.md');
    } finally {
      renameSync(backup, path);
    }
  });
});
