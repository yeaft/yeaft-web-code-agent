// Date-only values never pass through the local timezone (including DST changes).
const FIRST_DATE = '0001-01-01';
const LAST_DATE = '9999-12-31';
let pickerId = 0;

function dateFromISO(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return year > 0 && isoFromDate(date) === value ? date : null;
}
function isoFromDate(date) {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
function localToday() {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function moveMonth(value, delta) {
  const date = dateFromISO(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + delta);
  const end = new Date(date);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, end.getUTCDate()));
  if (date.getUTCFullYear() < 1) return FIRST_DATE;
  if (date.getUTCFullYear() > 9999) return LAST_DATE;
  return isoFromDate(date);
}

const messages = {
  chooseDate: ['Choose date', '选择日期'],
  previousMonth: ['Previous month', '上个月'],
  nextMonth: ['Next month', '下个月'],
  today: ['Today', '今天'],
  keyboardHelp: ['Use arrow keys to move by day or week, Home and End for week boundaries, Page Up and Page Down for months, Enter to select, Escape to close.', '使用方向键切换日期或周，Home 和 End 跳至周首或周末，Page Up 和 Page Down 切换月份，Enter 选择，Escape 关闭。'],
};

/** Inline, controlled date-only picker. Place beside a visible label, not inside a
 * <label> (the calendar contains multiple buttons); pass that label as ariaLabel.
 * The caller owns validation, the selected value, and the stylesheet import. */
export default {
  name: 'ScheduleDatePicker',
  props: {
    modelValue: { type: String, default: '' },
    min: { type: String, default: '' },
    today: { type: String, default: '' },
    max: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    ariaLabel: { type: String, default: '' },
  },
  emits: ['update:modelValue'],
  data() {
    return { open: false, focusedDate: '', visibleMonth: '', localTodayDate: localToday(), pickerId: `schedule-date-picker-${++pickerId}` };
  },
  computed: {
    todayDate() { return dateFromISO(this.today) ? this.today : this.localTodayDate; },
    locale() {
      // createI18n exposes a reactive $locale ref; support older host aliases too.
      const value = ('$locale' in this ? this.$locale : null) ?? ('$i18nLocale' in this ? this.$i18nLocale : null);
      const locale = value?.value ?? value ?? (typeof document !== 'undefined' ? document.documentElement.lang : '');
      return String(locale).startsWith('zh') ? 'zh-CN' : 'en';
    },
    firstWeekday() { return this.locale === 'zh-CN' ? 1 : 0; },
    lowerBound() { return dateFromISO(this.min) ? this.min : FIRST_DATE; },
    upperBound() { return dateFromISO(this.max) ? this.max : LAST_DATE; },
    emptyRange() { return this.lowerBound > this.upperBound; },
    triggerLabel() {
      return dateFromISO(this.modelValue)
        ? this.formatDate(this.modelValue, { year: 'numeric', month: 'short', day: 'numeric' })
        : this.text('chooseDate');
    },
    monthLabel() {
      return this.visibleMonth ? this.formatDate(`${this.visibleMonth}-01`, { year: 'numeric', month: 'long' }) : '';
    },
    weekdays() {
      return Array.from({ length: 7 }, (_, index) => {
        const date = new Date(Date.UTC(2024, 0, 7 + (index + this.firstWeekday) % 7));
        return {
          short: new Intl.DateTimeFormat(this.locale, { weekday: 'short', timeZone: 'UTC' }).format(date),
          long: new Intl.DateTimeFormat(this.locale, { weekday: 'long', timeZone: 'UTC' }).format(date),
        };
      });
    },
    days() {
      if (!this.visibleMonth) return [];
      const first = dateFromISO(`${this.visibleMonth}-01`);
      const offset = (first.getUTCDay() - this.firstWeekday + 7) % 7;
      const end = new Date(first);
      end.setUTCMonth(end.getUTCMonth() + 1, 0);
      const cells = Array.from({ length: offset }, (_, index) => ({ key: `blank-${index}` }));
      for (let day = 1; day <= end.getUTCDate(); day++) {
        const iso = `${this.visibleMonth}-${String(day).padStart(2, '0')}`;
        cells.push({ key: iso, iso, day, disabled: !this.isAllowed(iso) });
      }
      return cells;
    },
    canPrevious() { return !this.emptyRange && this.visibleMonth > this.lowerBound.slice(0, 7); },
    canNext() { return !this.emptyRange && this.visibleMonth < this.upperBound.slice(0, 7); },
  },
  watch: {
    modelValue() { if (this.open) this.resetView(); },
    min() { if (this.open) this.resetView(); },
    max() { if (this.open) this.resetView(); },
    disabled(value) { if (value) this.close(false); },
  },
  methods: {
    text(key) {
      const fullKey = `scheduleDatePicker.${key}`;
      const translated = '$t' in this ? this.$t(fullKey) : null;
      return translated && translated !== fullKey ? translated : messages[key][this.locale === 'zh-CN' ? 1 : 0];
    },
    formatDate(value, options) {
      return new Intl.DateTimeFormat(this.locale, { ...options, timeZone: 'UTC' }).format(dateFromISO(value));
    },
    isAllowed(value) { return !this.disabled && !this.emptyRange && value >= this.lowerBound && value <= this.upperBound; },
    clamp(value) { return value < this.lowerBound ? this.lowerBound : value > this.upperBound ? this.upperBound : value; },
    resetView() {
      this.localTodayDate = localToday();
      this.focusedDate = this.clamp(dateFromISO(this.modelValue) ? this.modelValue : this.todayDate);
      this.visibleMonth = this.focusedDate.slice(0, 7);
    },
    toggle() {
      if (this.disabled) return;
      if (this.open) return this.close();
      this.resetView();
      this.open = true;
      this.focusDay();
    },
    close(restoreFocus = true) {
      this.open = false;
      if (restoreFocus) this.$nextTick(() => this.$refs.trigger?.focus());
    },
    focusDay() {
      this.$nextTick(() => {
        if (!this.open) return;
        this.$refs.panel?.querySelector(`[data-date="${this.focusedDate}"]:not(:disabled)`)?.focus();
      });
    },
    select(value) {
      if (!this.isAllowed(value)) return;
      this.$emit('update:modelValue', value);
      this.close();
    },
    changeMonth(delta, focus = false) {
      if (this.disabled || (delta < 0 ? !this.canPrevious : !this.canNext)) return;
      this.focusedDate = this.clamp(moveMonth(this.focusedDate, delta));
      this.visibleMonth = this.focusedDate.slice(0, 7);
      // Keep pointer users on month navigation; keyboard paging stays on a day.
      if (focus) this.focusDay();
    },
    onDayKey(event, value) {
      if (this.disabled || this.emptyRange || event.altKey || event.ctrlKey || event.metaKey) return;
      const date = dateFromISO(value);
      const weekday = (date.getUTCDay() - this.firstWeekday + 7) % 7;
      const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        event.preventDefault();
        this.changeMonth(event.key === 'PageUp' ? -1 : 1, true);
      } else if (Object.hasOwn(offsets, event.key)) {
        event.preventDefault();
        date.setUTCDate(date.getUTCDate() + offsets[event.key]);
        const value = date.getUTCFullYear() < 1 ? FIRST_DATE : date.getUTCFullYear() > 9999 ? LAST_DATE : isoFromDate(date);
        this.focusedDate = this.clamp(value);
        this.visibleMonth = this.focusedDate.slice(0, 7);
        this.focusDay();
      }
    },
    onKeydown(event) {
      if (event.key === 'Escape' && this.open) {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    },
    onFocusout(event) {
      if (event.relatedTarget && !this.$el.contains(event.relatedTarget)) this.close(false);
    },
  },
  template: `
    <div class="schedule-date-picker" @keydown="onKeydown" @focusout="onFocusout" @click.stop>
      <button ref="trigger" type="button" class="btn-secondary schedule-date-picker__trigger"
        :disabled="disabled" :aria-label="ariaLabel ? ariaLabel + ': ' + triggerLabel : triggerLabel"
        :aria-expanded="open" :aria-controls="pickerId" @click="toggle">
        <svg class="schedule-date-picker__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>
        </svg>
        <span>{{ triggerLabel }}</span>
        <svg class="schedule-date-picker__chevron" :class="{ 'is-open': open }" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
      </button>
      <div v-if="open" :id="pickerId" ref="panel" class="schedule-date-picker__panel" role="group"
        :aria-label="ariaLabel || text('chooseDate')" :aria-describedby="pickerId + '-help'">
        <div class="schedule-date-picker__heading">
          <button type="button" class="btn-ghost schedule-date-picker__nav" :disabled="disabled || !canPrevious"
            :aria-label="text('previousMonth')" @click="changeMonth(-1)">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m10 4-4 4 4 4"/></svg>
          </button>
          <span class="schedule-date-picker__month" aria-live="polite" aria-atomic="true">{{ monthLabel }}</span>
          <button type="button" class="btn-ghost schedule-date-picker__nav" :disabled="disabled || !canNext"
            :aria-label="text('nextMonth')" @click="changeMonth(1)">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
          </button>
        </div>
        <div class="schedule-date-picker__grid">
          <abbr v-for="weekday in weekdays" :key="weekday.long" class="schedule-date-picker__weekday" :title="weekday.long">{{ weekday.short }}</abbr>
          <template v-for="cell in days" :key="cell.key">
            <button v-if="cell.iso" type="button" class="btn-ghost schedule-date-picker__day" :data-date="cell.iso"
              :disabled="cell.disabled" :tabindex="cell.iso === focusedDate && !cell.disabled ? 0 : -1"
              :aria-label="formatDate(cell.iso, { dateStyle: 'full' })" :aria-pressed="cell.iso === modelValue"
              :aria-current="cell.iso === todayDate ? 'date' : undefined"
              @focus="focusedDate = cell.iso" @keydown="onDayKey($event, cell.iso)" @click="select(cell.iso)">{{ cell.day }}</button>
            <span v-else aria-hidden="true"></span>
          </template>
        </div>
        <div class="schedule-date-picker__footer">
          <button type="button" class="btn-ghost schedule-date-picker__today" :disabled="!isAllowed(todayDate)" @click="select(todayDate)">{{ text('today') }}</button>
        </div>
        <p :id="pickerId + '-help'" class="schedule-date-picker__sr-only">{{ text('keyboardHelp') }}</p>
      </div>
    </div>
  `,
};
