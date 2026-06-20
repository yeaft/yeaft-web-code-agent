import ChatInput from './ChatInput.js';
import MessageList from './MessageList.js';
import SettingsPanel from './SettingsPanel.js';
import YeaftSidebar from './YeaftSidebar.js';
import VpDetailView from './VpDetailView.js';
import SessionInviteModal from './SessionInviteModal.js';
import SessionCreateModal from './SessionCreateModal.js';
import SessionSettingsModal from './SessionSettingsModal.js';
import WorkbenchPanel from './WorkbenchPanel.js';
import YeaftDebugPanel from './YeaftDebugPanel.js';
import VpTimelinePane from './VpTimelinePane.js';
import YeaftSessionActions from './YeaftSessionActions.js';
import LlmTab from './LlmTab.js';
import { parseMentions } from '../utils/parseMentions.js';
import { buildTimelineRows, selectGroupRosterVpList } from '../stores/helpers/vp-timeline.js';
import { buildModelSelectionRows, getDefaultModelEffort, getSelectableModelEfforts, modelOptionMatchesRef, modelOptionRef, resolveSessionModelEffort, resolveSessionModelRef } from '../utils/modelRefs.js';
import { shouldShowYeaftOnboardingGuide } from '../utils/yeaftOnboarding.js';
import { hasUsableYeaftAgent, resolveActiveSessionIdForSettings } from '../utils/yeaftSessionSettings.js';

function sessionTaskSortTime(task) {
  const raw = task?.updatedAt || task?.endedAt || task?.createdAt;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

export function visibleSessionStatusTasks(taskMap) {
  return Object.values(taskMap || {})
    .filter(Boolean)
    .sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (a.status !== 'running' && b.status === 'running') return 1;
      return sessionTaskSortTime(b) - sessionTaskSortTime(a);
    });
}

export default {
  name: 'YeaftPage',
  components: { ChatInput, MessageList, SettingsPanel, YeaftSidebar, VpDetailView, SessionInviteModal, SessionCreateModal, SessionSettingsModal, WorkbenchPanel, YeaftDebugPanel, VpTimelinePane, YeaftSessionActions, LlmTab },
  template: `
    <div class="yeaft-page" ref="pageRef">
      <!-- Mobile sidebar overlay -->
      <div class="yeaft-sidebar-overlay" v-if="!sidebarCollapsed && isMobile" @click="sidebarCollapsed = true"></div>

      <!-- Left Sidebar — V2 (task-341: V2 is the only sidebar now). -->
      <!-- Legacy sidebar event alias; canonical settings dialog uses session terminology. -->
      <YeaftSidebar
        :collapsed="sidebarCollapsed"
        @select-group="onSelectGroupV2"
        @select-chat="onSelectChat"
        @toggle-sidebar="toggleSidebar"
        @back="goBack"
        @open-settings="toggleSettings"
        @open-group-settings="openSessionSettings"
      />

      <!-- Workbench Panel (between sidebar and main) -->
      <WorkbenchPanel v-if="canUseWorkbench" />

      <!-- Center Conversation. The Session status pane is rendered as a
           sibling to the RIGHT of this main column so the visual order is
           [conversation][Session status][debug], with debug always far right. -->
      <div class="yeaft-main" :class="{ 'workbench-active': canUseWorkbench && store.workbenchExpanded, 'workbench-maximized': canUseWorkbench && store.workbenchMaximized && store.workbenchExpanded }">
        <!-- Center column: topbar + (settings | VpDetailView | empty-hero |
             MessageList) + ChatInput. -->
        <div class="yeaft-main-center">
        <!-- Conversation Header -->
        <div class="yeaft-topbar">
        <!-- task-341: sidebar-toggle moved from topbar into V2 sidebar header. -->
        <!-- task-fix-mobile-group-settings: re-add a mobile-only ☰ here so
             that after the sidebar collapses on group select the user
             still has a way back. CSS hides it on desktop (≥768px). -->
          <button
            class="yeaft-topbar-sidebar-toggle"
            @click="toggleSidebar"
            :title="$t('chat.sidebar.expand')"
            :aria-label="$t('chat.sidebar.expand')"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          </button>

        <!-- task-339-F1: SessionSelector removed from topbar — groups now surface via sidebar section. -->

          <!-- Model selector doubles as the LLM settings entry; no extra gear. -->
          <div class="yeaft-topbar-model" @click="toggleModelDropdown" :title="$t('yeaft.modelMenu.title')">
            <span class="yeaft-topbar-model-name">{{ topbarModel || $t('settings.llm.selectModel') }}</span>
            <span v-if="store.yeaftModelsRefreshing" class="yeaft-model-refreshing">{{ $t('common.loading') || 'Loading' }}</span>
            <svg class="yeaft-model-chevron" :class="{ open: modelDropdownOpen }" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
            <div class="yeaft-model-dropdown yeaft-topbar-model-dropdown" v-if="modelDropdownOpen" @click.stop>
              <div class="yeaft-model-selector-body">
                <div class="yeaft-model-list" role="listbox" :aria-label="$t('settings.llm.selectModel')">
                  <div
                    v-for="row in topbarModelRows"
                    :key="row.modelRef"
                    class="yeaft-model-option"
                    :class="{
                      active: isModelRowActive(row),
                      current: modelOptionMatchesRef(row.model, topbarModel),
                      'yeaft-model-option-with-effort': row.efforts.length,
                    }"
                    role="option"
                    :aria-selected="isModelRowActive(row) ? 'true' : 'false'"
                  >
                    <span class="yeaft-model-check" v-if="isModelRowActive(row)">&check;</span>
                    <span class="yeaft-model-check" v-else></span>
                    <button
                      type="button"
                      class="yeaft-model-option-main"
                      @click="selectModel(row.modelRef, row.defaultEffort)"
                    >
                      <span class="yeaft-model-option-label">{{ row.label }}</span>
                      <span class="yeaft-model-option-meta">
                        <span class="yeaft-model-option-provider" v-if="row.model.provider">{{ row.model.provider }}</span>
                        <span class="yeaft-model-option-ctx" v-if="row.model.contextWindow">{{ formatModelCtx(row.model) }}</span>
                      </span>
                    </button>
                    <span class="yeaft-model-effort-list" v-if="row.efforts.length" :aria-label="row.label">
                      <button
                        v-for="effort in row.efforts"
                        :key="row.modelRef + ':' + effort"
                        type="button"
                        class="yeaft-model-effort-chip"
                        :class="{ active: isModelSelectionActive(row.model, effort) }"
                        @click="selectModel(row.modelRef, effort)"
                      >{{ $t('yeaft.modelMenu.effort.' + effort) }}</button>
                    </span>
                  </div>
                </div>
                <div class="yeaft-model-fixed-controls">
                  <button type="button" class="yeaft-model-config-option" @click="openLlmConfig">
                    <span class="yeaft-model-config-label">{{ $t('settings.llm.configureMenu') }}</span>
                    <span class="yeaft-model-config-hint">{{ $t('yeaft.modelMenu.configureHint') }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="yeaft-topbar-title-group" :title="showOnboardingGuide ? $t('yeaft.onboarding.topbarTitle') : (topbarSessionTitle || topbarGroup?.id || '')">
            <div class="yeaft-topbar-session-title">{{ showOnboardingGuide ? $t('yeaft.onboarding.topbarTitle') : (topbarSessionTitle || $t('yeaft.session.create.untitled')) }}</div>
          </div>

          <YeaftSessionActions
            v-if="!showOnboardingGuide"
            class="yeaft-topbar-right"
            :loading-more-history="store.yeaftLoadingMoreHistory"
            :session-status-visible="sessionStatusVisible"
            :debug-mode="debugMode"
            :show-page-reload="isMobile"
            @reload-messages="reloadMessages"
            @toggle-session-status="toggleSessionStatus"
            @toggle-debug="toggleDebug"
            @reload-page="reloadPage"
          />
        </div>

        <div class="yeaft-conversation-body">
        <!-- H2.f.6: YeaftFeatureDetailView removed — cross-thread aggregation
             retired with the multi-thread engine; the task-detail view had
             no message data source after H2.f.1, so it's been deleted.
             Clicking a sidebar task still highlights it but the main pane
             stays on the conversation stream. -->

        <!-- task-334-ui-c: VP Detail View replaces the message list when
             a VP badge / library row has been clicked. Takes precedence
             over the task-detail view so clicking a VP inside a task
             pane feels like a drill-down. Esc returns to previous layer
             via the shared keydown cascade. -->
        <VpDetailView
          v-if="!showSettings && store.yeaftActiveVpDetailId"
          :vp-id="store.yeaftActiveVpDetailId"
          @back="exitVpDetailView"
        />

        <!-- No-session onboarding — when there is no Session, the bottom input
             cannot send anywhere. Replace the chat chrome with setup guidance
             instead of inviting the user to type into a dead input. -->
        <section
          v-if="!showSettings && !store.yeaftActiveVpDetailId && showOnboardingGuide"
          class="yeaft-onboarding"
          :aria-label="$t('yeaft.onboarding.ariaLabel')"
        >
          <div class="yeaft-onboarding-shell">
            <div class="yeaft-onboarding-eyebrow">{{ $t('yeaft.onboarding.eyebrow') }}</div>
            <h1 class="yeaft-onboarding-title">{{ $t('yeaft.onboarding.title') }}</h1>
            <p class="yeaft-onboarding-subtitle">{{ $t('yeaft.onboarding.subtitle') }}</p>

            <div class="yeaft-onboarding-actions">
              <button type="button" class="btn-primary yeaft-onboarding-primary" @click="openSessionCreate">
                {{ $t('yeaft.onboarding.createSession') }}
              </button>
              <button type="button" class="btn-secondary" @click="openLlmConfig">
                {{ $t('yeaft.onboarding.configureLlm') }}
              </button>
            </div>

            <div class="yeaft-onboarding-steps" role="list">
              <article class="yeaft-onboarding-card" role="listitem">
                <div class="yeaft-onboarding-step-index">1</div>
                <div class="yeaft-onboarding-card-body">
                  <h2>{{ $t('yeaft.onboarding.installTitle') }}</h2>
                  <p>{{ $t('yeaft.onboarding.installDesc') }}</p>
                  <div class="yeaft-onboarding-command">
                    <code>{{ installAgentCommand }}</code>
                    <button type="button" class="yeaft-onboarding-copy" @click="copyOnboardingCommand('install', installAgentCommand)">
                      {{ copiedOnboardingCommand === 'install' ? $t('common.copied') : $t('common.copy') }}
                    </button>
                  </div>
                </div>
              </article>

              <article class="yeaft-onboarding-card" role="listitem">
                <div class="yeaft-onboarding-step-index">2</div>
                <div class="yeaft-onboarding-card-body">
                  <h2>{{ $t('yeaft.onboarding.connectTitle') }}</h2>
                  <p>{{ $t('yeaft.onboarding.connectDesc') }}</p>
                  <div class="yeaft-onboarding-command">
                    <code>{{ connectAgentCommand }}</code>
                    <button type="button" class="yeaft-onboarding-copy" @click="copyOnboardingCommand('connect', connectAgentCommand)">
                      {{ copiedOnboardingCommand === 'connect' ? $t('common.copied') : $t('common.copy') }}
                    </button>
                  </div>
                </div>
              </article>

              <article class="yeaft-onboarding-card yeaft-onboarding-card-wide" role="listitem">
                <div class="yeaft-onboarding-step-index">3</div>
                <div class="yeaft-onboarding-card-body">
                  <h2>{{ $t('yeaft.onboarding.llmTitle') }}</h2>
                  <p>{{ $t('yeaft.onboarding.llmDesc') }}</p>
                  <div class="yeaft-onboarding-provider-grid">
                    <div class="yeaft-onboarding-provider">
                      <div class="yeaft-onboarding-provider-title">{{ $t('yeaft.onboarding.copilotTitle') }}</div>
                      <div class="yeaft-onboarding-command">
                        <code>{{ copilotCommand }}</code>
                        <button type="button" class="yeaft-onboarding-copy" @click="copyOnboardingCommand('copilot', copilotCommand)">
                          {{ copiedOnboardingCommand === 'copilot' ? $t('common.copied') : $t('common.copy') }}
                        </button>
                      </div>
                    </div>
                    <div class="yeaft-onboarding-provider">
                      <div class="yeaft-onboarding-provider-title">{{ $t('yeaft.onboarding.apiTitle') }}</div>
                      <div class="yeaft-onboarding-command">
                        <code>{{ apiProviderCommand }}</code>
                        <button type="button" class="yeaft-onboarding-copy" @click="copyOnboardingCommand('api', apiProviderCommand)">
                          {{ copiedOnboardingCommand === 'api' ? $t('common.copied') : $t('common.copy') }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </section>

        <!-- Messages Area — reuse standard MessageList for identical rendering -->
        <!-- task-fix-empty-group: hero state replaces MessageList when the
             active group has no roster — gives the user a single, clear
             next step instead of a blank canvas. The modal still pops on
             top for groups the user hasn't dismissed yet. -->
        <div
          v-if="!showSettings && !store.yeaftActiveVpDetailId && !showOnboardingGuide && isActiveGroupEmpty"
          class="yeaft-empty-group-hero"
        >
          <div class="yeaft-empty-group-hero__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 3-1.34 3-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          </div>
          <h2 class="yeaft-empty-group-hero__title">{{ $t('yeaft.session.empty.title') }}</h2>
          <p class="yeaft-empty-group-hero__hint">
            {{ $t('yeaft.session.empty.hint', { name: inviteGroupName || '' }) }}
          </p>
          <button type="button" class="yeaft-empty-group-hero__cta" @click="onInviteOpenLibrary">
            {{ $t('yeaft.session.empty.cta') }}
          </button>
        </div>
        <MessageList v-if="!showSettings && !store.yeaftActiveVpDetailId && !showOnboardingGuide && !isActiveGroupEmpty" />

        <!-- Settings Panel -->
        <SettingsPanel v-if="showSettings" :visible="showSettings" :initial-tab="'yeaft'" :initial-sub-tab="settingsInitialTab" :initial-edit-vp-id="settingsInitialEditVpId" @close="showSettings = false" />
        </div>

        <div v-if="showLlmConfig" class="modal-overlay yeaft-llm-config-overlay" @click.self="showLlmConfig = false">
          <div class="modal-card yeaft-llm-config-modal" role="dialog" aria-modal="true" :aria-label="$t('settings.llm.configureAgent')">
            <div class="modal-header">
              <h3>{{ $t('settings.llm.configureAgent') }}</h3>
              <button class="modal-close" @click="showLlmConfig = false" :aria-label="$t('common.close')">×</button>
            </div>
            <div class="yeaft-llm-config-body">
              <LlmTab context="yeaft" @message="onLlmConfigMessage" @saved="onLlmConfigSaved" />
            </div>
          </div>
        </div>

        <!-- Input Area -->
        <ChatInput
          v-if="!showSettings && !showOnboardingGuide"
          ref="chatInputRef"
          :conversation-id="store.yeaftConversationId"
          :send-fn="sendMessage"
          :cancel-fn="cancelYeaft"
          :show-stop="isProcessing"
          placeholder-key="yeaft.placeholder"
        />
        </div><!-- /.yeaft-main-center -->
      </div>

      <!-- Session status pane: announcement + VP roster + background tasks.
           It sits to the right of the conversation and to the left of debug. -->
      <VpTimelinePane
        v-if="showVpTimeline"
        :rows="vpTimelineRows"
        :tasks="sessionStatusTasksForActiveSession"
        :announcement-text="sessionStatusAnnouncementText"
        :sub-agent-prompt-results="store.yeaftSubAgentPromptResults"
        :class="{ 'mobile-session-status': isNarrowDetail }"
        :style="timelineWidthStyle"
        @mention-vp="onMentionVpFromTimeline"
        @edit-vp="onEditVpFromTimeline"
        @start-resize="startTimelineResize"
        @cancel-vp-turn="onCancelVpFromTimeline"
        @edit-announcement="openAnnouncementSettings"
        @prompt-sub-agent="onPromptSubAgentFromTimeline"
        @close="closeSessionStatus"
      />

      <!-- Right Detail Panel — only rendered when debug mode is on. The
           legacy "tasks memory" placeholder + collapse-toggle were retired
           in task-yeaft-group-ui-cleanup; the debug panel is the only
           right-pane content today, and it should not occupy layout space
           unless explicitly opened. -->
      <aside
        v-if="debugMode"
        class="yeaft-detail"
        :class="{ resizing: isResizingDetail, 'mobile-debug': isNarrowDetail }"
        :style="detailWidthStyle"
        ref="detailPanel"
      >
        <div class="yeaft-detail-drag-handle" :class="{ active: isResizingDetail }" @mousedown.prevent="startDetailResize"></div>
        <YeaftDebugPanel @close="closeDebug" />
      </aside>

      <!-- task-343: VP library is now an in-Settings tab (initial-tab='vp'). -->

      <!-- task-fix-group-member-editor: invite modal CTA now opens the
           group's member editor directly (the previous flow dumped the
           user into VP-Settings, where there was no add-to-group UI). -->
      <SessionInviteModal
        v-if="shouldShowInviteModal"
        :group-name="inviteGroupName"
        @open-library="onInviteOpenLibrary"
        @dismiss="onInviteDismiss"
      />

      <SessionCreateModal
        v-if="sessionCreateOpen"
        @close="sessionCreateOpen = false"
        @created="onSessionCreated"
      />

      <!-- task-fix-group-member-editor → unified SessionSettingsModal: a
           single dialog (session / members / memory) owned at this level
           so the empty-group hero CTA, the sidebar settings action, the
           invite-modal CTA, and the legacy openMemberEditor shim all
           converge here. -->
      <SessionSettingsModal
        v-if="groupSettingsOpen && groupSettingsId"
        :group-id="groupSettingsId"
        :initial-section="groupSettingsSection"
        :initial-edit-vp-id="groupSettingsEditVpId"
        @close="closeGroupSettings"
        @open-vp-library="openVpLibraryFromGroupSettings"
      />
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    // PR-3: VP roster is the source of truth for timeline ordering and
    // locale-aware naming. Read from the dedicated vp store rather than
    // reaching into the chat store so the helper signature stays clean.
    const vpStore = Pinia.useVpStore();

    const inst = Vue.getCurrentInstance();
    const $t = (inst && inst.appContext.config.globalProperties.$t) || ((key) => key);

    const sidebarCollapsed = Vue.ref(false);
    // task-yeaft-group-ui-cleanup: debug mode now starts OFF (was always
    // visible as a "tasks memory / coming soon" placeholder). The right
    // detail panel is only rendered when debugMode is on, so the
    // conversation column gets the full width by default.
    const debugMode = Vue.ref(false);
    const modelDropdownOpen = Vue.ref(false);
    const showSettings = Vue.ref(false);
    const showLlmConfig = Vue.ref(false);
    const sessionCreateOpen = Vue.ref(false);
    const copiedOnboardingCommand = Vue.ref('');
    let copiedOnboardingTimer = null;
    const settingsInitialTab = Vue.ref('vp');
    const settingsInitialEditVpId = Vue.ref(null);
    // feat-vp-list-ui-polish: template ref to the embedded ChatInput so we
    // can call its imperative `appendMention(vpId)` when the Session status
    // pane emits a VP mention request. Keeps the Yeaft-specific @-syntax out
    // of ChatInput (review fix — Fowler C2, PR #763).
    const chatInputRef = Vue.ref(null);
    const pageRef = Vue.ref(null);
    let mobileViewportRaf = null;
    let mobileViewportRecoverTimer = null;

    const isTextEditingElement = (el) => {
      if (!el) return false;
      const tag = String(el.tagName || '').toLowerCase();
      return tag === 'textarea' || tag === 'input' || el.isContentEditable === true;
    };

    const syncMobileViewportHeight = ({ recoverScroll = false } = {}) => {
      const page = pageRef.value;
      if (!page) return;
      if (!isMobile.value) {
        page.style.removeProperty('--yeaft-visual-viewport-height');
        return;
      }

      const vv = window.visualViewport;
      const height = Math.max(1, Math.round(vv?.height || window.innerHeight || 1));
      page.style.setProperty('--yeaft-visual-viewport-height', `${height}px`);

      if (!recoverScroll) return;
      const keyboardLikelyOpen = vv && window.innerHeight
        ? vv.height < window.innerHeight * 0.85
        : false;
      if (keyboardLikelyOpen || isTextEditingElement(document.activeElement)) return;
      window.scrollTo(0, 0);
    };

    const scheduleMobileViewportSync = (opts = {}) => {
      if (mobileViewportRaf != null) cancelAnimationFrame(mobileViewportRaf);
      mobileViewportRaf = requestAnimationFrame(() => {
        mobileViewportRaf = null;
        syncMobileViewportHeight(opts);
      });
    };

    const scheduleMobileViewportRecovery = () => {
      scheduleMobileViewportSync({ recoverScroll: true });
      if (mobileViewportRecoverTimer) clearTimeout(mobileViewportRecoverTimer);
      mobileViewportRecoverTimer = setTimeout(() => {
        mobileViewportRecoverTimer = null;
        scheduleMobileViewportSync({ recoverScroll: true });
      }, 260);
    };

    // task-340: Workbench capability gate — matches ChatPage.canUseWorkbench
    // semantics via store.hasCapability. store.workbenchExpanded and
    // workbenchMaximized are already shared across Chat/Yeaft pages.
    const canUseWorkbench = Vue.computed(() =>
      store.hasCapability('terminal') || store.hasCapability('file_editor')
    );

    // task-341: V2 sidebar is the only sidebar; flag kept as constant
    // for callers that still read it.
    const sidebarV2Enabled = Vue.computed(() => true);

    // task-fix (group-switch): clicking a group row in the sidebar narrows
    // the main pane to that group's messages. The store handles filter
    // mutex (task filter is cleared).
    const onSelectGroupV2 = (g) => {
      const id = g && g.id ? g.id : null;
      if (!id) return;
      store.setActiveSessionFilter(id);
      // Also leave the VP detail view so the main stream is visible.
      if (store.yeaftActiveVpDetailId) store.leaveVpDetailView();
      if (isMobile.value) sidebarCollapsed.value = true;
    };

    // Yeaft Chat Mode (1:1): clicking a chat row narrows the main pane to
    // that chat. Setting an active chat also clears any group filter via
    // the store, so the two modes are mutually exclusive in the main pane.
    const onSelectChat = (_c) => {
      // Phase 4: chat container removed. Sidebar no longer emits select-chat;
      // handler retained as a defensive no-op for any straggler emit.
    };

    // task-334-ui-c: exit the VP-detail view back to prior layer.
    const exitVpDetailView = () => {
      store.leaveVpDetailView();
    };

    // task-yeaft-remove-sidebar-search (2026-05-08): the sidebar search
    // box was retired, so the Esc-to-refocus handler that paired with
    // it is gone too.

    // Detail panel resizable width
    const detailPanel = Vue.ref(null);
    const isResizingDetail = Vue.ref(false);
    // task-345: Align to Chat right-panel tokens.
    // - ExpertPanel.open fixed width: 320px (web/styles/expert-panel.css)
    // - SubAgentPanel.open.expanded: width 40%, min 360, max 600 (web/styles/subagent-panel.css)
    // Yeaft detail is resizable; MIN matches ExpertPanel base, DEFAULT clamped like SubAgentPanel expanded.
    const DETAIL_MIN_WIDTH = 320;
    const DETAIL_DEFAULT_WIDTH = Math.max(DETAIL_MIN_WIDTH, Math.round(window.innerWidth * 0.25));
    const savedDetailWidth = localStorage.getItem('yeaft-debug-width');
    const detailWidth = Vue.ref(savedDetailWidth ? parseInt(savedDetailWidth, 10) : DETAIL_DEFAULT_WIDTH);

    const detailWidthStyle = Vue.computed(() => {
      return { '--yeaft-detail-width': detailWidth.value + 'px' };
    });

    const startDetailResize = (e) => {
      isResizingDetail.value = true;
      const startX = e.clientX;
      const startWidth = detailWidth.value;
      const maxWidth = window.innerWidth * 0.6;

      const onMouseMove = (ev) => {
        // Panel is on the right, so dragging left = wider
        const delta = startX - ev.clientX;
        const newWidth = Math.min(maxWidth, Math.max(DETAIL_MIN_WIDTH, startWidth + delta));
        detailWidth.value = newWidth;
      };

      const onMouseUp = () => {
        isResizingDetail.value = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        localStorage.setItem('yeaft-debug-width', String(detailWidth.value));
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    // ── Session status pane state (visibility + resizable width).
    // Historical vpTimeline identifiers are kept only where renaming would
    // cause a noisy component/storage churn. New user-facing behavior is
    // Session-status oriented.

    // User-controlled show/hide. The consolidated Session status pane must
    // default open for everyone, including users who previously hid the old
    // VP roster pane, so this PR switches to a new preference key instead of
    // inheriting the legacy `yeaft-vp-timeline-visible` value.
    const SESSION_STATUS_VISIBLE_KEY = 'yeaft-session-status-visible';
    const readSessionStatusVisible = () => {
      try {
        const v = localStorage.getItem(SESSION_STATUS_VISIBLE_KEY);
        if (v === '0' || v === 'false') return false;
        return true;
      } catch (_) { return true; }
    };
    const sessionStatusVisible = Vue.ref(readSessionStatusVisible());
    const setSessionStatusVisible = (visible) => {
      sessionStatusVisible.value = !!visible;
      try {
        localStorage.setItem(SESSION_STATUS_VISIBLE_KEY, sessionStatusVisible.value ? '1' : '0');
      } catch (_) {}
    };
    const toggleSessionStatus = () => setSessionStatusVisible(!sessionStatusVisible.value);
    const closeSessionStatus = () => setSessionStatusVisible(false);
    const TIMELINE_MIN_WIDTH = 220;
    const TIMELINE_DEFAULT_WIDTH = 280;
    const savedTimelineWidth = (() => {
      try { return localStorage.getItem('yeaft-vp-timeline-width'); } catch (_) { return null; }
    })();
    // Guard parseInt against garbled / partial storage values — a
    // bare parseInt would let 'NaNpx' leak into the CSS variable.
    const parsedTimelineWidth = savedTimelineWidth ? parseInt(savedTimelineWidth, 10) : NaN;
    const timelineWidth = Vue.ref(
      Number.isFinite(parsedTimelineWidth) && parsedTimelineWidth >= TIMELINE_MIN_WIDTH
        ? parsedTimelineWidth
        : TIMELINE_DEFAULT_WIDTH
    );
    const timelineWidthStyle = Vue.computed(() => ({
      '--yeaft-vp-timeline-width': timelineWidth.value + 'px',
    }));

    const startTimelineResize = (e) => {
      const startX = e.clientX;
      const startWidth = timelineWidth.value;
      // Cap at 40% of viewport — Session status is supplementary; never
      // let it crowd the conversation pane.
      const maxWidth = Math.max(TIMELINE_MIN_WIDTH, Math.floor(window.innerWidth * 0.4));

      const onMouseMove = (ev) => {
        const delta = startX - ev.clientX; // right-side pane: drag left = wider
        const newWidth = Math.min(maxWidth, Math.max(TIMELINE_MIN_WIDTH, startWidth + delta));
        timelineWidth.value = newWidth;
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        try { localStorage.setItem('yeaft-vp-timeline-width', String(timelineWidth.value)); } catch (_) {}
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    // Detect mobile/narrow layouts from the same media queries CSS uses.
    // Reading window.innerWidth directly can drift from @media evaluation on
    // real phones (browser chrome / visual viewport / device emulation), which
    // leaves .yeaft-detail hidden while the Debug button toggles state.
    const MOBILE_QUERY = '(max-width: 768px)';
    const NARROW_DETAIL_QUERY = '(max-width: 1024px)';
    const mobileMedia = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_QUERY) : null;
    const narrowDetailMedia = typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_DETAIL_QUERY) : null;
    const matchesMedia = (media, fallbackWidth) => media ? media.matches : window.innerWidth <= fallbackWidth;
    const isMobile = Vue.ref(matchesMedia(mobileMedia, 768));
    const isNarrowDetail = Vue.ref(matchesMedia(narrowDetailMedia, 1024));
    const syncResponsiveFlags = () => {
      isMobile.value = matchesMedia(mobileMedia, 768);
      isNarrowDetail.value = matchesMedia(narrowDetailMedia, 1024);
    };
    const onResize = () => {
      syncResponsiveFlags();
      scheduleMobileViewportRecovery();
    };
    const addMediaChangeListener = (media) => {
      if (!media) return;
      if (typeof media.addEventListener === 'function') media.addEventListener('change', onResize);
      else if (typeof media.addListener === 'function') media.addListener(onResize);
    };
    const removeMediaChangeListener = (media) => {
      if (!media) return;
      if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onResize);
      else if (typeof media.removeListener === 'function') media.removeListener(onResize);
    };

    // Esc handling — exit the VP detail view if it's open. (Task-detail
    // layer was deleted alongside yeaftActiveFeatureDetailId; only the
    // vp-detail layer remains.)
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (modelDropdownOpen.value) {
        closeModelDropdown();
        return;
      }
      if (store.yeaftActiveVpDetailId) {
        store.leaveVpDetailView();
      }
    };

    Vue.onMounted(() => {
      syncResponsiveFlags();
      window.addEventListener('resize', onResize);
      addMediaChangeListener(mobileMedia);
      addMediaChangeListener(narrowDetailMedia);
      window.visualViewport?.addEventListener('resize', scheduleMobileViewportRecovery);
      window.visualViewport?.addEventListener('scroll', scheduleMobileViewportRecovery);
      document.addEventListener('click', closeModelDropdownOutside);
      document.addEventListener('keydown', onKeyDown);
      scheduleMobileViewportSync();
    });
    Vue.onUnmounted(() => {
      window.removeEventListener('resize', onResize);
      removeMediaChangeListener(mobileMedia);
      removeMediaChangeListener(narrowDetailMedia);
      window.visualViewport?.removeEventListener('resize', scheduleMobileViewportRecovery);
      window.visualViewport?.removeEventListener('scroll', scheduleMobileViewportRecovery);
      document.removeEventListener('click', closeModelDropdownOutside);
      document.removeEventListener('keydown', onKeyDown);
      if (mobileViewportRaf != null) cancelAnimationFrame(mobileViewportRaf);
      if (mobileViewportRecoverTimer) clearTimeout(mobileViewportRecoverTimer);
    });

    // Watch for conversationId changes (session_ready migrates local -> agent ID)
    Vue.watch(() => store.yeaftConversationId, (newId) => {
      if (newId && store.activeConversations[0] !== newId) {
        store.activeConversations = [newId];
      }
    });

    const goBack = () => {
      store.leaveYeaft();
    };

    const sendMessage = (text, attachmentInfos) => {
      // task-334m: Pre-check `no_default_vp` before the WS round-trip.
      // If the active group has no roster + no defaultVpId, surface the
      // invite modal instead of sending a message that would round-trip
      // a `no_default_vp` error back as a silent toast.
      const gs = sessionsStore();
      if (gs && gs.activeNeedsInvite) {
        const g = gs.activeSession;
        if (g) inviteDismissedFor.delete(g.id); // force show
        return;
      }
      // Yeaft is conceptually a single conversation backed by a group.
      // The main pane filter is the authoritative group currently on screen;
      // sessionsStore.activeSessionId is only the fallback. Keeping send-path
      // resolution aligned with the visible filter prevents quick group
      // switches from stamping a message with a different group's id.
      const groupId = store.yeaftActiveSessionFilter || (gs && gs.activeSessionId) || 'grp_default';
      const mentions = parseMentions(text).mentions;
      // Attachments: ChatInput's custom-send path passes the resolved
      // info list as the second arg. We forward it untouched — the
      // store helper strips `fileId` shape for the wire and keeps the
      // preview/name/mimeType on the local message render.
      const attachments = Array.isArray(attachmentInfos) ? attachmentInfos : undefined;
      store.sendYeaftSessionMessage({ groupId, text, mentions, attachments });
    };

    // Yeaft stop is session-scoped. The virtual Yeaft conversation can have
    // multiple Sessions running at once; stopping the current input must not
    // abort turns in a different selected Session.
    const cancelYeaft = () => {
      const gs = sessionsStore();
      const sessionId = store.yeaftActiveSessionFilter || gs?.activeSessionId || null;
      if (sessionId) store.cancelYeaftSession(sessionId);
    };

    const toggleSidebar = () => {
      sidebarCollapsed.value = !sidebarCollapsed.value;
    };

    // task-yeaft-group-ui-cleanup: toggleDetail() was wired to a topbar
    // button that opened/collapsed the placeholder detail panel; the
    // button + placeholder are gone, so the helper is removed too.

    const toggleDebug = () => {
      debugMode.value = !debugMode.value;
    };
    const closeDebug = () => {
      debugMode.value = false;
    };

    const reloadMessages = () => {
      store.reloadYeaftMessages();
    };

    const reloadPage = () => {
      window.location.reload();
    };

    const sessionsStore = () => {
      try {
        return window.Pinia?.useSessionsStore?.() || null;
      } catch { return null; }
    };
    const isProcessing = Vue.computed(() => {
      const gs = sessionsStore();
      const sessionId = store.yeaftActiveSessionFilter || gs?.activeSessionId || null;
      return sessionId ? store.isYeaftSessionProcessing(sessionId) : false;
    });
    // task-fix-mobile-group-settings: surface a group ⚙ in the topbar
    // so the conversation always has a settings entry-point — sidebar
    // collapses to a slide-over on mobile, hover-reveal affordances
    // don't exist on touch. Resolve the group from the
    // groups store the same way `sendMessage` does (filter > activeSessionId
    // > grp_default fallback) so the gear targets whatever is on screen.
    const topbarGroup = Vue.computed(() => {
      const gs = sessionsStore();
      if (!gs || !gs.sessions) return null;
      const filterId = store.yeaftActiveSessionFilter || null;
      if (filterId && gs.sessions[filterId]) return gs.sessions[filterId];
      if (gs.activeSessionId && gs.sessions[gs.activeSessionId]) return gs.sessions[gs.activeSessionId];
      return gs.sessions['grp_default'] || null;
    });

    const activeSessionIdForSettings = () => resolveActiveSessionIdForSettings({
      activeSessionFilter: store.yeaftActiveSessionFilter,
      sessionsStore: sessionsStore(),
      topbarGroup: topbarGroup.value,
    });

    const topbarSessionTitle = Vue.computed(() => {
      const g = topbarGroup.value || {};
      const id = typeof g.id === 'string' ? g.id.trim() : '';
      const candidates = [g.title, g.name, g.config?.title, g.config?.name];
      for (const raw of candidates) {
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (!value) continue;
        if (id && value === id) continue;
        if (/^(sessions?|groups?)\//i.test(value)) continue;
        if (/^session_[A-Za-z0-9_-]+$/.test(value)) continue;
        if (g.workDir && value === g.workDir) continue;
        return value;
      }
      return '';
    });

    const sessionStatusAnnouncementText = Vue.computed(() => {
      const text = topbarGroup.value && typeof topbarGroup.value.announcement === 'string'
        ? topbarGroup.value.announcement
        : '';
      return text;
    });

    const topbarModel = Vue.computed(() => resolveSessionModelRef(topbarGroup.value, store.yeaftModel || ''));

    const topbarModelMeta = Vue.computed(() => {
      const id = topbarModel.value;
      if (!id) return null;
      return store.yeaftAvailableModels.find(m => modelOptionMatchesRef(m, id)) || null;
    });

    const selectableEffortsForModel = (model) => getSelectableModelEfforts(model?.effortOptions);

    const topbarRawEffort = Vue.computed(() => resolveSessionModelEffort(topbarGroup.value, store.yeaftModelEffort || ''));

    const topbarEffort = Vue.computed(() => {
      const options = Array.isArray(topbarModelMeta.value?.effortOptions)
        ? topbarModelMeta.value.effortOptions.filter(Boolean)
        : [];
      if (!options.length) return null;
      return options.includes(topbarRawEffort.value)
        ? topbarRawEffort.value
        : getDefaultModelEffort(options);
    });

    const topbarModelRows = Vue.computed(() => buildModelSelectionRows(store.yeaftAvailableModels));

    const isModelSelectionActive = (model, effort) => {
      if (!modelOptionMatchesRef(model, topbarModel.value)) return false;
      if (!effort) return !selectableEffortsForModel(model).length;
      return effort === topbarEffort.value;
    };

    const isModelRowActive = (row) => {
      if (!row || !modelOptionMatchesRef(row.model, topbarModel.value)) return false;
      if (!row.efforts.length) return true;
      return row.efforts.includes(topbarEffort.value);
    };

    // feat-6af5f9f1 PR C: the legacy debug helpers (toggleTurnExpand,
    // formatMessages, formatMsgContent, prettyJson, formatToolOutput,
    // getFunctionCallPairs, formatToolCalls, formatRawResponse) lived
    // here for the old inline debug panel. PR B replaced that panel
    // with <YeaftDebugPanel>; PR C removes the now-orphaned helpers.

    const openModelDropdown = () => {
      modelDropdownOpen.value = true;
    };

    const closeModelDropdown = () => {
      modelDropdownOpen.value = false;
    };

    const toggleModelDropdown = (e) => {
      e.stopPropagation();
      if (!store.yeaftAvailableModels.length) return;
      if (modelDropdownOpen.value) {
        closeModelDropdown();
      } else {
        openModelDropdown();
      }
    };

    const selectModel = (modelId, effort = null) => {
      if (!modelId) return;
      const groupId = topbarGroup.value?.id || null;
      store.switchYeaftModel(modelId, groupId, effort);
      closeModelDropdown();
    };

    // Format a token count compactly: 400000 → "400k", 1048576 → "1m", <1000 → raw.
    const formatTokens = (n) => {
      if (!n || !Number.isFinite(n) || n <= 0) return '';
      if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}m`;
      if (n >= 1000) return `${Math.round(n / 1000)}k`;
      return String(n);
    };

    // Context line for a model-dropdown row:
    //   both ctx + max → "400k · 128k out"
    //   only ctx       → "400k"
    //   neither        → "" (template uses v-if to hide the span entirely)
    const formatModelCtx = (m) => {
      const ctx = formatTokens(m?.contextWindow);
      const max = formatTokens(m?.maxOutput);
      if (ctx && max) return `${ctx} · ${max} out`;
      return ctx;
    };

    const closeModelDropdownOutside = (e) => {
      if (!modelDropdownOpen.value) return;
      const row = e.target.closest('.yeaft-topbar-model, .yeaft-topbar-model-dropdown');
      if (!row) closeModelDropdown();
    };

    const toggleSettings = () => {
      if (!showSettings.value) {
        settingsInitialTab.value = 'vp';
        settingsInitialEditVpId.value = null;
      }
      showSettings.value = !showSettings.value;
    };

    // task-343: VP library lives inside Settings as a tab. Helper to open
    // Settings at a specific tab (used by SessionInviteModal CTA).
    const openSettings = ({ initialTab = 'vp', editVpId = null } = {}) => {
      settingsInitialTab.value = ['vp', 'search', 'mcp'].includes(initialTab) ? initialTab : 'vp';
      settingsInitialEditVpId.value = settingsInitialTab.value === 'vp' ? (editVpId || null) : null;
      showSettings.value = true;
    };

    const openLlmConfig = () => {
      modelDropdownOpen.value = false;
      showLlmConfig.value = true;
    };

    const openSessionCreate = () => {
      sessionCreateOpen.value = true;
    };

    const onSessionCreated = (_session) => {
      sessionCreateOpen.value = false;
    };

    const copyOnboardingCommand = async (key, command) => {
      if (!command) return;
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
      try {
        await navigator.clipboard.writeText(command);
        copiedOnboardingCommand.value = key || '';
        if (copiedOnboardingTimer) clearTimeout(copiedOnboardingTimer);
        copiedOnboardingTimer = setTimeout(() => {
          copiedOnboardingCommand.value = '';
          copiedOnboardingTimer = null;
        }, 1800);
      } catch (_) {
        // Clipboard is best-effort; the command remains visible for manual copy.
      }
    };

    const onLlmConfigMessage = (msg, isError) => {
      if (isError) console.error('[Yeaft] LLM config:', msg);
      else console.log('[Yeaft] LLM config:', msg);
    };

    const onLlmConfigSaved = () => {
      showLlmConfig.value = false;
      const agentId = store.currentAgent;
      if (agentId) store.sendWsMessage({ type: 'yeaft_reset', agentId });
    };

    // task-334m: Group invite modal wiring. The modal is shown whenever
    // the active group has no roster + no defaultVpId. A per-group
    // `dismissed` set silences it mid-session until the roster changes
    // (dismiss is sticky to the current `(groupId, rosterVersion)` — any
    // roster mutation re-arms the prompt so adding then removing a VP
    // correctly re-surfaces the invite on the next empty state).
    const inviteDismissedFor = Vue.reactive(new Set());
    const activeGroupForInvite = Vue.computed(() => {
      const gs = sessionsStore();
      return gs ? gs.activeSession : null;
    });
    // D1 seed sentinel: translate raw 'Default' on grp_default via global
    // i18n. Used by `inviteGroupName` and the topbar ⚙ label so the two
    // can't drift if one site is later relocalised.
    const resolveGroupDisplayName = (g) => {
      if (!g) return '';
      if (g.id === 'grp_default' && (g.name === 'Default' || !g.name)) {
        try {
          const globalI18n = (typeof window !== 'undefined') ? window.i18n : null;
          if (globalI18n && globalI18n.global && typeof globalI18n.global.t === 'function') {
            return globalI18n.global.t('yeaft.session.defaultName');
          }
        } catch (_) {}
      }
      return g.name || g.id || '';
    };
    const inviteGroupName = Vue.computed(
      () => resolveGroupDisplayName(activeGroupForInvite.value),
    );
    const shouldShowInviteModal = Vue.computed(() => {
      const gs = sessionsStore();
      if (!gs || !gs.activeNeedsInvite) return false;
      const g = gs.activeSession;
      if (!g) return false;
      // Skip if the user already dismissed THIS empty-roster state.
      return !inviteDismissedFor.has(g.id);
    });
    // task-fix-empty-group: separate from `shouldShowInviteModal` because the
    // hero state stays visible even after the user dismisses the modal —
    // the empty group still needs a clear next step in the main pane.
    const isActiveGroupEmpty = Vue.computed(() => {
      const gs = sessionsStore();
      return !!(gs && gs.activeNeedsInvite);
    });
    const showOnboardingGuide = Vue.computed(() => {
      const gs = sessionsStore();
      return shouldShowYeaftOnboardingGuide({
        hasYeaftAgent: hasUsableYeaftAgent(store),
        sessionsReady: !!(gs && gs.hasLoadedSnapshot),
        sessionsEmpty: !!(gs && gs.isEmpty),
      });
    });
    const installAgentCommand = 'npm install -g @yeaft/webchat-agent';
    const connectAgentCommand = 'yeaft-agent install --server <your-server-url> --name my-worker --secret <agent-secret>';
    const copilotCommand = 'gh auth login && yeaft-agent llm list-models github-copilot && yeaft-agent llm use github-copilot --model <model-id>';
    const apiProviderCommand = 'export OPENAI_KEY=<your-api-key> && yeaft-agent llm use openai-compatible --name openai --base-url https://api.openai.com/v1 --api-key-env OPENAI_KEY --model <model-id>';
    const onInviteOpenLibrary = () => {
      const g = activeGroupForInvite.value;
      if (g) inviteDismissedFor.add(g.id);
      // task-fix-group-member-editor: open the in-place member editor
      // for the current group instead of routing through VP Settings.
      // The "open-library" event name is preserved for backwards-compat
      // with SessionInviteModal's emits but the destination has changed.
      openMemberEditor(g ? g.id : null);
    };
    const onInviteDismiss = () => {
      const g = activeGroupForInvite.value;
      if (g) inviteDismissedFor.add(g.id);
    };
    // Holds the session id + initial section so callers (sidebar settings,
    // hero CTA, invite-modal CTA, and Session status pane actions) can
    // target any Session and any pane.
    const groupSettingsOpen = Vue.ref(false);
    const groupSettingsId = Vue.ref(null);
    const groupSettingsSection = Vue.ref('session');
    const groupSettingsEditVpId = Vue.ref('');
    const openSessionSettings = (payload = {}) => {
      // Accept both { sessionId } (new) and { groupId } (legacy) — child
      // components were renamed in the msg.groupId→msg.sessionId sweep but
      // a few legacy callers may still pass either shape during the
      // deploy window.
      const sessionId = (payload && (payload.sessionId || payload.groupId)) || null;
      const editVpId = (payload && payload.editVpId) || '';
      const section = editVpId ? 'members' : ((payload && payload.section) || 'session');
      if (!sessionId) return;
      groupSettingsId.value = sessionId;
      groupSettingsSection.value = section;
      groupSettingsEditVpId.value = editVpId;
      groupSettingsOpen.value = true;
    };
    const openAnnouncementSettings = () => {
      const sessionId = activeSessionIdForSettings();
      if (!sessionId) return;
      openSessionSettings({ sessionId, section: 'session' });
    };
    const closeGroupSettings = () => {
      groupSettingsOpen.value = false;
      groupSettingsId.value = null;
      groupSettingsEditVpId.value = '';
    };
    // task-vp-customize: GroupSettings → "Open VP Library" shortcut. We
    // close the group settings modal first so the two dialogs never stack
    // visually, then jump into YeaftSettings with the 'vp' tab focused.
    const openVpLibraryFromGroupSettings = () => {
      closeGroupSettings();
      openSettings({ initialTab: 'vp' });
    };
    // Backwards-compat shim — the empty-group hero, the sidebar kebab,
    // and the invite-modal "open library" CTA still call this. Maps to
    // the Members section of the unified settings modal.
    const openMemberEditor = (sessionId) => {
      if (!sessionId) return;
      openSessionSettings({ sessionId, section: 'members' });
    };
    // I6: closeMemberEditor shim was unused — dropped. openMemberEditor
    // remains because SessionInviteModal's "open library" CTA still calls
    // it (see line 622, onInviteOpenLibrary).
    // Re-arm the prompt whenever the active roster transitions back to
    // empty (i.e. after the user removed the last member), so the modal
    // fires again next time `activeNeedsInvite` flips true.
    Vue.watch(
      () => {
        const g = activeGroupForInvite.value;
        if (!g) return '';
        return g.id + ':' + (Array.isArray(g.roster) ? g.roster.length : 0) + ':' + (g.defaultVpId || '');
      },
      (next, prev) => {
        // When the roster changes non-trivially, clear the dismissed flag
        // for whatever group id appears in `next` so a later empty state
        // re-shows the modal.
        const g = activeGroupForInvite.value;
        if (g && next !== prev && Array.isArray(g.roster) && g.roster.length > 0) {
          inviteDismissedFor.delete(g.id);
        }
      },
    );

    if (typeof Vue.onBeforeUnmount === 'function') {
      Vue.onBeforeUnmount(() => {
        if (copiedOnboardingTimer) clearTimeout(copiedOnboardingTimer);
        copiedOnboardingTimer = null;
      });
    }

    const onSettingsSaved = () => {
      showSettings.value = false;
    };

    // ── Session status pane computeds + handlers ───────────────────────
    // Pane is visible when (a) we're not in settings and (b) the user hasn't
    // hidden it via the topbar toggle or pane close button. On narrow screens
    // CSS promotes it to an overlay instead of removing the only announcement
    // and status surface. Historical vpTimeline naming remains for the row
    // projection helper and component shell only.
    const showVpTimeline = Vue.computed(
      () => !showSettings.value && !showOnboardingGuide.value && sessionStatusVisible.value
    );

    // Resolve the active group's roster and project it into timeline
    // rows. Status comes from the store's `vpStatuses` map (mirrored
    // from the agent broker) — no reverse-inference from message-level
    // `isStreaming` flags any more (see
    // docs/notes/2026-05-15-vp-status-from-agent.md).
    const sessionStatusTasksForActiveSession = Vue.computed(() => {
      const gs = sessionsStore();
      const sessionId = store.yeaftActiveSessionFilter || gs?.activeSessionId || null;
      if (!sessionId) return [];
      const map = store.yeaftActiveTasksBySession?.[sessionId] || {};
      return visibleSessionStatusTasks(map);
    });

    const vpTimelineRows = Vue.computed(() => {
      const convId = store.yeaftConversationId;
      if (!convId) return [];

      // Active group resolution: an explicit conversation-pane filter
      // wins; otherwise fall back to the groups store's selected group.
      // The VP timeline is ALWAYS roster-scoped — no group means no
      // rows. This matches the user's mental model: the middle column
      // is "this group's roster", not "every VP in the library".
      const gs = sessionsStore();
      const filter = store.yeaftActiveSessionFilter || gs?.activeSessionId || null;
      if (!filter) return [];

      const group = gs?.sessions?.[filter] ?? null;
      const roster = (group && Array.isArray(group.roster)) ? group.roster : [];
      if (roster.length === 0) return [];
      const rosterSet = new Set(roster);

      // Base list = the group's declared roster, ordered by the roster
      // array. Hydrate display data from vpStore (which holds
      // {displayName, ...}); roster ids the library hasn't hydrated yet
      // are stubbed as { vpId: id } so the timeline still has a row for
      // every roster member — the label callback falls back to the raw
      // id until vp_snapshot lands.
      const vpList = selectGroupRosterVpList(roster, vpStore.vpList || []);

      // Cross-group leak defense: only include status rows whose
      // sessionId matches the active filter, and whose vpId is in the
      // active roster. The store keys vpStatuses by `${sessionId}::${vpId}`
      // (see chat.js `vpStatusKey`) — iterate values, not keys, since
      // the composite key isn't a usable VP id by itself.
      const rawStatuses = store.vpStatuses || {};
      const scopedStatuses = {};
      for (const entry of Object.values(rawStatuses)) {
        if (!entry || !entry.vpId) continue;
        const entrySessionId = entry.sessionId ?? entry.groupId;
        if (entrySessionId && entrySessionId !== filter) continue;
        if (!rosterSet.has(entry.vpId)) continue;
        scopedStatuses[entry.vpId] = entry;
      }

      return buildTimelineRows({
        vpList,
        vpStatuses: scopedStatuses,
        stoppingVpTurnIds: store.stoppingVpTurnIds || {},
        connectionState: store.connectionState,
        vpLabelOf: (id) => vpStore.vpLabel(id),
      });
    });

    const onEditVpFromTimeline = (vpId) => {
      if (!vpId) return;
      if (store.yeaftActiveVpDetailId) store.leaveVpDetailView();
      const sessionId = activeSessionIdForSettings();
      if (!sessionId) return;
      openSessionSettings({ sessionId, section: 'members', editVpId: vpId });
    };

    // Clicking a VP row @-mentions that VP in the chat input (default
    // action), instead of jumping straight to a secondary panel.
    // YeaftPage owns the ChatInput template ref and calls its exposed
    // `appendMention()` method directly.
    const onMentionVpFromTimeline = (vpId) => {
      if (!vpId) return;
      const ci = chatInputRef.value;
      if (ci && typeof ci.appendMention === 'function') {
        ci.appendMention(vpId);
      }
    };

    // Per-VP abort from the timeline. The row can be active before the
    // engine has emitted vp_turn_start, so use the store helper that falls
    // back to the agent status table's current turnId.
    const onCancelVpFromTimeline = (vpId) => {
      if (!vpId) return;
      const gs = sessionsStore();
      const sessionId = store.yeaftActiveSessionFilter || gs?.activeSessionId || null;
      if (!sessionId) return;
      if (typeof store.cancelVpTurnForSession === 'function') {
        store.cancelVpTurnForSession(vpId, sessionId);
      }
    };

    const onPromptSubAgentFromTimeline = (payload) => {
      if (!payload || typeof store.sendYeaftSubAgentPrompt !== 'function') return false;
      return store.sendYeaftSubAgentPrompt(payload);
    };

    return {
      store,
      pageRef,
      sidebarCollapsed,
      debugMode,
      modelDropdownOpen,
      topbarGroup,
      topbarSessionTitle,
      topbarModel,
      topbarEffort,
      topbarModelRows,
      selectableEffortsForModel,
      isModelSelectionActive,
      isModelRowActive,
      modelOptionRef,
      modelOptionMatchesRef,
      showSettings,
      showLlmConfig,
      sessionCreateOpen,
      settingsInitialTab,
      settingsInitialEditVpId,
      chatInputRef,
      openSettings,
      isMobile,
      isNarrowDetail,
      detailPanel,
      isResizingDetail,
      detailWidthStyle,
      startDetailResize,
      isProcessing,
      goBack,
      sendMessage,
      cancelYeaft,
      toggleSidebar,
      toggleDebug,
      closeDebug,
      reloadMessages,
      reloadPage,
      toggleModelDropdown,
      selectModel,
      openLlmConfig,
      openSessionCreate,
      onSessionCreated,
      copyOnboardingCommand,
      copiedOnboardingCommand,
      onLlmConfigMessage,
      onLlmConfigSaved,
      formatTokens,
      formatModelCtx,
      toggleSettings,
      onSettingsSaved,
      sidebarV2Enabled,
      onSelectGroupV2,
      onSelectChat,
      exitVpDetailView,
      // task-340: workbench capability gate
      canUseWorkbench,
      // task-334m: invite modal bindings.
      shouldShowInviteModal,
      inviteGroupName,
      onInviteOpenLibrary,
      onInviteDismiss,
      isActiveGroupEmpty,
      showOnboardingGuide,
      installAgentCommand,
      connectAgentCommand,
      copilotCommand,
      apiProviderCommand,
      // task-fix-group-member-editor → unified group settings modal.
      groupSettingsOpen,
      groupSettingsId,
      groupSettingsSection,
      groupSettingsEditVpId,
      openSessionSettings,
      openAnnouncementSettings,
      closeGroupSettings,
      // task-vp-customize: members → "Open VP Library" handler.
      openVpLibraryFromGroupSettings,
      // Backwards-compat shim — onInviteOpenLibrary still calls this.
      openMemberEditor,
      // VP timeline pane bindings — restored in v0.1.767.
      showVpTimeline,
      vpTimelineRows,
      sessionStatusTasksForActiveSession,
      sessionStatusAnnouncementText,
      sessionStatusVisible,
      toggleSessionStatus,
      closeSessionStatus,
      timelineWidthStyle,
      startTimelineResize,
      onEditVpFromTimeline,
      onMentionVpFromTimeline,
      onCancelVpFromTimeline,
      onPromptSubAgentFromTimeline,
    };
  }
};
