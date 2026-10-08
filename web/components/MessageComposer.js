import { formatFileSize, hasAttachmentFileId } from '../utils/composer-attachments.js';

export default {
  name: 'MessageComposer',
  props: {
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    canSend: { type: Boolean, default: false },
    sending: { type: Boolean, default: false },
    showStop: { type: Boolean, default: false },
    // Opt-in keeps other consumers' keyboard handling unchanged. Parent keydown
    // handlers (autocomplete / quick-send) run first and may preventDefault().
    keyboardSend: { type: Boolean, default: false },
    attachmentsEnabled: { type: Boolean, default: false },
    attachments: { type: Array, default: () => [] },
    attachmentAccept: { type: String, default: '' },
    attachmentsDisabled: { type: Boolean, default: false },
    rows: { type: Number, default: 2 },
    inputId: { type: String, default: '' },
    sendLabel: { type: String, default: '' },
    stopLabel: { type: String, default: '' },
    ariaAutocomplete: { type: String, default: null },
    ariaHaspopup: { type: String, default: null },
    ariaControls: { type: String, default: null },
    ariaActivedescendant: { type: String, default: null },
  },
  emits: ['update:modelValue', 'input', 'keydown', 'paste', 'focus', 'blur', 'send', 'stop', 'files-selected', 'retry-attachment', 'remove-attachment'],
  setup(props, { emit }) {
    const fileInput = Vue.ref(null);
    const uid = Vue.getCurrentInstance()?.uid ?? nextComposerId++;
    const fileInputId = `composer-files-${uid}`;
    const attachmentsLocked = Vue.computed(() => props.disabled || props.sending || props.attachmentsDisabled);
    const sendDisabled = Vue.computed(() => props.disabled || props.sending || !props.canSend
      || (props.attachmentsEnabled && props.attachments.some(row => row.uploading || row.uploadError || !hasAttachmentFileId(row))));
    const send = () => { if (!sendDisabled.value) emit('send'); };
    const onKeydown = event => {
      emit('keydown', event);
      if (!props.keyboardSend || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      // Session's shared shortcut: Enter sends; Shift+Enter inserts a newline.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!event.repeat) send();
      }
    };
    const selectFiles = files => {
      if (props.attachmentsEnabled && !attachmentsLocked.value && files.length) emit('files-selected', files);
    };
    const onFileSelect = event => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      selectFiles(files);
      if (!attachmentsLocked.value) focusInput();
    };
    const onPaste = event => {
      emit('paste', event);
      if (!props.attachmentsEnabled || event.defaultPrevented) return;
      const files = Array.from(event.clipboardData?.files || []);
      if (!files.length) {
        for (const item of Array.from(event.clipboardData?.items || [])) {
          if (item.kind !== 'file') continue;
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length) { event.preventDefault(); selectFiles(files); }
    };
    const onDragover = event => {
      if (!props.attachmentsEnabled || !Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = attachmentsLocked.value ? 'none' : 'copy';
    };
    const onDrop = event => {
      if (!props.attachmentsEnabled) return;
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length) { event.preventDefault(); selectFiles(files); }
    };
    const retryAttachment = row => {
      if (!attachmentsLocked.value && !row.uploading && row.uploadError) emit('retry-attachment', row);
    };
    const removeAttachment = row => {
      if (attachmentsLocked.value) return;
      emit('remove-attachment', row);
      focusInput();
    };
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
      fileInput, fileInputId, attachmentsLocked, sendDisabled, send, onKeydown, onPaste, onFileSelect, onDragover, onDrop, retryAttachment, removeAttachment, formatFileSize,
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
    <div class="input-wrapper chat-composer" :class="{ 'is-disabled': disabled }" data-message-composer @dragover="onDragover" @drop="onDrop">
      <div class="attachments-preview" v-if="attachmentsEnabled && attachments.length" aria-live="polite">
        <div v-for="file in attachments" :key="file.localId" class="attachment-item" :class="{ 'is-uploading': file.uploading, 'has-error': file.uploadError }">
          <img v-if="file.preview" :src="file.preview" :alt="file.name" class="attachment-thumb" />
          <span v-else class="attachment-icon" aria-hidden="true">&#128206;</span>
          <span class="attachment-details">
            <span class="attachment-name" :title="file.name">{{ file.name }}</span>
            <span class="attachment-status">
              {{ formatFileSize(file.size) }}
              <span v-if="file.uploading"> · {{ $t('chatInput.uploading') }}</span>
              <span v-else-if="file.uploadError"> · {{ $t('chatInput.uploadFailed') }}</span>
            </span>
          </span>
          <button v-if="file.uploadError" type="button" class="attachment-retry" :disabled="attachmentsLocked || file.uploading" @click="retryAttachment(file)">{{ $t('chatInput.retryUpload') }}</button>
          <button type="button" class="attachment-remove" :disabled="attachmentsLocked" @click="removeAttachment(file)" :title="$t('chatInput.removeAttachment')" :aria-label="$t('chatInput.removeAttachment') + ' ' + file.name">&times;</button>
        </div>
      </div>
      <input v-if="attachmentsEnabled" ref="fileInput" :id="fileInputId" type="file" multiple :accept="attachmentAccept" :disabled="attachmentsLocked" tabindex="-1" aria-hidden="true" class="file-input-hidden" @change="onFileSelect" />
      <div ref="textareaWrapperRef" class="textarea-wrapper">
        <slot name="overlays"></slot>
        <textarea
          ref="textareaRef"
          :value="modelValue"
          :id="inputId || null"
          :rows="rows"
          :class="{ 'is-scrollable': textareaScrollable }"
          :placeholder="placeholder"
          :disabled="disabled || sending"
          :aria-autocomplete="ariaAutocomplete"
          :aria-haspopup="ariaHaspopup"
          :aria-controls="ariaControls"
          :aria-activedescendant="ariaActivedescendant"
          @input="onInput"
          @keydown="onKeydown"
          @paste="onPaste"
          @focus="$emit('focus', $event)"
          @blur="$emit('blur', $event)"
        ></textarea>
      </div>
      <div class="chat-composer-actions">
        <div class="chat-composer-actions-start">
          <button v-if="attachmentsEnabled" type="button" class="attach-btn" :disabled="attachmentsLocked" :aria-controls="fileInputId" :title="$t('chatInput.upload')" :aria-label="$t('chatInput.upload')" @click="fileInput?.click()">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
          </button>
          <slot name="start-actions"></slot>
        </div>
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
            @click="send"
            :disabled="sendDisabled"
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

let nextComposerId = 1;
