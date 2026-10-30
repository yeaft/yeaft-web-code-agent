import ModernSelect from './ModernSelect.js';
import ScheduleDatePicker from './ScheduleDatePicker.js';
import { dateInZone, scheduleFormResult, normalizeScheduleTime, scheduleDateBounds } from '../utils/work-center-schedule.js';

const zoneField = `
  <div class="work-center-schedule-field">
    <span>{{ $t('workCenter.scheduling.timeZone') }}</span>
    <ModernSelect :model-value="modelValue.timeZone" :options="zones" searchable :disabled="disabled" :aria-label="$t('workCenter.scheduling.timeZone')" @update:model-value="patch('timeZone', $event)" />
  </div>`;
const dateField = `
  <div class="work-center-schedule-field">
    <span>{{ $t(modelValue.frequency === 'once' ? 'workCenter.scheduling.date' : 'workCenter.scheduling.fromDate') }}</span>
    <ScheduleDatePicker :model-value="modelValue.date" :min="today" :max="bounds.maxStartDate" :today="today" :disabled="disabled" :aria-label="$t('workCenter.scheduling.date')" @update:model-value="patch('date', $event)" />
  </div>`;
const endFields = `
  <div v-if="modelValue.frequency !== 'once'" class="work-center-schedule-fields">
    <div class="work-center-schedule-field">
      <span>{{ $t('workCenter.scheduling.ends') }}</span>
      <ModernSelect :model-value="modelValue.end" :options="endOptions" :disabled="disabled" :aria-label="$t('workCenter.scheduling.ends')" @update:model-value="patch('end', $event)" />
    </div>
    <div v-if="modelValue.end === 'date'" class="work-center-schedule-field">
      <span>{{ $t('workCenter.scheduling.endDate') }}</span>
      <ScheduleDatePicker :model-value="modelValue.endDate" :min="modelValue.date" :max="bounds.maxEndDate" :today="today" :disabled="disabled" :aria-label="$t('workCenter.scheduling.endDate')" @update:model-value="patch('endDate', $event)" />
    </div>
    <label v-if="modelValue.end === 'count'" class="work-center-schedule-field">
      <span>{{ $t('workCenter.scheduling.runCount') }}</span>
      <input type="number" min="1" max="1000" :value="modelValue.maxRuns" :disabled="disabled" @input="patch('maxRuns', Number($event.target.value))">
    </label>
  </div>`;

export default {
  name: 'WorkCenterScheduleEditor',
  components: { ModernSelect, ScheduleDatePicker },
  props: {
    modelValue: { type: Object, required: true },
    disabled: { type: Boolean, default: false },
    recurringSupported: { type: Boolean, default: false },
    // The calendar is shared, but its execution semantics belong to the caller.
    scheduleHint: { type: String, default: '' },
    compact: { type: Boolean, default: false },
    monthlyMultipleSupported: { type: Boolean, default: false },
  },
  emits: ['update:modelValue', 'valid'],
  watch: {
    result: { immediate: true, handler(value) {
      this.$emit('valid', !value.error);
      if (this.compact && ['futureTime', 'invalidDateTime', 'invalidTimeZone', 'invalidEndDate', 'invalidRunCount', 'tooFar', 'supportedRange'].includes(value.error)) this.advancedOpen = true;
    } },
  },
  data() { return { now: Date.now(), timer: null, advancedOpen: false }; },
  mounted() { this.timer = setInterval(() => { this.now = Date.now(); }, 30000); },
  beforeUnmount() { clearInterval(this.timer); },
  computed: {
    locale() { return this.$locale?.value || this.$locale || document.documentElement.lang || 'en'; },
    result() { return scheduleFormResult(this.modelValue, this.now); },
    monthDays() { return this.modelValue.daysOfMonth ?? [this.modelValue.dayOfMonth]; },
    today() { try { return dateInZone(this.now, this.modelValue.timeZone).date; } catch { return ''; } },
    bounds() { try { return scheduleDateBounds(this.modelValue.timeZone, this.now); } catch { return {}; } },
    frequencies() {
      return ['once', 'daily', 'weekdays', 'weekly', 'monthly'].map(value => ({
        value, label: this.$t(`workCenter.scheduling.${value}`), disabled: value !== 'once' && !this.recurringSupported,
      }));
    },
    endOptions() { return ['never', 'date', 'count'].map(value => ({ value, label: this.$t(`workCenter.scheduling.end.${value}`) })); },
    zones() {
      const values = Intl.supportedValuesOf?.('timeZone') || ['UTC'];
      return [...new Set([this.modelValue.timeZone, 'UTC', ...values])].filter(Boolean).map(value => ({ value, label: value.replaceAll('_', ' ') }));
    },
    weekdays() {
      return [1, 2, 3, 4, 5, 6, 0].map(value => {
        const date = new Date(Date.UTC(2026, 0, 4 + value));
        return { value, label: new Intl.DateTimeFormat(this.locale, { weekday: 'short', timeZone: 'UTC' }).format(date), full: new Intl.DateTimeFormat(this.locale, { weekday: 'long', timeZone: 'UTC' }).format(date) };
      });
    },
    nextRun() {
      return this.result.scheduledFor ? new Intl.DateTimeFormat(this.locale, {
        timeZone: this.modelValue.timeZone, dateStyle: 'medium', timeStyle: 'short', hour12: false,
      }).format(this.result.scheduledFor) : '';
    },
  },
  methods: {
    normalizeScheduleTime,
    patch(key, value) { this.$emit('update:modelValue', { ...this.modelValue, [key]: value }); },
    toggleMonthDay(day) {
      const days = this.monthDays;
      this.patch('daysOfMonth', !this.monthlyMultipleSupported ? [day]
        : days.includes(day) ? days.filter(value => value !== day) : [...days, day].sort((a, b) => a - b));
    },
    toggleWeekday(day) {
      const days = this.modelValue.weekdays;
      this.patch('weekdays', days.includes(day) ? days.filter(value => value !== day) : [...days, day]);
    },
  },
  template: `
    <div class="work-center-schedule-editor" :class="{ 'is-compact': compact }">
      <div class="work-center-schedule-fields">
        <div class="work-center-schedule-field">
          <span>{{ $t('workCenter.scheduling.repeat') }}</span>
          <ModernSelect :model-value="modelValue.frequency" :options="frequencies" :disabled="disabled" :aria-label="$t('workCenter.scheduling.repeat')" @update:model-value="patch('frequency', $event)" />
        </div>
        <label v-if="compact" class="work-center-schedule-field">
          <span>{{ $t('workCenter.scheduling.time') }}</span>
          <input type="text" inputmode="numeric" maxlength="5" placeholder="09:00" autocomplete="off" :value="modelValue.time" :disabled="disabled" :aria-label="$t('workCenter.scheduling.time')" @input="patch('time', normalizeScheduleTime($event.target.value))">
        </label>
        <template v-if="!compact">${zoneField}</template>
        <template v-if="!compact || modelValue.frequency === 'once'">${dateField}</template>
        <label v-if="!compact" class="work-center-schedule-field">
          <span>{{ $t('workCenter.scheduling.time') }}</span>
          <input type="text" inputmode="numeric" maxlength="5" placeholder="09:00" autocomplete="off" :value="modelValue.time" :disabled="disabled" :aria-label="$t('workCenter.scheduling.time')" @input="patch('time', normalizeScheduleTime($event.target.value))">
          <small class="work-center-field-help">{{ $t('workCenter.scheduling.timeHint') }}</small>
        </label>
      </div>
      <fieldset v-if="modelValue.frequency === 'weekly'" class="work-center-schedule-weekdays" :disabled="disabled">
        <legend>{{ $t('workCenter.scheduling.onDays') }}</legend>
        <div><button v-for="day in weekdays" :key="day.value" type="button" class="btn-secondary" :disabled="disabled" :aria-label="day.full" :aria-pressed="modelValue.weekdays.includes(day.value)" @click="toggleWeekday(day.value)">{{ day.label }}</button></div>
      </fieldset>
      <fieldset v-if="compact && modelValue.frequency === 'monthly'" class="task-month-days" :disabled="disabled">
        <legend>{{ $t('scheduledTasks.monthDays') }}</legend>
        <div class="task-month-days-grid">
          <button v-for="day in 31" :key="day" type="button" class="btn-secondary" :disabled="disabled" :aria-pressed="monthDays.includes(day)" @click="toggleMonthDay(day)">{{ day }}</button>
        </div>
        <p class="work-center-field-help">{{ $t('scheduledTasks.shortMonth') }}</p>
        <p v-if="!monthlyMultipleSupported" class="work-center-field-help" role="status">{{ $t('scheduledTasks.monthDaysUpgrade') }}</p>
      </fieldset>
      <label v-else-if="modelValue.frequency === 'monthly'" class="work-center-schedule-field">
        <span>{{ $t('workCenter.scheduling.monthDay') }}</span>
        <input type="number" min="1" max="31" :value="modelValue.dayOfMonth" :disabled="disabled" @input="patch('dayOfMonth', Number($event.target.value))">
        <small class="work-center-field-help">{{ $t('workCenter.scheduling.shortMonth') }}</small>
      </label>
      <details v-if="compact" class="task-schedule-advanced" :open="advancedOpen" @toggle="advancedOpen = $event.target.open">
        <summary>{{ $t('scheduledTasks.moreScheduleOptions') }}</summary>
        <div class="work-center-schedule-fields">
          <template v-if="modelValue.frequency !== 'once'">${dateField}</template>
          ${zoneField}
        </div>
        ${endFields}
        <p class="work-center-field-help">{{ scheduleHint }}</p>
      </details>
      <template v-else>${endFields}</template>
      <p v-if="!recurringSupported" class="work-center-field-help">{{ $t('workCenter.scheduling.upgrade') }}</p>
      <p v-if="result.error" class="work-center-error" role="status">{{ $t('workCenter.scheduling.' + result.error) }}</p>
      <div v-else class="work-center-schedule-preview" aria-live="polite">
        <span>{{ $t('workCenter.scheduling.nextRun') }}</span>
        <strong>{{ nextRun }}</strong>
        <small>{{ modelValue.timeZone.replaceAll('_', ' ') }}</small>
      </div>
      <p v-if="!compact" class="work-center-field-help">{{ scheduleHint || $t(modelValue.frequency === 'once' ? 'workCenter.scheduling.onceHint' : 'workCenter.scheduling.recurringHint') }}</p>
    </div>
  `,
};
