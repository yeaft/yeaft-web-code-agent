import ChatInput from './ChatInput.js';
import MessageList from './MessageList.js';
import UnifySettings from './UnifySettings.js';
import UnifySidebar from './UnifySidebar.js';
import VpDetailView from './VpDetailView.js';
import GroupInviteModal from './GroupInviteModal.js';
import GroupSettingsModal from './GroupSettingsModal.js';
import WorkbenchPanel from './WorkbenchPanel.js';
import UnifyDebugPanel from './UnifyDebugPanel.js';
import UnifyToolStatsDrawer from './UnifyToolStatsDrawer.js';
import VpTimelinePane from './VpTimelinePane.js';
import { parseMentions } from '../utils/parseMentions.js';
import { buildTimelineRows, selectGroupRosterVpList } from '../stores/helpers/vp-timeline.js';
import {
  DREAM_JUST_FINISHED_MS,
  DREAM_REDDOT_THRESHOLD_MS,
  DREAM_RELATIVE_TIME_REFRESH_MS,
} from './dream-ui-constants.js';

export default {
  name: 'UnifyPage',
  components: { ChatInput, MessageList, UnifySettings, UnifySidebar, VpDetailView, GroupInviteModal, GroupSettingsModal, WorkbenchPanel, UnifyDebugPanel, UnifyToolStatsDrawer, VpTimelinePane },
  template: `
    <div class="unify-page">
      <!-- Mobile sidebar overlay -->
      <div class="unify-sidebar-overlay" v-if="!sidebarCollapsed && isMobile" @click="sidebarCollapsed = true"></div>

      <!-- Left Sidebar — V2 (task-341: V2 is the only sidebar now). -->
      <UnifySidebar
        :collapsed="sidebarCollapsed"
        @select-group="onSelectGroupV2"
        @toggle-sidebar="toggleSidebar"
        @back="goBack"
        @open-settings="toggleSettings"
        @open-group-settings="openGroupSettings"
      />

      <!-- Workbench Panel (between sidebar and main) -->
      <WorkbenchPanel v-if="canUseWorkbench" />

      <!-- Center Conversation. unify-main is now an inner row layout so
           the VP list sits to the LEFT of the conversation (mirroring
           Crew's role-panel-left + crew-panel-center). The conversation
           stack lives inside .unify-main-center; the right .unify-detail
           is still a sibling of .unify-main at the page level. -->
      <div class="unify-main" :class="{ 'workbench-active': canUseWorkbench && store.workbenchExpanded, 'workbench-maximized': canUseWorkbench && store.workbenchMaximized && store.workbenchExpanded }">
        <!-- Left VP List Pane (Crew-style alignment).
             Surfaces, for the active Unify conversation, one row per VP
             showing live status (typing / streaming / idle). Click →
             @-mention; hover-revealed info button → drill into VP detail.
             Hidden under 1024 px (CSS @media + Vue gate). The pane sits
             at the LEFT edge of unify-main so visual order is
             [VP list][conversation], matching Crew's members-left layout.
             Restored in v0.1.767 after PR #767 inadvertently removed it
             along with the Feature system; the row no longer renders
             feature-specific fields. -->
        <VpTimelinePane
          v-if="showVpTimeline"
          :rows="vpTimelineRows"
          :style="timelineWidthStyle"
          @mention-vp="onMentionVpFromTimeline"
          @open-vp-detail="onOpenVpDetailFromTimeline"
          @start-resize="startTimelineResize"
          @cancel-vp-turn="onCancelVpFromTimeline"
        />

        <!-- Center column: topbar + (settings | VpDetailView | empty-hero |
             MessageList) + ChatInput. Wrapped in unify-main-center so
             unify-main itself can be a row flex without breaking the
             column stacking these descendants rely on. -->
        <div class="unify-main-center">
        <!-- Conversation Header -->
        <div class="unify-topbar">
        <!-- task-341: sidebar-toggle moved from topbar into V2 sidebar header. -->
        <!-- task-fix-mobile-group-settings: re-add a mobile-only ☰ here so
             that after the sidebar collapses on group select the user
             still has a way back. CSS hides it on desktop (≥768px). -->
          <button
            class="unify-topbar-sidebar-toggle"
            @click="toggleSidebar"
            :title="$t('chat.sidebar.expand')"
            :aria-label="$t('chat.sidebar.expand')"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          </button>

        <!-- task-339-F1: GroupSelector removed from topbar — groups now surface via sidebar section. -->

          <!-- Model selector (compact dropdown in topbar) -->
          <div class="unify-topbar-model" @click="toggleModelDropdown" :title="$t('unify.switchModel')">
            <span class="unify-topbar-model-name">{{ store.unifyModel || $t('settings.llm.selectModel') }}</span>
            <svg v-if="store.unifyAvailableModels.length > 1" class="unify-model-chevron" :class="{ open: modelDropdownOpen }" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
            <!-- Dropdown -->
            <div class="unify-model-dropdown unify-topbar-model-dropdown" v-if="modelDropdownOpen && store.unifyAvailableModels.length > 1" @click.stop>
              <div
                class="unify-model-option"
                :class="{ active: m.id === store.unifyModel }"
                v-for="m in store.unifyAvailableModels"
                :key="m.id"
                @click="selectModel(m.id)"
              >
                <span class="unify-model-check" v-if="m.id === store.unifyModel">&#10003;</span>
                <span class="unify-model-check" v-else></span>
                <span class="unify-model-option-label">{{ m.label || m.id }}</span>
                <span class="unify-model-option-provider" v-if="m.provider">{{ m.provider }}</span>
                <span class="unify-model-option-ctx" v-if="m.contextWindow">{{ formatModelCtx(m) }}</span>
              </div>
            </div>
          </div>

          <div class="unify-topbar-right">
            <!-- Page reload — always visible, full window.location.reload() -->
            <button
              class="unify-reload-btn"
              @click="reloadPage"
              :title="$t('unify.reloadPage')"
              :aria-label="$t('unify.reloadPage')"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="23 20 23 14 17 14"/><polyline points="1 4 1 10 7 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </button>
            <!-- task-fix-mobile-group-settings: gear button to open group
                 settings from the conversation header. Visible on every
                 viewport so users can edit announcement / members /
                 rename / delete without hunting for hover-only sidebar
                 affordances (which don't exist on touch). -->
            <button
              v-if="topbarGroup"
              class="unify-topbar-group-settings"
              @click="openTopbarGroupSettings"
              :title="$t('unify.group.settings.title', { name: topbarGroupName })"
              :aria-label="$t('unify.group.settings.title', { name: topbarGroupName })"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
            </button>
            <button
              class="unify-clear-btn"
              @click="clearMessages"
              v-if="hasMessages"
              :title="$t('unify.clearConfirm')"
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
            <button
              class="unify-debug-btn"
              :class="{ active: debugMode }"
              @click="toggleDebug"
              :title="debugMode ? $t('unify.hideDebug') : $t('unify.showDebug')"
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 8h-2.81c-.45-.78-1.07-1.45-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z"/></svg>
            </button>
            <!-- task-unify-group-ui-cleanup: VP-list show/hide moved here
                 (was at the left edge of the topbar). Mirrors Crew's
                 right-side panel toggles. Hidden under 1024 px because
                 the pane itself is gated by the same breakpoint.

                 fix/dream-cadence-and-ui-trigger: manual dream trigger
                 sits to the LEFT of the VP-list toggle. Three states —
                 idle / running (spin) / just-finished (✓ + +N bubble).
                 24h-stale red dot when the local cache shows no recent
                 run. Backend wiring: ws unify_dream_trigger →
                 handleUnifyDreamTrigger; updates flow back via
                 unify_dream_status / unify_dream_result through
                 vpStore.applyDreamStatus / applyDreamResult. -->
            <button
              class="unify-topbar-dream-toggle"
              :class="{
                running: dreamRunning,
                'just-finished': dreamJustFinished,
                stale: dreamStale,
              }"
              @click="onDreamTriggerClick"
              :disabled="dreamRunning"
              :title="dreamLastRunRelative
                ? ($t('unify.dream.runNow') + '\\n' + $t('unify.dream.lastRun', { ago: dreamLastRunRelative }))
                : ($t('unify.dream.runNow') + '\\n' + $t('unify.dream.lastRunNever'))"
              :aria-label="$t('unify.dream.runNow')"
              :aria-busy="dreamRunning ? 'true' : 'false'"
            >
              <!-- Composite icon: moon (idle) overlaid with a small
                   refresh arc — distinct from clock (debug) and gear
                   (settings) so the affordance is unambiguous. The
                   spinner state hides the moon body and rotates the
                   arc only. -->
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" class="unify-topbar-dream-icon">
                <path class="unify-topbar-dream-moon" fill="currentColor"
                  d="M14.5 3.5c-.5 1-.8 2.2-.8 3.4 0 4 3.3 7.3 7.3 7.3.4 0 .8 0 1.2-.1-1.1 4.1-4.8 7.1-9.2 7.1-5.3 0-9.5-4.3-9.5-9.5 0-4.4 3-8.1 7-9.2-.1.4 0 .7 0 1z"/>
                <path class="unify-topbar-dream-arc" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                  d="M19.5 8.5a4 4 0 1 0 1 3.5"/>
                <polyline class="unify-topbar-dream-arc-tip" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                  points="20.5 5.5 20.5 8.5 17.5 8.5"/>
              </svg>
              <!-- 3-second post-success bubble. Position absolute so it
                   doesn't shift the topbar height. -->
              <span
                v-if="dreamJustFinished && dreamEntriesCreated !== null"
                class="unify-topbar-dream-bubble"
                aria-hidden="true"
              >+{{ dreamEntriesCreated }}</span>
              <!-- 24h-stale red dot. Pure visual nudge; click on the
                   button still works the same. -->
              <span
                v-if="dreamStale && !dreamRunning && !dreamJustFinished"
                class="unify-topbar-dream-staledot"
                aria-hidden="true"
              ></span>
            </button>
            <!-- VP list show/hide toggle. Lives next to the debug
                 toggle on the right side of the topbar, mirroring
                 Crew's "hide roles / hide features" affordances.
                 Hidden under 1024 px because the pane itself is gated
                 by the same breakpoint. Restored in v0.1.767 after
                 PR #767 inadvertently removed it. -->
            <button
              v-if="!isNarrowDetail"
              class="unify-topbar-vp-toggle"
              :class="{ active: vpTimelineVisible }"
              @click="toggleVpTimeline"
              :title="vpTimelineVisible ? $t('unify.vpTimeline.hide') : $t('unify.vpTimeline.show')"
              :aria-label="vpTimelineVisible ? $t('unify.vpTimeline.hide') : $t('unify.vpTimeline.show')"
              :aria-expanded="vpTimelineVisible ? 'true' : 'false'"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            </button>
            <!-- task-unify-group-ui-cleanup: legacy ".unify-detail-toggle"
                 (tasks/feature placeholder slide-in) removed — Unify only
                 supports the debug panel today, and the placeholder
                 button surfaced an unimplemented feature. Debug button
                 above remains the sole right-pane affordance. -->
          </div>
        </div>

        <!-- H2.f.6: UnifyFeatureDetailView removed — cross-thread aggregation
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
          v-if="!showSettings && store.unifyActiveVpDetailId"
          :vp-id="store.unifyActiveVpDetailId"
          @back="exitVpDetailView"
        />

        <!-- Messages Area — reuse standard MessageList for identical rendering -->
        <!-- task-fix-empty-group: hero state replaces MessageList when the
             active group has no roster — gives the user a single, clear
             next step instead of a blank canvas. The modal still pops on
             top for groups the user hasn't dismissed yet. -->
        <div
          v-if="!showSettings && !store.unifyActiveVpDetailId && isActiveGroupEmpty"
          class="unify-empty-group-hero"
        >
          <div class="unify-empty-group-hero__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 3-1.34 3-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          </div>
          <h2 class="unify-empty-group-hero__title">{{ $t('unify.group.empty.title') }}</h2>
          <p class="unify-empty-group-hero__hint">
            {{ $t('unify.group.empty.hint', { name: inviteGroupName || '' }) }}
          </p>
          <button type="button" class="unify-empty-group-hero__cta" @click="onInviteOpenLibrary">
            {{ $t('unify.group.empty.cta') }}
          </button>
        </div>
        <MessageList v-if="!showSettings && !store.unifyActiveVpDetailId && !isActiveGroupEmpty" @open-group-settings="openGroupSettings" />

        <!-- Settings Panel -->
        <UnifySettings v-if="showSettings" :initial-tab="settingsInitialTab" @close="showSettings = false" @saved="onSettingsSaved" />

        <!-- Input Area -->
        <ChatInput
          v-if="!showSettings"
          ref="chatInputRef"
          :send-fn="sendMessage"
          :cancel-fn="cancelUnify"
          :show-stop="isProcessing"
          placeholder-key="unify.placeholder"
        />
        </div><!-- /.unify-main-center -->
      </div>

      <!-- Right Detail Panel — only rendered when debug mode is on. The
           legacy "tasks memory" placeholder + collapse-toggle were retired
           in task-unify-group-ui-cleanup; the debug panel is the only
           right-pane content today, and it should not occupy layout space
           unless explicitly opened. -->
      <aside
        v-if="debugMode"
        class="unify-detail"
        :class="{ resizing: isResizingDetail, 'mobile-debug': isNarrowDetail }"
        :style="detailWidthStyle"
        ref="detailPanel"
      >
        <div class="unify-detail-drag-handle" :class="{ active: isResizingDetail }" @mousedown.prevent="startDetailResize"></div>
        <!-- Mobile/tablet overlay: close affordance for the debug panel.
             The topbar toggle is hidden behind the overlay on narrow
             viewports so the user needs an in-panel exit. -->
        <button
          v-if="isNarrowDetail"
          class="unify-debug-mobile-close"
          @click="toggleDebug"
          :aria-label="$t('common.close')"
        >
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
        <!-- 2026-05-13: open the Tool Usage Stats drawer. Lives here so
             it's reachable only from the debug surface (matches the
             "developer panel" framing). -->
        <button
          class="tool-stats-open-button"
          @click="toolStatsOpen = true"
          :title="$t('unify.toolStats.buttonLabel')"
        >
          📊 {{ $t('unify.toolStats.buttonLabel') }}
        </button>
        <UnifyDebugPanel />
      </aside>

      <!-- 2026-05-13: Tool Usage Stats drawer (modal). Controlled by
           the chip inside the debug panel header. -->
      <UnifyToolStatsDrawer v-model="toolStatsOpen" />

      <!-- task-343: VP library is now an in-Settings tab (initial-tab='vp'). -->

      <!-- task-fix-group-member-editor: invite modal CTA now opens the
           group's member editor directly (the previous flow dumped the
           user into VP-Settings, where there was no add-to-group UI). -->
      <GroupInviteModal
        v-if="shouldShowInviteModal"
        :group-name="inviteGroupName"
        @open-library="onInviteOpenLibrary"
        @dismiss="onInviteDismiss"
      />

      <!-- task-fix-group-member-editor → unified GroupSettingsModal: a
           single dialog (announcement / members / rename / danger) owned
           at this level so the empty-group hero CTA, the sidebar ⚙
           button, the invite-modal CTA, and the legacy openMemberEditor
           shim all converge here. -->
      <GroupSettingsModal
        v-if="groupSettingsOpen && groupSettingsId"
        :group-id="groupSettingsId"
        :initial-section="groupSettingsSection"
        @close="closeGroupSettings"
      />
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    // PR-3: VP roster is the source of truth for timeline ordering and
    // locale-aware naming. Read from the dedicated vp store rather than
    // reaching into the chat store so the helper signature stays clean.
    const vpStore = Pinia.useVpStore();

    const sidebarCollapsed = Vue.ref(false);
    // task-unify-group-ui-cleanup: debug mode now starts OFF (was always
    // visible as a "tasks memory / coming soon" placeholder). The right
    // detail panel is only rendered when debugMode is on, so the
    // conversation column gets the full width by default.
    const debugMode = Vue.ref(false);
    const modelDropdownOpen = Vue.ref(false);
    const showSettings = Vue.ref(false);
    const settingsInitialTab = Vue.ref('llm'); // task-343: 'llm' | 'vp'
    // 2026-05-13: tool-stats drawer open state. Toggled by the chip in
    // the debug detail header, populated lazily on first open by the
    // drawer's own watcher.
    const toolStatsOpen = Vue.ref(false);

    // feat-vp-list-ui-polish: template ref to the embedded ChatInput so we
    // can call its imperative `appendMention(vpId)` when the VP list pane
    // emits a mention request. Keeps the Unify-specific @-syntax out of
    // ChatInput (review fix — Fowler C2, PR #763).
    const chatInputRef = Vue.ref(null);

    // task-340: Workbench capability gate — matches ChatPage.canUseWorkbench
    // semantics via store.hasCapability. store.workbenchExpanded and
    // workbenchMaximized are already shared across Chat/Unify pages.
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
      store.setActiveGroupFilter(id);
      // Also leave the VP detail view so the main stream is visible.
      if (store.unifyActiveVpDetailId) store.leaveVpDetailView();
      if (isMobile.value) sidebarCollapsed.value = true;
    };

    // task-334-ui-c: exit the VP-detail view back to prior layer.
    const exitVpDetailView = () => {
      store.leaveVpDetailView();
    };

    // task-unify-remove-sidebar-search (2026-05-08): the sidebar search
    // box was retired, so the Esc-to-refocus handler that paired with
    // it is gone too.

    // Detail panel resizable width
    const detailPanel = Vue.ref(null);
    const isResizingDetail = Vue.ref(false);
    // task-345: Align to Chat right-panel tokens.
    // - ExpertPanel.open fixed width: 320px (web/styles/expert-panel.css)
    // - SubAgentPanel.open.expanded: width 40%, min 360, max 600 (web/styles/subagent-panel.css)
    // Unify detail is resizable; MIN matches ExpertPanel base, DEFAULT clamped like SubAgentPanel expanded.
    const DETAIL_MIN_WIDTH = 320;
    const DETAIL_DEFAULT_WIDTH = Math.max(DETAIL_MIN_WIDTH, Math.round(window.innerWidth * 0.25));
    const savedDetailWidth = localStorage.getItem('unify-debug-width');
    const detailWidth = Vue.ref(savedDetailWidth ? parseInt(savedDetailWidth, 10) : DETAIL_DEFAULT_WIDTH);

    const detailWidthStyle = Vue.computed(() => {
      return { '--unify-detail-width': detailWidth.value + 'px' };
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
        localStorage.setItem('unify-debug-width', String(detailWidth.value));
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    // ── VP Timeline pane state (visibility + resizable width).
    // Restored in v0.1.767 after PR #767 inadvertently removed it
    // together with the Feature system. The pane is roster-driven and
    // has no Feature-system dependency; no per-second tick is needed
    // (the original `nowMs` only drove the in-feature elapsed timer).

    // User-controlled show/hide. Defaults to true so first-time users
    // see the pane; subsequent sessions restore whatever the user last
    // chose. localStorage is wrapped in try/catch because in
    // private-browsing mode setItem can throw.
    const VP_TIMELINE_VISIBLE_KEY = 'unify-vp-timeline-visible';
    const readVpTimelineVisible = () => {
      try {
        const v = localStorage.getItem(VP_TIMELINE_VISIBLE_KEY);
        if (v === '0' || v === 'false') return false;
        return true;
      } catch (_) { return true; }
    };
    const vpTimelineVisible = Vue.ref(readVpTimelineVisible());
    const toggleVpTimeline = () => {
      vpTimelineVisible.value = !vpTimelineVisible.value;
      try {
        localStorage.setItem(VP_TIMELINE_VISIBLE_KEY, vpTimelineVisible.value ? '1' : '0');
      } catch (_) {}
    };
    const TIMELINE_MIN_WIDTH = 220;
    const TIMELINE_DEFAULT_WIDTH = 280;
    const savedTimelineWidth = (() => {
      try { return localStorage.getItem('unify-vp-timeline-width'); } catch (_) { return null; }
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
      '--unify-vp-timeline-width': timelineWidth.value + 'px',
    }));

    const startTimelineResize = (e) => {
      const startX = e.clientX;
      const startWidth = timelineWidth.value;
      // Cap at 40% of viewport — the VP list is supplementary; never
      // let it crowd the conversation pane.
      const maxWidth = Math.max(TIMELINE_MIN_WIDTH, Math.floor(window.innerWidth * 0.4));

      const onMouseMove = (ev) => {
        const delta = ev.clientX - startX; // drag right = wider (handle on right edge)
        const newWidth = Math.min(maxWidth, Math.max(TIMELINE_MIN_WIDTH, startWidth + delta));
        timelineWidth.value = newWidth;
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        try { localStorage.setItem('unify-vp-timeline-width', String(timelineWidth.value)); } catch (_) {}
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    // Detect mobile for overlay behavior.
    //   isMobile        — sidebar overlay (<=768)
    //   isNarrowDetail  — debug-panel overlay (<=1024). The base
    //     responsive rule hides .unify-detail at 1024 and below, which
    //     was making the debug toggle a no-op on tablets too. We mirror
    //     that breakpoint here so the JS-driven overlay class is
    //     applied on every viewport where CSS would otherwise hide the
    //     panel.
    const isMobile = Vue.ref(window.innerWidth <= 768);
    const isNarrowDetail = Vue.ref(window.innerWidth <= 1024);
    const onResize = () => {
      isMobile.value = window.innerWidth <= 768;
      isNarrowDetail.value = window.innerWidth <= 1024;
    };

    // Esc handling — exit the VP detail view if it's open. (Task-detail
    // layer was deleted alongside unifyActiveFeatureDetailId; only the
    // vp-detail layer remains.)
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (store.unifyActiveVpDetailId) {
        store.leaveVpDetailView();
      }
    };

    Vue.onMounted(() => {
      window.addEventListener('resize', onResize);
      document.addEventListener('click', closeModelDropdownOutside);
      document.addEventListener('keydown', onKeyDown);
    });
    Vue.onUnmounted(() => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('click', closeModelDropdownOutside);
      document.removeEventListener('keydown', onKeyDown);
    });

    // Watch for conversationId changes (session_ready migrates local -> agent ID)
    Vue.watch(() => store.unifyConversationId, (newId) => {
      if (newId && store.activeConversations[0] !== newId) {
        store.activeConversations = [newId];
      }
    });

    const hasMessages = Vue.computed(() => {
      const convId = store.unifyConversationId;
      if (!convId) return false;
      const msgs = store.messagesMap[convId];
      return msgs && msgs.length > 0;
    });

    const isProcessing = Vue.computed(() => {
      const convId = store.unifyConversationId;
      return convId ? !!store.processingConversations[convId] : false;
    });

    const goBack = () => {
      store.leaveUnify();
    };

    const sendMessage = (text, attachmentInfos) => {
      // task-334m: Pre-check `no_default_vp` before the WS round-trip.
      // If the active group has no roster + no defaultVpId, surface the
      // invite modal instead of sending a message that would round-trip
      // a `no_default_vp` error back as a silent toast.
      const gs = groupsStore();
      if (gs && gs.activeNeedsInvite) {
        const g = gs.activeGroup;
        if (g) inviteDismissedFor.delete(g.id); // force show
        return;
      }
      // Unify is conceptually a single conversation backed by a group.
      // Default to grp_default when no group is active so the agent
      // ALWAYS builds a coordinator and ctx.router for the per-VP turn.
      const groupId = (gs && gs.activeGroupId) || 'grp_default';
      const mentions = parseMentions(text).mentions;
      // Attachments: ChatInput's custom-send path passes the resolved
      // info list as the second arg. We forward it untouched — the
      // store helper strips `fileId` shape for the wire and keeps the
      // preview/name/mimeType on the local message render.
      const attachments = Array.isArray(attachmentInfos) ? attachmentInfos : undefined;
      store.sendUnifyGroupChat({ groupId, text, mentions, attachments });
    };

    // Bug 5: ChatInput's default cancel triggers Chat-mode cancel_execution,
    // which is a no-op for Unify (no Claude CLI conversation, abort lives
    // in the agent's per-thread registry). Route stop -> unify_abort_all.
    const cancelUnify = () => {
      store.cancelUnify();
    };

    const clearMessages = () => {
      const { t } = Vue.getCurrentInstance().appContext.config.globalProperties;
      if (confirm(t('unify.clearConfirm'))) {
        store.clearUnifyMessages();
      }
    };

    const toggleSidebar = () => {
      sidebarCollapsed.value = !sidebarCollapsed.value;
    };

    // task-unify-group-ui-cleanup: toggleDetail() was wired to a topbar
    // button that opened/collapsed the placeholder detail panel; the
    // button + placeholder are gone, so the helper is removed too.

    const toggleDebug = () => {
      debugMode.value = !debugMode.value;
    };

    const reloadPage = () => {
      window.location.reload();
    };

    // groupsStore + topbarGroup must be declared BEFORE dreamButtonVpId.
    // The chain that hits TDZ otherwise:
    //   Vue.watch(dreamLastRunAt, …) eagerly resolves its source during
    //   setup → dreamLastRunAt.value reads dreamStatusEntry.value →
    //   vpStore.dreamStatusFor(dreamButtonVpId.value) → topbarGroup.value
    // If topbarGroup is declared later in setup() the last step throws
    // "ReferenceError: Cannot access 'topbarGroup' before initialization"
    // and the component fails to mount, blanking out the page.
    const groupsStore = () => {
      try {
        return window.Pinia?.useGroupsStore?.() || null;
      } catch { return null; }
    };
    // task-fix-mobile-group-settings: surface a group ⚙ in the topbar
    // so the conversation always has a settings entry-point — sidebar
    // collapses to a slide-over on mobile, hover-reveal affordances
    // don't exist on touch, and the announcement bar may not be
    // visible if the active group has none. Resolve the group from the
    // groups store the same way `sendMessage` does (filter > activeGroupId
    // > grp_default fallback) so the gear targets whatever is on screen.
    const topbarGroup = Vue.computed(() => {
      const gs = groupsStore();
      if (!gs || !gs.groups) return null;
      const filterId = store.unifyActiveGroupFilter || null;
      if (filterId && gs.groups[filterId]) return gs.groups[filterId];
      if (gs.activeGroupId && gs.groups[gs.activeGroupId]) return gs.groups[gs.activeGroupId];
      return gs.groups['grp_default'] || null;
    });

    // ── fix/dream-cadence-and-ui-trigger: manual dream trigger ──
    // The button targets whichever VP key the agent will use to fan
    // back the result. `handleUnifyDreamTrigger` defaults to 'default'
    // when no vpId is sent; mirroring that here keeps the round-trip
    // keys aligned with vpStore.dreamStatus[vpId].
    const dreamButtonVpId = Vue.computed(() => {
      const g = topbarGroup.value;
      if (g && g.defaultVpId) return g.defaultVpId;
      return 'default';
    });

    /** @type {import('vue').Ref<number|null>} just-finished flag — wall-clock when the last result arrived. */
    const dreamFinishedAt = Vue.ref(null);
    let dreamFinishedTimer = null;
    /** Ticker used to re-evaluate "stale" + relative-time strings without re-rendering on every input event. */
    const dreamTickMs = Vue.ref(Date.now());
    let dreamTickHandle = null;
    Vue.onMounted(() => {
      // Refresh ticker — re-evaluates the relative-time tooltip and
      // the 24h-stale check at DREAM_RELATIVE_TIME_REFRESH_MS cadence.
      dreamTickHandle = setInterval(
        () => { dreamTickMs.value = Date.now(); },
        DREAM_RELATIVE_TIME_REFRESH_MS,
      );
    });
    Vue.onBeforeUnmount(() => {
      if (dreamTickHandle) { clearInterval(dreamTickHandle); dreamTickHandle = null; }
      if (dreamFinishedTimer) { clearTimeout(dreamFinishedTimer); dreamFinishedTimer = null; }
    });

    const dreamStatusEntry = Vue.computed(
      () => vpStore.dreamStatusFor(dreamButtonVpId.value),
    );
    const dreamRunning = Vue.computed(() => dreamStatusEntry.value.status === 'running');
    const dreamLastRunAt = Vue.computed(() => dreamStatusEntry.value.lastRunAt);

    // Auto-clear the post-success bubble after 3 s. Watching `lastRunAt`
    // catches both success and error paths; we only show the +N badge on
    // success (entriesCreated will be null on error).
    Vue.watch(dreamLastRunAt, (newVal) => {
      if (!newVal) return;
      dreamFinishedAt.value = newVal;
      if (dreamFinishedTimer) clearTimeout(dreamFinishedTimer);
      dreamFinishedTimer = setTimeout(() => {
        dreamFinishedAt.value = null;
        dreamFinishedTimer = null;
      }, DREAM_JUST_FINISHED_MS);
    });

    const dreamJustFinished = Vue.computed(() => {
      const f = dreamFinishedAt.value;
      if (!f) return false;
      // Only paint the bubble for successful runs — error path leaves
      // status='error' and lastResult=null.
      return dreamStatusEntry.value.status === 'success'
        && !!dreamStatusEntry.value.lastResult;
    });
    const dreamEntriesCreated = Vue.computed(() => {
      const lr = dreamStatusEntry.value.lastResult;
      if (!lr) return null;
      const n = lr.entriesCreated;
      return typeof n === 'number' ? n : null;
    });

    // Stale = no run observed yet OR last run >24h old. The local cache
    // is per-tab; a freshly opened browser tab will always show stale
    // until the server pushes a state snapshot or the user runs it
    // manually. That's intentional — better to nudge once than to
    // silently let dream rot.
    const dreamStale = Vue.computed(() => {
      const t = dreamLastRunAt.value;
      if (!t) return true;
      return (dreamTickMs.value - t) > DREAM_REDDOT_THRESHOLD_MS;
    });

    /** Format a millisecond delta as a short relative-time string. */
    const formatRelativeFromNow = (whenMs) => {
      if (!whenMs) return null;
      const dt = Math.max(0, dreamTickMs.value - whenMs);
      const min = Math.floor(dt / 60_000);
      if (min < 1) return null; // "just now" handled by the bubble already
      if (min < 60) return `${min}m`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr}h`;
      const day = Math.floor(hr / 24);
      return `${day}d`;
    };

    /** Relative-time string for the tooltip's second line (or null = never run). */
    const dreamLastRunRelative = Vue.computed(() => formatRelativeFromNow(dreamLastRunAt.value));

    const onDreamTriggerClick = () => {
      if (dreamRunning.value) return;
      vpStore.triggerDream(dreamButtonVpId.value);
    };

    // feat-6af5f9f1 PR C: the legacy debug helpers (toggleTurnExpand,
    // formatMessages, formatMsgContent, prettyJson, formatToolOutput,
    // getFunctionCallPairs, formatToolCalls, formatRawResponse) lived
    // here for the old inline debug panel. PR B replaced that panel
    // with <UnifyDebugPanel>; PR C removes the now-orphaned helpers.

    const toggleModelDropdown = (e) => {
      e.stopPropagation();
      if (store.unifyAvailableModels.length <= 1) return;
      modelDropdownOpen.value = !modelDropdownOpen.value;
    };

    const selectModel = (modelId) => {
      if (modelId === store.unifyModel) {
        modelDropdownOpen.value = false;
        return;
      }
      store.switchUnifyModel(modelId);
      modelDropdownOpen.value = false;
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
      const row = e.target.closest('.unify-topbar-model, .unify-topbar-model-dropdown');
      if (!row) modelDropdownOpen.value = false;
    };

    const toggleSettings = () => {
      if (!showSettings.value) settingsInitialTab.value = 'llm';
      showSettings.value = !showSettings.value;
    };

    // task-343: VP library lives inside Settings as a tab. Helper to open
    // Settings at a specific tab (used by GroupInviteModal CTA).
    const openSettings = ({ initialTab = 'llm' } = {}) => {
      settingsInitialTab.value = initialTab === 'vp' ? 'vp' : 'llm';
      showSettings.value = true;
    };

    // task-334m: Group invite modal wiring. The modal is shown whenever
    // the active group has no roster + no defaultVpId. A per-group
    // `dismissed` set silences it mid-session until the roster changes
    // (dismiss is sticky to the current `(groupId, rosterVersion)` — any
    // roster mutation re-arms the prompt so adding then removing a VP
    // correctly re-surfaces the invite on the next empty state).
    const inviteDismissedFor = Vue.reactive(new Set());
    const activeGroupForInvite = Vue.computed(() => {
      const gs = groupsStore();
      return gs ? gs.activeGroup : null;
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
            return globalI18n.global.t('unify.group.defaultName');
          }
        } catch (_) {}
      }
      return g.name || g.id || '';
    };
    const inviteGroupName = Vue.computed(
      () => resolveGroupDisplayName(activeGroupForInvite.value),
    );
    const shouldShowInviteModal = Vue.computed(() => {
      const gs = groupsStore();
      if (!gs || !gs.activeNeedsInvite) return false;
      const g = gs.activeGroup;
      if (!g) return false;
      // Skip if the user already dismissed THIS empty-roster state.
      return !inviteDismissedFor.has(g.id);
    });
    // task-fix-empty-group: separate from `shouldShowInviteModal` because the
    // hero state stays visible even after the user dismisses the modal —
    // the empty group still needs a clear next step in the main pane.
    const isActiveGroupEmpty = Vue.computed(() => {
      const gs = groupsStore();
      return !!(gs && gs.activeNeedsInvite);
    });
    const onInviteOpenLibrary = () => {
      const g = activeGroupForInvite.value;
      if (g) inviteDismissedFor.add(g.id);
      // task-fix-group-member-editor: open the in-place member editor
      // for the current group instead of routing through VP Settings.
      // The "open-library" event name is preserved for backwards-compat
      // with GroupInviteModal's emits but the destination has changed.
      openMemberEditor(g ? g.id : null);
    };
    const onInviteDismiss = () => {
      const g = activeGroupForInvite.value;
      if (g) inviteDismissedFor.add(g.id);
    };
    // task-fix-group-member-editor → unified group settings modal.
    // Holds the groupId + initial section so callers (sidebar ⚙, hero
    // CTA, invite-modal CTA, announcement-bar "Open settings" link) can
    // target any group and any pane.
    const groupSettingsOpen = Vue.ref(false);
    const groupSettingsId = Vue.ref(null);
    const groupSettingsSection = Vue.ref('announcement');
    const openGroupSettings = ({ groupId, section = 'announcement' } = {}) => {
      if (!groupId) return;
      groupSettingsId.value = groupId;
      groupSettingsSection.value = section;
      groupSettingsOpen.value = true;
    };
    const closeGroupSettings = () => {
      groupSettingsOpen.value = false;
      groupSettingsId.value = null;
    };
    // Backwards-compat shim — the empty-group hero, the sidebar kebab,
    // and the invite-modal "open library" CTA still call this. Maps to
    // the Members section of the unified settings modal.
    const openMemberEditor = (groupId) => {
      if (!groupId) return;
      openGroupSettings({ groupId, section: 'members' });
    };
    const topbarGroupName = Vue.computed(
      () => resolveGroupDisplayName(topbarGroup.value),
    );
    const openTopbarGroupSettings = () => {
      const g = topbarGroup.value;
      if (!g) return;
      openGroupSettings({ groupId: g.id, section: 'announcement' });
    };
    // I6: closeMemberEditor shim was unused — dropped. openMemberEditor
    // remains because GroupInviteModal's "open library" CTA still calls
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

    const onSettingsSaved = () => {
      showSettings.value = false;
    };

    // ── VP Timeline computeds + handlers ───────────────────────────────
    // Pane is visible when (a) we're not in settings, (b) viewport is
    // wide enough (CSS also hides .unify-vp-timeline at <=1024 px), and
    // (c) the user hasn't hidden the pane via the topbar toggle. The
    // pane STAYS visible when unifyActiveVpDetailId is set so the user
    // can hop between VPs without losing context.
    // Restored in v0.1.767 after PR #767 inadvertently removed it
    // together with the Feature system; no feature-aware status / meta.
    const showVpTimeline = Vue.computed(
      () => !showSettings.value && !isNarrowDetail.value && vpTimelineVisible.value
    );

    // Resolve the active group's roster and project it into timeline
    // rows. Status comes from the store's `vpStatuses` map (mirrored
    // from the agent broker) — no reverse-inference from message-level
    // `isStreaming` flags any more (see
    // docs/notes/2026-05-15-vp-status-from-agent.md).
    const vpTimelineRows = Vue.computed(() => {
      const convId = store.unifyConversationId;
      if (!convId) return [];

      // Active group resolution: an explicit conversation-pane filter
      // wins; otherwise fall back to the groups store's selected group.
      // The VP timeline is ALWAYS roster-scoped — no group means no
      // rows. This matches the user's mental model: the middle column
      // is "this group's roster", not "every VP in the library".
      const gs = groupsStore();
      const filter = store.unifyActiveGroupFilter || gs?.activeGroupId || null;
      if (!filter) return [];

      const group = gs?.groups?.[filter] ?? null;
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
      // groupId matches the active filter, and whose vpId is in the
      // active roster. The store keys vpStatuses by `${groupId}::${vpId}`
      // (see chat.js `vpStatusKey`) — iterate values, not keys, since
      // the composite key isn't a usable VP id by itself.
      const rawStatuses = store.vpStatuses || {};
      const scopedStatuses = {};
      for (const entry of Object.values(rawStatuses)) {
        if (!entry || !entry.vpId) continue;
        if (entry.groupId && entry.groupId !== filter) continue;
        if (!rosterSet.has(entry.vpId)) continue;
        scopedStatuses[entry.vpId] = entry;
      }

      return buildTimelineRows({
        vpList,
        vpStatuses: scopedStatuses,
        connectionState: store.connectionState,
        vpLabelOf: (id) => vpStore.vpLabel(id),
      });
    });

    const onOpenVpDetailFromTimeline = (vpId) => {
      if (!vpId) return;
      // Same path MessageList uses for VP-badge clicks:
      // the store handles "leave any conflicting layer" cleanup internally.
      store.enterVpDetailView(vpId);
    };

    // Clicking a VP row @-mentions that VP in the chat input (default
    // action), instead of jumping straight to the detail view. The
    // detail view moved to a hover-revealed info button on the row.
    // UnifyPage owns the ChatInput template ref and calls its exposed
    // `appendMention()` method directly.
    const onMentionVpFromTimeline = (vpId) => {
      if (!vpId) return;
      const ci = chatInputRef.value;
      if (ci && typeof ci.appendMention === 'function') {
        ci.appendMention(vpId);
      }
    };

    // Per-VP abort from the timeline. The pane only knows the vpId of
    // the row the user clicked. We reverse-look-up the most recently
    // started turnId for that VP from `activeVpTurns`. If a VP has
    // multiple concurrent turns (rare; possible during fan-out), we
    // abort the one with the most recent `startedAt` — that matches
    // "what is this VP doing right now." `cancelVpTurn` is a no-op if
    // the controller has already cleared.
    const onCancelVpFromTimeline = (vpId) => {
      if (!vpId) return;
      const map = store.activeVpTurns || {};
      let bestTurnId = null;
      let bestStartedAt = -Infinity;
      for (const [turnId, info] of Object.entries(map)) {
        if (!info || info.vpId !== vpId) continue;
        if (info.endedAt) continue;
        const ts = (typeof info.startedAt === 'number') ? info.startedAt : 0;
        if (ts >= bestStartedAt) {
          bestStartedAt = ts;
          bestTurnId = turnId;
        }
      }
      if (!bestTurnId) return;
      store.cancelVpTurn(bestTurnId);
    };

    return {
      store,
      sidebarCollapsed,
      debugMode,
      modelDropdownOpen,
      showSettings,
      settingsInitialTab,
      toolStatsOpen,
      chatInputRef,
      openSettings,
      isMobile,
      isNarrowDetail,
      detailPanel,
      isResizingDetail,
      detailWidthStyle,
      startDetailResize,
      hasMessages,
      isProcessing,
      goBack,
      sendMessage,
      cancelUnify,
      clearMessages,
      toggleSidebar,
      toggleDebug,
      reloadPage,
      toggleModelDropdown,
      selectModel,
      formatTokens,
      formatModelCtx,
      toggleSettings,
      onSettingsSaved,
      sidebarV2Enabled,
      onSelectGroupV2,
      exitVpDetailView,
      // task-340: workbench capability gate
      canUseWorkbench,
      // task-334m: invite modal bindings.
      shouldShowInviteModal,
      inviteGroupName,
      onInviteOpenLibrary,
      onInviteDismiss,
      isActiveGroupEmpty,
      // task-fix-group-member-editor → unified group settings modal.
      groupSettingsOpen,
      groupSettingsId,
      groupSettingsSection,
      openGroupSettings,
      closeGroupSettings,
      // Backwards-compat shim — onInviteOpenLibrary still calls this.
      openMemberEditor,
      // task-fix-mobile-group-settings: topbar group ⚙ bindings.
      topbarGroup,
      topbarGroupName,
      openTopbarGroupSettings,
      // VP timeline pane bindings — restored in v0.1.767.
      showVpTimeline,
      vpTimelineRows,
      vpTimelineVisible,
      toggleVpTimeline,
      timelineWidthStyle,
      startTimelineResize,
      onOpenVpDetailFromTimeline,
      onMentionVpFromTimeline,
      onCancelVpFromTimeline,
      // fix/dream-cadence-and-ui-trigger: manual dream trigger bindings.
      dreamRunning,
      dreamJustFinished,
      dreamStale,
      dreamEntriesCreated,
      dreamLastRunRelative,
      onDreamTriggerClick,
    };
  }
};
