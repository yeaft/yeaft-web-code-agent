import { describe, it, expect } from 'vitest';
import { normalizePresentation, safePresentationUrl, PRESENTATION_SCHEMA } from '../../../agent/yeaft/response-presentation.js';

const payload = (blocks, overrides = {}) => ({ summary: 'Verified comparison; costs remain estimates.', blocks, ...overrides });
describe('shared response presentation contract', () => {
  it('snapshots every supported structure with plain-text fallback and bounded schema', () => {
    const blocks = [
      { type: 'markdown', text: '**Scope**: two options.' },
      { type: 'cards', items: [{ title: 'A', text: 'Small change', label: 'Recommended' }] },
      { type: 'metrics', items: [{ label: 'Tests', value: '24', detail: 'Passed locally' }] },
      { type: 'table', columns: ['Option', 'Cost'], rows: [['A', '10'], ['B', '20']] },
      { type: 'chart', style: 'bar', labels: ['A', 'B'], series: [{ label: 'Cost', values: [10, -20] }], unit: 'USD' },
      { type: 'timeline', items: [{ label: 'Today', title: 'Validate', text: 'Focused tests' }] },
      { type: 'diagram', nodes: [{ id: 'browser', label: 'Browser' }, { id: 'agent', label: 'Agent' }], edges: [{ from: 'browser', to: 'agent' }] },
      { type: 'image', url: 'https://example.com/image.png', alt: 'Observed output' },
      { type: 'link', url: 'https://example.com/report', text: 'Report' },
      { type: 'map', points: [{ label: 'Known location', latitude: 31.2, longitude: 121.5 }] },
    ];
    const source = payload(blocks);
    const result = normalizePresentation(source);
    expect(result).toMatchObject({ version: 1, phase: 'final', summary: source.summary, blocks });
    source.blocks[1].items[0].title = 'Changed';
    expect(result.blocks[1].items[0].title).toBe('A');
    expect(PRESENTATION_SCHEMA.properties.blocks.items.anyOf).toHaveLength(10);
    expect(normalizePresentation(payload([{ type: 'markdown', text: 'Partial evidence' }], { phase: 'progress' })).phase).toBe('progress');
  });

  it('rejects malformed geometry, fabricated structure, oversized content and identity injection atomically', () => {
    const bad = [
      payload([{ type: 'html', text: '<script>run()</script>' }]),
      payload([{ type: 'markdown', text: 'x', javascript: 'run()' }]),
      payload([{ type: 'table', columns: ['a', 'b'], rows: [['a']] }]),
      payload([{ type: 'chart', style: 'line', labels: ['a'], series: [{ label: 's', values: [1, 2] }] }]),
      payload([{ type: 'chart', style: 'line', labels: ['a'], series: [{ label: 's', values: [NaN] }] }]),
      payload([{ type: 'chart', style: 'bar', labels: ['a'], series: [{ label: 's', values: [Infinity] }] }]),
      payload([{ type: 'map', points: [{ label: 'a', latitude: 91, longitude: 0 }] }]),
      payload([{ type: 'map', points: [{ label: 'a', latitude: 0, longitude: -181 }] }]),
      payload([{ type: 'diagram', nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'missing' }] }]),
      payload([{ type: 'diagram', nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], edges: [] }]),
      payload([{ type: 'markdown', text: 'a'.repeat(12001) }]),
      payload(Array.from({ length: 13 }, () => ({ type: 'markdown', text: 'a' }))),
      payload([{ type: 'markdown', text: 'a' }], { summary: '' }),
      payload([{ type: 'markdown', text: 'a' }], { phase: 'done' }),
      payload([{ type: 'markdown', text: 'a' }], { sessionId: 'other-owner' }),
      payload(Array.from({ length: 8 }, () => ({ type: 'markdown', text: '中'.repeat(11000) }))),
    ];
    for (const input of bad) expect(() => normalizePresentation(input)).toThrow();
    expect(() => normalizePresentation(null)).toThrow();
  });

  it('treats URLs as credential-free metadata and never permits executable or local references', () => {
    for (const url of ['javascript:alert(1)', 'data:image/svg+xml,x', 'file:///etc/passwd', '/agent/other-owner/file', 'https://user:secret@example.com/x', 'https://example.com/\nscript', '//example.com/image']) {
      expect(() => safePresentationUrl(url)).toThrow();
      expect(() => normalizePresentation(payload([{ type: 'link', url, text: 'Bad' }]))).toThrow();
    }
    expect(safePresentationUrl('https://example.com')).toBe('https://example.com/');
    expect(safePresentationUrl('https://example.com/地图?x=1&y=2')).toContain('example.com/');
    const boundaryUrl = 'https://example.com/' + '中'.repeat(220);
    const accepted = normalizePresentation(payload([{ type: 'link', url: boundaryUrl, text: 'Report' }]));
    expect(accepted.blocks[0].url).toHaveLength(2000);
    expect(normalizePresentation({ summary: accepted.summary, blocks: accepted.blocks })).toEqual(accepted);
    for (const type of ['link', 'image']) {
      const input = { type, url: 'https://example.com/' + '中'.repeat(221), ...(type === 'link' ? { text: 'Report' } : { alt: 'Preview' }) };
      expect(() => normalizePresentation(payload([input]))).toThrow('URL exceeds 2000');
    }
    const suspicious = normalizePresentation(payload([{ type: 'cards', items: [{ title: '<img onerror=run()>', text: '<script>run()</script>' }] }]));
    expect(suspicious.blocks[0].items[0].text).toBe('<script>run()</script>'); // text stays data; renderer must escape it
  });
});
