/**
 * Yeaft Cosmos Creations — DirectorChatPane
 *
 * Reusable in BOTH Studio right rail AND Read Mode's 380px slide-out Anchor AI Drawer.
 * Wired to creationsStore's thread bucket (`loadThread`, `sendMessage`, `threadMessagesByKey`,
 * `controlRun`, `uploadSources`).
 */
import { useCreationsStore, creationThreadKey } from '../../../../stores/creations.js';
import { renderMarkdown } from '../../../../utils/markdown.js';
import { sanitizeCreationHtml } from '../sanitize.js';

function isFolderNode(n) {
  if (!n) return false;
  return n.kind === 'folder' || n.nodeType === 'folder' || n.type === 'folder' || n.isFolder === true;
}

const SLASH_PRESETS = [
  { key: 'slashOutline', cmd: '/outline ' },
  { key: 'slashCanon', cmd: '/canon ' },
  { key: 'slashDraft', cmd: '/draft ' },
  { key: 'slashPolish', cmd: '/polish ' },
];

export default {
  name: 'DirectorChatPane',
  setup() {
    const creationsStore = useCreationsStore();
    return { creationsStore };
  },
  props: {
    anchorMode: { type: Boolean, default: false },
    anchor: { type: Object, default: null },
    activeNode: { type: Object, default: null },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
    prefillText: { type: String, default: '' },
  },
  emits: ['close-anchor', 'action-chip', 'select-node'],
  data() {
    return {
      inputText: '',
      followSelection: true,
      manualScope: 'global', // 'global' | 'node'
      openContextGroup: null,
      excludedIds: [],
      pendingFiles: [],
      sending: false,
      sendError: '',
      loadingThread: false,
      activeThreadId: '',
      loadedThreadScopeKey: '',
      _threadLoadSeq: 0,
      slashPresets: SLASH_PRESETS,
    };
  },
  computed: {
    resolvedAgentId() {
      return this.agentId || this.creationsStore.activeCreation?.agentId || '';
    },
    resolvedCreationId() {
      return this.creationId || this.creationsStore.activeCreation?.creationId || '';
    },
    effectiveScope() {
      if (this.anchorMode) {
        return isFolderNode(this.activeNode) ? 'folder' : 'unit';
      }
      if (this.followSelection && this.activeNode) {
        return isFolderNode(this.activeNode) ? 'folder' : 'unit';
      }
      if (this.manualScope === 'node' && this.activeNode) {
        return isFolderNode(this.activeNode) ? 'folder' : 'unit';
      }
      return 'global';
    },
    scopeNodeId() {
      if (this.anchorMode && this.anchor?.nodeId) return this.anchor.nodeId;
      return this.effectiveScope !== 'global' ? this.activeNode?.id || null : null;
    },
    currentScopeKey() {
      return `${this.resolvedAgentId}:${this.resolvedCreationId}:${this.effectiveScope}:${this.scopeNodeId || 'global'}`;
    },
    threadBucket() {
      const aId = this.resolvedAgentId;
      const cId = this.resolvedCreationId;
      if (!aId || !cId) return null;
      if (this.activeThreadId && this.loadedThreadScopeKey === this.currentScopeKey) {
        const direct = this.creationsStore.threadMessagesByKey[creationThreadKey(aId, cId, this.activeThreadId)];
        if (direct) return direct;
      }
      if (this.loadingThread) return null;
      const fallbackId = `${this.effectiveScope}:${this.scopeNodeId || 'global'}`;
      return this.creationsStore.threadMessagesByKey[creationThreadKey(aId, cId, fallbackId)] || null;
    },
    messages() {
      return Array.isArray(this.threadBucket?.messages) ? this.threadBucket.messages : [];
    },
    hasMoreMessages() {
      return Boolean(this.threadBucket?.hasMore);
    },
    loadingMoreMessages() {
      return Boolean(this.threadBucket?.loadingMore);
    },
    streamingMessage() {
      return this.threadBucket?.streamingMessage || null;
    },
    isStreaming() {
      return Boolean(this.sending || this.streamingMessage);
    },
    canSend() {
      return !this.loadingThread && !this.isStreaming && Boolean(this.inputText.trim() || this.pendingFiles.length > 0);
    },
    activeBatchRun() {
      const runs = this.creationsStore.activeRunsForActive || [];
      return runs.find((r) => r && r.type === 'batch') || runs[0] || null;
    },
    isBatchRun() {
      return this.activeBatchRun?.type === 'batch';
    },
    batchDoneCount() {
      const r = this.activeBatchRun;
      return r ? (r.completedUnits ?? r.progress?.completed ?? r.completedCount ?? 0) : 0;
    },
    batchTotalCount() {
      const r = this.activeBatchRun;
      return r ? (r.totalUnits ?? r.progress?.total ?? r.totalCount ?? 0) : 0;
    },
    batchPercent() {
      if (!this.batchTotalCount) return 0;
      return Math.min(100, Math.round((this.batchDoneCount / this.batchTotalCount) * 100));
    },
    contextGroups() {
      const preview = this.threadBucket?.contextPreview || {};
      return [
        { key: 'contextPinned', icon: '📌', items: preview.coreCanon || preview.pinnedCanon || [] },
        { key: 'contextRecalled', icon: '✦', items: preview.recalledCanon || [] },
        { key: 'contextContinuity', icon: '📄', items: preview.continuityNodes || preview.adjacentNodes || preview.continuity || [] },
        { key: 'contextSources', icon: '📎', items: preview.sources || [] },
      ];
    },
    activeContextGroupObj() {
      if (!this.openContextGroup) return null;
      return this.contextGroups.find((g) => g.key === this.openContextGroup) || null;
    },
  },
  watch: {
    prefillText(val) {
      if (val) {
        this.inputText = val;
        this.$nextTick(() => this.$refs.composerInput?.focus());
      }
    },
    effectiveScope() {
      this.syncThread();
    },
    scopeNodeId() {
      this.syncThread();
    },
    'messages.length'() {
      this.$nextTick(() => this.scrollToBottom());
    },
    'streamingMessage.content'() {
      this.$nextTick(() => this.scrollToBottom());
    },
  },
  mounted() {
    this.syncThread();
  },
  methods: {
    renderMd(text) {
      return sanitizeCreationHtml(renderMarkdown(String(text || '')));
    },
    scrollToBottom() {
      const el = this.$refs.streamEl;
      if (el) el.scrollTop = el.scrollHeight;
    },
    async syncThread() {
      const aId = this.resolvedAgentId;
      const cId = this.resolvedCreationId;
      this.activeThreadId = '';
      this.loadedThreadScopeKey = '';
      if (!aId || !cId) {
        this.loadingThread = false;
        return;
      }
      const seq = ++this._threadLoadSeq;
      const scopeKey = this.currentScopeKey;
      const scopeType = this.effectiveScope;
      const scopeId = this.scopeNodeId;
      this.loadingThread = true;
      try {
        const bucket = await this.creationsStore.loadThread(aId, cId, scopeType, scopeId);
        if (seq !== this._threadLoadSeq || scopeKey !== this.currentScopeKey) {
          return;
        }
        if (bucket?.thread?.id) {
          this.activeThreadId = bucket.thread.id;
          this.loadedThreadScopeKey = scopeKey;
        }
      } catch {
        // non-fatal if offline
      } finally {
        if (seq === this._threadLoadSeq) {
          this.loadingThread = false;
        }
      }
    },
    toggleScope() {
      if (this.anchorMode) return;
      if (this.effectiveScope !== 'global') {
        this.followSelection = false;
        this.manualScope = 'global';
      } else if (this.activeNode) {
        this.manualScope = 'node';
      }
    },
    toggleContextGroup(key) {
      this.openContextGroup = this.openContextGroup === key ? null : key;
    },
    isExcluded(id) {
      return this.excludedIds.includes(id);
    },
    toggleExcludeContext(id) {
      if (this.isExcluded(id)) {
        this.excludedIds = this.excludedIds.filter((x) => x !== id);
      } else {
        this.excludedIds = [...this.excludedIds, id];
      }
    },
    activeCountForGroup(group) {
      return group.items.filter((item) => !this.isExcluded(item.id)).length;
    },
    applySlash(preset) {
      if (!this.inputText.startsWith(preset.cmd)) {
        this.inputText = `${preset.cmd}${this.inputText}`;
      }
      this.$nextTick(() => this.$refs.composerInput?.focus());
    },
    onComposerKeyDown(e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        this.sendMessage();
      }
    },
    onAttachFiles(e) {
      const files = Array.from(e.target?.files || []);
      if (e.target) e.target.value = '';
      if (!files.length) return;
      this.pendingFiles = [...this.pendingFiles, ...files];
    },
    removePendingFile(idx) {
      const next = this.pendingFiles.slice();
      next.splice(idx, 1);
      this.pendingFiles = next;
    },
    async loadOlderMessages() {
      const threadId = this.threadBucket?.thread?.id || this.activeThreadId;
      if (!threadId || !this.hasMoreMessages || this.loadingMoreMessages) return;
      try {
        await this.creationsStore.loadMoreThreadMessages(
          this.resolvedAgentId,
          this.resolvedCreationId,
          threadId,
        );
      } catch {
        // non-fatal
      }
    },
    async sendMessage() {
      const submittedText = this.inputText;
      const text = submittedText.trim();
      const filesToSend = this.pendingFiles.slice();
      if ((!text && filesToSend.length === 0) || this.isStreaming || this.loadingThread) return;
      this.sendError = '';
      this.openContextGroup = null;
      this.sending = true;
      const scopeKey = this.currentScopeKey;
      const threadId = (this.activeThreadId && this.loadedThreadScopeKey === scopeKey)
        ? this.activeThreadId
        : undefined;
      try {
        const res = await this.creationsStore.sendMessage(this.resolvedAgentId, this.resolvedCreationId, {
          text,
          content: text,
          threadId,
          scopeType: this.effectiveScope,
          scopeId: this.scopeNodeId,
          anchor: this.anchorMode ? this.anchor : null,
          excludedContextIds: [...this.excludedIds],
          ...(filesToSend.length > 0 ? { rawFiles: filesToSend } : {}),
        });
        if (this.inputText === submittedText) {
          this.inputText = '';
        }
        this.pendingFiles = [];
        if (scopeKey === this.currentScopeKey && (res?.threadId || res?.thread?.id)) {
          this.activeThreadId = res.threadId || res.thread.id;
          this.loadedThreadScopeKey = scopeKey;
        }
      } catch (err) {
        this.sendError = err?.message || 'Failed to send message';
      } finally {
        this.sending = false;
      }
    },
    async controlBatch(action) {
      if (!this.activeBatchRun) return;
      await this.creationsStore.controlRun(this.resolvedAgentId, this.resolvedCreationId, this.activeBatchRun.id, action);
    },
    onClickActionChip(chip) {
      if (chip?.nodeId) {
        this.$emit('select-node', chip.nodeId);
      }
      if (chip?.prompt) {
        this.inputText = chip.prompt;
        this.$nextTick(() => this.$refs.composerInput?.focus());
      }
      this.$emit('action-chip', chip);
    },
  },
  template: `
    <aside class="creation-director-pane" :class="{ 'is-anchor-mode': anchorMode }">
      <!-- Header -->
      <header class="creation-director-head">
        <div class="creation-director-scope-row">
          <button
            type="button"
            class="creation-scope-pill"
            :class="{ 'is-node': effectiveScope !== 'global' }"
            @click="toggleScope"
          >
            <template v-if="effectiveScope !== 'global' && (anchor?.label || activeNode?.title)">
              {{ $t('creation.director.scopeNode') }}: {{ anchor?.label || activeNode?.title }}
            </template>
            <template v-else>
              {{ $t('creation.director.scopeGlobal') }}
            </template>
          </button>

          <label v-if="!anchorMode" class="creation-follow-toggle">
            <input v-model="followSelection" type="checkbox" />
            <span>{{ $t('creation.director.followSelection') }}</span>
          </label>

          <button
            v-if="anchorMode"
            type="button"
            class="creation-icon-mini"
            :title="$t('creation.inspector.close')"
            @click="$emit('close-anchor')"
          >✕</button>
        </div>

        <!-- Anchor Quote Card -->
        <div v-if="anchorMode && anchor" class="creation-anchor-card">
          <div class="creation-anchor-card-label">✦ {{ $t('creation.book.anchorDrawerTitle') }}: {{ anchor.label || anchor.kind }}</div>
          <blockquote v-if="anchor.quote" class="creation-anchor-quote">{{ anchor.quote }}</blockquote>
        </div>

        <!-- Transparent Context Chips -->
        <div class="creation-context-pills">
          <button
            v-for="grp in contextGroups"
            :key="grp.key"
            type="button"
            class="creation-context-chip"
            :class="{ 'is-open': openContextGroup === grp.key, 'is-empty': grp.items.length === 0 }"
            @click="toggleContextGroup(grp.key)"
          >
            <span>{{ grp.icon }}</span>
            <span>{{ $t('creation.director.' + grp.key) }}</span>
            <span class="creation-context-chip-count">{{ activeCountForGroup(grp) }}/{{ grp.items.length }}</span>
          </button>
        </div>

        <!-- Context Exclusion Popover -->
        <div v-if="activeContextGroupObj" class="creation-context-popover">
          <div class="creation-context-popover-head">
            <span>{{ activeContextGroupObj.icon }} {{ $t('creation.director.' + activeContextGroupObj.key) }}</span>
            <button type="button" class="creation-icon-mini" @click="openContextGroup = null">×</button>
          </div>
          <ul v-if="activeContextGroupObj.items.length" class="creation-context-popover-list">
            <li v-for="item in activeContextGroupObj.items" :key="item.id" class="creation-context-popover-item">
              <label>
                <input
                  type="checkbox"
                  :checked="!isExcluded(item.id)"
                  @change="toggleExcludeContext(item.id)"
                />
                <span>{{ item.title || item.name || item.id }}</span>
              </label>
            </li>
          </ul>
          <p v-else class="creation-context-popover-empty">{{ $t('creation.director.contextMounted') }}: 0</p>
        </div>

        <!-- Active Run Status Bar -->
        <div v-if="activeBatchRun" class="creation-batch-status-bar">
          <div class="creation-batch-status-top">
            <span class="creation-batch-status-label">
              <template v-if="isBatchRun">
                {{ activeBatchRun.status === 'paused' ? $t('creation.studio.batchPaused') : $t('creation.studio.batchRunning') }}
                ({{ batchDoneCount }}/{{ batchTotalCount }})
              </template>
              <template v-else>
                {{ $t('creation.director.thinking') }}
              </template>
            </span>
            <div class="creation-batch-status-btns">
              <template v-if="isBatchRun">
                <button
                  v-if="activeBatchRun.status === 'running'"
                  type="button"
                  class="creation-glass-btn"
                  @click="controlBatch('pause')"
                >{{ $t('creation.studio.pause') }}</button>
                <button
                  v-else
                  type="button"
                  class="creation-glass-btn is-primary"
                  @click="controlBatch('resume')"
                >{{ $t('creation.studio.resume') }}</button>
              </template>
              <button
                type="button"
                class="creation-glass-btn is-danger"
                @click="controlBatch('cancel')"
              >{{ $t('creation.studio.stop') }}</button>
            </div>
          </div>
          <div v-if="isBatchRun" class="creation-progress-track">
            <div class="creation-progress-fill" :style="{ width: batchPercent + '%' }"></div>
          </div>
        </div>
      </header>

      <!-- Message Stream -->
      <div ref="streamEl" class="creation-chat-messages">
        <div v-if="hasMoreMessages" class="creation-chat-load-more">
          <button
            type="button"
            class="creation-glass-btn"
            :disabled="loadingMoreMessages"
            @click="loadOlderMessages"
          >
            {{ loadingMoreMessages ? $t('common.loading') : $t('creation.director.loadOlder') }}
          </button>
        </div>

        <div v-if="messages.length === 0 && !streamingMessage" class="creation-director-empty">
          <p>{{ $t('creation.director.emptyChat') }}</p>
        </div>

        <article
          v-for="msg in messages"
          :key="msg.id"
          class="creation-chat-msg"
          :class="'is-' + (msg.role || 'assistant')"
        >
          <div v-if="msg.toolCalls && msg.toolCalls.length" class="creation-tool-badges">
            <span
              v-for="(tc, ti) in msg.toolCalls"
              :key="ti"
              class="creation-tool-badge"
              :class="'is-' + (tc.status || 'done')"
            >
              {{ tc.status === 'error' ? '!' : '✓' }} {{ tc.name || tc.tool }}
            </span>
          </div>

          <div v-if="msg.role === 'user'" class="creation-chat-user-text">{{ msg.content || msg.text }}</div>
          <div v-else class="creation-chat-md markdown-body" v-html="renderMd(msg.content || msg.text)"></div>

          <div v-if="msg.actions && msg.actions.length" class="creation-action-chips">
            <button
              v-for="(chip, ci) in msg.actions"
              :key="ci"
              type="button"
              class="creation-action-chip"
              @click="onClickActionChip(chip)"
            >
              {{ chip.label }}
            </button>
          </div>
        </article>

        <!-- Live Streaming Assistant Delta -->
        <article v-if="isStreaming" class="creation-chat-msg is-assistant is-streaming">
          <div v-if="streamingMessage?.toolStatus" class="creation-tool-badges">
            <span class="creation-tool-badge">◌ {{ streamingMessage.toolStatus }}</span>
          </div>
          <div
            v-if="streamingMessage?.content"
            class="creation-chat-md markdown-body"
            v-html="renderMd(streamingMessage.content)"
          ></div>
          <span v-else class="creation-streaming-dots">{{ $t('creation.director.thinking') }}</span>
        </article>
      </div>

      <!-- Bottom Composer -->
      <footer class="creation-chat-composer">
        <div class="creation-slash-chips">
          <button
            v-for="preset in slashPresets"
            :key="preset.key"
            type="button"
            class="creation-slash-btn"
            @click="applySlash(preset)"
          >
            {{ $t('creation.director.' + preset.key) }}
          </button>
        </div>

        <div class="creation-composer-box">
          <div v-if="pendingFiles.length > 0" class="creation-ignite-files">
            <span
              v-for="(file, idx) in pendingFiles"
              :key="(file.name || 'file') + '-' + idx"
              class="creation-file-chip"
            >
              <span class="creation-file-chip-name">{{ file.name }}</span>
              <button
                type="button"
                class="creation-file-chip-remove"
                :aria-label="$t('creation.sources.delete')"
                @click="removePendingFile(idx)"
              >✕</button>
            </span>
          </div>

          <textarea
            ref="composerInput"
            v-model="inputText"
            class="creation-composer-textarea"
            rows="2"
            :disabled="sending || loadingThread"
            :placeholder="anchorMode ? $t('creation.book.anchorPlaceholder') : $t('creation.director.inputPlaceholder')"
            @keydown="onComposerKeyDown"
          ></textarea>

          <div v-if="sendError" class="creation-ignite-error" role="alert">
            {{ sendError }}
          </div>

          <div class="creation-composer-foot">
            <label class="creation-glass-btn creation-upload-label" :title="$t('creation.sources.upload')">
              <input type="file" multiple hidden :disabled="sending" @change="onAttachFiles" />
              <span>📎 {{ $t('creation.galaxy.igniteAttach') }}</span>
            </label>

            <button
              type="button"
              class="creation-glass-btn is-primary"
              :disabled="!canSend"
              @click="sendMessage"
            >
              {{ anchorMode ? $t('creation.book.send') : $t('creation.director.send') }}
            </button>
          </div>
        </div>
      </footer>
    </aside>
  `,
};
