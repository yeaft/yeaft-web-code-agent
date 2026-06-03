/**
 * dream-v2 runner ↔ error-sink integration.
 *
 * The unit suite (`dream-error-sink.test.js`) pins the helper's own
 * contract. This suite pins the wiring: the runner's catch sites
 * MUST call `writeDreamError` so a real-world failure leaves an on-
 * disk trace.
 *
 * Two failure modes are exercised:
 *
 *   1. Triage failure — `llm({pass:'triage-pass1'})` throws. The
 *      sink lands at `<root>/group/<id>/.dream-last-error.json` with
 *      `phase === 'triage'`.
 *
 *   2. Apply failure — triage succeeds but `llm({pass:'update'})`
 *      throws on a specific target (we make `user`'s update fail).
 *      The sink lands at `<root>/user/.dream-last-error.json` with
 *      `phase === 'apply'`. Critically, this is the NON-group scope
 *      case — it pins that the sink works for `user/`, `vp/<id>`,
 *      `feature/<id>` too, not just `group/<id>`.
 *
 * Also asserts that the runner does NOT throw on either failure
 * mode — the report is returned with status='error' on the affected
 * group/target. The error sink is observability, not control flow.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDream } from '../../../../agent/yeaft/dream-v2/runner.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dream-runerr-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('runDream — error sink wiring', () => {
  it('writes group/<id>/.dream-last-error.json when triage throws', async () => {
    const llm = async ({ pass }) => {
      if (pass === 'triage-pass1') throw new Error('LLM returned malformed JSON');
      // Unreachable under this scenario, but keep deterministic.
      return JSON.stringify({});
    };
    const r = await runDream({
      root,
      manual: true,
      llm,
      listSessions: async () => ['grp_fun'],
      countMessages: async () => 25,
      loadGroupDiff: async () => Array.from(
        { length: 25 },
        (_, i) => ({ id: `m${i + 1}`, role: 'user', body: 'hi' }),
      ),
      loadOverlapPreamble: async () => [],
    });

    // Runner did not throw, and surfaced the failure in the report.
    const g = r.groups.find(x => x.sessionId === 'grp_fun');
    expect(g.status).toBe('error');
    expect(g.error).toContain('LLM returned malformed JSON');

    // On-disk sink exists with the expected shape.
    const sink = join(root, 'group', 'grp_fun', '.dream-last-error.json');
    expect(existsSync(sink)).toBe(true);
    const body = JSON.parse(readFileSync(sink, 'utf8'));
    expect(body.scope).toBe('group/grp_fun');
    expect(body.phase).toBe('triage');
    expect(body.message).toContain('LLM returned malformed JSON');
    expect(typeof body.at).toBe('string');
    // Stack should be present (the helper trims to 5 frames; we just
    // care that something landed).
    expect(typeof body.stack === 'string' || body.stack === null).toBe(true);
  });

  it('writes user/.dream-last-error.json when an apply throws (non-group scope)', async () => {
    // Triage succeeds with default hard-rule actions (user + group/g +
    // possibly vp/...); the failing update is targeted at `user` only.
    const llm = async ({ pass, prompt }) => {
      if (pass === 'triage-pass1') return JSON.stringify({ user_profile_signals: false, topics: [], trivial_only: true });
      if (pass === 'triage-pass2') return JSON.stringify({ decision: 'none' });
      if (pass === 'update' || pass === 'create') {
        // Only blow up on the `user` target. Other targets (e.g.
        // group/g, vp/zhang-san) succeed so the runner reaches apply
        // for `user`.
        if (/Scope(?: path)?:\s*user\b/.test(prompt)) {
          throw new Error('apply explosion on user');
        }
        return JSON.stringify({ memory_md: 'ok', summary_md: 'ok' });
      }
      throw new Error(`unexpected pass ${pass}`);
    };

    const r = await runDream({
      root,
      manual: true,
      llm,
      listSessions: async () => ['g'],
      countMessages: async () => 25,
      loadGroupDiff: async () => Array.from(
        { length: 25 },
        (_, i) => ({
          id: `m${i + 1}`,
          role: i % 2 ? 'assistant' : 'user',
          vpId: 'zhang-san',
          body: `msg ${i + 1}`,
        }),
      ),
      loadOverlapPreamble: async () => [],
    });

    // `user` target reported an error; the runner didn't throw.
    const userTarget = r.targets.find(t => t.target === 'user');
    expect(userTarget).toBeTruthy();
    expect(userTarget.status).toBe('error');
    expect(userTarget.error).toContain('apply explosion on user');

    // Sink landed under the NON-group scope dir.
    const sink = join(root, 'user', '.dream-last-error.json');
    expect(existsSync(sink)).toBe(true);
    const body = JSON.parse(readFileSync(sink, 'utf8'));
    expect(body.scope).toBe('user');
    expect(body.phase).toBe('apply');
    expect(body.message).toContain('apply explosion on user');
  });

  it('overwrites a prior error sink on the next failed pass', async () => {
    const stages = ['first', 'second'];
    for (const stage of stages) {
      const llm = async ({ pass }) => {
        if (pass === 'triage-pass1') throw new Error(`triage-${stage}-blew-up`);
        return JSON.stringify({});
      };
      await runDream({
        root,
        manual: true,
        llm,
        listSessions: async () => ['g'],
        countMessages: async () => 25,
        loadGroupDiff: async () => Array.from(
          { length: 25 },
          (_, i) => ({ id: `m${i + 1}`, role: 'user', body: 'x' }),
        ),
        loadOverlapPreamble: async () => [],
      });
    }
    const body = JSON.parse(
      readFileSync(join(root, 'group', 'g', '.dream-last-error.json'), 'utf8'),
    );
    // Most-recent-wins: we should see 'second', not 'first'.
    expect(body.message).toContain('triage-second-blew-up');
    expect(body.message).not.toContain('triage-first-blew-up');
  });
});
