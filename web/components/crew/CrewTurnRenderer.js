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
import { renderMarkdown, renderMermaidIn, stripRouteBlocks } from '../../utils/markdown.js';
import { openImagePreview } from '../../utils/imagePreview.js';
import {
  formatTime, shortName, getRoleStyle as getRoleStyleFn, getImageUrl
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
    roleColorMap: { type: Object, default: () => ({}) },
    getRoleDisplayName: { type: Function, default: (name) => name }
  },
  emits: ['toggle-turn', 'ask-submit'],
  data() {
    return {
      crewCopied: false,
      crewScreenshotting: false
    };
  },
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
        <div v-else-if="turn.message.type === 'text' && turn.message.role === 'human'" class="crew-msg-content user-text-content">{{ turn.message.content }}<span v-if="showHumanBubble && turn.message.timestamp" class="message-time crew-bubble-time" :title="formatTime(turn.message.timestamp)">{{ formatTime(turn.message.timestamp) }}</span></div>
        <div v-else-if="turn.message.type === 'text'" class="crew-msg-content markdown-body" v-html="mdRender(turn.message.content)"></div>
        <div v-if="turn.message.type === 'text' && turn.message.role !== 'human' && turn.message.role !== 'system' && turn.message.content" class="crew-turn-footer">
          <button class="screenshot-btn" @click="crewScreenshot($event, turn.message.content)" :title="crewScreenshotting ? $t('message.screenshotting') : $t('message.screenshot')">
            <svg v-if="!crewScreenshotting" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
            <svg v-else class="screenshot-spinner" viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30 70" /></svg>
            <span class="screenshot-label">{{ crewScreenshotting ? $t('message.screenshotting') : $t('message.screenshot') }}</span>
          </button>
          <button class="export-md-btn" @click="crewExportMd(turn.message.content)" :title="$t('message.exportMd')">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            <span class="export-md-label">{{ $t('message.exportMd') }}</span>
          </button>
          <button class="copy-full-btn" @click="crewCopy(turn.message.content)" :title="crewCopied ? $t('message.copied') : $t('message.copyAll')">
            <svg v-if="!crewCopied" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
            <svg v-else viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
            <span class="copy-full-label">{{ crewCopied ? $t('message.copied') : $t('message.copyAll') }}</span>
          </button>
        </div>
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
          <div class="crew-turn-footer">
            <button class="screenshot-btn" @click="crewScreenshot($event, turn.textMsg.content)" :title="crewScreenshotting ? $t('message.screenshotting') : $t('message.screenshot')">
              <svg v-if="!crewScreenshotting" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
              <svg v-else class="screenshot-spinner" viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30 70" /></svg>
              <span class="screenshot-label">{{ crewScreenshotting ? $t('message.screenshotting') : $t('message.screenshot') }}</span>
            </button>
            <button class="export-md-btn" @click="crewExportMd(turn.textMsg.content)" :title="$t('message.exportMd')">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              <span class="export-md-label">{{ $t('message.exportMd') }}</span>
            </button>
            <button class="copy-full-btn" @click="crewCopy(turn.textMsg.content)" :title="crewCopied ? $t('message.copied') : $t('message.copyAll')">
              <svg v-if="!crewCopied" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
              <svg v-else viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
              <span class="copy-full-label">{{ crewCopied ? $t('message.copied') : $t('message.copyAll') }}</span>
            </button>
          </div>
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
              <span v-if="rm.timestamp" class="crew-route-time">{{ formatTime(rm.timestamp) }}</span>
            </div>
            <div v-if="rm.routeSummary" class="crew-route-summary">{{ rm.routeSummary }}</div>
            <div v-if="rm.routeImages && rm.routeImages.length > 0" class="crew-route-images">
              <img v-for="(img, idx) in rm.routeImages" :key="idx"
                :src="getRouteImageUrl(img)"
                class="crew-route-thumbnail"
                @click="openImagePreview(getRouteImageUrl(img))"
                @error="handleImageError($event)"
                :alt="'Attached image ' + (idx + 1)" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  mounted() {
    this.$nextTick(() => renderMermaidIn(this.$el));
  },
  updated() {
    this.$nextTick(() => renderMermaidIn(this.$el));
  },
  computed: {
    askToolMsg() {
      if (this.turn.type !== 'turn') return null;
      return this.turn.toolMsgs?.find(m => m.toolName === 'AskUserQuestion') || null;
    }
  },
  methods: {
    formatTime,
    shortName,
    getRoleStyle(roleName) {
      return getRoleStyleFn(roleName, this.roleColorMap[roleName]);
    },
    getImageUrl,
    getRouteImageUrl(img) {
      if (!img.fileId) return '';
      return `/api/preview/${img.fileId}?token=${img.previewToken || ''}`;
    },
    // task-328: explicit "displayBody" pipeline — strip ROUTE/TASKS markers
    // before markdown so multi-paragraph prose around a ROUTE block stays
    // intact in the rendered turn body. Route metadata is rendered separately
    // via `turn.routeMsgs` and is not duplicated in the prose.
    mdRender(text) {
      return renderMarkdown(stripRouteBlocks(text));
    },

    openImagePreview,

    handleImageError(event) {
      const img = event.target;
      const expired = document.createElement('div');
      expired.className = 'crew-screenshot-expired';
      expired.textContent = this.$t('crew.imageExpired');
      img.parentNode.replaceChild(expired, img);
    },

    async crewScreenshot(event, content) {
      if (this.crewScreenshotting || !window.htmlToImage) return;
      this.crewScreenshotting = true;
      try {
        const btn = event.currentTarget;
        const msgBody = btn.closest('.crew-msg-body');
        const contentEl = msgBody?.querySelector('.crew-msg-content.markdown-body');
        if (!contentEl) return;
        const bgColor = getComputedStyle(document.body).getPropertyValue('--bg-main').trim() || '#ffffff';
        contentEl.classList.add('screenshot-mode');
        try {
          const pad = 32;
          const rect = contentEl.getBoundingClientRect();
          const dataUrl = await window.htmlToImage.toPng(contentEl, {
            backgroundColor: bgColor,
            pixelRatio: 3,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            style: { padding: `${pad}px` }
          });
          const link = document.createElement('a');
          link.download = `crew-response-${Date.now()}.png`;
          link.href = dataUrl;
          link.click();
        } finally {
          contentEl.classList.remove('screenshot-mode');
        }
      } catch (e) {
        console.error('Crew screenshot failed:', e);
      } finally {
        this.crewScreenshotting = false;
      }
    },

    crewExportMd(content) {
      if (!content) return;
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `crew-response-${Date.now()}.md`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    },

    async crewCopy(content) {
      try {
        await navigator.clipboard.writeText(content || '');
        this.crewCopied = true;
        setTimeout(() => { this.crewCopied = false; }, 2000);
      } catch (e) {
        console.error('Crew copy failed:', e);
      }
    }
  }
};
