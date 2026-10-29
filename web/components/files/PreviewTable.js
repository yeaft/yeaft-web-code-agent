import { spreadsheetColumn, spreadsheetSelectionText, spreadsheetViewRows } from '../../utils/spreadsheet-preview.js';

/** Shared read-only CSV/Excel table. All cells and headers are Vue text nodes. */
export default {
  name: 'PreviewTable',
  props: {
    rows: { type: Array, required: true },
    columnCount: { type: Number, required: true },
    name: { type: String, required: true },
    defaultHeader: { type: Boolean, default: true },
  },
  setup(props) {
    const firstRowHeader = Vue.ref(props.defaultHeader);
    const query = Vue.ref('');
    const filterColumn = Vue.ref(-1);
    const sortColumn = Vue.ref(-1);
    const sortDirection = Vue.ref(0);
    const page = Vue.ref(0);
    const scroll = Vue.ref(null);
    const selection = Vue.ref(null);
    const copyState = Vue.ref('');
    const pageSize = 50;
    const headers = Vue.computed(() => Array.from({ length: props.columnCount }, (_, i) => firstRowHeader.value ? (props.rows[0]?.[i] ?? '') : spreadsheetColumn(i)));
    const dataRows = Vue.computed(() => spreadsheetViewRows(props.rows, {
      firstRowHeader: firstRowHeader.value, query: query.value, filterColumn: filterColumn.value,
      sortColumn: sortColumn.value, sortDirection: sortDirection.value,
    }));
    const pageCount = Vue.computed(() => Math.max(1, Math.ceil(dataRows.value.length / pageSize)));
    const visibleRows = Vue.computed(() => dataRows.value.slice(page.value * pageSize, (page.value + 1) * pageSize));
    const selectionText = Vue.computed(() => spreadsheetSelectionText(visibleRows.value, selection.value));
    const dragging = Vue.ref(false);
    const activeCell = Vue.computed(() => selection.value?.focus || { row: 0, column: 0 });
    const selectionLabel = Vue.computed(() => {
      if (!selection.value) return '';
      const valid = cell => Number.isInteger(cell.row) && !!visibleRows.value[cell.row]
        && Number.isInteger(cell.column) && cell.column >= 0 && cell.column < props.columnCount;
      if (!valid(selection.value.anchor) || !valid(selection.value.focus)) return '';
      const address = cell => spreadsheetColumn(cell.column) + visibleRows.value[cell.row].number;
      return address(selection.value.anchor) + ':' + address(selection.value.focus);
    });
    function select(row, column, extend = false) {
      if (!visibleRows.value.length) return;
      const focus = { row, column };
      selection.value = { anchor: extend && selection.value ? selection.value.anchor : focus, focus };
      copyState.value = '';
    }
    function selected(row, column) {
      const s = selection.value;
      return !!s && row >= Math.min(s.anchor.row, s.focus.row) && row <= Math.max(s.anchor.row, s.focus.row)
        && column >= Math.min(s.anchor.column, s.focus.column) && column <= Math.max(s.anchor.column, s.focus.column);
    }
    function sort(column) {
      if (sortColumn.value !== column) { sortColumn.value = column; sortDirection.value = 1; }
      else sortDirection.value = sortDirection.value === 1 ? -1 : sortDirection.value === -1 ? 0 : 1;
    }
    function copy(event) {
      if (!selection.value) return;
      event.clipboardData.setData('text/plain', selectionText.value);
      event.preventDefault();
      copyState.value = 'files.tableCopied';
    }
    async function copySelection() {
      const text = selectionText.value;
      try {
        await navigator.clipboard.writeText(text);
        copyState.value = 'files.tableCopied';
      } catch { copyState.value = 'files.tableCopyFailed'; }
    }
    function onKeydown(event) {
      if (event.target?.tagName !== 'TD') return;
      const current = activeCell.value;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        select(0, 0);
        select(visibleRows.value.length - 1, props.columnCount - 1, true);
        return;
      }
      if (event.key === 'Escape') { selection.value = null; return; }
      const deltas = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      const delta = deltas[event.key];
      if (!delta) return;
      event.preventDefault();
      const row = Math.max(0, Math.min(visibleRows.value.length - 1, current.row + delta[0]));
      const column = Math.max(0, Math.min(props.columnCount - 1, current.column + delta[1]));
      select(row, column, event.shiftKey);
      Vue.nextTick(() => scroll.value?.querySelector(`td[data-row="${row}"][data-column="${column}"]`)?.focus());
    }
    Vue.watch(() => [props.rows, firstRowHeader.value, query.value, filterColumn.value, sortColumn.value, sortDirection.value], () => { page.value = 0; selection.value = null; copyState.value = ''; }, { flush: 'sync' });
    Vue.watch(page, () => {
      selection.value = null;
      copyState.value = '';
      dragging.value = false;
    }, { flush: 'sync' });
    Vue.watch(() => [page.value, props.rows, firstRowHeader.value, query.value, filterColumn.value, sortColumn.value, sortDirection.value], () => {
      if (scroll.value) scroll.value.scrollTop = 0;
    }, { flush: 'post' });
    return { firstRowHeader, query, filterColumn, sortColumn, sortDirection, page, scroll, selection, copyState, headers,
      dataRows, pageCount, visibleRows, dragging, activeCell, selectionLabel, select, selected, sort, copy, copySelection, onKeydown };
  },
  template: `
    <div class="preview-table-container">
      <div class="csv-preview-toolbar">
        <label><input type="checkbox" v-model="firstRowHeader" /> {{ $t('files.csvFirstRowHeader') }}</label>
        <span>{{ $t('files.csvDimensions', { rows: dataRows.length, columns: columnCount }) }}</span>
        <label class="table-search-label"><span>{{ $t('files.tableFilter') }}</span><input type="search" v-model="query" :placeholder="$t('files.tableSearch')" /></label>
        <select v-model.number="filterColumn" :aria-label="$t('files.tableFilterColumn')">
          <option :value="-1">{{ $t('files.tableAllColumns') }}</option>
          <option v-for="(header, i) in headers" :key="i" :value="i">{{ i + 1 }} · {{ header }}</option>
        </select>
        <button type="button" class="btn-ghost table-copy" :disabled="!selection" @click="copySelection">{{ $t('files.tableCopy') }}</button>
      </div>
      <div class="table-preview-hint">{{ $t('files.tableReadOnly') }} <span v-if="selection">{{ selectionLabel }}</span> <span role="status">{{ copyState ? $t(copyState) : '' }}</span></div>
      <div v-if="!rows.length" class="preview-unsupported" role="status">{{ $t('files.tableEmpty') }}</div>
      <template v-else>
        <div ref="scroll" class="csv-preview-scroll" tabindex="0" role="region" :aria-label="$t('files.tablePreviewTitle', { name })" @copy="copy" @keydown="onKeydown" @mouseup="dragging = false" @mouseleave="dragging = false">
          <table class="csv-preview-table" :aria-label="$t('files.tablePreviewTitle', { name })">
            <thead><tr>
              <th scope="col" class="csv-row-number">#</th>
              <th v-for="(header, i) in headers" :key="i" scope="col" :aria-sort="sortColumn === i && sortDirection ? (sortDirection === 1 ? 'ascending' : 'descending') : 'none'">
                <button type="button" class="table-sort btn-ghost" :aria-label="$t('files.tableSort', { column: i + 1 })" @click="sort(i)"><span class="csv-header-content" tabindex="0">{{ header }}</span><span aria-hidden="true">{{ sortColumn === i && sortDirection ? (sortDirection === 1 ? '↑' : '↓') : '↕' }}</span></button>
              </th>
            </tr></thead>
            <tbody><tr v-for="(row, index) in visibleRows" :key="row.number">
              <th scope="row" class="csv-row-number">{{ row.number }}</th>
              <td v-for="column in columnCount" :key="column" :data-row="index" :data-column="column - 1" :class="{ 'table-cell-selected': selected(index, column - 1) }"
                :tabindex="activeCell.row === index && activeCell.column === column - 1 ? 0 : -1"
                @focus="!selection && select(index, column - 1)"
                @mousedown.left.prevent="dragging = true; select(index, column - 1, $event.shiftKey); $event.currentTarget.focus()"
                @mouseenter="(dragging && $event.buttons === 1) && select(index, column - 1, true)"
                @click="($event.pointerType === 'touch' || $event.detail === 0) && select(index, column - 1, $event.shiftKey)"
              >{{ row.values[column - 1] ?? '' }}</td>
            </tr></tbody>
          </table>
          <div v-if="!dataRows.length" class="preview-unsupported" role="status">{{ $t('files.tableNoMatches') }}</div>
        </div>
        <div v-if="pageCount > 1" class="csv-preview-pagination">
          <button type="button" class="btn-ghost" :disabled="page === 0" @click="page--">{{ $t('files.csvPrevious') }}</button>
          <span role="status">{{ $t('files.csvPage', { page: page + 1, total: pageCount }) }}</span>
          <button type="button" class="btn-ghost" :disabled="page + 1 >= pageCount" @click="page++">{{ $t('files.csvNext') }}</button>
        </div>
      </template>
    </div>
  `,
};
