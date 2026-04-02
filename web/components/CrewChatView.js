/**
 * CrewChatView - Crew 群聊视图（入口组件）
 *
 * 拆分为子组件和模块：
 *   crew/CrewTurnRenderer.js    — turn 渲染子组件（消除 3x 重复模板）
 *   crew/CrewRolePanel.js       — 左侧角色面板子组件
 *   crew/CrewFeaturePanel.js    — 右侧 Feature 看板子组件
 *   crew/crewInput.js           — 输入处理 composable
 *   crew/crewScroll.js          — 滚动管理 composable
 *   crew/crewHelpers.js         — 工具函数（样式、格式化、图标）
 *   crew/crewMessageGrouping.js — 消息分组逻辑（turns、segments、blocks）
 *   crew/crewKanban.js          — Kanban/TODO 计算逻辑
 *   crew/crewRolePresets.js     — 预设角色数据
 */
import { clearMarkdownCache } from '../utils/markdown.js';
import {
  ICONS, formatTokens, PRESET_ROLES
} from './crew/crewHelpers.js';
import {
  appendToSegments, rebuildBlocksFromSegments,
  createFbCache, fullBuildFeatureBlocks,
  shouldShowTurnDivider, getMaxRound, getBlockTurns
} from './crew/crewMessageGrouping.js';
import {
  parseCrewTasks, computeCompletedTaskIds, collectActiveTasks,
  buildTodosByFeature, buildFeatureKanban, groupKanban, kanbanProgress
} from './crew/crewKanban.js';
import { rolePresets } from './crew/crewRolePresets.js';
import { createCrewInput } from './crew/crewInput.js';
import { createCrewScroll } from './crew/crewScroll.js';
import CrewTurnRenderer from './crew/CrewTurnRenderer.js';
import CrewRolePanel from './crew/CrewRolePanel.js';
import CrewFeaturePanel from './crew/CrewFeaturePanel.js';

import CrewNotifications from './crew/CrewNotifications.js';

export default {
  name: 'CrewChatView',
  components: { CrewTurnRenderer, CrewRolePanel, CrewFeaturePanel, CrewNotifications },
  props: {
    conversationId: { type: String, default: null },
    paneId: { type: String, default: null }
  },
  template: `
    <div class="crew-chat-view">
      <div class="crew-workspace" :class="{ 'hide-roles': !effectivePanelVisible.roles, 'hide-features': !effectivePanelVisible.features, 'feature-expanded': !!expandedFeatureTaskId, 'mobile-panel-roles': effectiveMobilePanel === 'roles', 'mobile-panel-features': effectiveMobilePanel === 'features' }">
        <div class="crew-mobile-overlay" v-if="effectiveMobilePanel" @click="clearMobilePanel"></div>

        <!-- Left Panel: Role Cards -->
        <crew-role-panel
          :store="store"
          :session-roles="sessionRoles"
          :role-color-map="roleColorMap"
          :crew-status="paneCrewStatus"
          :crew-messages="paneCrewMessages"
          @scroll-to-role="scrollToRoleLatest"
          @control-action="controlAction"
          @clear-role="clearRole"
          @abort-role="abortRole"
          @show-add-role="showAddRole = true"
        />

        <!-- Center Panel: Chat Flow -->
        <div class="crew-panel-center">

      <!-- Messages -->
      <div class="crew-messages" ref="messagesRef" @scroll="scroll.onScroll()">
        <div v-if="paneCrewMessages.length === 0" class="crew-empty">
          <div class="crew-empty-icon" v-html="icons.crew.replace(/16/g, '48')"></div>
          <div class="crew-empty-text" v-if="paneCrewSession">{{ $t('crew.emptyWaiting') }}</div>
          <div class="crew-empty-text" v-else>{{ $t('crew.emptyWaitingSession') }}</div>
        </div>

        <div v-if="scroll.isLoadingHistory.value" class="crew-load-more crew-load-more-loading">
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          {{ $t('crew.loadingHistory') }}
        </div>
        <div v-else-if="scroll.hiddenBlockCount.value > 0" class="crew-load-more" @click="scroll.loadMoreBlocks()">
          {{ $t('crew.loadOlder') }} <span class="crew-load-more-count">({{ scroll.hiddenBlockCount.value }})</span>
        </div>
        <div v-else-if="scroll.hasOlderMessages.value" class="crew-load-more" @click="loadHistory">
          {{ $t('crew.loadHistory') }}
        </div>

        <template v-for="(block, bidx) in scroll.visibleBlocks.value" :key="block.id">
          <!-- Only render global blocks (PM/human messages); feature content is in the right panel -->
          <template v-if="block.type === 'global'">
            <template v-for="(turn, tidx) in block.turns" :key="turn.id">
              <div v-if="tidx > 0 && shouldShowTurnDivider(block.turns, tidx)" class="crew-turn-divider"></div>
              <div v-if="turn.type === 'turn' && getMaxRound(turn) > 0" class="crew-round-divider">
                <div class="crew-round-line"></div>
                <span class="crew-round-label">Round {{ getMaxRound(turn) }}</span>
                <div class="crew-round-line"></div>
              </div>
              <crew-turn-renderer
                :turn="turn"
                :show-human-bubble="true"
                :expanded-turns="expandedTurns"
                :icons="icons"
                :role-color-map="roleColorMap"
                :get-role-display-name="getRoleDisplayName"
                @toggle-turn="toggleTurn"
                @ask-submit="onAskSubmit"
              />
            </template>
          </template>
        </template>

        <!-- Typing dots: visible after user sends message, before AI responds -->
        <div v-if="isWaitingResponse" class="typing-indicator" :class="waitingStatus ? ('status-' + waitingStatus) : ''">
          <span></span><span></span><span></span>
          <span class="running-cat" aria-hidden="true">
            <span class="cat-body">
              <span class="cat-head"><span class="cat-ear cat-ear-l"></span><span class="cat-ear cat-ear-r"></span></span>
              <span class="cat-tail"></span>
              <span class="cat-leg cat-leg-front"></span>
              <span class="cat-leg cat-leg-back"></span>
            </span>
          </span>
          <span v-if="waitingStatus === 'disconnected'" class="typing-status-text typing-status-error">
            {{ $t('chat.waiting.disconnected') }}
          </span>
          <span v-else-if="waitingStatus === 'compacting'" class="typing-status-text typing-status-compact">
            {{ $t('chat.waiting.compacting') }}
          </span>
          <span v-else-if="waitingStatus === 'agent-offline'" class="typing-status-text typing-status-error">
            {{ $t('chat.waiting.agentOffline') }}
            <button class="typing-refresh-btn" @click="refreshCrewSession">{{ $t('chat.waiting.refresh') }}</button>
          </span>
          <span v-else-if="waitingStatus === 'session-lost'" class="typing-status-text typing-status-warn">
            {{ $t('chat.waiting.sessionLost') }}
          </span>
          <span v-else-if="waitingStatus === 'cli-exited'" class="typing-status-text typing-status-warn">
            {{ $t('chat.waiting.cliExited') }}
          </span>
          <span v-else-if="waitingStatus === 'thinking'" class="typing-status-text typing-status-thinking">
            {{ $t('chat.waiting.thinking') }}
          </span>
        </div>

        <div class="crew-scroll-bottom"
             :class="{ 'is-hidden': scroll.isAtBottom.value }"
             @click="scroll.scrollToBottomAndReset()">
          {{ $t('crew.scrollToLatest') }}
        </div>

        <div v-if="isInitializing" class="crew-init-progress">
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          <span class="crew-init-text">{{ initProgressText }}</span>
        </div>
      </div>

      <!-- Input -->
      <div class="input-area crew-input-area">
        <div class="crew-input-hints" v-if="paneCrewSession && paneCrewStatus">
          <span class="crew-hint-meta">R{{ paneCrewStatus.round || 0 }}</span>
          <span class="crew-hint-sep">&middot;</span>
          <span class="crew-hint-meta">\${{ (paneCrewStatus.costUsd || 0).toFixed(2) }}</span>
          <template v-if="totalTokens > 0">
            <span class="crew-hint-sep">&middot;</span>
            <span class="crew-hint-meta">{{ formatTokens(totalTokens) }}</span>
          </template>
        </div>
        <div v-if="currentPendingAsk" class="crew-ask-hint" @click="scrollToAskCard">
          <span class="crew-ask-hint-icon">{{ currentPendingAsk.roleIcon }}</span>
          <span class="crew-ask-hint-text">{{ currentPendingAsk.roleName }} {{ $t('crew.askingYou') }}</span>
          <span class="crew-ask-hint-dismiss" :title="$t('crew.dismissAsk')" @click.stop="dismissPendingAsk">✕</span>
        </div>
        <div class="attachments-preview" v-if="input.attachments.value.length > 0">
          <div class="attachment-item" v-for="(file, index) in input.attachments.value" :key="index">
            <img v-if="file.preview" :src="file.preview" class="attachment-thumb" />
            <span v-else class="attachment-icon">\u{1F4CE}</span>
            <span class="attachment-name">{{ file.name }}</span>
            <button class="attachment-remove" @click="input.removeAttachment(index)">&times;</button>
          </div>
        </div>
        <div class="input-wrapper">
          <input
            type="file"
            ref="fileInput"
            id="crew-file-input"
            @change="input.handleFileSelect($event)"
            multiple
            accept="image/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.json,.md,.py,.js,.ts,.css,.html"
            class="file-input-hidden"
          />
          <label class="attach-btn" for="crew-file-input" :title="$t('crew.uploadFile')">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
            </svg>
          </label>
          <div class="textarea-wrapper">
            <div class="slash-autocomplete" v-if="input.slashMenuVisible.value && input.slashFlatItems.value.length > 0">
              <template v-for="group in input.slashGroupedCommands.value" :key="group.label">
                <div class="slash-group-label">{{ group.label }}</div>
                <div
                  v-for="item in group.items"
                  :key="item.cmd"
                  class="slash-autocomplete-item"
                  :class="{ active: item.flatIndex === input.slashMenuIndex.value }"
                  @mousedown.prevent="input.selectSlashCommand(item.cmd)"
                  @mouseenter="input.slashMenuIndex.value = item.flatIndex"
                >
                  <span class="slash-cmd-name">{{ item.cmd }}</span>
                  <span class="slash-cmd-desc">{{ item.desc }}</span>
                </div>
                <div v-if="!group.isLast" class="slash-group-separator"></div>
              </template>
            </div>
            <textarea
              ref="inputRef"
              v-model="input.inputText.value"
              @input="input.handleInput()"
              @keydown="input.handleKeydown($event, () => sendMessage())"
              @paste="input.handlePaste($event)"
              @blur="input.onBlur()"
              :placeholder="$t('crew.inputPlaceholder')"
              rows="1"
            ></textarea>
            <div class="crew-at-menu" v-if="input.atMenuVisible.value && input.filteredAtRoles.value.length > 0">
              <div v-for="(role, idx) in input.filteredAtRoles.value" :key="role.name"
                class="crew-at-menu-item" :class="{ active: idx === input.atMenuIndex.value }"
                @mousedown.prevent="input.selectAtRole(role)">
                <span v-if="role.icon" class="crew-at-menu-icon">{{ role.icon }}</span>
                <span class="crew-at-menu-name">{{ role.displayName }}</span>
                <span class="crew-at-menu-desc">{{ role.description }}</span>
              </div>
            </div>
          </div>
          <button class="send-btn" @click="sendMessage" :disabled="!input.canSend.value" :title="$t('crew.send')">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>

        </div><!-- /crew-panel-center -->

        <!-- Right Panel: Feature Kanban -->
        <crew-feature-panel
          :store="store"
          :feature-kanban="featureKanban"
          :feature-kanban-grouped="featureKanbanGrouped"
          :kanban-progress-data="kanbanProgressData"
          :feature-blocks="featureBlocks"
          :get-block-turns="resolveBlockTurns"
          :expanded-turns="expandedTurns"
          :expanded-feature-task-id="expandedFeatureTaskId"
          :now-tick="nowTick"
          :icons="icons"
          :role-color-map="roleColorMap"
          :get-role-display-name="getRoleDisplayName"
          :persisted-feature-ids="persistedFeatureIds"
          :crew-messages="paneCrewMessages"
          @toggle-turn="toggleTurn"
          @expand-feature="expandFeature"
          @close-feature="closeFeature"
          @ask-submit="onAskSubmit"
        />
      </div><!-- /crew-workspace -->

      <!-- Route Notification Toasts -->
      <crew-notifications
        :notifications="store.crewNotifications"
        @dismiss="dismissNotification"
      />

      <!-- Add Role Modal -->
      <div v-if="showAddRole" class="crew-add-role-overlay" @click.self="showAddRole = false">
        <div class="crew-add-role-modal">
          <div class="crew-add-role-title">{{ $t('crew.addRoleTitle') }}</div>

          <div class="crew-add-role-presets">
            <button v-for="preset in availablePresets" :key="preset.name" class="crew-preset-btn" @click="quickAddPreset(preset)">
              <span v-if="preset.icon">{{ preset.icon }} </span>{{ preset.displayName }}
            </button>
          </div>

          <details class="crew-add-custom-details">
            <summary class="crew-add-custom-summary">{{ $t('crew.customRole') }}</summary>
            <div class="crew-add-role-form">
              <div class="crew-add-role-row">
                <input v-model="newRole.name" :placeholder="$t('crew.namePlaceholder')" class="crew-add-input" />
                <input v-model="newRole.displayName" :placeholder="$t('crew.displayNamePlaceholder')" class="crew-add-input" />
                <input v-model="newRole.icon" :placeholder="$t('crew.iconPlaceholder')" class="crew-add-input" style="width: 50px; flex: none;" />
              </div>
              <input v-model="newRole.description" :placeholder="$t('crew.descPlaceholder')" class="crew-add-input" />
              <textarea v-model="newRole.claudeMd" :placeholder="$t('crew.promptPlaceholder')" rows="2" class="crew-add-input"></textarea>
              <div class="crew-add-role-actions">
                <button class="crew-add-role-confirm" @click="confirmAddRole" :disabled="!newRole.name || !newRole.displayName">{{ $t('crew.add') }}</button>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  `,

  setup() {
    const store = Pinia.useChatStore();
    const authStore = Pinia.useAuthStore();
    return { store, authStore };
  },

  data() {
    return {
      icons: ICONS,
      showAddRole: false,
      expandedTurns: {},
      expandedFeatures: {},
      expandedHistories: {},
      expandedFeatureTaskId: null,
      nowTick: Date.now(),
      typingStartTime: 0,
      newRole: this.getEmptyRole(),
      rolePresets
    };
  },

  created() {
    this.input = createCrewInput(this.store, this.authStore, {
      getInputRef: () => this.$refs.inputRef,
      getFileInputRef: () => this.$refs.fileInput,
      getCurrentPendingAsk: () => this.currentPendingAsk,
      getConversationId: () => this.effectiveConvId
    });
    this.scroll = createCrewScroll(this.store, {
      getMessagesRef: () => this.$refs.messagesRef,
      getFeatureBlocks: () => this.featureBlocks,
      getConversationId: () => this.effectiveConvId
    });
  },

  computed: {
    effectivePanelVisible() {
      return this.store.getPanelVisible(this.paneId);
    },
    effectiveMobilePanel() {
      return this.store.getPaneMobilePanel(this.paneId);
    },
    effectiveConvId() {
      return this.conversationId || this.store.currentConversation;
    },
    // Per-pane crew data — reads from effectiveConvId instead of global currentConversation
    paneCrewSession() {
      const convId = this.effectiveConvId;
      if (!convId) return null;
      return this.store.crewSessions[convId] || null;
    },
    paneCrewStatus() {
      const convId = this.effectiveConvId;
      if (!convId) return null;
      return this.store.crewStatuses[convId] || null;
    },
    paneCrewMessages() {
      const convId = this.effectiveConvId;
      if (!convId) return [];
      return this.store.crewMessagesMap[convId] || [];
    },
    isWaitingResponse() {
      const messages = this.paneCrewMessages;
      if (!messages || messages.length === 0) return false;
      const lastMsg = messages[messages.length - 1];
      return lastMsg.role === 'human' && !lastMsg._sendFailed;
    },
    waitingStatus() {
      if (!this.isWaitingResponse) return null;
      if (this.store.connectionState !== 'connected') return 'disconnected';
      const convId = this.effectiveConvId;
      if (this.store.compactStatus?.conversationId === convId && this.store.compactStatus?.status === 'compacting') return 'compacting';
      const health = this.store.sessionHealth?.[convId];
      if (health) return health.status;
      if (this.typingStartTime && this.nowTick - this.typingStartTime > 8000) return 'thinking';
      return null;
    },
    isInitializing() {
      return this.paneCrewStatus?.status === 'initializing';
    },
    initProgressText() {
      const p = this.paneCrewStatus?.initProgress;
      if (p === 'roles') return this.$t('crew.initRoles');
      if (p === 'worktrees') return this.$t('crew.initWorktrees');
      return this.$t('crew.initPreparing');
    },
    totalTokens() {
      const s = this.paneCrewStatus;
      if (!s) return 0;
      return (s.totalInputTokens || 0) + (s.totalOutputTokens || 0);
    },
    availablePresets() {
      const existing = this.paneCrewSession?.roles?.map(r => r.name) || [];
      return this.rolePresets.filter(p => !existing.includes(p.name));
    },
    crewTasks() {
      return parseCrewTasks(this.paneCrewMessages);
    },
    completedTaskCount() {
      return this.crewTasks.filter(t => t.done).length;
    },
    doneTasks() {
      return this.crewTasks.filter(t => t.done);
    },
    activeTasks() {
      const persistedFeatures = this.paneCrewStatus?.features || [];
      return collectActiveTasks(persistedFeatures, this.paneCrewMessages);
    },
    persistedFeatureIds() {
      const features = this.paneCrewStatus?.features || [];
      return new Set(features.map(f => f.taskId));
    },
    completedTaskIds() {
      return computeCompletedTaskIds(this.doneTasks, this.activeTasks);
    },
    featureBlocks() {
      const allMessages = this.paneCrewMessages;
      const completed = this.completedTaskIds;
      const len = allMessages.length;

      if (!this._fbCache) {
        this._fbCache = createFbCache(null);
      }
      const cache = this._fbCache;

      if (cache._lastArr !== allMessages) {
        Object.assign(cache, createFbCache(allMessages));
        if (len === 0) return cache.blocks;
        return fullBuildFeatureBlocks(allMessages, completed, cache);
      }

      if (len === 0) {
        Object.assign(cache, createFbCache(allMessages));
        return cache.blocks;
      }

      const startIdx = cache.processedLen;
      if (startIdx > len) {
        Object.assign(cache, createFbCache(allMessages));
        return fullBuildFeatureBlocks(allMessages, completed, cache);
      }

      if (startIdx < len) {
        appendToSegments(allMessages, startIdx, cache);
      }

      rebuildBlocksFromSegments(cache, completed);
      return cache.blocks;
    },
    pendingAsks() {
      const asks = [];
      const messages = this.paneCrewMessages;
      for (const msg of messages) {
        if (msg.type === 'tool' && msg.toolName === 'AskUserQuestion' && !msg.askAnswered && msg.askRequestId) {
          asks.push({
            taskId: msg.taskId || null,
            roleIcon: msg.roleIcon,
            roleName: msg.roleName,
            askMsg: msg,
          });
        }
      }
      return asks;
    },
    currentPendingAsk() {
      return this.pendingAsks.length > 0 ? this.pendingAsks[0] : null;
    },
    todosByFeature() {
      return buildTodosByFeature(this.paneCrewMessages);
    },
    sessionRoles() {
      return this.paneCrewSession?.roles || [];
    },
    roleColorMap() {
      const map = {};
      let fbIndex = 0;
      for (const role of this.sessionRoles) {
        if (PRESET_ROLES.includes(role.name)) {
          map[role.name] = null;
        } else {
          map[role.name] = fbIndex++;
        }
      }
      return map;
    },
    featureKanban() {
      return buildFeatureKanban(
        this.activeTasks, this.todosByFeature, this.featureBlocks,
        this.completedTaskIds, this.$t('crew.globalTask')
      );
    },
    featureKanbanGrouped() {
      return groupKanban(this.featureKanban);
    },
    kanbanProgressData() {
      return kanbanProgress(this.featureKanban);
    },
    kanbanFeatureCount() {
      // Count features with signals (messages, todos, streaming, activity).
      // Mirrors filteredFeatures filter in CrewFeaturePanel.
      const persisted = this.persistedFeatureIds;
      return this.featureKanban.filter(f => {
        if (persisted.has(f.taskId)) return true;
        const block = this.featureBlocks.find(
          b => b.type === 'feature' && b.taskId === f.taskId
        );
        if (block) {
          const turns = getBlockTurns(block, this._fbCache);
          if (turns && turns.length > 0) return true;
        }
        if (f.totalCount > 0) return true;
        if (f.hasStreaming) return true;
        if (f.lastActivityAt > 0) return true;
        return false;
      }).length;
    }
  },

  watch: {
    '$route'() {
      this.store.setPaneMobilePanel(this.paneId, null);
    },
    isWaitingResponse(val) {
      this.typingStartTime = val ? Date.now() : 0;
    },
    kanbanFeatureCount(val) {
      this.store.crewInProgressCount = val;
    },
    'effectiveConvId'(newId, oldId) {
      this.store.setPaneMobilePanel(this.paneId, null);
      if (oldId) this.input.saveDraft(oldId);
      this.input.restoreDraft(newId);
      this._draftConvId = newId;
      this._fbCache = null;
      clearMarkdownCache();
      this.scroll.visibleBlockCount.value = 20;
      this.$nextTick(() => {
        setTimeout(() => this.scroll.scrollToMeaningfulContent(), 300);
      });
    },
    'input.inputText.value'(val) {
      const convId = this.effectiveConvId;
      if (convId) {
        if (val) {
          this.store.inputDrafts[convId] = val;
        } else {
          delete this.store.inputDrafts[convId];
        }
      }
    },
    'paneCrewMessages': {
      handler() {
        this.$nextTick(() => this.scroll.smartScrollToBottom());
      },
      deep: true
    }
  },

  methods: {
    formatTokens,
    shouldShowTurnDivider,
    getMaxRound,

    dismissNotification(id) {
      const idx = this.store.crewNotifications.findIndex(n => n.id === id);
      if (idx !== -1) this.store.crewNotifications.splice(idx, 1);
    },

    clearMobilePanel() {
      this.store.setPaneMobilePanel(this.paneId, null);
    },

    getEmptyRole() {
      return { name: '', displayName: '', icon: '\u{1F916}', description: '', model: 'sonnet', claudeMd: '', isDecisionMaker: false };
    },

    toggleTurn(turnId) {
      this.expandedTurns[turnId] = !this.expandedTurns[turnId];
    },

    getRoleDisplayName(roleName) {
      const session = this.paneCrewSession;
      if (!session) return roleName;
      const role = session.roles.find(r => r.name === roleName);
      return role ? role.displayName : roleName;
    },

    sendMessage(e) {
      this.input.sendMessage(e, () => {
        this.scroll.isAtBottom.value = true;
        this.scroll.scrollToBottom();
      });
    },

    controlAction(action, targetRole = null) {
      if (action === 'clear') {
        if (!confirm(this.$t('crew.confirmClear'))) return;
      }
      this.store.sendCrewControl(action, targetRole, this.effectiveConvId);
    },

    clearRole(roleName) {
      if (!roleName) return;
      this.controlAction('clear_role', roleName);
    },

    abortRole(roleName) {
      if (!roleName) return;
      this.controlAction('abort_role', roleName);
    },

    quickAddPreset(preset) {
      this.store.addCrewRole({ ...preset }, this.effectiveConvId);
      if (this.availablePresets.length <= 1) {
        this.showAddRole = false;
      }
    },

    confirmAddRole() {
      if (!this.newRole.name || !this.newRole.displayName) return;
      this.store.addCrewRole({ ...this.newRole }, this.effectiveConvId);
      this.showAddRole = false;
      this.newRole = this.getEmptyRole();
    },

    dismissPendingAsk() {
      const ask = this.currentPendingAsk;
      if (ask) {
        ask.askMsg.askAnswered = true;
        ask.askMsg.selectedAnswers = { _dismissed: true };
      }
    },

    scrollToAskCard() {
      // Find the first AskCard element in the messages area and scroll to it
      const container = this.$refs.messagesRef;
      if (!container) return;
      const askCard = container.querySelector('.ask-card-wrapper');
      if (askCard) {
        askCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    },

    onAskSubmit(requestId, answers) {
      this.store.answerUserQuestion(requestId, answers, this.effectiveConvId);
    },

    scrollToRoleLatest(roleName) {
      this.scroll.scrollToRoleLatest(
        roleName, this.featureBlocks,
        this.expandedFeatures, this.expandedHistories, this.$el
      );
    },

    scrollToFeature(taskId) {
      this.scroll.scrollToFeature(taskId, this.expandedFeatures, this.$el);
    },

    resolveBlockTurns(block) {
      return getBlockTurns(block, this._fbCache);
    },

    expandFeature(taskId) {
      this.expandedFeatureTaskId = this.expandedFeatureTaskId === taskId ? null : taskId;
    },

    closeFeature() {
      this.expandedFeatureTaskId = null;
    },

    loadHistory() {
      this.scroll.loadHistory((getter, cb) => this.$watch(getter, cb));
    },

    refreshCrewSession() {
      const convId = this.effectiveConvId;
      if (!convId) return;
      const conv = this.store.conversations.find(c => c.id === convId);
      this.store.sendWsMessage({ type: 'refresh_conversation', conversationId: convId, agentId: conv?.agentId });
    }
  },

  mounted() {
    const closeMenus = () => {};
    document.addEventListener('click', closeMenus);
    this._cleanupClick = closeMenus;
    this._elapsedTimer = setInterval(() => { this.nowTick = Date.now(); }, 1000);
    const convId = this.effectiveConvId;
    this._draftConvId = convId;
    this.input.restoreDraft(convId);
    this.$nextTick(() => this.scroll.scrollToBottom());
  },

  beforeUnmount() {
    if (this._cleanupClick) {
      document.removeEventListener('click', this._cleanupClick);
    }
    if (this._elapsedTimer) {
      clearInterval(this._elapsedTimer);
    }
    const convId = this._draftConvId || this.effectiveConvId;
    this.input.saveDraft(convId);
  }
};
