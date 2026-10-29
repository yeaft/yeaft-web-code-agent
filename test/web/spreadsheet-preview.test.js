// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';
import PreviewTable from '../../web/components/files/PreviewTable.js';
import SpreadsheetPreview from '../../web/components/files/SpreadsheetPreview.js';
import {
  SPREADSHEET_PREVIEW_LIMITS as limits, readSpreadsheetNames, readSpreadsheetSheet,
  spreadsheetColumn, spreadsheetSelectionText, spreadsheetViewRows,
} from '../../web/utils/spreadsheet-preview.js';

const sandbox = {};
runInNewContext(readFileSync('web/vendor/xlsx.min.js', 'utf8'), sandbox);
const XLSX = sandbox.XLSX;
const t = key => key;
const bufferFor = (sheet, bookType = 'xlsx', name = 'Data') => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, name);
  return XLSX.write(book, { type: 'array', bookType });
};
afterEach(() => vi.unstubAllGlobals());

describe('read-only spreadsheet preview', () => {
  it('reads real XLSX and XLS values, worksheets, formatted dates, cached formulas and literal hostile text without HTML', () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['name', 'value', 'date'], ['<img src=x onerror=alert(1)>', 42, new Date('2026-01-02T00:00:00Z')],
    ]);
    sheet.C2 = { t: 'n', v: 46024, z: 'm/d/yy' }; // Date serial, independent of the test VM realm.
    sheet.B2 = { t: 'n', v: 42, f: 'SUM(40,2)' };
    sheet.B3 = { t: 'n', f: 'WEBSERVICE("https://example.com")' };
    sheet['!ref'] = 'A1:C3';
    for (const bookType of ['xlsx', 'xls']) {
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, '<svg onload=alert(1)>');
      XLSX.utils.book_append_sheet(book, {}, 'Empty');
      const buffer = XLSX.write(book, { type: 'array', bookType });
      expect(readSpreadsheetNames(XLSX, buffer).names).toEqual(['<svg onload=alert(1)>', 'Empty']);
      const parsed = readSpreadsheetSheet(XLSX, buffer, '<svg onload=alert(1)>');
      expect(parsed.rows[1]).toEqual(['<img src=x onerror=alert(1)>', '42', '1/2/26']);
      expect(parsed.rows[2][1]).toBe('');
      expect(readSpreadsheetSheet(XLSX, buffer, 'Empty').rows).toEqual([]);
    }
    expect(() => readSpreadsheetNames(XLSX, new ArrayBuffer(limits.bytes + 1))).toThrow('size');
    expect(() => readSpreadsheetNames(XLSX, new ArrayBuffer(0))).toThrow('size');
    expect(() => readSpreadsheetNames(XLSX, new TextEncoder().encode('not a workbook').buffer)).toThrow('invalid');
  });

  it('bounds sparse huge ranges, rows, columns, cell text and total text before rendering', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['x'.repeat(limits.cellCharacters + 1), 'b']]);
    sheet['!ref'] = 'A1:XFD1048576';
    const read = vi.fn(() => ({ Sheets: { Data: sheet } }));
    const parsed = readSpreadsheetSheet({ read, utils: XLSX.utils }, new ArrayBuffer(1), 'Data');
    expect(read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sheets: ['Data'], sheetRows: limits.rows, cellHTML: false, cellFormula: false }));
    expect(parsed.rows).toHaveLength(limits.rows);
    expect(parsed.columnCount).toBe(limits.columns);
    expect(parsed.limited).toMatchObject({ rows: true, columns: true, cell: true });
    expect(parsed.rows[0][0]).toHaveLength(limits.cellCharacters + 1);
    const full = XLSX.utils.aoa_to_sheet(Array.from({ length: 11 }, () => Array(10).fill('a'.repeat(limits.cellCharacters))));
    const bounded = readSpreadsheetSheet({ read: () => ({ Sheets: { Data: full } }), utils: XLSX.utils }, new ArrayBuffer(1), 'Data');
    expect(bounded.rows).toHaveLength(10);
    expect(bounded.limited.characters).toBe(true);
    expect(readSpreadsheetSheet(XLSX, bufferFor(XLSX.utils.aoa_to_sheet(Array.from({ length: limits.rows + 1 }, () => ['x']))), 'Data').limited.rows).toBe(true);
    const names = readSpreadsheetNames({ read: () => ({ SheetNames: Array.from({ length: limits.sheets + 1 }, (_, i) => String(i)) }) }, new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer);
    expect(names.names).toHaveLength(limits.sheets);
    expect(names.sheetsLimited).toBe(true);
  });

  it('keeps stable source row identities while sorting/filtering and serializes reversed selections as quoted TSV', () => {
    const rows = [['name', 'n'], ['same', '10'], ['same', '2'], ['other', '2'], ['tabs\tand\n"quotes"']];
    const original = JSON.stringify(rows);
    const view = spreadsheetViewRows(rows, { firstRowHeader: true, sortColumn: 1, sortDirection: 1, query: 'SAME' });
    expect(view.map(row => row.number)).toEqual([3, 2]);
    expect(spreadsheetViewRows(rows, { query: 'same', filterColumn: 1 })).toEqual([]);
    expect(spreadsheetViewRows(rows, { firstRowHeader: true, sortColumn: 1, sortDirection: -1 }).map(row => row.number)).toEqual([2, 3, 4, 5]);
    const selection = { anchor: { row: 1, column: 1 }, focus: { row: 0, column: 0 } };
    expect(spreadsheetSelectionText(view, selection)).toBe('same\t2\nsame\t10');
    expect(spreadsheetSelectionText([{ values: rows[4] }], { anchor: { row: 0, column: 0 }, focus: { row: 0, column: 1 } })).toBe('"tabs\tand\n""quotes"""\t');
    expect(JSON.stringify(rows)).toBe(original);
    expect([0, 25, 26, 99].map(spreadsheetColumn)).toEqual(['A', 'Z', 'AA', 'CV']);
  });

  it('shares inert CSV/Excel table sorting, column search, page reset, keyboard selection and clipboard failure recovery', async () => {
    vi.stubGlobal('Vue', Vue);
    const wrapper = mount(PreviewTable, { props: {
      name: 'data', columnCount: 2, rows: [['name', 'n'], ...Array.from({ length: 60 }, (_, i) => [`<a href=evil>${i}`, String(60 - i)])],
    }, global: { mocks: { $t: t } } });
    try {
      expect(wrapper.find('a').exists()).toBe(false);
      await wrapper.findAll('.table-sort')[1].trigger('click');
      expect(wrapper.get('tbody td:nth-of-type(2)').text()).toBe('1');
      expect(wrapper.get('tbody th').text()).toBe('61');
      await wrapper.get('tbody td').trigger('mousedown', { button: 0 });
      await wrapper.get('tbody td').trigger('keydown', { key: 'ArrowRight', shiftKey: true });
      expect(wrapper.findAll('.table-cell-selected')).toHaveLength(2);
      const setData = vi.fn();
      await wrapper.get('.csv-preview-scroll').trigger('copy', { clipboardData: { setData } });
      expect(setData).toHaveBeenCalledWith('text/plain', '<a href=evil>59\t1');
      vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
      await wrapper.get('.table-copy').trigger('click');
      await Vue.nextTick();
      expect(wrapper.text()).toContain('files.tableCopyFailed');
      await wrapper.findAll('tbody tr')[49].find('td').trigger('mousedown', { button: 0 });
      expect(wrapper.vm.selectionLabel).toBe('A12:A12');
      wrapper.vm.page = 1;
      expect(wrapper.vm.selection).toBeNull(); // Must clear before the shorter page renders.
      await Vue.nextTick();
      expect(wrapper.findAll('tbody tr')).toHaveLength(10);
      wrapper.vm.selection = { anchor: { row: 49, column: 0 }, focus: { row: 49, column: 0 } };
      expect(wrapper.vm.selectionLabel).toBe(''); // Defensive against stale/out-of-range state.
      wrapper.vm.selection = null;
      expect(wrapper.get('.table-copy').element.disabled).toBe(true);
      await wrapper.get('input[type=search]').setValue('59');
      expect(wrapper.findAll('tbody tr')).toHaveLength(2); // n=59 and name=59
      await wrapper.get('select').setValue('1');
      expect(wrapper.findAll('tbody tr')).toHaveLength(1);
      await wrapper.get('input[type=search]').setValue('no match');
      expect(wrapper.text()).toContain('files.tableNoMatches');
      await wrapper.setProps({ rows: [] });
      expect(wrapper.text()).toContain('files.tableEmpty');
    } finally { wrapper.unmount(); }
  });

  it('fences worker replies, renders hostile sheet names safely, handles errors/deadlines and terminates on disposal', async () => {
    vi.stubGlobal('Vue', Vue);
    vi.useFakeTimers();
    const workers = [];
    class Worker {
      constructor(url) { this.url = url; this.messages = []; this.terminate = vi.fn(); workers.push(this); }
      postMessage(message) { this.messages.push(message); }
      reply(result, id = this.messages.at(-1).id) { this.onmessage({ data: { id, result } }); }
    }
    vi.stubGlobal('Worker', Worker);
    const wrapper = mount(SpreadsheetPreview, { props: { name: 'data.xlsx', buffer: new ArrayBuffer(1) }, global: { mocks: { $t: t } } });
    try {
      const worker = workers[0];
      expect(worker.url.pathname).toBe(`${process.cwd()}/web/spreadsheet-worker.js`);
      worker.reply({ names: ['<img src=x>', 'Empty'], sheetsLimited: false });
      await Vue.nextTick();
      expect(wrapper.find('img').exists()).toBe(false);
      expect(wrapper.get('.xlsx-sheet-tab').text()).toBe('<img src=x>');
      worker.reply({ rows: [['<script>evil</script>']], columnCount: 1, limited: {} });
      await Vue.nextTick();
      expect(wrapper.get('tbody td').text()).toBe('<script>evil</script>');
      expect(wrapper.find('script').exists()).toBe(false);
      await wrapper.findAll('.xlsx-sheet-tab')[1].trigger('click');
      worker.reply({ rows: [['stale']], columnCount: 1, limited: {} }, 2);
      await Vue.nextTick();
      expect(wrapper.find('tbody').exists()).toBe(false);
      worker.reply({ rows: [], columnCount: 0, limited: {} });
      await Vue.nextTick();
      expect(wrapper.text()).toContain('files.tableEmpty');
      await wrapper.setProps({ buffer: new ArrayBuffer(2) });
      expect(worker.terminate).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(limits.timeoutMs);
      expect(wrapper.get('[role=alert]').text()).toContain('files.sheetError');
      expect(workers[1].terminate).toHaveBeenCalled();
      await wrapper.get('[role=alert] button').trigger('click');
      workers[2].reply({ names: ['Broken', 'Other'], sheetsLimited: false });
      workers[2].onmessage({ data: { id: workers[2].messages.at(-1).id, error: 'password protected' } });
      await Vue.nextTick();
      expect(wrapper.get('[role=alert]').text()).toContain('files.sheetError');
      expect(wrapper.text()).not.toContain('password protected');
      expect(wrapper.findAll('.xlsx-sheet-tab').every(tab => tab.element.disabled)).toBe(true);
      const messageCount = workers[2].messages.length;
      wrapper.vm.selectSheet(1); // Even a direct/stale handler cannot use the terminated worker.
      expect(workers[2].messages).toHaveLength(messageCount);
      expect(wrapper.vm.activeSheet).toBe(0);
      await wrapper.get('[role=alert] button').trigger('click');
      expect(workers).toHaveLength(4);
      workers[3].reply({ names: ['Recovered'], sheetsLimited: false });
      workers[3].reply({ rows: [['ok']], columnCount: 1, limited: {} });
      await Vue.nextTick();
      expect(wrapper.get('tbody td').text()).toBe('ok');
      expect(wrapper.get('.xlsx-sheet-tab').element.disabled).toBe(false);
    } finally { wrapper.unmount(); vi.useRealTimers(); }
    expect(workers.at(-1).terminate).toHaveBeenCalled();
  });
});
