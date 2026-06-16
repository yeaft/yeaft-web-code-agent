import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDreamDebugItems, filterDreamDebugItems, parseDreamMemorySegments, selectDreamDebugItem } from '../../web/components/dream-debug-model.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('Dream debug model', () => {
  it('parses memory.md frontmatter into structured segment cards', () => {
    const memory = `---\nid: seg_1234\nscope: sessions/s1\nkind: decision\ntags: [dream, debug]\nsourceMessages: [m1, m2]\ncreatedAt: 2026-06-01T10:00:00Z\nupdatedAt: 2026-06-01T11:00:00Z\n---\nKeep Dream debug inspectable.\n\n---\nid: seg_5678\nkind: lesson\ntags: ui\nsourceMessages: m3\n---\nLong raw memory belongs in a nested scroll container.`;

    const segments = parseDreamMemorySegments(memory);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      id: 'seg_1234',
      scope: 'sessions/s1',
      kind: 'decision',
      tags: ['dream', 'debug'],
      sourceMessages: ['m1', 'm2'],
      createdAt: '2026-06-01T10:00:00Z',
      updatedAt: '2026-06-01T11:00:00Z',
      content: 'Keep Dream debug inspectable.',
    });
    expect(segments[1].sourceMessages).toEqual(['m3']);
  });

  it('builds scope items with detail layers and request/response availability', () => {
    const items = buildDreamDebugItems({
      latest: {
        'sessions/s1': { scope: 'sessions/s1', status: 'success', finishedAt: '2026-06-02T12:00:00Z' },
      },
      snapshots: {
        'sessions/s1': {
          scope: 'sessions/s1',
          sessionId: 's1',
          hasOutput: true,
          loadedAt: '2026-06-02T12:00:01Z',
          lastDreamAt: '2026-06-02T12:00:00Z',
          messageCount: 42,
          summaryText: 'Resident summary for the session.',
          memoryText: '---\nid: seg_a\nkind: fact\ntags: [x]\nsourceMessages: [m1]\n---\nFact body.',
        },
      },
      promptLoads: {
        'sessions/s1': { scope: 'sessions/s1', summary: 'summary.md -> prompt' },
      },
      events: [
        { scope: 'sessions/s1', phase: 'loop', at: '2026-06-02T12:00:02Z', systemPrompt: 'system', response: { ok: true } },
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: 'sessions/s1',
      sessionId: 's1',
      status: 'success',
      segmentCount: 1,
      hasRequestResponse: true,
    });
    expect(items[0].segments[0].id).toBe('seg_a');
    expect(items[0].summaryPreview).toContain('Resident summary');
  });

  it('keeps request/response explicitly empty when no persisted event data exists', () => {
    const items = buildDreamDebugItems({
      snapshots: {
        'sessions/s2': { scope: 'sessions/s2', hasOutput: true, memoryText: 'body only memory' },
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0].hasRequestResponse).toBe(false);
    expect(items[0].segments).toHaveLength(1);
    expect(items[0].segments[0].id).toBe('memory-1');
  });

  it('defines a scrollable Dream accordion without the old two-pane shell', () => {
    const css = readFileSync(resolve(repoRoot, 'web/styles/yeaft.css'), 'utf8');

    expect(css).not.toContain('.yeaft-debug-dream-shell');
    expect(css).not.toContain('grid-template-columns: minmax(220px, 32%) minmax(0, 1fr)');
    expect(css).toMatch(/\.yeaft-debug-dream-panel\s*\{[\s\S]*?overflow:\s*hidden;/);
    expect(css).toMatch(/\.yeaft-debug-dream-list\s*\{[\s\S]*?overflow-y:\s*auto;/);
    expect(css).toMatch(/\.yeaft-debug-dream-detail\s*\{[\s\S]*?max-height:\s*min\(560px, 62vh\);[\s\S]*?overflow:\s*hidden;/);
    expect(css).toMatch(/\.yeaft-debug-scroll-pre\s*\{[\s\S]*?overflow:\s*auto;/);
  });

  it('renders Dream items as an inline accordion and keeps ids out of collapsed subtitles', () => {
    const component = readFileSync(resolve(repoRoot, 'web/components/YeaftDebugPanel.js'), 'utf8');

    expect(component).toContain('yeaft-debug-dream-accordion-item');
    expect(component).toContain('activeDreamItem && activeDreamItem.key === item.key');
    expect(component).toContain('v-if="item.subtitle"');
    expect(component).not.toContain("item.summaryPreview || item.scope");
    expect(component).toContain("allDreamItems.length ? $t('yeaft.dreamDebug.noSearchResults') : $t('yeaft.dreamDebug.empty')");
  });

  it('uses readable session titles while keeping ids as metadata', () => {
    const items = buildDreamDebugItems({
      snapshots: {
        'sessions/session_internal_123': {
          sessionId: 'session_internal_123',
          hasOutput: true,
          summaryText: '# Raw fallback title',
          memoryText: 'memory',
        },
      },
      sessionTitles: {
        session_internal_123: 'Customer onboarding debug',
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Customer onboarding debug');
    expect(items[0].sessionId).toBe('session_internal_123');
    expect(items[0].scope).toBe('sessions/session_internal_123');
    expect(items[0].title).not.toContain('session_internal_123');
  });

  it('does not use scope or session id as the visible list subtitle', () => {
    const items = buildDreamDebugItems({
      latest: {
        'sessions/session_without_summary': { status: 'never-ran', startedAt: '2026-06-02T10:00:00Z' },
      },
      sessionTitles: {
        session_without_summary: 'Readable session',
      },
    });

    expect(items[0].title).toBe('Readable session');
    expect(items[0].subtitle).toBe('');
    expect(items[0].subtitle).not.toContain('session_without_summary');
    expect(items[0].subtitle).not.toContain('sessions/session_without_summary');
  });

  it('falls back to a summary heading only when no session title is available', () => {
    const items = buildDreamDebugItems({
      snapshots: {
        'sessions/session_missing_title': {
          sessionId: 'session_missing_title',
          hasOutput: true,
          summaryText: '## Memory maintenance notes\nMore text',
        },
      },
    });

    expect(items[0].title).toBe('Memory maintenance notes');
  });

  it('filters dream items by title, id, and summary preview', () => {
    const items = buildDreamDebugItems({
      snapshots: {
        'sessions/session_a': { sessionId: 'session_a', summaryText: 'Alpha summary' },
        'sessions/session_b': { sessionId: 'session_b', summaryText: 'Dreams about tool reliability' },
      },
      sessionTitles: {
        session_a: 'Roadmap planning',
        session_b: 'Operations review',
      },
    });

    expect(filterDreamDebugItems(items, 'roadmap').map((item) => item.sessionId)).toEqual(['session_a']);
    expect(filterDreamDebugItems(items, 'session_b').map((item) => item.title)).toEqual(['Operations review']);
    expect(filterDreamDebugItems(items, 'tool reliability').map((item) => item.sessionId)).toEqual(['session_b']);
    expect(filterDreamDebugItems(items, 'nope')).toEqual([]);
  });

  it('selects an active Dream item for the detail pane and falls back to the first filtered item', () => {
    const items = buildDreamDebugItems({
      latest: {
        'sessions/session_a': { status: 'success', finishedAt: '2026-06-02T10:00:00Z' },
        'sessions/session_b': { status: 'success', finishedAt: '2026-06-02T11:00:00Z' },
      },
      sessionTitles: {
        session_a: 'Alpha',
        session_b: 'Beta',
      },
    });

    expect(selectDreamDebugItem(items, 'sessions/session_a').sessionId).toBe('session_a');
    expect(selectDreamDebugItem(items, 'missing').sessionId).toBe('session_b');
    expect(selectDreamDebugItem([], 'sessions/session_a')).toBeNull();
  });

});
