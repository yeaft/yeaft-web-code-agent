import { openImagePreview } from '../utils/imagePreview.js';
import { getSelectionLabel } from '../utils/expert-roles.js';

export default {
  name: 'MessageItem',
  props: {
    message: {
      type: Object,
      required: true
    }
  },
  template: `
    <div :class="messageClass">
      <!-- User message -->
      <template v-if="message.type === 'user'">
        <!-- Expert selections labels -->
        <div class="message-expert-labels" v-if="message.expertSelections && message.expertSelections.length > 0">
          <span
            v-for="sel in message.expertSelections"
            :key="sel.role + (sel.action || '')"
            class="expert-label"
          >{{ formatExpertLabel(sel) }}</span>
        </div>
        <div class="message-content" v-if="message.content">{{ message.content }}</div>
        <!-- Attachments indicator -->
        <div class="user-attachments-indicator" v-if="message.attachments && message.attachments.length > 0">
          <span class="attachments-badge" @click="toggleAttachments">
            <span class="badge-icon">\u{1F4CE}</span>
            <span class="badge-text">{{ getAttachmentsText(message.attachments) }}</span>
            <span class="badge-toggle" :class="{ expanded: showAttachments }">
              <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
            </span>
          </span>
        </div>
        <!-- Expanded attachments preview -->
        <div class="user-attachments" v-if="message.attachments && message.attachments.length > 0 && showAttachments">
          <div
            v-for="(attachment, index) in message.attachments"
            :key="index"
            class="user-attachment-item"
            :class="{ 'is-image': attachment.isImage }"
          >
            <img
              v-if="attachment.isImage && attachment.preview"
              :src="attachment.preview"
              :alt="attachment.name"
              class="user-attachment-image"
              @click="openImagePreview(attachment.preview)"
            />
            <div v-else class="user-attachment-file">
              <span class="file-icon">{{ getFileIcon(attachment.mimeType) }}</span>
              <span class="file-name">{{ attachment.name }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- System message -->
      <template v-else-if="message.type === 'system'">
        {{ message.content }}
      </template>

      <!-- Error message -->
      <template v-else-if="message.type === 'error'">
        {{ message.content }}
      </template>
    </div>
  `,
  setup(props) {
    const store = Pinia.useChatStore();
    const showAttachments = Vue.ref(false);
    const t = Vue.inject('t');

    const messageClass = Vue.computed(() => {
      return ['message', props.message.type];
    });

    const toggleAttachments = () => {
      showAttachments.value = !showAttachments.value;
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
      showAttachments,
      toggleAttachments,
      formatExpertLabel,
      getAttachmentsText,
      getFileIcon,
      openImagePreview
    };
  }
};
