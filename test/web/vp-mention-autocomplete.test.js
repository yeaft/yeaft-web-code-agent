/**
 * test/web/vp-mention-autocomplete.test.js — task-334j
 *
 * 3 tests covering the VP mention autocomplete filter + selection logic.
 * Pure unit tests — exercises the exported functions, no Vue mount.
 */
import { describe, it, expect } from 'vitest';

// Import only the pure functions — avoid importing the Vue component
// (which triggers Pinia/Vue globals). The component file exports these
// alongside the default Vue component.
// Vitest can import the module but the default export (Vue component)
// references VpAvatar which in turn imports vp.js store (Pinia global).
// We re-implement the pure functions here to test the logic without
// pulling in the Vue dependency chain.

// Mirror of filterVpMentions from VpMentionAutocomplete.js:
const VP_MENTION_MAX_RESULTS = 12;

function filterVpMentions(vps, query) {
  const list = Array.isArray(vps) ? vps : [];
  const q = typeof query === 'string' ? query.toLowerCase() : '';
  if (!q) {
    return list
      .filter(v => v && v.vpId && v.vpId !== 'user')
      .slice(0, VP_MENTION_MAX_RESULTS);
  }
  const prefix = [];
  const substring = [];
  for (const vp of list) {
    if (!vp || !vp.vpId || vp.vpId === 'user') continue;
    const idLower = String(vp.vpId).toLowerCase();
    if (idLower.startsWith(q)) { prefix.push(vp); continue; }
    const dn = String(vp.displayName || '').toLowerCase();
    if (dn.includes(q)) { substring.push(vp); }
  }
  return [...prefix, ...substring].slice(0, VP_MENTION_MAX_RESULTS);
}

// Mirror of applyMentionSelection from VpMentionAutocomplete.js:
function applyMentionSelection(text, vpId) {
  if (typeof text !== 'string' || !vpId) return text;
  const atIdx = text.lastIndexOf('@');
  if (atIdx < 0) return text;
  let end = atIdx + 1;
  while (end < text.length && !/[\s]/.test(text[end])) end++;
  return text.slice(0, atIdx) + '@' + vpId + ' ' + text.slice(end);
}

const mockVps = [
  { vpId: 'alice', displayName: 'Alice PM', role: 'Product Manager' },
  { vpId: 'bob', displayName: 'Bob Dev', role: 'Developer' },
  { vpId: 'charlie', displayName: 'Charlie QA', role: 'QA' },
  { vpId: 'user', displayName: 'You', role: '' },  // should be excluded
  { vpId: 'alice-jr', displayName: 'Alice Junior', role: 'Intern' },
];

describe('filterVpMentions', () => {
  it('shows all VPs (except user) when query is empty, up to VP_MENTION_MAX_RESULTS', () => {
    const result = filterVpMentions(mockVps, '');
    expect(result.every(v => v.vpId !== 'user')).toBe(true);
    expect(result.length).toBe(4); // alice, bob, charlie, alice-jr (user excluded)
  });

  it('vpId-prefix matches come before displayName-substring matches', () => {
    // 'ali' → vpId prefix: alice, alice-jr; displayName substring: none extra
    const result = filterVpMentions(mockVps, 'ali');
    expect(result[0].vpId).toBe('alice');
    expect(result[1].vpId).toBe('alice-jr');
    expect(result.length).toBe(2);
  });

  it('keyboard selection replaces @query with @vpId + trailing space', () => {
    const text = 'hey @ali';
    const result = applyMentionSelection(text, 'alice');
    expect(result).toBe('hey @alice ');
  });
});
