import {
  clampSidebarProjectsRatio, DEFAULT_SIDEBAR_PROJECTS_RATIO,
  MIN_SIDEBAR_PROJECTS_RATIO, MAX_SIDEBAR_PROJECTS_RATIO,
} from '../utils/user-preferences.js';

/** Desktop Projects/Recent divider; the caller owns preview and persistence. */
export default {
  name: 'SidebarSectionResizeHandle',
  props: {
    modelValue: { type: Number, default: DEFAULT_SIDEBAR_PROJECTS_RATIO },
    disabled: { type: Boolean, default: false },
    label: { type: String, required: true },
  },
  emits: ['update:modelValue', 'change'],
  data() { return { dragging: false }; },
  watch: {
    disabled(value) { if (value) this.finishDrag(false); },
  },
  mounted() {
    window.addEventListener('blur', this.cancelDrag);
    this.observer = new ResizeObserver(() => {
      if (!this.$el.getClientRects().length) this.finishDrag(false);
    });
    this.observer.observe(this.$el);
  },
  beforeUnmount() {
    this.finishDrag(false);
    this.observer?.disconnect();
    window.removeEventListener('blur', this.cancelDrag);
  },
  methods: {
    startDrag(event) {
      if (this.disabled || event.button !== 0 || !event.isPrimary) return;
      const available = this.$el.parentElement.clientHeight - this.$el.offsetHeight;
      if (available <= 0) return;
      event.preventDefault();
      this.$el.focus({ preventScroll: true });
      this.drag = {
        id: event.pointerId, y: event.clientY, available,
        initial: this.modelValue, ratio: this.modelValue,
        size: this.$el.previousElementSibling.getBoundingClientRect().height,
        cursor: document.body.style.cursor, userSelect: document.body.style.userSelect,
      };
      this.$el.setPointerCapture(event.pointerId);
      this.dragging = true;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    moveDrag(event) {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      this.drag.ratio = clampSidebarProjectsRatio(
        (this.drag.size + event.clientY - this.drag.y) / this.drag.available,
      );
      this.$emit('update:modelValue', this.drag.ratio);
    },
    finishDrag(commit = true) {
      const drag = this.drag;
      if (!drag) return;
      this.drag = null;
      this.dragging = false;
      document.body.style.cursor = drag.cursor;
      document.body.style.userSelect = drag.userSelect;
      if (this.$el.hasPointerCapture(drag.id)) this.$el.releasePointerCapture(drag.id);
      if (commit && !this.disabled && drag.ratio !== drag.initial) this.$emit('change', drag.ratio);
      else this.$emit('update:modelValue', drag.initial);
    },
    cancelDrag() { this.finishDrag(false); },
    onKeydown(event) {
      if (event.key === 'Escape' && this.drag) { event.preventDefault(); this.cancelDrag(); return; }
      if (this.disabled) return;
      const step = event.shiftKey ? 0.1 : 0.02;
      const values = {
        ArrowUp: this.modelValue - step, ArrowDown: this.modelValue + step,
        Home: MIN_SIDEBAR_PROJECTS_RATIO, End: MAX_SIDEBAR_PROJECTS_RATIO,
      };
      if (!(event.key in values)) return;
      event.preventDefault();
      this.setRatio(values[event.key]);
    },
    setRatio(value) {
      if (this.disabled) return;
      const ratio = clampSidebarProjectsRatio(value);
      this.$emit('update:modelValue', ratio);
      this.$emit('change', ratio);
    },
  },
  template: `
    <div class="sidebar-section-resize-handle" :class="{ 'is-dragging': dragging }"
         role="separator" :tabindex="disabled ? -1 : 0" aria-orientation="horizontal"
         :aria-label="label" :aria-disabled="disabled"
         :aria-valuemin="15" :aria-valuemax="85" :aria-valuenow="Math.round(modelValue * 100)"
         @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="finishDrag()"
         @pointercancel="cancelDrag" @lostpointercapture="cancelDrag"
         @keydown="onKeydown" @dblclick="setRatio(0.5)"><span aria-hidden="true"></span></div>
  `,
};
