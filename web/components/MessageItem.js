import { openImagePreview } from '../utils/imagePreview.js';
import { getSelectionLabel } from '../utils/expert-roles.js';
import { normalizeTerminalOutput } from '../utils/terminal-output.js';
import { formatSessionMessageDateTime, quoteFromUserMessage } from '../utils/session-message-quote.js';

export default {
  name: 'MessageItem',
  props: {
    message: {
      type: Object,
      required: true
    },
    sessionActions: { type: Boolean, default: false },
    hideSpeakerIdentity: { type: Boolean, default: false },
    externalAttachmentOpen: { type: Boolean, default: false }
  },
  emits: ['quote', 'edit-as-new', 'open-attachment'],
  template: `
    <div :class="messageClass">
      <!-- User message -->
      <template v-if="message.type === 'user'">
        <div class="message-user-meta">
          <span class="message-user-author">{{ $t('message.you') }}</span>
          <template v-if="messageTime">
            <span class="message-user-meta-separator" aria-hidden="true">·</span>
            <span class="message-time" :title="messageTimeFull">{{ messageTime }}</span>
          </template>
        </div>
        <div class="message-user-block">
          <!-- Expert selections labels -->
          <div class="message-expert-labels" v-if="message.expertSelections && message.expertSelections.length > 0">
            <span
              v-for="sel in message.expertSelections"
              :key="sel.role + (sel.action || '')"
              class="expert-label"
            >{{ formatExpertLabel(sel) }}</span>
          </div>
          <div v-if="message.quote" class="message-quoted-context">
            <div class="message-quoted-author">{{ $t('message.quotedFrom', { author: hideSpeakerIdentity && message.quote.role === 'assistant' ? $t('message.assistant') : message.quote.author }) }}</div>
            <div v-if="message.quote.content" class="message-quoted-content">{{ message.quote.content }}</div>
            <div v-if="message.quote.todos && message.quote.todos.length" class="message-quoted-todos">
              <div v-for="todo in message.quote.todos" :key="todo.content" class="message-quoted-todo">
                <span>{{ todoStatusSymbol(todo.status) }}</span>
                <span>{{ todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content }}</span>
              </div>
            </div>
          </div>
          <div class="message-content" v-if="message.content">{{ displayContent }}</div>
          <div v-if="message.attachments && message.attachments.length > 0" class="message-user-attachments">
            <button type="button" class="attachments-badge" @click="toggleAttachments">
              <span class="badge-icon" aria-hidden="true">\u{1F4CE}</span>
              <span class="badge-text">{{ getAttachmentsText(message.attachments) }}</span>
              <span class="badge-toggle" :class="{ expanded: showAttachments }" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
              </span>
            </button>
          </div>
          <!-- Expanded attachments preview -->
          <div class="user-attachments" v-if="message.attachments && message.attachments.length > 0 && showAttachments">
            <template v-for="(attachment, index) in message.attachments" :key="index">
              <button
                v-if="attachment.isImage && attachment.preview"
                type="button"
                class="user-attachment-item is-image"
                @click="previewAttachment(attachment, $event.currentTarget)"
              >
                <img
                  :src="attachment.preview"
                  :alt="attachment.name || t('message.imagePreview')"
                  class="user-attachment-image"
                />
              </button>
              <button
                v-else-if="externalAttachmentOpen"
                type="button"
                class="user-attachment-item"
                @click="previewAttachment(attachment, $event.currentTarget)"
              >
                <span class="user-attachment-file">
                  <span class="file-icon">{{ getFileIcon(attachment.mimeType) }}</span>
                  <span class="file-name">{{ attachment.name }}</span>
                </span>
              </button>
              <div v-else class="user-attachment-item">
                <div class="user-attachment-file">
                  <span class="file-icon">{{ getFileIcon(attachment.mimeType) }}</span>
                  <span class="file-name">{{ attachment.name }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>
        <div v-if="sessionActions" class="message-user-actions">
          <button type="button" class="message-action-btn" @click="$emit('quote', userQuote)" :title="$t('message.quote')" :aria-label="$t('message.quote')">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
          </button>
          <button type="button" class="message-action-btn" @click="$emit('edit-as-new', displayContent)" :title="$t('message.editAsNew')" :aria-label="$t('message.editAsNew')">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          </button>
        </div>
      </template>

      <!-- System message -->
      <template v-else-if="message.type === 'system'">
        {{ displayContent }}
      </template>

      <!-- Error message -->
      <template v-else-if="message.type === 'error'">
        {{ displayContent }}
      </template>
    </div>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const showAttachments = Vue.ref(false);
    const t = Vue.inject('t');

    const messageClass = Vue.computed(() => {
      return ['message', props.message.type];
    });

    const _timeSource = () => {
      const m = props.message;
      if (typeof m.timestamp === 'number' && m.timestamp > 0) return m.timestamp;
      if (typeof m.createdAt === 'number' && m.createdAt > 0) return m.createdAt;
      return null;
    };

    const messageTime = Vue.computed(() => formatSessionMessageDateTime(_timeSource()));

    const messageTimeFull = Vue.computed(() => {
      const ts = _timeSource();
      if (!ts) return '';
      try { return new Date(ts).toLocaleString(); } catch { return ''; }
    });

    const displayContent = Vue.computed(() => normalizeTerminalOutput(props.message.content || ''));
    const userQuote = Vue.computed(() => quoteFromUserMessage(props.message, t('message.you')));

    const toggleAttachments = () => {
      showAttachments.value = !showAttachments.value;
    };

    const previewableAttachments = Vue.computed(() => (
      (Array.isArray(props.message?.attachments) ? props.message.attachments : [])
        .filter(attachment => attachment?.isImage && attachment?.preview)
        .map(attachment => ({
          attachment,
          src: attachment.preview,
          alt: attachment.name || t('message.imagePreview'),
        }))
    ));

    const previewAttachment = (attachment, trigger) => {
      if (props.externalAttachmentOpen) {
        emit('open-attachment', { attachment, trigger });
        return;
      }
      const images = previewableAttachments.value;
      const initialIndex = images.findIndex(entry => entry.attachment === attachment);
      if (initialIndex < 0) return;
      openImagePreview(images[initialIndex].src, {
        alt: images[initialIndex].alt,
        closeLabel: t('common.close'),
        previousLabel: t('message.previousImage'),
        nextLabel: t('message.nextImage'),
        positionLabel: (current, total) => t('message.imagePosition', { current, total }),
        gallery: images.map(({ src, alt }) => ({ src, alt })),
        initialIndex,
        trigger,
      });
    };

    const formatExpertLabel = (sel) => {
      return getSelectionLabel(sel, store.customExpertRoles);
    };

    const getAttachmentsText = (attachments) => {
      if (!attachments || attachments.length === 0) return '';
      const imageCount = attachments.filter(a => a.isImage).length;
      const fileCount = attachments.length - imageCount;
      const parts = [];
      if (imageCount > 0) parts.push(t('message.imageCount', { count: imageCount }));
      if (fileCount > 0) parts.push(t('message.fileCount', { count: fileCount }));
      return parts.join(t('common.comma'));
    };

    const todoStatusSymbol = (status) => {
      if (status === 'completed') return '✓';
      if (status === 'in_progress') return '→';
      return '○';
    };

    const getFileIcon = (mimeType) => {
      if (!mimeType) return '\u{1F4C4}';
      if (mimeType.startsWith('image/')) return '\u{1F5BC}\uFE0F';
      if (mimeType.startsWith('video/')) return '\u{1F3AC}';
      if (mimeType.startsWith('audio/')) return '\u{1F3B5}';
      if (mimeType.includes('pdf')) return '\u{1F4D5}';
      if (mimeType.includes('word') || mimeType.includes('document')) return '\u{1F4DD}';
      if (mimeType.includes('sheet') || mimeType.includes('excel')) return '\u{1F4CA}';
      if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '\u{1F4FD}\uFE0F';
      if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive')) return '\u{1F4E6}';
      if (mimeType.includes('text') || mimeType.includes('json') || mimeType.includes('xml')) return '\u{1F4C3}';
      return '\u{1F4C4}';
    };

    return {
      messageClass,
      messageTime,
      messageTimeFull,
      displayContent,
      userQuote,
      showAttachments,
      toggleAttachments,
      previewAttachment,
      t,
      formatExpertLabel,
      getAttachmentsText,
      todoStatusSymbol,
      getFileIcon
    };
  }
};
