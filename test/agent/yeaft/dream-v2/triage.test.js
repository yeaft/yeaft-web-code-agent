/**
 * dream-v2/triage.test.js — §14
 *
 * Hard rules + soft 2-pass classification with a stub LLM.
 */

import { describe, it, expect } from 'vitest';
import {
  applyHardRules,
  classifySoft,
  triageOneSegment,
  triageGroupSegments,
  buildPass1Prompt,
  buildPass2Prompt,
  parseJsonSafe,
} from '../../../../agent/yeaft/dream-v2/triage.js';

describe('applyHardRules', () => {
  it('always includes user', () => {
    const out = applyHardRules({ groupId: 'g-eng', messages: [] });
    expect(out.find(a => a.scope === 'user')).toBeTruthy();
  });
  it('includes the active group except _no-group', () => {
    expect(applyHardRules({ groupId: 'g-eng', messages: [] }).map(a => a.scope))
      .toContain('group/g-eng');
    expect(applyHardRules({ groupId: '_no-group', messages: [] }).map(a => a.scope))
      .not.toContain('group/_no-group');
  });
  it('adds group/<g>/vp/<id> for each assistant message vpId', () => {
    const out = applyHardRules({
      groupId: 'g-eng',
      messages: [
        { role: 'assistant', vpId: 'zhang-san' },
        { role: 'assistant', vpId: 'li-si' },
        { role: 'user' },
      ],
    });
    const scopes = out.map(a => a.scope);
    expect(scopes).toContain('group/g-eng/vp/zhang-san');
    expect(scopes).toContain('group/g-eng/vp/li-si');
    expect(scopes).toContain('group/g-eng/user');
  });
  it('extracts vp from author "vp:<id>" format', () => {
    const out = applyHardRules({
      groupId: 'g',
      messages: [{ role: 'assistant', author: 'vp:wang-wu' }],
    });
    expect(out.map(a => a.scope)).toContain('group/g/vp/wang-wu');
  });
  it('does NOT create feature scopes from messages (Feature system removed)', () => {
    const out = applyHardRules({
      groupId: 'g-eng',
      messages: [{ role: 'user', featureId: 'abc-123' }],
    });
    expect(out.map(a => a.scope).some(s => s.startsWith('feature/'))).toBe(false);
  });
  it('rejects unsafe vp ids silently', () => {
    const out = applyHardRules({
      groupId: 'g',
      messages: [
        { role: 'assistant', vpId: '../etc/passwd' },
      ],
    });
    const scopes = out.map(a => a.scope);
    expect(scopes.some(s => s.startsWith('vp/'))).toBe(false);
  });
});

describe('parseJsonSafe', () => {
  it('parses plain JSON', () => {
    expect(parseJsonSafe('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips markdown fences', () => {
    expect(parseJsonSafe('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it('recovers a {…} block from prose', () => {
    expect(parseJsonSafe('here you go: {"a":3} bye')).toEqual({ a: 3 });
  });
  it('returns null on garbage', () => {
    expect(parseJsonSafe('not json')).toBe(null);
  });
});

describe('classifySoft', () => {
  it('emits user + topics from Pass-1, binds topics in Pass-2', async () => {
    const calls = [];
    const llm = async ({ pass, prompt }) => {
      calls.push(pass);
      if (pass === 'triage-pass1') {
        return JSON.stringify({
          user_profile_signals: true,
          topics: ['physics quantum', 'parenting sleep'],
          trivial_only: false,
        });
      }
      if (pass === 'triage-pass2') {
        // Inspect the Description: line specifically (existing-topics list also
        // mentions 'physics', so we can't just substring-match the whole prompt).
        const desc = (/Description:\s*(.+)/.exec(prompt) || [])[1] || '';
        if (desc.includes('physics')) {
          return JSON.stringify({ decision: 'match', path: 'science/physics' });
        }
        return JSON.stringify({ decision: 'new', path: 'life/parenting' });
      }
      return '{}';
    };
    const out = await classifySoft({
      groupId: 'g',
      messages: [{ role: 'user', body: 'hi' }],
      topicSummaries: [{ path: 'science/physics', summary: 'physics talks' }],
      llm,
    });
    expect(calls.filter(c => c === 'triage-pass1').length).toBe(1);
    expect(calls.filter(c => c === 'triage-pass2').length).toBe(2);
    const scopes = out.map(a => a.scope);
    expect(scopes).toContain('user');
    expect(scopes).toContain('group/g/topic/science/physics');
    expect(scopes).toContain('group/g/topic/life/parenting');
    const created = out.find(a => a.scope === 'group/g/topic/life/parenting');
    expect(created.kind).toBe('create');
  });
  it('rejects topic paths exceeding 2 levels', async () => {
    const llm = async ({ pass }) => {
      if (pass === 'triage-pass1') return JSON.stringify({ user_profile_signals: false, topics: ['too deep'] });
      return JSON.stringify({ decision: 'new', path: 'a/b/c' });
    };
    const out = await classifySoft({ groupId: 'g', messages: [], topicSummaries: [], llm });
    expect(out.find(a => /^group\/.+\/topic\//.test(a.scope))).toBeUndefined();
  });
  it('skips Pass-2 when Pass-1 returns no topics', async () => {
    const calls = [];
    const llm = async ({ pass }) => {
      calls.push(pass);
      return JSON.stringify({ user_profile_signals: false, topics: [], trivial_only: true });
    };
    const out = await classifySoft({ groupId: 'g', messages: [], topicSummaries: [], llm });
    expect(calls).toEqual(['triage-pass1']);
    expect(out).toEqual([]);
  });
  it('tolerates malformed Pass-2 responses', async () => {
    const llm = async ({ pass }) => {
      if (pass === 'triage-pass1') return JSON.stringify({ topics: ['x'] });
      return 'sorry, not JSON at all';
    };
    const out = await classifySoft({ groupId: 'g', messages: [], topicSummaries: [], llm });
    expect(out).toEqual([]);
  });
});

describe('triageOneSegment + triageGroupSegments', () => {
  it('combines hard + soft', async () => {
    const llm = async ({ pass }) => {
      if (pass === 'triage-pass1') return JSON.stringify({ topics: ['phys'] });
      return JSON.stringify({ decision: 'match', path: 'science/physics' });
    };
    const out = await triageOneSegment({
      groupId: 'g-eng',
      messages: [{ role: 'assistant', vpId: 'zhang-san' }],
      topicSummaries: [{ path: 'science/physics', summary: '' }],
      llm,
    });
    const scopes = out.map(a => a.scope);
    expect(scopes).toContain('user');
    expect(scopes).toContain('group/g-eng');
    expect(scopes).toContain('group/g-eng/vp/zhang-san');
    expect(scopes).toContain('group/g-eng/topic/science/physics');
  });
  it('dedupes across multiple segments', async () => {
    let calls = 0;
    const llm = async ({ pass }) => {
      calls += 1;
      if (pass === 'triage-pass1') return JSON.stringify({ user_profile_signals: false, topics: [] });
      return JSON.stringify({ decision: 'none' });
    };
    const segs = [
      { messages: [{ role: 'assistant', vpId: 'zhang-san' }] },
      { messages: [{ role: 'assistant', vpId: 'zhang-san' }] },
    ];
    const out = await triageGroupSegments({
      groupId: 'g',
      segments: segs,
      topicSummaries: [],
      llm,
    });
    // vp/zhang-san should appear once.
    expect(out.filter(a => a.scope === 'group/g/vp/zhang-san').length).toBe(1);
    expect(calls).toBe(2); // Pass-1 ran for each segment, no Pass-2 (no topics)
  });
});

describe('prompt builders contain expected scaffolding', () => {
  it('Pass-1 prompt mentions hard-rule exclusions', () => {
    const p = buildPass1Prompt({ groupId: 'g', messages: [{ role: 'user', body: 'hi' }], topicSummaries: [] });
    expect(p).toContain('user_profile_signals');
    expect(p).toContain('topics');
    expect(p).toMatch(/Do NOT mention vp\/, group\/, or feature\//);
  });
  it('Pass-2 prompt enforces ≤2 levels and shows existing topics', () => {
    const p = buildPass2Prompt({ description: 'physics', existingTopics: [{ path: 'science/physics', summary: 'x' }] });
    expect(p).toContain('At most TWO');
    expect(p).toContain('science/physics');
  });
});
