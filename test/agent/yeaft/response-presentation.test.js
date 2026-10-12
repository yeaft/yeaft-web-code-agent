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

  it('keeps one tool and ten types while adding optional card imagery and official map embeds', () => {
    const card = { type: 'cards', items: [{ title: 'Team', text: 'Verified game information',
      image: { url: 'https://example.com/队标.png', alt: 'Official team logo', fit: 'contain' }, url: 'https://example.com' }] };
    const point = { label: 'Beijing', latitude: 39.9075, longitude: 116.39723 };
    const osm = { type: 'map', points: [point], embed: { provider: 'openstreetmap' } };
    const google = { ...osm, embed: { provider: 'google', url: 'https://www.google.com/maps/embed?pb=!1m18!2m3!1d1000' } };
    const result = normalizePresentation(payload([card, osm, google]));
    expect(result.version).toBe(1);
    expect(result.blocks[0].items[0].image.url).toContain('%E9%98%9F');
    expect(result.blocks[0].items[0].url).toBe('https://example.com/');
    expect(result.blocks[1]).toEqual(osm);
    expect(result.blocks[2]).toEqual(google);
    expect(normalizePresentation(payload(result.blocks))).toEqual(result);
    expect(PRESENTATION_SCHEMA.properties.blocks.items.anyOf).toHaveLength(10);
    card.items[0].image.alt = 'Changed';
    expect(result.blocks[0].items[0].image.alt).toBe('Official team logo');
  });

  it('rejects invalid optional media and arbitrary frames before publication', () => {
    const card = image => ({ type: 'cards', items: [{ title: 'Safe title', text: 'Safe text', image }] });
    const point = { label: 'Location', latitude: 0, longitude: 0 };
    const map = embed => ({ type: 'map', points: [point], embed });
    const bad = [
      card({ url: 'javascript:alert(1)', alt: 'Bad' }), card({ url: 'https://user:password@example.com/x', alt: 'Bad' }),
      card({ url: 'https://example.com/x' }), card({ url: 'https://example.com/x', alt: 'x', fit: 'stretch' }),
      { type: 'cards', items: [{ title: 'A', text: 'B', url: '/owner-secret' }] },
      map({ provider: 'other', url: 'https://example.com' }),
      map({ provider: 'openstreetmap', url: 'https://www.openstreetmap.org/export/embed.html' }),
      ...['https://www.google.com/maps', 'https://www.google.com/maps/embed/v1/directions?key=secret',
        'http://www.google.com/maps/embed?pb=!1m18', 'https://www.google.com:444/maps/embed?pb=!1m18',
        'https://www.google.com.evil.test/maps/embed?pb=!1m18', 'https://evil.test/maps/embed?pb=!1m18',
        'https://www.google.com/maps/embed?pb=!1m18&key=secret', 'https://www.google.com/maps/embed?pb=!1m18&pb=!1m18',
        'https://www.google.com/maps/embed?pb=', 'https://www.google.com/maps/embed?pb=madeup',
        'https://www.google.com/maps/embed?pb=!1m18#fragment', 'https://www.google.com/maps/embed?pb=!1m18%0A',
        'https://user:secret@www.google.com/maps/embed?pb=!1m18',
      ].map(url => map({ provider: 'google', url })),
      map({ provider: 'google' }), map({ provider: 'google', url: 'https://www.google.com/maps/embed?pb=!1m18', html: '<iframe>' }),
    ];
    for (const block of bad) expect(() => normalizePresentation(payload([{ type: 'markdown', text: 'First block' }, block]))).toThrow();
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
