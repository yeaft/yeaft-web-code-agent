/** Accessible divider for a right-hand flex pane. Size belongs to the caller;
 * the handle only measures its parent and adjacent pane, never global layout. */
export default {
  name: 'PaneResizeHandle',
  props: {
    modelValue: { type: Number, required: true },
    label: { type: String, required: true },
    controls: { type: String, required: true },
    minSize: { type: Number, default: 280 },
    minRemaining: { type: Number, default: 360 },
    defaultSize: { type: Number, default: 400 },
  },
  emits: ['update:modelValue'],
  data() { return { availableWidth: 0, dragging: false }; },
  computed: {
    maxSize() { return Math.max(this.minSize, this.availableWidth - this.minRemaining); },
    currentSize() { return this.clamp(this.modelValue); },
  },
  mounted() {
    this.measure = () => {
      this.availableWidth = this.$el.parentElement?.clientWidth || 0;
      if (!this.$el.getClientRects().length) this.finishDrag();
    };
    this.measure();
    this.observer = new ResizeObserver(this.measure);
    this.observer.observe(this.$el.parentElement);
    window.addEventListener('blur', this.finishDrag);
  },
  beforeUnmount() {
    this.finishDrag();
    this.observer?.disconnect();
    window.removeEventListener('blur', this.finishDrag);
  },
  methods: {
    clamp(size) { return Math.round(Math.max(this.minSize, Math.min(this.maxSize, size))); },
    setSize(size) { this.$emit('update:modelValue', this.clamp(size)); },
    startDrag(event) {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      this.finishDrag();
      this.measure();
      this.$el.focus({ preventScroll: true });
      this.drag = {
        id: event.pointerId,
        x: event.clientX,
        size: this.$el.nextElementSibling?.getBoundingClientRect().width || this.currentSize,
        cursor: document.body.style.cursor,
        userSelect: document.body.style.userSelect,
      };
      this.$el.setPointerCapture(event.pointerId);
      this.dragging = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    moveDrag(event) {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      this.setSize(this.drag.size + this.drag.x - event.clientX);
    },
    finishDrag() {
      const drag = this.drag;
      if (!drag) return;
      this.drag = null;
      this.dragging = false;
      document.body.style.cursor = drag.cursor;
      document.body.style.userSelect = drag.userSelect;
      if (this.$el.hasPointerCapture(drag.id)) this.$el.releasePointerCapture(drag.id);
    },
    onKeydown(event) {
      const step = event.shiftKey ? 64 : 16;
      const sizes = {
        ArrowLeft: this.currentSize + step,
        ArrowRight: this.currentSize - step,
        Home: this.defaultSize,
        End: this.maxSize,
      };
      if (!(event.key in sizes)) return;
      event.preventDefault();
      this.setSize(sizes[event.key]);
    },
  },
  template: `
    <div class="pane-resize-handle" :class="{ 'is-dragging': dragging }"
         role="separator" tabindex="0" aria-orientation="vertical"
         :aria-label="label" :aria-controls="controls"
         :aria-valuemin="minSize" :aria-valuemax="maxSize" :aria-valuenow="currentSize"
         @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="finishDrag"
         @pointercancel="finishDrag" @lostpointercapture="finishDrag"
         @keydown="onKeydown" @dblclick="setSize(defaultSize)"></div>
  `,
};
