import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDreamDebugItems, parseDreamMemorySegments } from '../../web/components/dream-debug-model.js';

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

  it('defines a fixed Dream shell with internal scroll containers', () => {
    const css = readFileSync(resolve(repoRoot, 'web/styles/yeaft.css'), 'utf8');

    expect(css).toContain('.yeaft-debug-dream-shell');
    expect(css).toMatch(/\.yeaft-debug-dream-panel\s*\{[\s\S]*?overflow:\s*hidden;/);
    expect(css).toMatch(/\.yeaft-debug-dream-list,[\s\S]*?\.yeaft-debug-dream-segments\s*\{[\s\S]*?overflow-y:\s*auto;/);
    expect(css).toMatch(/\.yeaft-debug-scroll-pre\s*\{[\s\S]*?overflow:\s*auto;/);
  });
});
