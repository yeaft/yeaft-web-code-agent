// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { mount } from '@vue/test-utils';
import ResponsePresentation from '../web/components/ResponsePresentation.js';
import { projectPresentation, safeResponseUrl, chartGeometry, diagramGeometry, mapGeometry, responseMarkdown } from '../web/utils/response-presentation.js';
import { normalizePresentation } from '../agent/yeaft/response-presentation.js';
import en from '../web/i18n/en.js';
import zh from '../web/i18n/zh-CN.js';

const canonical = blocks => normalizePresentation({ title: 'Verified result', summary: 'A self-contained text summary.', blocks });
const chart = { type: 'chart', style: 'bar', labels: ['Before', 'After'], series: [{ label: 'Change', values: [-8, 12] }] };
const diagram = { type: 'diagram', nodes: [{ id: 'client', label: 'Client' }, { id: 'agent', label: 'Agent' }], edges: [{ from: 'client', to: 'agent', label: 'relay' }] };
const map = { type: 'map', points: [{ label: 'San Francisco', latitude: 37.7749, longitude: -122.4194 }, { label: 'Oakland', latitude: 37.8044, longitude: -122.2712 }] };
const blocks = [
  { type: 'markdown', text: '**Verified** and `safe`.' },
  { type: 'cards', items: [{ title: 'Plan', text: 'Build it', label: 'Next' }] },
  { type: 'metrics', items: [{ label: 'Checks', value: '24', detail: 'Passing' }] },
  { type: 'table', columns: ['Name', 'Status'], rows: [['Build', 'Pass']] },
  chart, { ...chart, style: 'line' },
  { type: 'timeline', items: [{ label: 'Today', title: 'Verify', text: 'Focused tests' }] },
  diagram, map,
  { type: 'image', url: 'https://images.example.test/preview.png', alt: 'Architecture preview', caption: 'External reference' },
  { type: 'link', url: 'https://example.test/report', text: 'Evidence' },
];
let wrapper;
const render = presentation => (wrapper = mount(ResponsePresentation, { props: { presentation }, global: { mocks: { $t: key => en[key] || key } } }));
beforeAll(() => {
  window.happyDOM.settings.navigation.disableChildPageNavigation = true;
  window.happyDOM.settings.navigation.disableMainFrameNavigation = true;
  const context = {};
  runInNewContext(readFileSync(`${process.cwd()}/web/vendor/marked.min.js`, 'utf8'), context);
  globalThis.marked = context.marked;
});
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('response presentation contract and security', () => {
  it('renders every canonical block, keeps full summary, and provides chart/diagram alternatives', async () => {
    render(canonical(blocks));
    expect(wrapper.findAll('.response-block')).toHaveLength(11);
    expect(wrapper.find('.response-summary').text()).toBe('A self-contained text summary.');
    expect(wrapper.findAll('svg')).toHaveLength(4);
    expect(wrapper.findAll('table')).toHaveLength(3);
    expect(wrapper.find('.response-markdown strong').text()).toBe('Verified');
    expect(wrapper.find('.response-map-list').text()).toContain('37.7749, -122.4194');
    expect(wrapper.find('.response-node-list').text()).toContain('Client');
    expect(wrapper.find('.response-edge-list').text()).toContain('Client → Agent · relay');
    expect(wrapper.find('.response-table-scroll').attributes('tabindex')).toBe('0');
    expect(wrapper.findAll('th').every(th => !!th.attributes('scope'))).toBe(true);
    expect(wrapper.find('a.response-link').attributes()).toMatchObject({ target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' });
    expect(wrapper.find('img').exists()).toBe(true);
  });

  it('fails closed for versions, oversized data, malformed shapes and unknown blocks while preserving summary', () => {
    for (const input of [null, { version: 2, summary: 'Older client text', blocks: [] }, { version: 1, summary: 'Valid summary', blocks: new Array(13).fill(chart) },
      { version: 1, summary: 'x'.repeat(8001), blocks: [chart] },
      { version: 1, summary: 'Valid summary', blocks: new Array(5).fill({ type: 'markdown', text: 'x'.repeat(12000) }) },
      { version: 1, summary: 'Valid summary', blocks: [{ type: 'markdown', text: 'text' }], circular: null, toJSON() { throw new Error('Not JSON'); } },
    ]) {
      const result = projectPresentation(input);
      expect(result.invalid).toBe(true);
      expect(result.blocks).toEqual([]);
    }
    const invalid = [
      { type: 'html', text: '<script>evil()</script>' },
      { type: 'table', columns: ['A', 'B'], rows: [['one']] },
      { ...chart, series: [{ label: 'X', values: [Infinity, 1] }] },
      { ...chart, series: [{ label: 'X', values: [1] }] },
      { ...diagram, edges: [{ from: 'missing', to: 'agent' }] },
      { ...diagram, nodes: [diagram.nodes[0], diagram.nodes[0]] },
      { ...map, points: [{ label: 'bad', latitude: 91, longitude: 0 }] },
      { type: 'image', url: 'javascript:alert(1)', alt: 'Bad' },
    ];
    const result = projectPresentation({ version: 1, summary: 'Readable summary', blocks: invalid });
    expect(result.blocks.every(b => b.type === 'unsupported')).toBe(true);
    render({ version: 2, summary: 'Readable summary', blocks: invalid });
    expect(wrapper.find('.response-summary').text()).toBe('Readable summary');
    expect(wrapper.find('.response-notice').text()).toBe(en['richResponse.invalid']);
  });

  it('allows only credential-free absolute HTTP(S) links', () => {
    for (const url of ['javascript:alert(1)', 'data:image/svg+xml,x', '//example.com', '/local', 'file:///etc/passwd', 'https://user:pass@example.com', 'https://user@example.com', 'https://example.com/\npath', ' https://example.com', 'ftp://example.com']) expect(safeResponseUrl(url)).toBe('');
    expect(safeResponseUrl('https://example.com/x?y=1#part')).toBe('https://example.com/x?y=1#part');
    expect(safeResponseUrl('http://example.com')).toBe('http://example.com/');
    expect(safeResponseUrl('https://example.com/' + '中'.repeat(300))).toBe('');
    const accepted = canonical([{ type: 'link', url: 'https://example.com/' + '中'.repeat(220), text: 'Report' }]);
    expect(projectPresentation(accepted).blocks[0].type).toBe('link');
    expect(projectPresentation({ ...accepted, blocks: [{ type: 'link', url: 'https://example.com/' + '中'.repeat(300), text: 'Too long' }] }).blocks[0].type).toBe('unsupported');
  });

  it('preserves and copies the ordinary text fallback when presentation summaries are unusable', async () => {
    const writeText = vi.fn().mockResolvedValue();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    for (const summary of [undefined, null, 42, '', '   ', 'x'.repeat(8001)]) {
      wrapper = mount(ResponsePresentation, { props: { presentation: { version: 1, summary, blocks: [] }, fallbackText: 'Readable answer' }, global: { mocks: { $t: key => en[key] || key } } });
      expect(wrapper.get('.response-summary').text()).toBe('Readable answer');
      await wrapper.get('.response-copy').trigger('click');
      expect(writeText).toHaveBeenLastCalledWith('Readable answer');
      wrapper.unmount();
    }
  });

  it('renders markdown through safe tokens, never mounts raw HTML, image, SVG or event handlers', () => {
    const source = '**Hello** [bad](javascript:alert(1)) [credentials](https://user:pass@example.com) [ok](https://example.com) ![tracking](https://track.example.com/x)\n\n<img src="x" onerror="alert(1)"><svg onload="alert(1)"><script>alert(1)</script></svg>\n\n| Name | Value |\n| --- | --- |\n| Safe | 1 |';
    render(canonical([{ type: 'markdown', text: source }]));
    expect(wrapper.findAll('a')).toHaveLength(2);
    expect(wrapper.find('a').attributes('href')).toBe('https://example.com/');
    expect(wrapper.find('a').attributes('rel')).toBe('noopener noreferrer');
    expect(wrapper.findAll('img, svg, script, [onerror], [onload]')).toHaveLength(0);
    expect(wrapper.find('.response-markdown').text()).toContain('<img');
    expect(wrapper.find('.response-markdown table').exists()).toBe(true);
    expect(responseMarkdown('```mermaid\ngraph TD; A-->B\n```')[0].tag).toBe('pre');
  });

  it('automatically loads images, handles errors/retries/preview, and ignores detached image events', async () => {
    render(canonical([blocks[9]]));
    expect(wrapper.find('img').attributes('src')).toBe(blocks[9].url);
    expect(wrapper.find('img').attributes('referrerpolicy')).toBe('no-referrer');
    expect(wrapper.find('.response-image button').exists()).toBe(false);
    await wrapper.find('img').trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('.response-image-placeholder').text()).toContain(en['richResponse.imageError']);
    await wrapper.find('.response-image button').trigger('click');
    const oldImage = wrapper.find('img');
    await oldImage.trigger('load');
    await wrapper.find('.response-image button').trigger('click');
    expect(wrapper.find('.response-image').classes()).toContain('is-expanded');
    await wrapper.setProps({ presentation: canonical([{ ...blocks[9], url: 'https://other.example.test/new.png' }]) });
    expect(wrapper.find('img').attributes('src')).toBe('https://other.example.test/new.png');
    expect(wrapper.find('.response-image').classes()).not.toContain('is-expanded');
    await oldImage.trigger('error');
    expect(wrapper.find('img').exists()).toBe(true);
    expect(wrapper.find('.response-image button').exists()).toBe(false);
    await wrapper.find('img').trigger('load');
    expect(wrapper.find('img').isVisible()).toBe(true);
  });

  it('routes markdown and delivery links to the owning browser, leaving explicit new tabs and modifiers native', async () => {
    const openLink = vi.fn(() => true);
    render(canonical([{ type: 'markdown', text: '[Source](https://example.test/source)' }, blocks[10]]));
    await wrapper.setProps({ openLink });
    for (const selector of ['.response-markdown a:not([data-response-external])', 'a.response-link']) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      wrapper.get(selector).element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(openLink.mock.calls).toEqual([['https://example.test/source'], [blocks[10].url]]);
    for (const selector of ['.response-markdown a[data-response-external]', '.response-link-row a[data-response-external]']) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      wrapper.get(selector).element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...options });
      wrapper.get('a.response-link').element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(openLink).toHaveBeenCalledTimes(2);
  });

  it('does not silently open new tabs when the owning browser is missing or rejects navigation', async () => {
    render(canonical([blocks[10]]));
    for (const openLink of [null, vi.fn(() => false)]) {
      await wrapper.setProps({ openLink });
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      wrapper.get('a.response-link').element.dispatchEvent(event);
      await wrapper.vm.$nextTick();
      expect(event.defaultPrevented).toBe(true);
      expect(wrapper.find('.response-status').text()).toBe(en['richResponse.browserUnavailable']);
    }
  });

  it('consumes ordinary control-plane links without opening the browser or a new tab', async () => {
    const openLink = vi.fn(() => true);
    render(canonical([{ type: 'link', url: new URL('/source', window.location.origin).href, text: 'Local source' }]));
    await wrapper.setProps({ openLink });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    wrapper.get('a.response-link').element.dispatchEvent(event);
    await wrapper.vm.$nextTick();
    expect(event.defaultPrevented).toBe(true);
    expect(openLink).not.toHaveBeenCalled();
    expect(wrapper.find('.response-status').text()).toBe(en['richResponse.browserUnavailable']);
  });

  it('uses an injected WorkItem browser instead of consulting a hidden Session', () => {
    const opener = vi.fn(() => true);
    wrapper = mount(ResponsePresentation, { props: { presentation: canonical([blocks[10]]) },
      global: { provide: { 'workbench-browser-opener': opener }, mocks: { $t: key => en[key] || key } } });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    wrapper.get('a.response-link').element.dispatchEvent(event);
    expect(opener).toHaveBeenCalledWith(blocks[10].url);
    expect(event.defaultPrevented).toBe(true);
  });

  it('copies only the canonical summary and provides a selected-text fallback when clipboard fails', async () => {
    const writeText = vi.fn().mockResolvedValue();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(canonical([chart]));
    await wrapper.find('.response-copy').trigger('click');
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('A self-contained text summary.');
    expect(wrapper.text()).toContain(en['richResponse.copied']);
    writeText.mockRejectedValue(new Error('Denied'));
    await wrapper.find('.response-copy').trigger('click');
    await Promise.resolve();
    expect(wrapper.text()).toContain(en['richResponse.copyFallback']);
    let resolveCopy;
    writeText.mockImplementation(() => new Promise(resolve => { resolveCopy = resolve; }));
    await wrapper.find('.response-copy').trigger('click');
    await wrapper.setProps({ presentation: canonical([{ ...chart, title: 'Replacement response' }]) });
    resolveCopy();
    await Promise.resolve();
    expect(wrapper.find('.response-status').exists()).toBe(false);
  });

  it('keeps geometry finite for zeros, signed extremes, coincident points, poles and self edges', () => {
    for (const values of [[0, 0], [-1e12, 1e12], [5, 5], [-2, -2]]) {
      const geometry = chartGeometry({ ...chart, series: [{ label: 'data', values }] });
      for (const p of geometry.series[0].points) for (const key of ['x', 'y', 'barX', 'barY', 'width', 'height']) expect(Number.isFinite(p[key])).toBe(true);
      expect(geometry.series[0].points.every(p => p.height >= 0)).toBe(true);
    }
    for (const p of [{ latitude: 90, longitude: 180 }, { latitude: -90, longitude: -180 }, { latitude: 0, longitude: 0 }]) {
      const geometry = mapGeometry({ points: [{ label: 'A', ...p }, { label: 'B', ...p }] });
      expect(geometry.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    }
    const normal = mapGeometry(map);
    expect(normal.points[1].x).toBeGreaterThan(normal.points[0].x);
    expect(normal.points[1].y).toBeLessThan(normal.points[0].y);
    expect(diagramGeometry({ ...diagram, edges: [{ from: 'client', to: 'client' }] }).edges[0].arrow).not.toMatch(/NaN|Infinity/);
  });

  it('has matching bilingual local strings and progress does not claim task success', () => {
    const keys = Object.keys(en).filter(key => key.startsWith('richResponse.'));
    expect(keys.every(key => typeof zh[key] === 'string')).toBe(true);
    render({ ...canonical([chart]), phase: 'progress' });
    expect(wrapper.find('.response-phase').text()).toBe('Progress update');
    expect(wrapper.text()).not.toContain('Completed');
  });
});
