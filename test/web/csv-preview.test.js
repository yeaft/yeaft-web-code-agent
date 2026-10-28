// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';
import { CSV_PREVIEW_LIMITS as limits, parseCsvPreview } from '../../web/utils/csv-preview.js';
import CsvPreview from '../../web/components/files/CsvPreview.js';
import { getFileType, isCsvFile, isPreviewableTextFile, updateFileText } from '../../web/components/files/fileEditor.js';
import { createFilePreview } from '../../web/components/files/filePreview.js';

const t = (key, values = {}) => `${key} ${JSON.stringify(values)}`;
afterEach(() => vi.unstubAllGlobals());

describe('CSV preview', () => {
  it('preserves CSV values, quoting, BOM, Unicode, newline forms, empty fields and ragged records', () => {
    const source = '\ufeff名称,备注,数量\r\n"A,B","line 1\r\nline ""2""",001\rC,,\n\n"",=SUM(A1:A2),<img src=x onerror=alert(1)>\n';
    const parsed = parseCsvPreview(source);
    expect(parsed.rows).toEqual([
      ['名称', '备注', '数量'], ['A,B', 'line 1\r\nline "2"', '001'], ['C', '', ''], [''],
      ['', '=SUM(A1:A2)', '<img src=x onerror=alert(1)>'],
    ]);
    expect(parsed.columnCount).toBe(3);
    expect(parsed.error).toBeNull();
    expect(Object.values(parsed.limited).some(Boolean)).toBe(false);
    expect(parseCsvPreview('').rows).toEqual([]);
    expect(parseCsvPreview('\ufeff').rows).toEqual([]);
    expect(parseCsvPreview('""').rows).toEqual([['']]);
    expect(parseCsvPreview('a,b,').rows).toEqual([['a', 'b', '']]);
    expect(parseCsvPreview('a\r\n').rows).toEqual([['a']]);
    expect(parseCsvPreview('a\r\n\r\n').rows).toEqual([['a'], ['']]);
    expect(parseCsvPreview('a\rb\nc\r\nd').rows).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('reports malformed records without silently inventing cells, while keeping Edit available', () => {
    for (const source of ['good,row\n"unclosed', 'good,row\n"closed"tail,x', 'good,row\na"b,c']) {
      const parsed = parseCsvPreview(source);
      expect(parsed.error).toEqual({ record: 2 });
      expect(parsed.rows).toEqual([['good', 'row']]);
    }
    expect(isCsvFile('report.CSV')).toBe(true);
    expect(isCsvFile('report.csv.js')).toBe(false);
    expect(isPreviewableTextFile('report.CSV')).toBe(true);
    expect(getFileType('report.CSV')).toBe('text');
    const file = { originalContent: 'name,value\r\nquoted,001\r\n', content: '' };
    updateFileText(file, 'changed,value\nquoted,001\n');
    expect(file.isDirty).toBe(true);
    updateFileText(file, 'name,value\nquoted,001\n');
    expect(file.isDirty).toBe(false);
    expect(file.content).toBe(file.originalContent);
    vi.stubGlobal('Vue', Vue);
    const scope = Vue.effectScope();
    scope.run(() => {
      const activeFile = Vue.ref({ name: 'report.csv', content: '"unclosed' });
      const createEditor = vi.fn();
      const editorContainer = Vue.ref(document.createElement('div'));
      const preview = createFilePreview(activeFile, { editorContainer, createEditor });
      expect(preview.isActiveCsv.value).toBe(true);
      expect(preview.textPreviewMode.value).toBe(true);
      preview.switchToTextEdit();
      expect(preview.textPreviewMode.value).toBe(false);
    });
    scope.stop();
  });

  it('bounds records, columns, cell content and parsing work, never labeling a scan-cut record malformed', () => {
    const exactRows = Array(limits.rows).fill('a,b').join('\n');
    expect(parseCsvPreview(exactRows).limited.rows).toBe(false);
    const rows = parseCsvPreview(exactRows + '\nlast,row');
    expect(rows.rows).toHaveLength(limits.rows);
    expect(rows.limited.rows).toBe(true);
    const columns = parseCsvPreview(Array(limits.columns + 1).fill('x').join(','));
    expect(columns.columnCount).toBe(limits.columns);
    expect(columns.rows[0]).toHaveLength(limits.columns);
    expect(columns.limited.columns).toBe(true);
    const cell = parseCsvPreview('x'.repeat(limits.cellCharacters + 1));
    expect(cell.rows[0][0]).toHaveLength(limits.cellCharacters + 1);
    expect(cell.rows[0][0].endsWith('…')).toBe(true);
    expect(cell.limited.cell).toBe(true);
    const source = 'header\n"' + 'x'.repeat(limits.sourceCharacters) + '"';
    const scan = parseCsvPreview(source);
    expect(scan.rows).toEqual([['header']]);
    expect(scan.limited.source).toBe(true);
    expect(scan.error).toBeNull();
    // Do not show a partial unquoted record either, even at a CRLF boundary.
    const boundary = 'x'.repeat(limits.sourceCharacters - 1) + '\r\nnext';
    expect(parseCsvPreview(boundary).rows).toHaveLength(1);
    expect(parseCsvPreview(boundary).limited.source).toBe(true);
  });

  it('renders only inert text with optional headers, bounded pages, empty/error notices and source reset', async () => {
    vi.stubGlobal('Vue', Vue);
    const source = 'name,note\n' + Array.from({ length: 60 }, (_, i) => `${i},"<img src=x onerror=alert(1)>"`).join('\n');
    const wrapper = mount(CsvPreview, {
      props: { content: source, name: 'report.csv' },
      global: { mocks: { $t: t } },
    });
    try {
      expect(wrapper.findAll('tbody tr')).toHaveLength(50);
      expect(wrapper.find('img, script, iframe, a').exists()).toBe(false);
      expect(wrapper.get('tbody td').text()).toBe('0');
      expect(wrapper.get('tbody tr td:nth-of-type(2)').text()).toBe('<img src=x onerror=alert(1)>');
      expect(wrapper.get('thead th:nth-child(2)').text()).toBe('name');
      expect(wrapper.get('.csv-preview-scroll').attributes('tabindex')).toBe('0');
      expect(wrapper.findAll('button')[0].element.disabled).toBe(true);
      await wrapper.findAll('button')[1].trigger('click');
      expect(wrapper.findAll('tbody tr')).toHaveLength(10);
      expect(wrapper.get('tbody td').text()).toBe('50');
      expect(wrapper.findAll('button')[1].element.disabled).toBe(true);
      await wrapper.get('input').setValue(false);
      expect(wrapper.get('tbody td').text()).toBe('name');
      expect(wrapper.get('thead th:nth-child(2)').text()).toContain('files.csvColumn');
      await wrapper.setProps({ content: '' });
      expect(wrapper.get('[role="status"]').text()).toContain('files.csvEmpty');
      expect(wrapper.find('table').exists()).toBe(false);
      await wrapper.setProps({ content: '"' + 'x'.repeat(limits.sourceCharacters) + '"' });
      expect(wrapper.text()).toContain('files.csvNoCompleteRecords');
      expect(wrapper.text()).not.toContain('files.csvEmpty');
      expect(wrapper.find('table').exists()).toBe(false);
      await wrapper.setProps({ content: '"bad' });
      expect(wrapper.get('[role="alert"]').text()).toContain('files.csvInvalid');
      expect(wrapper.find('table').exists()).toBe(false);
      await wrapper.setProps({ content: 'a\n' + 'b\n'.repeat(limits.rows) });
      expect(wrapper.get('.csv-preview-notice').text()).toContain('files.csvLimited');
      expect(wrapper.findAll('tbody tr')).toHaveLength(50);
    } finally { wrapper.unmount(); }
  });
});
