/**
 * ids.test.js — pins the ULID-style suffix on session ids.
 *
 * Background: an earlier refactor dropped the random suffix from
 * `nextSessionId`, so re-creating a session with the same display name
 * always produced the same id (`grp_<slug>`) and tripped the
 * `duplicate` guard in `session-crud.js`. Users hit this when
 * re-creating a session named "Test" after deleting the first one.
 *
 * The fix restores the suffix; this file locks the shape so the
 * regression cannot recur silently.
 */
import { describe, it, expect } from 'vitest';
import { nextSessionId } from '../../../../agent/yeaft/sessions/ids.js';

describe('nextSessionId', () => {
  it('embeds the slug and prefixes with grp_', () => {
    const id = nextSessionId('Hello World');
    expect(id.startsWith('grp_hello-world_')).toBe(true);
  });

  it('falls back to the "group" slug when the input is empty', () => {
    const id = nextSessionId('');
    expect(id.startsWith('grp_group_')).toBe(true);
  });

  it('caps the slug at 24 chars to keep the total id compact', () => {
    const long = 'a'.repeat(100);
    const id = nextSessionId(long);
    // `grp_<24 chars>_<8 chars>` = 4 + 24 + 1 + 8 = 37
    expect(id.length).toBe(37);
  });

  it('produces a unique id on every call even with the same slug', () => {
    // N=1000 keeps the birthday collision probability for 40 random bits at
    // ~5e-7 (vs 5e-5 at N=10000) — well below CI flake territory. The
    // regression we're guarding against was *deterministic* identical ids,
    // not low-N collisions, so 1000 is plenty.
    const N = 1000;
    const seen = new Set();
    for (let i = 0; i < N; i++) seen.add(nextSessionId('same'));
    expect(seen.size).toBe(N);
  });

  it('uses only crockford-base32 characters in the suffix', () => {
    const id = nextSessionId('x');
    const suffix = id.slice(id.lastIndexOf('_') + 1);
    expect(suffix).toHaveLength(8);
    expect(/^[0-9A-HJKMNP-TV-Z]+$/.test(suffix)).toBe(true);
  });
});
