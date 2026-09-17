import UserTurnBlock from './UserTurnBlock.js';
import VpTurnBlock from './VpTurnBlock.js';

import { renderMermaidIn } from '../utils/markdown.js';

export default {
  name: 'WorkCenterActionDetail',
  components: { UserTurnBlock, VpTurnBlock },
  props: {
    action: { type: Object, default: null },
    canMessage: { type: Boolean, default: false },
    messages: { type: Array, default: () => [] },
    messagesNextCursor: { type: [String, Number], default: null },
    messagesLoading: { type: Boolean, default: false },
    messagesError: { type: String, default: '' },
    previewingAttachmentId: { type: String, default: null },
    attachmentError: { type: String, default: '' },
  },
  emits: ['load-earlier-messages', 'open-attachment', 'quote', 'edit-as-new'],
  computed: {
    executorName() {
      return this.action?.assignedVp?.name || this.action?.assignedVp?.id
        || this.action?.requiredRole || this.tr('workCenter.actionExecutorPending', 'Executor pending');
    },
    hasMessages() {
      return this.messages.length > 0;
    },
    waitingQuestion() {
      if (this.action?.status !== 'waiting') return '';
      return String(this.action?.canonicalResult?.waitingReason || '').trim();
    },
    conversationBlocks() {
      return this.messages.map(message => {
        const timestamp = Number(message?.updatedAt || message?.createdAt) || 0;
        if (message?.role === 'user') {
          return {
            key: message.id,
            kind: 'user',
            message: {
              id: message.id,
              messageId: message.id,
              type: 'user',
              content: message.text || '',
              attachments: Array.isArray(message.attachments) ? message.attachments : [],
              quote: message.quote || null,
              timestamp,
            },
          };
        }
        const speaker = message.speaker || {};
        const speakerName = this.messageSpeaker(message);
        const speakerId = speaker.id || `work-center-action:${this.action?.id || 'unknown'}`;
        return {
          key: message.id,
          kind: 'assistant',
          speakerName,
          turn: {
            id: message.id,
            messageId: message.id,
            atMessageId: message.id,
            turnId: message.turnId || message.id,
            textContent: message.text || '',
            textSegments: message.text ? [{
              key: message.id,
              content: message.text,
              kind: message.status === 'running' ? 'progress' : 'result',
              isStreaming: message.status === 'running',
            }] : [],
            isStreaming: message.status === 'running',
            speakerVpId: speakerId,
            speakerTimestamp: timestamp,
            showSpeakerHeader: true,
            timestamp,
            createdAt: timestamp,
            todoMsg: null,
            toolMsgs: (Array.isArray(message.toolEvents) ? message.toolEvents : []).map((event, index) => ({
              type: 'tool-use',
              toolId: event.id || `${message.id}:tool:${index}`,
              toolName: event.name,
              toolInput: event.resource ? { displayResource: event.resource } : null,
              hasResult: event.status !== 'running',
              isError: event.status === 'error',
              startTime: Number(event.startedAt) || 0,
            })),
            toolSummaryCount: Array.isArray(message.toolEvents) ? message.toolEvents.length : 0,
            imageMsgs: [],
            askMsg: null,
            attachments: Array.isArray(message.attachments) ? message.attachments : [],
          },
        };
      });
    },
  },
  watch: {
    messages: {
      deep: true,
      handler() { this.$nextTick(() => renderMermaidIn(this.$el)); },
    },
  },
  mounted() {
    this.$nextTick(() => renderMermaidIn(this.$el));
  },
  methods: {
    tr(key, fallback) {
      const translated = this.$t ? this.$t(key) : key;
      return translated && translated !== key ? translated : fallback;
    },
    statusLabel(status) {
      return this.tr(`workCenter.status.${status}`, String(status || '').replace('_', ' '));
    },
    actionSequence() {
      const sequence = Number(this.action?.sequence);
      return Number.isFinite(sequence) && sequence > 0 ? sequence : 1;
    },
    messageSpeaker(message) {
      if (message?.role === 'user') return this.tr('workCenter.you', 'You');
      const role = this.$t('workCenter.actionNumber', { number: this.actionSequence() });
      const name = message?.speaker?.name || message?.speaker?.id || '';
      return name ? this.$t('workCenter.messageSpeakerRole', { name, role }) : role;
    },
    time(value) {
      if (!value) return '';
      try { return new Date(Number(value)).toLocaleString(); } catch { return ''; }
    },
    formatAttachmentSize(value) {
      const size = Math.max(0, Number(value) || 0);
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / 1024 / 1024).toFixed(1)} MB`;
    },
    openAttachment(payload) {
      this.$emit('open-attachment', payload?.attachment || payload, payload?.trigger || null);
    },
  },
  template: `
    <section class="work-center-action-detail-pane" v-if="action">
      <div class="work-center-action-detail-scroll">
        <div class="work-center-action-conversation-column">
          <section class="work-center-action-overview">
            <div class="work-center-action-overview-meta">
              <span class="work-center-status" :data-status="action.status"><span aria-hidden="true"></span>{{ statusLabel(action.status) }}</span>
              <span v-if="action.assignedVp || action.requiredRole || ['ready', 'running', 'waiting'].includes(action.status)" class="work-center-action-executor"><span class="work-center-action-vp-presence" :data-status="action.status" aria-hidden="true"></span>{{ executorName }}</span>
            </div>
            <h2>{{ action.brief?.objective || tr('workCenter.actionDetails', 'Action details') }}</h2>
            <p v-if="action.brief?.approach">{{ action.brief.approach }}</p>
            <dl class="work-center-action-context-list">
              <div v-if="action.brief?.expectedOutcome"><dt>{{ tr('workCenter.actionExpectedOutcome', 'Expected result') }}</dt><dd>{{ action.brief.expectedOutcome }}</dd></div>
              <div v-if="(action.sourceActionIds?.length || action.dependsOnStageIds?.length)"><dt>{{ tr('workCenter.dependencies', 'Source Actions') }}</dt><dd>{{ (action.sourceActionIds?.length ? action.sourceActionIds : action.dependsOnStageIds).join(', ') }}</dd></div>
              <div v-if="action.canonicalResult?.summary"><dt>{{ tr('workCenter.actionResult', 'Latest result') }}</dt><dd>{{ action.canonicalResult.summary }}</dd></div>
            </dl>
          </section>

          <section v-if="waitingQuestion" id="work-center-action-waiting-question" class="work-center-action-waiting" role="status">
            <strong>{{ tr('workCenter.waitingQuestionTitle', 'Input required') }}</strong>
            <p>{{ waitingQuestion }}</p>
          </section>
          <section v-if="action.status === 'closed' && action.closeReason" class="work-center-action-closed" role="status">
            <strong>{{ tr('workCenter.actionClosedTitle', 'Why this Action was closed') }}</strong>
            <p>{{ action.closeReason }}</p>
            <small v-if="action.closedAt">{{ tr('workCenter.closedAt', 'Closed at') }} · {{ time(action.closedAt) }}</small>
          </section>
          <section v-if="action.failure" class="work-center-action-failure" role="alert">
            <strong>{{ tr('workCenter.actionFailedTitle', 'Why this Action failed') }}</strong>
            <p v-if="action.failure.error">{{ action.failure.error }}</p>
            <p v-if="action.failure.summary && action.failure.summary !== action.failure.error">{{ action.failure.summary }}</p>
            <small v-if="action.failure.failedAt">{{ tr('workCenter.failedAt', 'Failed at') }} · {{ time(action.failure.failedAt) }}</small>
            <small v-if="canMessage">{{ tr('workCenter.actionFailureRecovery', 'Choose this Action in the Work Item composer to send corrected instructions.') }}</small>
          </section>

          <button v-if="messagesNextCursor != null" class="btn-ghost work-center-action-load-earlier" type="button" @click="$emit('load-earlier-messages')" :disabled="messagesLoading">
            {{ messagesLoading ? tr('workCenter.loadingEarlierMessages', 'Loading earlier messages…') : tr('workCenter.loadEarlierMessages', 'Load earlier messages') }}
          </button>
          <p v-if="messagesError" class="work-center-error">{{ messagesError }}</p>
          <div class="work-center-action-message-list">
            <template v-for="block in conversationBlocks" :key="block.key">
              <UserTurnBlock
                v-if="block.kind === 'user'"
                class="work-center-action-message role-user"
                :message="block.message"
                :external-attachment-open="true"
                @quote="$emit('quote', $event)"
                @edit-as-new="$emit('edit-as-new', $event)"
                @open-attachment="openAttachment"
              />
              <VpTurnBlock
                v-else
                class="work-center-action-message role-assistant"
                :turn="block.turn"
                :display-name-override="block.speakerName"
                :can-stop="false"
                :interactive-speaker="false"
                @quote="$emit('quote', $event)"
              >
                <div v-if="block.turn.attachments?.length" class="work-center-attachment-list">
                  <button v-for="attachment in block.turn.attachments" :key="attachment.id" type="button"
                          class="work-center-attachment-chip work-center-attachment-preview"
                          :disabled="previewingAttachmentId === attachment.id"
                          :aria-label="$t('workCenter.openAttachmentNamed', { name: attachment.name })"
                          @click="$emit('open-attachment', attachment, $event.currentTarget)">
                    <span>{{ attachment.name }}</span><small>{{ previewingAttachmentId === attachment.id ? tr('workCenter.openingAttachment', 'Opening attachment…') : formatAttachmentSize(attachment.size) }}</small>
                  </button>
                </div>
              </VpTurnBlock>
            </template>
          </div>
          <p v-if="attachmentError" class="work-center-error" role="alert">{{ attachmentError }}</p>
          <p v-if="!hasMessages" class="work-center-action-empty">{{ tr('workCenter.noActionMessages', 'No messages yet.') }}</p>
        </div>
      </div>
    </section>
    <section v-else class="work-center-action-detail-pane work-center-detail-empty"><strong>{{ tr('workCenter.selectAction', 'Select an Action') }}</strong></section>
  `,
};
