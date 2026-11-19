/** Accessible divider for a flex pane beside it: the following pane (a
 * right-hand panel, default) or the preceding one (a left sidebar). Size
 * belongs to the caller; the handle only measures its parent and that pane,
 * never global layout. */
export default {
  name: 'PaneResizeHandle',
  props: {
    modelValue: { type: Number, required: true },
    label: { type: String, required: true },
    controls: { type: String, required: true },
    pane: { type: String, default: 'next', validator: value => value === 'next' || value === 'previous' },
    minSize: { type: Number, default: 280 },
    maxLimit: { type: Number, default: Infinity },
    minRemaining: { type: Number, default: 360 },
    defaultSize: { type: Number, default: 400 },
  },
  emits: ['update:modelValue'],
  data() { return { availableWidth: 0, dragging: false }; },
  computed: {
    maxSize() {
      return Math.max(this.minSize, Math.min(this.maxLimit, this.availableWidth - this.minRemaining));
    },
    currentSize() { return this.clamp(this.modelValue); },
    // Arrow keys move the divider in the direction pressed.
    growKey() { return this.pane === 'previous' ? 'ArrowRight' : 'ArrowLeft'; },
    shrinkKey() { return this.pane === 'previous' ? 'ArrowLeft' : 'ArrowRight'; },
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
    paneElement() {
      return this.pane === 'previous' ? this.$el.previousElementSibling : this.$el.nextElementSibling;
    },
    startDrag(event) {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      this.finishDrag();
      this.measure();
      // Focus taken only for the drag is released afterwards, so a mouse
      // resize leaves no focus indicator behind.
      const releaseFocus = document.activeElement !== this.$el;
      this.$el.focus({ preventScroll: true });
      this.drag = {
        id: event.pointerId,
        x: event.clientX,
        size: this.paneElement()?.getBoundingClientRect().width || this.currentSize,
        releaseFocus,
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
      const delta = event.clientX - this.drag.x;
      this.setSize(this.drag.size + (this.pane === 'previous' ? delta : -delta));
    },
    finishDrag() {
      const drag = this.drag;
      if (!drag) return;
      this.drag = null;
      this.dragging = false;
      document.body.style.cursor = drag.cursor;
      document.body.style.userSelect = drag.userSelect;
      if (this.$el.hasPointerCapture(drag.id)) this.$el.releasePointerCapture(drag.id);
      if (drag.releaseFocus && document.activeElement === this.$el) this.$el.blur();
    },
    onKeydown(event) {
      const step = event.shiftKey ? 64 : 16;
      const sizes = {
        [this.growKey]: this.currentSize + step,
        [this.shrinkKey]: this.currentSize - step,
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
