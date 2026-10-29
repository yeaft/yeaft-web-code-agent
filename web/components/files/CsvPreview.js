import { CSV_PREVIEW_LIMITS, parseCsvPreview } from '../../utils/csv-preview.js';
import PreviewTable from './PreviewTable.js';

export default {
  name: 'CsvPreview',
  components: { PreviewTable },
  props: {
    content: { type: String, default: '' },
    name: { type: String, required: true },
    fontSize: { type: Number, default: 15 },
  },
  setup(props) {
    const parsed = Vue.computed(() => parseCsvPreview(props.content));
    const limited = Vue.computed(() => Object.values(parsed.value.limited).some(Boolean));
    return { parsed, limited, limits: CSV_PREVIEW_LIMITS };
  },
  template: `
    <div class="file-preview-container csv-preview-container" :style="{ fontSize: fontSize + 'px' }">
      <div v-if="parsed.error" class="csv-preview-notice" role="alert">{{ $t('files.csvInvalid', { row: parsed.error.record }) }}</div>
      <template v-else>
        <div v-if="limited" class="csv-preview-notice" role="status">{{ $t('files.csvLimited', { rows: limits.rows, columns: limits.columns, characters: limits.cellCharacters }) }}</div>
        <div v-if="!parsed.rows.length" class="preview-unsupported" role="status">{{ $t(parsed.limited.source ? 'files.csvNoCompleteRecords' : 'files.csvEmpty') }}</div>
        <PreviewTable v-else :rows="parsed.rows" :column-count="parsed.columnCount" :name="name" />
      </template>
    </div>
  `,
};
