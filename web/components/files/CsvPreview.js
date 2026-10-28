import { CSV_PREVIEW_LIMITS, parseCsvPreview } from '../../utils/csv-preview.js';

export default {
  name: 'CsvPreview',
  props: {
    content: { type: String, default: '' },
    name: { type: String, required: true },
    fontSize: { type: Number, default: 15 },
  },
  setup(props) {
    const parsed = Vue.computed(() => parseCsvPreview(props.content));
    const firstRowHeader = Vue.ref(true);
    const page = Vue.ref(0);
    const scroll = Vue.ref(null);
    const pageSize = 50;
    const dataRows = Vue.computed(() => firstRowHeader.value ? parsed.value.rows.slice(1) : parsed.value.rows);
    const pageCount = Vue.computed(() => Math.max(1, Math.ceil(dataRows.value.length / pageSize)));
    const visibleRows = Vue.computed(() => dataRows.value.slice(page.value * pageSize, (page.value + 1) * pageSize));
    const limited = Vue.computed(() => Object.values(parsed.value.limited).some(Boolean));
    Vue.watch(() => [props.content, firstRowHeader.value], () => { page.value = 0; }, { flush: 'sync' });
    Vue.watch(() => [page.value, props.content, firstRowHeader.value], () => {
      if (scroll.value) scroll.value.scrollTop = 0;
    }, { flush: 'post' });
    return { parsed, firstRowHeader, page, scroll, pageSize, dataRows, pageCount, visibleRows, limited, limits: CSV_PREVIEW_LIMITS };
  },
  template: `
    <div class="file-preview-container csv-preview-container" :style="{ fontSize: fontSize + 'px' }">
      <div class="csv-preview-toolbar">
        <label><input type="checkbox" v-model="firstRowHeader" /> {{ $t('files.csvFirstRowHeader') }}</label>
        <span>{{ $t('files.csvDimensions', { rows: dataRows.length, columns: parsed.columnCount }) }}</span>
      </div>
      <div v-if="parsed.error" class="csv-preview-notice" role="alert">{{ $t('files.csvInvalid', { row: parsed.error.record }) }}</div>
      <template v-else>
        <div v-if="limited" class="csv-preview-notice" role="status">{{ $t('files.csvLimited', { rows: limits.rows, columns: limits.columns, characters: limits.cellCharacters }) }}</div>
        <div v-if="!parsed.rows.length" class="preview-unsupported" role="status">{{ $t(parsed.limited.source ? 'files.csvNoCompleteRecords' : 'files.csvEmpty') }}</div>
        <div v-else ref="scroll" class="csv-preview-scroll" tabindex="0" role="region" :aria-label="$t('files.csvPreviewTitle', { name })">
          <table class="csv-preview-table" :aria-label="$t('files.csvPreviewTitle', { name })">
            <thead><tr>
              <th scope="col" class="csv-row-number">#</th>
              <th v-for="column in parsed.columnCount" :key="column" scope="col"><div class="csv-header-content" tabindex="0">{{ firstRowHeader ? (parsed.rows[0][column - 1] ?? '') : $t('files.csvColumn', { column }) }}</div></th>
            </tr></thead>
            <tbody><tr v-for="(row, index) in visibleRows" :key="page * pageSize + index">
              <th scope="row" class="csv-row-number">{{ page * pageSize + index + 1 }}</th>
              <td v-for="column in parsed.columnCount" :key="column">{{ row[column - 1] ?? '' }}</td>
            </tr></tbody>
          </table>
        </div>
        <div v-if="dataRows.length > pageSize" class="csv-preview-pagination">
          <button type="button" class="btn-ghost" :disabled="page === 0" @click="page--">{{ $t('files.csvPrevious') }}</button>
          <span role="status">{{ $t('files.csvPage', { page: page + 1, total: pageCount }) }}</span>
          <button type="button" class="btn-ghost" :disabled="page + 1 >= pageCount" @click="page++">{{ $t('files.csvNext') }}</button>
        </div>
      </template>
    </div>
  `,
};
