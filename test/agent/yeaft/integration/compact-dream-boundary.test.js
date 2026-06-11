/**
 * compact-dream-boundary.test.js
 *
 * Boundary regression for Compact (history) vs Dream (memory). Locks the
 * 3-case minimum from `agent/yeaft/DESIGN-COMPACT-VS-DREAM.md`:
 *
 *   A. Compact writes ONLY to `<yeaftDir>/groups/<sid>/conversation/compact/`
 *      — `<yeaftDir>/memory/...` MUST be untouched.
 *   B. Dream writes ONLY to `<memoryRoot>/<scope>/{memory,summary}.md`
 *      — `<yeaftDir>/groups/<sid>/conversation/compact/...` MUST be untouched.
 *   C. With both produced, the engine surfaces:
 *        - dream output → system prompt §6 (via AMS Resident)
 *        - compact output → messages[] head as <conversation_summary>
 *      Crucially, neither leaks into the other slot.
 *
 * The test exercises the REAL writers (`ConversationStore.replaceCompactSummaryFor`
 * and `store.writeMemory`/`writeSummary`) against an isolated tmp dir
 * rather than booting the full Engine + LLM. The boundary the user named
 * ("compact 和 dream 是两个不一样的事情，不要混在一起") is a STORAGE +
 * PROMPT-SLOT invariant; that's exactly what these writers enforce, and
 * spinning up an LLM-driven Engine would mostly exercise harness, not
 * the boundary itself.
 *
 * Case C uses static fixture text (no LLM) and asserts the well-known
 * facts about how each piece flows into the prompt: dream → system prompt
 * §6 Memory section via AMS Resident; compact → `<conversation_summary>`
 * user/assistant pair prepended to messages. The corresponding engine
 * code paths are pinned by source assertions so a future refactor that
 * accidentally crosses the wires will trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConversationStore } from '../../../../agent/yeaft/conversation/persist.js';
import { writeMemory, writeSummary } from '../../../../agent/yeaft/memory/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..', '..');

// Small helper: stat().mtimeMs but treat "missing" as null so a test can
// distinguish "never written" from "written then untouched".
function mtimeOrNull(path) {
  return existsSync(path) ? statSync(path).mtimeMs : null;
}

// Wait for the next tick of fs mtime resolution. On most kernels that's
// 1 ms; we sleep 30 ms to be conservative across CI. Without this, a
// "was the file modified" assertion can yield false negatives on hot
// loops where two writes land in the same tick.
function bumpMtime() {
  return new Promise((r) => setTimeout(r, 30));
}

describe('Compact ↔ Dream boundary (storage)', () => {
  let yeaftDir;
  let memoryRoot;
  let store;
  const sessionId = 's-boundary-test';
  const vpId = 'vp-alice';

  beforeEach(() => {
    yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-boundary-'));
    // Match the live layout: memory tree under `<yeaftDir>/memory`.
    memoryRoot = join(yeaftDir, 'memory');
    store = new ConversationStore(yeaftDir);
  });

  afterEach(() => {
    try { rmSync(yeaftDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ─── Case A ─────────────────────────────────────────────────────
  it('A — compact write lands ONLY under groups/<sid>/conversation/compact/, not under memory/', async () => {
    // Pre-seed a dream-style memory.md so we can detect any accidental
    // overwrite by the compact path.
    const groupScope = { kind: 'group', id: sessionId };
    const vpScope = { kind: 'group-vp', sessionId, id: vpId };
    await writeMemory(groupScope, '## dream baseline\n', { root: memoryRoot });
    await writeSummary(vpScope, 'baseline summary', { root: memoryRoot });

    const memoryFile = join(memoryRoot, 'group', sessionId, 'memory.md');
    const summaryFile = join(memoryRoot, 'group', sessionId, 'vp', vpId, 'summary.md');
    const memBefore = mtimeOrNull(memoryFile);
    const sumBefore = mtimeOrNull(summaryFile);
    expect(memBefore).not.toBeNull();
    expect(sumBefore).not.toBeNull();

    await bumpMtime();

    // Compact's only write call — exactly what `engine.js#runOrchestratorCompact`
    // invokes when `scoped` is true.
    store.replaceCompactSummaryFor(sessionId, vpId, '## compact summary v1\nold turns folded.\n');

    // 1) Compact landed in the right place.
    const compactPath = join(yeaftDir, 'groups', sessionId, 'conversation', 'compact', `${vpId}.md`);
    expect(existsSync(compactPath)).toBe(true);
    expect(readFileSync(compactPath, 'utf8')).toContain('compact summary v1');

    // 2) Memory tree is COMPLETELY untouched. mtime stable, contents stable.
    expect(mtimeOrNull(memoryFile)).toBe(memBefore);
    expect(mtimeOrNull(summaryFile)).toBe(sumBefore);
    expect(readFileSync(memoryFile, 'utf8')).toContain('dream baseline');
    expect(readFileSync(summaryFile, 'utf8')).toContain('baseline summary');

    // 3) No stray file inside memory/ that looks like a compact summary —
    //    guards against a future refactor where someone reroutes compact
    //    writes through the memory writers (the exact failure mode the
    //    boundary doc forbids).
    const allUnderMemory = await walkFiles(memoryRoot);
    for (const f of allUnderMemory) {
      const text = readFileSync(f, 'utf8');
      expect(text, `unexpected compact text in ${f}`).not.toContain('compact summary v1');
    }
  });

  // ─── Case B ─────────────────────────────────────────────────────
  it('B — dream write lands ONLY under memory/<scope>/, not under groups/<sid>/conversation/', async () => {
    // Pre-seed a compact summary so we can detect any accidental overwrite
    // by the dream path.
    store.replaceCompactSummaryFor(sessionId, vpId, 'COMPACT baseline\n');
    const compactPath = join(yeaftDir, 'groups', sessionId, 'conversation', 'compact', `${vpId}.md`);
    expect(existsSync(compactPath)).toBe(true);
    const compactBefore = mtimeOrNull(compactPath);
    const compactTextBefore = readFileSync(compactPath, 'utf8');

    await bumpMtime();

    // Dream's only writes — exactly what `dream/apply.js` invokes when
    // it commits a memory rewrite for a (group, vp) scope.
    const vpScope = { kind: 'group-vp', sessionId, id: vpId };
    await writeMemory(vpScope, '## DREAM produced memory\n- fact 1\n', { root: memoryRoot });
    await writeSummary(vpScope, 'dream produced summary', { root: memoryRoot });

    // 1) Dream landed in the right place.
    const memFile = join(memoryRoot, 'group', sessionId, 'vp', vpId, 'memory.md');
    const sumFile = join(memoryRoot, 'group', sessionId, 'vp', vpId, 'summary.md');
    expect(readFileSync(memFile, 'utf8')).toContain('DREAM produced memory');
    expect(readFileSync(sumFile, 'utf8')).toContain('dream produced summary');

    // 2) Compact summary on disk untouched. mtime AND content.
    expect(mtimeOrNull(compactPath)).toBe(compactBefore);
    expect(readFileSync(compactPath, 'utf8')).toBe(compactTextBefore);

    // 3) Nothing under the conversation/ tree contains the dream text —
    //    catches a future refactor where dream's writer accidentally hits
    //    a per-(session, vp) path.
    const convRoot = join(yeaftDir, 'groups', sessionId, 'conversation');
    const allUnderConv = await walkFiles(convRoot);
    for (const f of allUnderConv) {
      const text = readFileSync(f, 'utf8');
      expect(text, `unexpected dream text in ${f}`).not.toContain('DREAM produced memory');
      expect(text, `unexpected dream text in ${f}`).not.toContain('dream produced summary');
    }
  });

  // ─── Case C ─────────────────────────────────────────────────────
  it('C — engine code paths keep compact in messages[] and dream in system prompt §6', () => {
    // Source-level pin: the boundary is physically enforced by which
    // function reads compact vs dream and where it routes the text. The
    // HARD INVARIANT comment is the human-readable contract; this test
    // pins the wiring so that if someone removes the comment AND moves
    // either reader to the wrong slot, vitest screams.

    const engineSrc = readFileSync(join(repoRoot, 'agent', 'yeaft', 'engine.js'), 'utf8');
    const promptsSrc = readFileSync(join(repoRoot, 'agent', 'yeaft', 'prompts.js'), 'utf8');

    // (1) Compact summary reader exists and produces a <conversation_summary>
    //     wrapper that is destined for the MESSAGES array — not the system
    //     prompt. The marker we pin is the literal wrapper tag near the
    //     compactMessages assignment.
    expect(engineSrc).toMatch(/const\s+compactMessages\s*=\s*compactSummary/);
    expect(engineSrc).toMatch(/<conversation_summary>[\s\S]{0,15}compactSummary[\s\S]{0,15}<\/conversation_summary>/);

    // (2) The compact summary string MUST NOT be referenced by
    //     `prompts.js` at all — that file builds the system prompt and is
    //     the only place §6 Memory is assembled. If a future change starts
    //     to thread compact text through prompts.js, this assertion trips.
    expect(promptsSrc).not.toMatch(/<conversation_summary>/);
    expect(promptsSrc).not.toMatch(/compactSummary/);

    // (3) Dream output flows through `buildResidentEntries` (engine.js)
    //     and lands in the §6 Memory section assembled by `prompts.js`.
    //     We pin both ends: engine.js produces resident entries,
    //     prompts.js renders the §6 section header. Pin the literal
    //     section-header comment marker rather than any stray mention of
    //     "memory" — `prompts.js` has multiple incidental matches today,
    //     only one of which is the real §6 outlet (`prompts.js:380`:
    //     `─── 6. Memory Section`).
    expect(engineSrc).toMatch(/buildResidentEntries\s*\(/);
    expect(promptsSrc).toMatch(/6\.\s*Memory Section/);

    // (4) The HARD INVARIANT comment is present near the compact slot.
    //     Removing it without replacement is a smell the next reviewer
    //     should catch — pin the marker so a silent delete fails.
    expect(engineSrc).toMatch(/HARD INVARIANT:\s*Compact\s*≠\s*Dream/);

    // (5) The design doc the comment references must exist. Dangling
    //     pointers in HARD-INVARIANT comments are how this boundary got
    //     re-violated last time.
    const docPath = join(repoRoot, 'agent', 'yeaft', 'DESIGN-COMPACT-VS-DREAM.md');
    expect(existsSync(docPath)).toBe(true);
    const doc = readFileSync(docPath, 'utf8');
    // Sanity: the doc must mention BOTH write roots explicitly so the
    // 8-column table can't be reduced to one-sided documentation.
    expect(doc).toMatch(/conversation\/compact/);
    expect(doc).toMatch(/memory\.md/);
    expect(doc).toMatch(/summary\.md/);
  });
});

/**
 * Recursively list every file under `root`. Returns absolute paths.
 * Used by Cases A and B to scan the OPPOSITE tree for stray writes.
 */
async function walkFiles(root) {
  if (!existsSync(root)) return [];
  const fsp = await import('node:fs/promises');
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const p = join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) out.push(p);
    }
  }
  return out;
}
