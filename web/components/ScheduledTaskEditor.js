import WorkCenterScheduleEditor from './WorkCenterScheduleEditor.js';
import { dateInZone, scheduleDraft, scheduleFormResult } from '../utils/work-center-schedule.js';

export function newScheduledTask() {
  return { prompt: '', enabled: true, notify: true, trigger: { type: 'manual' } };
}

function draftForTrigger(trigger) {
  const initial = scheduleDraft();
  const draft = { ...initial, daysOfMonth: [initial.dayOfMonth] };
  if (trigger?.type !== 'schedule') return draft;
  const recurrence = trigger.recurrence;
  const timeZone = recurrence?.timeZone || draft.timeZone;
  try {
    const local = dateInZone(trigger.scheduledFor, timeZone);
    return {
      ...draft, ...local, timeZone,
      frequency: recurrence?.frequency || 'once',
      weekdays: recurrence?.weekdays || draft.weekdays,
      dayOfMonth: recurrence?.dayOfMonth || Number(local.date.slice(-2)),
      daysOfMonth: recurrence?.daysOfMonth || [recurrence?.dayOfMonth || Number(local.date.slice(-2))],
      end: recurrence?.endsAt ? 'date' : recurrence?.maxRuns ? 'count' : 'never',
      endDate: recurrence?.endsAt ? dateInZone(recurrence.endsAt, timeZone).date : '',
      maxRuns: recurrence?.maxRuns || draft.maxRuns,
    };
  } catch { return draft; }
}

// One task form shared by Session creation and Session settings. Scheduling and
// timezone/DST validation remain in the existing Work Center schedule editor.
export default {
  name: 'ScheduledTaskEditor',
  components: { WorkCenterScheduleEditor },
  props: {
    modelValue: { type: Object, required: true },
    disabled: { type: Boolean, default: false },
    monthlyMultipleSupported: { type: Boolean, default: false },
  },
  emits: ['update:modelValue', 'valid'],
  data() {
    return { schedule: draftForTrigger(this.modelValue.trigger), scheduleTouched: false, scheduleValid: true };
  },
  computed: {
    triggerOptions() {
      return ['manual', 'schedule'].map(value => ({ value, label: this.$t(`scheduledTasks.trigger.${value}`) }));
    },
    supportedTrigger() { return ['manual', 'schedule'].includes(this.modelValue.trigger?.type); },
    preservedPastSchedule() {
      return !this.scheduleTouched && this.modelValue.trigger?.type === 'schedule'
        && this.modelValue.trigger.scheduledFor <= Date.now();
    },
    existingScheduleLabel() {
      return new Date(this.modelValue.trigger.scheduledFor).toLocaleString();
    },
    valid() {
      if (!this.supportedTrigger || !this.modelValue.prompt?.trim()) return false;
      if (this.modelValue.trigger.type === 'manual') return true;
      // An existing completed one-off or recurring schedule can be left intact
      // when editing prompt / notification settings, even if its start is past.
      return !this.scheduleTouched || (this.scheduleValid && !scheduleFormResult(this.schedule).error
        && (this.monthlyMultipleSupported || this.schedule.frequency !== 'monthly' || this.schedule.daysOfMonth?.length <= 1));
    },
  },
  watch: {
    valid: { immediate: true, handler(value) { this.$emit('valid', value); } },
  },
  methods: {
    patch(key, value) { this.$emit('update:modelValue', { ...this.modelValue, [key]: value }); },
    setTrigger(type) {
      if (type === 'manual') this.patch('trigger', { type });
      else this.updateSchedule(this.schedule);
    },
    updateSchedule(draft) {
      this.schedule = draft;
      this.scheduleTouched = true;
      const result = scheduleFormResult(draft);
      this.scheduleValid = !result.error;
      this.patch('trigger', { type: 'schedule', ...(result.error ? {} : result) });
    },
  },
  template: `
    <fieldset class="scheduled-task-editor" :disabled="disabled">
      <div class="scheduled-task-main">
      <slot name="heading"></slot>
      <label class="scheduled-task-field scheduled-task-prompt">
        <span class="scheduled-task-field-title">{{ $t('scheduledTasks.prompt') }}<span class="task-required">{{ $t('scheduledTasks.required') }}</span></span>
        <span class="scheduled-task-help">{{ $t('scheduledTasks.promptHint') }}</span>
        <textarea :value="modelValue.prompt" rows="5" required aria-required="true" :disabled="disabled" :aria-label="$t('scheduledTasks.prompt')" :placeholder="$t('scheduledTasks.promptPlaceholder')" @input="patch('prompt', $event.target.value)"></textarea>
      </label>
      <slot></slot>

      </div>
      <div class="scheduled-task-timing">
      <div class="scheduled-task-field">
        <span class="scheduled-task-field-title">{{ $t('scheduledTasks.triggerLabel') }}</span>
        <div class="scheduled-task-trigger-options" role="group" :aria-label="$t('scheduledTasks.triggerLabel')">
          <button v-for="option in triggerOptions" :key="option.value" type="button" class="btn btn-secondary" :aria-pressed="modelValue.trigger?.type === option.value" :disabled="disabled" @click="setTrigger(option.value)">{{ option.label }}</button>
        </div>
        <p v-if="supportedTrigger" class="scheduled-task-help">{{ $t('scheduledTasks.triggerHint.' + modelValue.trigger.type) }}</p>
      </div>
      <div v-if="preservedPastSchedule" class="scheduled-task-existing-schedule">
        <p>{{ $t('scheduledTasks.existingSchedule') }}: {{ existingScheduleLabel }} · {{ $t('workCenter.scheduling.' + schedule.frequency) }} · {{ schedule.timeZone }}</p>
        <button type="button" class="btn-secondary" :disabled="disabled" @click="scheduleTouched = true">{{ $t('scheduledTasks.changeSchedule') }}</button>
      </div>
      <WorkCenterScheduleEditor v-else-if="modelValue.trigger?.type === 'schedule'" :model-value="schedule" :disabled="disabled" :schedule-hint="$t('scheduledTasks.scheduleHint')" compact :monthly-multiple-supported="monthlyMultipleSupported" recurring-supported @update:model-value="updateSchedule" @valid="scheduleValid = $event" />
      <p v-else-if="!supportedTrigger" class="scheduled-task-error" role="alert">{{ $t('scheduledTasks.unsupportedTrigger') }}</p>

      </div>
      <div class="scheduled-task-options">
        <label v-for="key in ['enabled', 'notify']" :key="key" class="scheduled-task-option-row">
          <span class="scheduled-task-option-copy">
            <span class="scheduled-task-field-title">{{ $t('scheduledTasks.' + key) }}</span>
            <span class="scheduled-task-help">{{ $t('scheduledTasks.' + key + 'Hint') }}</span>
          </span>
          <span class="agent-settings-switch">
            <input type="checkbox" role="switch" :aria-label="$t('scheduledTasks.' + key)" :checked="modelValue[key]" :disabled="disabled" @change="patch(key, $event.target.checked)">
            <span aria-hidden="true"></span>
          </span>
        </label>
      </div>
    </fieldset>
  `,
};
