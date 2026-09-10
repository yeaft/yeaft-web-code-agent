export default {
  name: 'MessageComposer',
  props: {
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    canSend: { type: Boolean, default: false },
    sending: { type: Boolean, default: false },
    showStop: { type: Boolean, default: false },
    rows: { type: Number, default: 2 },
    inputId: { type: String, default: '' },
    sendLabel: { type: String, default: '' },
    stopLabel: { type: String, default: '' },
    ariaAutocomplete: { type: String, default: null },
    ariaHaspopup: { type: String, default: null },
    ariaControls: { type: String, default: null },
    ariaActivedescendant: { type: String, default: null },
  },
  emits: ['update:modelValue', 'input', 'keydown', 'paste', 'blur', 'send', 'stop'],
  setup(props, { emit }) {
    const textareaWrapperRef = Vue.ref(null);
    const textareaRef = Vue.ref(null);
    const textareaScrollable = Vue.ref(false);
    const maxTextareaHeight = 120;
    let resizeObserver = null;
    let resizeFrame = null;
    let observedWidth = null;

    const autoResize = () => {
      const textarea = textareaRef.value;
      if (!textarea) return;
      textarea.style.height = 'auto';
      const nextHeight = Math.min(textarea.scrollHeight, maxTextareaHeight);
      textarea.style.height = `${nextHeight}px`;
      textareaScrollable.value = textarea.scrollHeight > maxTextareaHeight;
    };

    const scheduleAutoResize = () => {
      if (resizeFrame !== null) return;
      if (typeof requestAnimationFrame !== 'function') {
        autoResize();
        return;
      }
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        autoResize();
      });
    };

    const resetTextareaSize = () => {
      const textarea = textareaRef.value;
      if (!textarea) return;
      textarea.style.height = 'auto';
      textareaScrollable.value = false;
    };

    const onInput = (event) => {
      emit('update:modelValue', event.target.value);
      emit('input', event);
      autoResize();
    };

    const focusInput = () => Vue.nextTick(() => textareaRef.value?.focus());
    const getTextarea = () => textareaRef.value;

    Vue.watch(() => props.modelValue, (value) => {
      Vue.nextTick(() => {
        if (value) autoResize();
        else resetTextareaSize();
      });
    });

    Vue.onMounted(() => {
      autoResize();
      const wrapper = textareaWrapperRef.value;
      if (!wrapper || typeof ResizeObserver === 'undefined') return;
      observedWidth = wrapper.getBoundingClientRect().width;
      resizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect?.width ?? wrapper.getBoundingClientRect().width;
        if (width === observedWidth) return;
        observedWidth = width;
        scheduleAutoResize();
      });
      resizeObserver.observe(wrapper);
    });

    Vue.onUnmounted(() => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (resizeFrame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = null;
    });

    return {
      textareaWrapperRef,
      textareaRef,
      textareaScrollable,
      autoResize,
      resetTextareaSize,
      focusInput,
      getTextarea,
      onInput,
      emit,
    };
  },
  template: `
    <div class="input-wrapper chat-composer" data-message-composer>
      <div ref="textareaWrapperRef" class="textarea-wrapper">
        <slot name="overlays"></slot>
        <textarea
          ref="textareaRef"
          :value="modelValue"
          :id="inputId || null"
          :rows="rows"
          :class="{ 'is-scrollable': textareaScrollable }"
          :placeholder="placeholder"
          :disabled="disabled"
          :aria-autocomplete="ariaAutocomplete"
          :aria-haspopup="ariaHaspopup"
          :aria-controls="ariaControls"
          :aria-activedescendant="ariaActivedescendant"
          @input="onInput"
          @keydown="$emit('keydown', $event)"
          @paste="$emit('paste', $event)"
          @blur="$emit('blur', $event)"
        ></textarea>
      </div>
      <div class="chat-composer-actions">
        <div class="chat-composer-actions-start"><slot name="start-actions"></slot></div>
        <slot name="quick-actions"></slot>
        <div class="chat-composer-actions-end">
          <slot name="end-actions-before"></slot>
          <button
            v-if="showStop"
            type="button"
            class="send-btn stop-btn"
            @click="$emit('stop')"
            :title="stopLabel"
            :aria-label="stopLabel"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
          </button>
          <button
            type="button"
            class="send-btn"
            @click="$emit('send')"
            :disabled="!canSend"
            :title="sendLabel"
            :aria-label="sendLabel"
          >
            <span v-if="sending" class="message-composer-spinner" aria-hidden="true"></span>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m7 12 5-5 5 5M12 7v10"/></svg>
          </button>
        </div>
      </div>
    </div>
  `,
};
