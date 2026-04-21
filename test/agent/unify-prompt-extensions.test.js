/**
 * task-334e — Assembled-prompt snapshot coverage for the three new sections
 *   §Δ24.5  task_ctx (task-memory top-5, `[shard]` prefix, no sourceRef)
 *   §Δ27.3  task summary reminder (initiator-only, ≥3 msgs, >15min)
 *   §Δ31.4  related tasks (ACL-gated by target.members ∋ currentVpId)
 *   §Δ29.3  user_profile (stub read from ~/.yeaft/user/profile.json)
 *   §Δ24.5  core_memory (recall top-7 + `memory_trace` meta line)
 *
 * These tests lock in the rendered text for each branch so future edits to
 * prompts.js or templates/ surface as reviewable snapshot diffs.
 *
 * Red lines (task-334e contract):
 *   - No sourceRef appears in any rendered block.
 *   - Related tasks fail-closed on missing `members`.
 *   - Summary reminder only fires when currentVpId == initiatorVpId.
 *   - User profile stub does not throw when the file is absent / malformed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
  renameSync,
} from 'fs';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_PATH = join(__dirname, '..', '..', 'agent', 'unify', 'prompts.js');

async function freshImportPrompts() {
  const url = pathToFileURL(PROMPTS_PATH).href + `?t=${Date.now()}-${Math.random()}`;
  return import(/* @vite-ignore */ url);
}

function normalizeDate(prompt) {
  return prompt
    .replace(/^Date: \d{4}-\d{2}-\d{2}$/m, 'Date: 2026-04-19')
    .replace(/^日期：\d{4}-\d{2}-\d{2}$/m, '日期：2026-04-19');
}

/**
 * Stash the user's real `~/.yeaft/user/profile.json` (if any) before each
 * test and restore it afterwards. Tests that want the stub to return empty
 * simply skip creating the file; tests that want content write the file
 * inside their `it` block. This keeps the dev's real profile untouched.
 */
const PROFILE_DIR = join(homedir(), '.yeaft', 'user');
const PROFILE_PATH = join(PROFILE_DIR, 'profile.json');
const PROFILE_BACKUP = PROFILE_PATH + '.__task334e_backup__';

beforeEach(() => {
  if (existsSync(PROFILE_PATH)) {
    renameSync(PROFILE_PATH, PROFILE_BACKUP);
  }
});

afterEach(() => {
  if (existsSync(PROFILE_PATH)) rmSync(PROFILE_PATH);
  if (existsSync(PROFILE_BACKUP)) renameSync(PROFILE_BACKUP, PROFILE_PATH);
});

// ──────────────────────────────────────────────────────────────
// §Δ24.5 task_ctx — task memories + related tasks
// ──────────────────────────────────────────────────────────────

describe('task-334e — task_ctx section (§Δ24.5 + §Δ31.4)', () => {
  it('renders top-5 task memories with [shard] prefix and no sourceRef (en)', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt({
      language: 'en',
      taskCtx: {
        taskId: 'task-334e',
        currentVpId: 'vp:alice',
        initiatorVpId: 'vp:alice',
        memories: [
          { body: 'first memory body', shard: 'design' },
          { body: 'second memory body', shard: 'code' },
          { body: 'third memory body' }, // default shard -> general
          { body: '  fourth memory body  ', shard: 'spec' },
          { body: 'fifth memory body', shard: 'notes' },
          { body: 'sixth (dropped)', shard: 'notes' }, // exceeds top-5
        ],
      },
    });
    expect(prompt).toContain('## task_ctx');
    expect(prompt).toContain('taskId: task-334e');
    expect(prompt).toContain('- [design] first memory body');
    expect(prompt).toContain('- [general] third memory body');
    expect(prompt).toContain('- [spec] fourth memory body');
    expect(prompt).toContain('- [notes] fifth memory body');
    expect(prompt).not.toContain('sixth (dropped)');
    expect(prompt).not.toMatch(/sourceRef|source_ref/i);
    expect(normalizeDate(prompt)).toMatchSnapshot();
  });

  it('ACL-filters related tasks: members must include currentVpId', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt({
      language: 'en',
      taskCtx: {
        currentVpId: 'vp:alice',
        initiatorVpId: 'vp:alice',
        memories: [{ body: 'task-local hint', shard: 'general' }],
        relatedTasks: [
          // Allowed: alice is a member
          {
            id: 'task-A',
            title: 'allowed task',
            members: ['vp:alice', 'vp:bob'],
            updatedAt: 3000,
            memories: [
              { body: 'A-m1', shard: 'x' },
              { body: 'A-m2', shard: 'y' },
              { body: 'A-m3 (dropped)', shard: 'z' },
            ],
          },
          // Denied: alice NOT in members
          {
            id: 'task-B',
            title: 'denied task',
            members: ['vp:carol'],
            updatedAt: 9000,
            memories: [{ body: 'B-secret' }],
          },
          // Fail-closed: missing members
          {
            id: 'task-C',
            title: 'no-members task',
            updatedAt: 9000,
            memories: [{ body: 'C-secret' }],
          },
          // Allowed with a newer updatedAt: comes first
          {
            id: 'task-D',
            title: 'newer allowed',
            members: ['vp:alice'],
            updatedAt: 5000,
            memories: [{ body: 'D-m1' }],
          },
        ],
      },
    });
    expect(prompt).toContain('### related tasks');
    // Ordering: D (5000) before A (3000)
    const idxD = prompt.indexOf('**task-D**');
    const idxA = prompt.indexOf('**task-A**');
    expect(idxD).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(idxD);
    // Denied + fail-closed never surface
    expect(prompt).not.toContain('task-B');
    expect(prompt).not.toContain('task-C');
    expect(prompt).not.toContain('B-secret');
    expect(prompt).not.toContain('C-secret');
    // Top-2 memory per task
    expect(prompt).toContain('- [x] A-m1');
    expect(prompt).toContain('- [y] A-m2');
    expect(prompt).not.toContain('A-m3 (dropped)');
    expect(normalizeDate(prompt)).toMatchSnapshot();
  });

  it('omits the task_ctx block entirely when nothing qualifies', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt({
      language: 'en',
      taskCtx: {
        currentVpId: 'vp:alice',
        initiatorVpId: 'vp:bob', // not initiator → no reminder
        memories: [],
        relatedTasks: [{ id: 't', members: ['vp:other'] }],
      },
    });
    expect(prompt).not.toContain('## task_ctx');
  });
});

// ──────────────────────────────────────────────────────────────
// §Δ27.3 task summary reminder
// ──────────────────────────────────────────────────────────────

describe('task-334e — summary reminder (§Δ27.3)', () => {
  const base = (overrides = {}) => ({
    language: 'en',
    taskCtx: {
      taskId: 'task-X',
      currentVpId: 'vp:alice',
      initiatorVpId: 'vp:alice',
      memories: [{ body: 'placeholder', shard: 'general' }],
      summaryReminder: {
        nonSummaryCount: 5,
        lastSummaryAt: 1_700_000_000_000,
        now: 1_700_000_000_000 + 20 * 60 * 1000, // +20min
      },
      ...overrides,
    },
  });

  it('fires when initiator, ≥3 msgs, and >15min since last summary', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt(base());
    expect(prompt).toMatch(/💡 20min since last summary/);
    expect(prompt).toContain('+5 new messages');
    expect(prompt).toContain('task_summary_post');
    expect(normalizeDate(prompt)).toMatchSnapshot();
  });

  it('does NOT fire when currentVpId != initiatorVpId', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt(base({ currentVpId: 'vp:bob' }));
    expect(prompt).not.toMatch(/💡/);
  });

  it('does NOT fire when fewer than 3 non-summary messages', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt(base({
      summaryReminder: { nonSummaryCount: 2, lastSummaryAt: 1, now: 1 + 999_999_999 },
    }));
    expect(prompt).not.toMatch(/💡/);
  });

  it('does NOT fire when lastSummary is within 15min', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt(base({
      summaryReminder: {
        nonSummaryCount: 5,
        lastSummaryAt: 1_700_000_000_000,
        now: 1_700_000_000_000 + 10 * 60 * 1000,
      },
    }));
    expect(prompt).not.toMatch(/💡/);
  });

  it('fires when never summarized (lastSummaryAt=0) and msgs ≥ 3', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt(base({
      summaryReminder: { nonSummaryCount: 3, lastSummaryAt: 0, now: 1_700_000_000_000 },
    }));
    // "Never summarized" reports minutes as "—" to avoid fabricating a count
    expect(prompt).toMatch(/💡 —min since last summary/);
  });
});

// ──────────────────────────────────────────────────────────────
// §Δ29.3 user_profile stub
// ──────────────────────────────────────────────────────────────

describe('task-334e — user_profile section (§Δ29.3 stub)', () => {
  it('renders explicit userProfile param verbatim', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt({
      language: 'en',
      userProfile: 'The user prefers terse answers in 中文.',
    });
    expect(prompt).toContain('## user_profile');
    expect(prompt).toContain('The user prefers terse answers in 中文.');
    expect(normalizeDate(prompt)).toMatchSnapshot();
  });

  it('falls back to reading ~/.yeaft/user/profile.json when param omitted', async () => {
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(
      PROFILE_PATH,
      JSON.stringify({ content: 'Night owl, works in pacific timezone.' }),
      'utf8',
    );
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt({ language: 'en' });
    expect(prompt).toContain('## user_profile');
    expect(prompt).toContain('Night owl, works in pacific timezone.');
  });

  it('silently skips block when profile.json is absent', async () => {
    if (existsSync(PROFILE_PATH)) rmSync(PROFILE_PATH);
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt({ language: 'en' });
    expect(prompt).not.toContain('## user_profile');
  });

  it('silently skips block when profile.json is malformed', async () => {
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(PROFILE_PATH, '{not-valid-json', 'utf8');
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt({ language: 'en' });
    expect(prompt).not.toContain('## user_profile');
  });

  it('respects empty-string override (explicit opt-out does not fall back to file)', async () => {
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(
      PROFILE_PATH,
      JSON.stringify({ content: 'should-not-appear' }),
      'utf8',
    );
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt({ language: 'en', userProfile: '' });
    // Empty string is truthy-string-check-falsy, so block is skipped AND
    // stub is NOT re-consulted (non-null override blocks fallback).
    expect(prompt).not.toContain('## user_profile');
    expect(prompt).not.toContain('should-not-appear');
    // Cleanup the file we wrote
    void readFileSync(PROFILE_PATH, 'utf8');
  });
});

// ──────────────────────────────────────────────────────────────
// §Δ24.5 core_memory
// ──────────────────────────────────────────────────────────────

describe('task-334e — core_memory section (§Δ24.5)', () => {
  it('renders top-7 entries + memory_trace meta line (en)', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const entries = Array.from({ length: 10 }, (_, i) => ({
      body: `memory body ${i}`,
      shard: i % 2 === 0 ? 'even' : 'odd',
    }));
    const prompt = buildSystemPrompt({
      language: 'en',
      coreMemory: { entries },
    });
    expect(prompt).toContain('## core_memory');
    expect(prompt).toContain('- [even] memory body 0');
    expect(prompt).toContain('- [odd] memory body 5');
    expect(prompt).toContain('- [even] memory body 6'); // 7th (index 6 → even)
    expect(prompt).not.toContain('memory body 7'); // 8th truncated
    expect(prompt).toContain('memory_trace');
    expect(prompt).not.toMatch(/sourceRef|source_ref/i);
    expect(normalizeDate(prompt)).toMatchSnapshot();
  });

  it('respects zh header + meta line', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt({
      language: 'zh',
      coreMemory: {
        entries: [{ body: '用户喜欢深色主题', shard: 'pref' }],
      },
    });
    expect(prompt).toContain('## core_memory');
    expect(prompt).toContain('- [pref] 用户喜欢深色主题');
    expect(prompt).toContain('如需原始 message，调 `memory_trace`。');
  });

  it('omits block entirely when all entries are empty bodies', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt({
      language: 'en',
      coreMemory: { entries: [{ body: '   ' }, { body: '' }] },
    });
    expect(prompt).not.toContain('## core_memory');
  });

  it('honours custom max cap', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const entries = Array.from({ length: 5 }, (_, i) => ({ body: `m${i}` }));
    const prompt = buildSystemPrompt({
      language: 'en',
      coreMemory: { entries, max: 2 },
    });
    expect(prompt).toContain('- [general] m0');
    expect(prompt).toContain('- [general] m1');
    expect(prompt).not.toContain('- [general] m2');
  });
});

// ──────────────────────────────────────────────────────────────
// Backward-compat: existing callers still work untouched.
// ──────────────────────────────────────────────────────────────

describe('task-334e — backward compat', () => {
  it('baseline call (no new params) unchanged in shape', async () => {
    const { buildSystemPrompt } = await freshImportPrompts();
    const prompt = buildSystemPrompt({
      language: 'en',
      mode: 'unified',
      toolNames: ['bash', 'memory_recall'],
    });
    expect(prompt).not.toContain('## task_ctx');
    expect(prompt).not.toContain('## core_memory');
    // Profile stub: whatever is on disk would flow through, but beforeEach
    // moves the real file aside and afterEach restores it.
    expect(prompt).not.toContain('## user_profile');
    expect(prompt).toContain('Available tools: bash, memory_recall');
  });
});
