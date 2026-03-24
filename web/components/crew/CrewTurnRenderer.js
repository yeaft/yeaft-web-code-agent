/**
 * CrewTurnRenderer — Renders a single turn (message or turn-group).
 * Extracted from CrewChatView to eliminate 3x duplicated turn templates.
 *
 * Props:
 *   turn       — turn object (type: 'turn' | 'system' | etc)
 *   showHumanBubble — enable human bubble styling and attachments (global blocks only)
 *   expandedTurns   — reactive map for tool expansion state
 *   icons           — icon SVG strings
 */
import { renderMarkdown } from '../../utils/markdown.js';
import { openImagePreview } from '../../utils/imagePreview.js';
import {
  formatTime, shortName, getRoleStyle, getImageUrl
} from './crewHelpers.js';
import AskCard from '../AskCard.js';

export default {
  name: 'CrewTurnRenderer',
  components: { AskCard },
  props: {
    turn: { type: Object, required: true },
    showHumanBubble: { type: Boolean, default: false },
    expandedTurns: { type: Object, required: true },
    icons: { type: Object, required: true },
    getRoleDisplayName: { type: Function, default: (name) => name }
  },
  emits: ['toggle-turn', 'ask-submit'],
  template: `
    <div v-if="turn.type !== 'turn'" class="crew-message" :class="['crew-msg-' + (turn.message.type), 'crew-role-' + (turn.message.role), { 'crew-msg-human-bubble': showHumanBubble && turn.message.role === 'human' && turn.message.type === 'text' }]" :data-role="turn.message.role" :style="getRoleStyle(turn.message.role)">
      <div class="crew-msg-body">
        <div v-if="showHumanBubble ? (turn.message.role !== 'human' || turn.message.type !== 'text') : true" class="crew-msg-header">
          <span v-if="turn.message.roleIcon" class="crew-msg-header-icon">{{ turn.message.roleIcon }}</span>
          <span class="crew-msg-name" :class="{ 'is-human': turn.message.role === 'human', 'is-system': turn.message.role === 'system' }">{{ shortName(turn.message.roleName) }}</span>
          <span class="crew-msg-time">{{ formatTime(turn.message.timestamp) }}</span>
        </div>
        <div v-if="turn.message.type === 'system'" class="crew-msg-system">{{ turn.message.content }}</div>
        <div v-else-if="turn.message.type === 'human_needed'" class="crew-msg-human-needed">
          <span class="crew-control-icon" v-html="icons.bell"></span> {{ turn.message.content }}
        </div>
        <div v-else-if="turn.message.type === 'role_error'" class="crew-msg-role-error">
          <span class="crew-error-icon">{{ turn.message.recoverable ? '🔄' : '❌' }}</span>
          <span>{{ turn.message.content }}</span>
        </div>
        <div v-else-if="turn.message.type === 'text' && turn.message.role === 'human'" class="crew-msg-content user-text-content">{{ turn.message.content }}</div>
        <div v-else-if="turn.message.type === 'text'" class="crew-msg-content markdown-body" v-html="mdRender(turn.message.content)"></div>
        <div v-if="showHumanBubble && turn.message.attachments && turn.message.attachments.length > 0" class="user-attachments" style="margin-top: 6px;">
          <div v-for="(att, aidx) in turn.message.attachments" :key="aidx" class="user-attachment-item" :class="{ 'is-image': att.isImage }">
            <img v-if="att.isImage && att.preview" :src="att.preview" :alt="att.name" class="user-attachment-image" @click="openImagePreview(att.preview)" />
            <div v-else class="user-attachment-file"><span class="file-name">{{ att.name }}</span></div>
          </div>
        </div>
        <div v-if="showHumanBubble && turn.message._sendFailed" class="crew-msg-send-failed">{{ $t('crew.sendFailed') }}</div>
      </div>
    </div>
    <div v-else class="crew-message crew-turn-group" :class="'crew-role-' + turn.role" :data-role="turn.role" :style="getRoleStyle(turn.role)">
      <div class="crew-msg-body">
        <div class="crew-msg-header">
          <span v-if="turn.roleIcon" class="crew-msg-header-icon">{{ turn.roleIcon }}</span>
          <span class="crew-msg-name">{{ shortName(turn.roleName) }}</span>
          <span class="crew-msg-time">{{ formatTime(turn.messages[0].timestamp) }}</span>
        </div>
        <template v-if="turn.textMsg">
          <div class="crew-msg-content markdown-body" v-html="mdRender(turn.textMsg.content)"></div>
        </template>
        <div v-if="turn.toolMsgs.length > 0" class="crew-turn-tools">
          <div v-if="expandedTurns[turn.id]" class="crew-turn-tools-expanded">
            <template v-for="(toolMsg, ti) in turn.toolMsgs.slice(0, -1)" :key="toolMsg.id">
              <tool-line :tool-name="toolMsg.toolName" :tool-input="toolMsg.toolInput" :tool-result="toolMsg.toolResult" :has-result="!!toolMsg.hasResult" :start-time="toolMsg.timestamp" :compact="true" />
            </template>
          </div>
          <div class="crew-turn-tool-latest">
            <tool-line :tool-name="turn.toolMsgs[turn.toolMsgs.length - 1].toolName" :tool-input="turn.toolMsgs[turn.toolMsgs.length - 1].toolInput" :tool-result="turn.toolMsgs[turn.toolMsgs.length - 1].toolResult" :has-result="!!turn.toolMsgs[turn.toolMsgs.length - 1].hasResult" :start-time="turn.toolMsgs[turn.toolMsgs.length - 1].timestamp" :compact="true" />
            <button v-if="turn.toolMsgs.length > 1" class="crew-turn-expand-btn" @click.stop="$emit('toggle-turn', turn.id)" :title="expandedTurns[turn.id] ? $t('crew.collapse') : $t('crew.expandOps', { count: turn.toolMsgs.length - 1 })">
              <svg v-if="!expandedTurns[turn.id]" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
              <svg v-else viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg>
              <span class="crew-turn-expand-count">{{ turn.toolMsgs.length }}</span>
            </button>
          </div>
        </div>
        <template v-if="askToolMsg">
          <AskCard :ask-msg="askToolMsg" :compact="true" @submit="(rid, ans) => $emit('ask-submit', rid, ans)" />
        </template>
        <div v-if="turn.imageMsgs.length > 0" class="crew-msg-images">
          <div v-for="img in turn.imageMsgs" :key="img.id" class="crew-msg-image">
            <img v-if="img.fileId" :src="getImageUrl(img)" class="crew-screenshot" @error="handleImageError($event)" @click="openImagePreview(getImageUrl(img))" :alt="'Screenshot by ' + (img.roleName || img.role)" />
            <div v-else class="crew-screenshot-expired">{{ $t('crew.imageExpired') }}</div>
          </div>
        </div>
        <div v-if="turn.routeMsgs.length > 0" class="crew-turn-routes">
          <div v-for="rm in turn.routeMsgs" :key="rm.id" class="crew-turn-route-item">
            <div class="crew-route-header">
              <span class="crew-route-from">{{ shortName(turn.roleName) }}</span>
              <span class="crew-route-arrow">→</span>
              <span class="crew-route-target-name">{{ rm.routeToName || getRoleDisplayName(rm.routeTo) }}</span>
            </div>
            <div v-if="rm.routeSummary" class="crew-route-summary">{{ rm.routeSummary }}</div>
          </div>
        </div>
      </div>
    </div>
  `,
  computed: {
    askToolMsg() {
      if (this.turn.type !== 'turn') return null;
      return this.turn.toolMsgs?.find(m => m.toolName === 'AskUserQuestion') || null;
    }
  },
  methods: {
    formatTime,
    shortName,
    getRoleStyle,
    getImageUrl,
    mdRender: renderMarkdown,

    openImagePreview,

    handleImageError(event) {
      const img = event.target;
      const expired = document.createElement('div');
      expired.className = 'crew-screenshot-expired';
      expired.textContent = this.$t('crew.imageExpired');
      img.parentNode.replaceChild(expired, img);
    }
  }
};
