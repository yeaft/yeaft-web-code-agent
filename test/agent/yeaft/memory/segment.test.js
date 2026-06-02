/**
 * segment.test.js — H2.a segment schema + parse/serialize tolerance.
 */

import { describe, it, expect } from 'vitest';
import {
  makeSegment, parseSegments, serializeSegments,
  computeSegmentId, KIND_VALUES,
} from '../../../../agent/yeaft/memory/segment.js';

describe('makeSegment', () => {
  it('fills defaults when only scope+body given', () => {
    const s = makeSegment({ scope: 'user', body: 'hello world' });
    expect(s.kind).toBe('context');
    expect(s.tags).toEqual([]);
    expect(s.sourceMessages).toEqual([]);
    expect(s.id).toMatch(/^seg_[0-9a-f]{8}$/);
    expect(s.createdAt).toBeTruthy();
    expect(s.updatedAt).toBe(s.createdAt);
  });

  it('coerces invalid kind to context', () => {
    const s = makeSegment({ scope: 'user', body: 'x', kind: 'bogus' });
    expect(s.kind).toBe('context');
  });

  it('rejects invalid scope', () => {
    expect(() => makeSegment({ scope: 'badscope!', body: 'x' })).toThrow();
  });

  it('requires non-empty body', () => {
    expect(() => makeSegment({ scope: 'user', body: '   ' })).toThrow();
  });

  it('id is stable for same scope/kind/body', () => {
    const a = makeSegment({ scope: 'user', kind: 'fact', body: 'sky is blue' });
    const b = makeSegment({ scope: 'user', kind: 'fact', body: 'sky is blue' });
    expect(a.id).toBe(b.id);
  });

  it('accepts all valid scope shapes', () => {
    for (const scope of ['user', 'vp/alice', 'group/g1', 'feature/auth', 'topic/lang', 'topic/lang/js']) {
      expect(() => makeSegment({ scope, body: 'x' })).not.toThrow();
    }
  });

  it('exposes KIND_VALUES set', () => {
    expect(KIND_VALUES.has('decision')).toBe(true);
    expect(KIND_VALUES.has('preference')).toBe(true);
  });
});

describe('parseSegments — tolerant', () => {
  it('returns [] for empty / whitespace', () => {
    expect(parseSegments('')).toEqual([]);
    expect(parseSegments('   \n\n  ')).toEqual([]);
  });

  it('parses pure body (no frontmatter) using defaultScope', () => {
    const segs = parseSegments('User decided to use JWT.', { defaultScope: 'feature/auth' });
    expect(segs).toHaveLength(1);
    expect(segs[0].body).toBe('User decided to use JWT.');
    expect(segs[0].scope).toBe('feature/auth');
    expect(segs[0].kind).toBe('context');
  });

  it('drops body-only block when no defaultScope', () => {
    expect(parseSegments('hello')).toEqual([]);
  });

  it('parses partial frontmatter, fills missing fields', () => {
    const text = `---
kind: decision
---
JWT chosen over sessions.`;
    const segs = parseSegments(text, { defaultScope: 'feature/auth' });
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('decision');
    expect(segs[0].scope).toBe('feature/auth');
    expect(segs[0].tags).toEqual([]);
  });

  it('parses complete frontmatter', () => {
    const text = `---
id: seg_abcd1234
scope: user
kind: preference
tags: [zsh, terminal]
sourceMessages: [m_1, m_2]
createdAt: 2026-04-29T10:00:00.000Z
updatedAt: 2026-04-29T10:00:00.000Z
---
User uses zsh.`;
    const segs = parseSegments(text);
    expect(segs).toHaveLength(1);
    expect(segs[0].id).toBe('seg_abcd1234');
    expect(segs[0].tags).toEqual(['zsh', 'terminal']);
    expect(segs[0].sourceMessages).toEqual(['m_1', 'm_2']);
  });

  it('parses multiple segments', () => {
    const text = `---
scope: user
kind: fact
---
Body A.

---
scope: user
kind: decision
---
Body B.`;
    const segs = parseSegments(text);
    expect(segs).toHaveLength(2);
    expect(segs[0].body).toBe('Body A.');
    expect(segs[1].body).toBe('Body B.');
  });

  it('handles mixed: prefix body + frontmatter blocks', () => {
    const text = `Free-form intro paragraph.

---
scope: user
kind: fact
---
Structured block.`;
    const segs = parseSegments(text, { defaultScope: 'user' });
    expect(segs).toHaveLength(2);
    expect(segs[0].body).toBe('Free-form intro paragraph.');
    expect(segs[1].body).toBe('Structured block.');
  });

  it('handles tags with quoted strings', () => {
    const text = `---
scope: user
kind: fact
tags: [a, "b c", d]
---
body`;
    const segs = parseSegments(text);
    expect(segs[0].tags).toEqual(['a', 'b c', 'd']);
  });
});

describe('serializeSegments — round-trip', () => {
  it('round-trips canonical input', () => {
    const segs = [
      makeSegment({ scope: 'user', kind: 'fact', body: 'A', tags: ['x'] }),
      makeSegment({ scope: 'user', kind: 'decision', body: 'B', sourceMessages: ['m_1'] }),
    ];
    const text = serializeSegments(segs);
    const back = parseSegments(text);
    expect(back).toHaveLength(2);
    expect(back[0].body).toBe('A');
    expect(back[0].tags).toEqual(['x']);
    expect(back[1].sourceMessages).toEqual(['m_1']);
    // ids stable
    expect(back[0].id).toBe(segs[0].id);
    expect(back[1].id).toBe(segs[1].id);
  });

  it('returns empty string for empty array', () => {
    expect(serializeSegments([])).toBe('');
  });
});

describe('computeSegmentId', () => {
  it('produces seg_ prefix + 8 hex', () => {
    const id = computeSegmentId({ scope: 'user', kind: 'fact', body: 'x' });
    expect(id).toMatch(/^seg_[0-9a-f]{8}$/);
  });

  it('different body → different id', () => {
    const a = computeSegmentId({ scope: 'user', kind: 'fact', body: 'x' });
    const b = computeSegmentId({ scope: 'user', kind: 'fact', body: 'y' });
    expect(a).not.toBe(b);
  });

  it('different scope → different id', () => {
    const a = computeSegmentId({ scope: 'user', kind: 'fact', body: 'x' });
    const b = computeSegmentId({ scope: 'vp/alice', kind: 'fact', body: 'x' });
    expect(a).not.toBe(b);
  });
});
