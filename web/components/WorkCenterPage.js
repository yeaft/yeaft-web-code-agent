import { confirmDialog } from '../utils/dialog.js';
import WorkCenterActionDetail from './WorkCenterActionDetail.js';
import WorkCenterResourceControl from './WorkCenterResourceControl.js';
import WorkCenterSettingsModal from './WorkCenterSettingsModal.js';
import MessageComposer from './MessageComposer.js';
import UserTurnBlock from './UserTurnBlock.js';
import VpTurnBlock from './VpTurnBlock.js';
import AgentSettingsPanel from './AgentSettingsPanel.js';
import ModernSelect from './ModernSelect.js';
import WorkbenchPanel from './WorkbenchPanel.js';
import PaneResizeHandle from './PaneResizeHandle.js';
import { createWorkCenterWorkbenchContext, workCenterOutputTarget } from '../utils/work-center-workbench.js';
import folderPickerMixin from './mixins/folder-picker-mixin.js';
import { normalizeSessionMessageQuote } from '../utils/session-message-quote.js';
import { openImagePreview } from '../utils/imagePreview.js';
import {
  mergeActionMessages,
  workCenterActionMessageKey,
} from '../stores/helpers/work-center.js';

function savedActionsPaneWidth() {
  try {
    const width = Number(localStorage.getItem('work-center-actions-width'));
    if (Number.isFinite(width) && width >= 280 && width <= 10000) return width;
  } catch { /* Browser storage can be disabled. */ }
  return 400;
}

function invalidateWorkCenterUrlRestore(target) {
  const generation = (Number(target?.workCenterUrlRestoreGeneration) || 0) + 1;
  if (target) target.workCenterUrlRestoreGeneration = generation;
  return generation;
}

export default {
  name: 'WorkCenterPage',
  components: {
    MessageComposer, UserTurnBlock, VpTurnBlock, WorkCenterActionDetail,
    WorkCenterSettingsModal, AgentSettingsPanel, ModernSelect, WorkCenterResourceControl, WorkbenchPanel, PaneResizeHandle,
  },
  mixins: [folderPickerMixin],
  data() {
    return {
      selectedId: null,
      workbenchExpanded: false,
      selectedActionId: null,
      narrowPane: 'items',
      contentPanelOpen: false,
      actionsPaneWidth: savedActionsPaneWidth(),
      contentStack: [{ type: 'action-list' }],
      staleComposerTarget: null,
      composerTargetValue: 'coordinator',
      actionInputRequestGeneration: 0,
      workCenterUrlRestoreGeneration: 0,
      workItemMessage: '',
      workItemMessageQuote: null,
      workItemMessageAttachments: [],
      workItemMessageAttachmentsUploading: false,
      workItemMessageSending: false,
      workItemMessageError: '',
      workItemComposerGeneration: 0,
      preserveComposerOnEnvelopeClear: false,
      detailLoading: false,
      detailError: '',
      createOpen: false,
      settingsOpen: false,
      saving: false,
      createGeneration: 0,
      llmConfigOpen: false,
      agentSettingsOpen: false,
      agentSettingsTargetId: null,
      unavailableAgentStateGeneration: 0,
      unavailableAgentStateLoading: false,
      unavailableAgentStateError: '',
      search: '',
      filtersOpen: false,
      headerMenuOpen: false,
      boardVpId: '',
      boardWorkItemType: '',
      boardUpdatedRange: 'week',
      mobileBoardLane: 'active',
      deletingWorkItemIds: {},
      deleteWorkItemError: '',
      boardQueryTimer: null,
      workDirTouched: false,
      startTouched: false,
      createAttachments: [],
      attachmentsUploading: false,
      previewingAttachmentId: null,
      attachmentPreviewError: '',
      attachmentPreviewGeneration: 0,
      form: {
        requirement: '',
        workDir: '',
        deliveryTarget: '',
        reuseMemory: true,
        start: true,
      },
    };
  },
  computed: {
    store() { return Pinia.useChatStore(); },
    chat() { return this.store; },
    agents() { return this.store.agents || []; },
    onlineAgents() {
      return this.agents.filter(agent => agent?.online
        && Array.isArray(agent.capabilities) && agent.capabilities.includes('work_center'));
    },
    configurableDisabledAgents() {
      return this.agents.filter(agent => {
        const settings = this.store.workCenterFeatureSettingsByAgent?.[agent?.id];
        return agent?.online
          && Array.isArray(agent.capabilities)
          && agent.capabilities.includes('work_center_feature_settings')
          && !agent.capabilities.includes('work_center')
          && settings?.loaded === true
          && !settings.error
          && settings.enabled !== true;
      });
    },
    configurableUnavailableAgents() {
      return this.agents.filter(agent => {
        const settings = this.store.workCenterFeatureSettingsByAgent?.[agent?.id];
        return agent?.online
          && Array.isArray(agent.capabilities)
          && agent.capabilities.includes('work_center_feature_settings')
          && !agent.capabilities.includes('work_center')
          && settings?.loaded === true
          && !settings.error
          && settings.enabled === true;
      });
    },
    configurableAgentSettingsLoading() {
      return this.unavailableAgentStateLoading;
    },
    configurableAgentSettingsFailed() {
      return !!this.unavailableAgentStateError;
    },
    hasConfigurableOnlineAgents() {
      return this.agents.some(agent => agent?.online
        && agent.capabilities?.includes('work_center_feature_settings'));
    },
    hasOnlineAgents() { return this.agents.some(agent => agent?.online); },
    agentId() {
      const selected = this.store.workCenterAgentId;
      return this.onlineAgents.some(agent => agent.id === selected)
        ? selected
        : (this.onlineAgents[0]?.id || null);
    },
    workCenterAgentOptions() {
      return this.onlineAgents.map(agent => ({
        value: agent.id,
        label: agent.name || agent.id,
      }));
    },
    watcher() { return this.store.workCenterWatcherByAgent[this.agentId] || null; },
    boardNextCursor() { return this.store.workCenterListPageByAgent[this.agentId]?.nextCursor || null; },
    boardLoadingMore() { return !!this.store.workCenterListMoreLoadingByAgent[this.agentId]; },
    settings() { return this.store.workCenterSettingsByAgent[this.agentId] || null; },
    runtime() { return this.store.workCenterRuntimeByAgent[this.agentId] || null; },
    workItemTypes() { return Array.isArray(this.runtime?.workItemTypes) ? this.runtime.workItemTypes : []; },
    workItemAttachmentsSupported() { return this.runtime?.workItemAttachments === true; },
    canonicalMessageWireSupported() {
      return this.agents.find(agent => agent?.id === this.agentId)?.capabilities
        ?.includes('work_center_message_v2') === true;
    },
    createDefaultWorkDir() {
      return this.settings?.defaultWorkDir || this.runtime?.defaultWorkDir || '';
    },
    createDefaultStart() {
      return this.settings?.startImmediately !== false;
    },
    folderPickerAgentId() {
      return this.agentId || '';
    },
    defaultWorkDir() {
      return this.createDefaultWorkDir;
    },
    items() { return this.store.workCenterItemsByAgent[this.agentId] || []; },
    loading() { return !!this.store.workCenterLoadingByAgent[this.agentId]; },
    loaded() { return !!this.store.workCenterLoadedByAgent[this.agentId]; },
    error() { return this.store.workCenterErrorByAgent[this.agentId] || null; },
    detail() { return this.store.workCenterDetailByAgent[this.agentId] || null; },
    selected() {
      if (this.detail?.id === this.selectedId) return this.detail;
      return this.items.find(item => item.id === this.selectedId) || null;
    },
    workbenchContext() {
      return createWorkCenterWorkbenchContext({
        agentId: this.agentId,
        workItem: this.narrowPane !== 'items' ? this.selected : null,
        routeProtocolSupported: this.store.workCenterWorkbenchProtocolSupported === true
          && this.store.workbenchRouteProtocolSupported === true,
        hasAgentCapability: (id, capability) => this.store.hasAgentCapability(id, capability),
      });
    },
    goalProgress() {
      const progress = this.selected?.goalProgress;
      return Array.isArray(progress?.criteria) ? progress : null;
    },
    finalResponses() {
      const responses = this.selected?.finalResult?.responses;
      return Array.isArray(responses) ? responses.filter(response => typeof response?.summary === 'string' && response.summary.trim()) : [];
    },
    selectedAction() {
      const actions = Array.isArray(this.selected?.actions) ? this.selected.actions : [];
      return actions.find(action => action.id === this.selectedActionId) || null;
    },
    contentRef() {
      return this.contentStack[this.contentStack.length - 1] || { type: 'action-list' };
    },
    contentIsActionList() {
      return this.contentRef.type === 'action-list';
    },
    composerTargetIsCoordinator() {
      return this.composerTargetValue === 'coordinator';
    },
    composerTargetAction() {
      if (!this.composerTargetValue.startsWith('action:')) return null;
      const [, actionId, generationText] = this.composerTargetValue.split(':');
      const generation = Number(generationText);
      const actions = Array.isArray(this.selected?.actions) ? this.selected.actions : [];
      return actions.find(action => action.id === actionId
        && Number(action.generation) === generation) || null;
    },
    composerTargetIsStale() {
      return this.composerTargetValue !== 'coordinator' && !this.composerTargetAction;
    },
    composerTargetOptions() {
      const actions = Array.isArray(this.selected?.actions) ? this.selected.actions : [];
      const coordinator = this.tr('workCenter.coordinator', 'Coordinator');
      const options = [
        {
          value: 'coordinator',
          label: this.$t('workCenter.sendToTarget', { target: coordinator }),
          sublabel: this.tr('workCenter.coordinatorTargetHint', 'Work Item planning and coordination'),
          disabled: false,
        },
        ...actions.map(action => {
          const actionName = this.$t('workCenter.actionNumber', { number: this.actionSequence(action) });
          return {
            value: `action:${action.id}:${action.generation}`,
            label: this.$t('workCenter.sendToTarget', { target: actionName }),
            sublabel: action.brief?.objective || this.actionLabel(action.type),
            badge: this.statusLabel(action.status),
            disabled: !this.canMessageAction(action),
          };
        }),
      ];
      if (!this.composerTargetIsStale) return options;
      return [{
        value: this.composerTargetValue,
        label: this.tr('workCenter.targetUnavailable', 'Selected Action is no longer available'),
        sublabel: this.tr('workCenter.targetUnavailableHelp', 'Choose another target before sending. This draft was not redirected.'),
        disabled: true,
      }, ...options];
    },
    composerTargetLabel() {
      return this.composerTargetAction
        ? (this.composerTargetAction.brief?.objective || this.actionLabel(this.composerTargetAction.type))
        : this.tr('workCenter.coordinator', 'Coordinator');
    },
    composerPlaceholder() {
      return this.composerTargetAction
        ? this.$t('workCenter.actionChatPlaceholder', { name: this.composerTargetLabel })
        : this.tr('workCenter.conversationPlaceholder', 'Message about this work item');
    },
    composerTargetUnavailable() {
      if (this.coordinatorReadOnly) return true;
      if (this.composerTargetIsCoordinator) return this.coordinatorThinking;
      if (!this.composerTargetAction) return true;
      return !this.canMessageAction(this.composerTargetAction);
    },
    composerCanSend() {
      return !this.workItemMessageSending && !this.workItemMessageAttachmentsUploading
        && !this.composerTargetUnavailable
        && (!!this.workItemMessage.trim() || this.workItemMessageAttachments.length > 0);
    },
    pendingMessageEnvelope() {
      return this.selected?.id
        ? this.store.loadWorkCenterMessageEnvelope(this.agentId, this.selected.id)
        : null;
    },
    composerDraftLocked() {
      return !!this.pendingMessageEnvelope && !this.composerTargetIsStale;
    },
    pendingEnvelopeHasAttachments() {
      return Array.isArray(this.pendingMessageEnvelope?.attachments)
        && this.pendingMessageEnvelope.attachments.length > 0;
    },
    pendingEnvelopeAttachmentRecovery() {
      return this.composerDraftLocked && this.pendingEnvelopeHasAttachments;
    },
    actionMessageKey() {
      return this.selected?.id && this.selectedAction?.id
        ? workCenterActionMessageKey(
          this.agentId,
          this.selected.id,
          this.selectedAction.id,
          this.selectedAction.generation,
        )
        : '';
    },
    workItemComposerScope() {
      return this.selected?.id
        ? `${this.agentId}:${this.selected.id}:${this.workItemComposerGeneration}`
        : '';
    },
    conversationBlocks() {
      return (Array.isArray(this.selected?.messages) ? this.selected.messages : [])
        .map(message => {
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
                quote: normalizeSessionMessageQuote(message.quote),
                timestamp,
              },
            };
          }
          if (message?.role === 'assistant') {
            const speaker = message.speaker || {};
            const speakerName = this.workItemMessageSpeaker(message);
            const speakerId = speaker.id || `work-center-coordinator:${this.selected?.id || 'unknown'}`;
            const statusText = message.status === 'thinking'
              ? this.tr('workCenter.conversationThinking', 'Working…')
              : message.error || '';
            const decisionText = message.decision?.kind && message.decision.kind !== 'answer'
              ? this.tr(`workCenter.coordinatorDecision.${message.decision.kind}`, message.decision.kind)
              : '';
            const segments = [message.text, statusText, decisionText].filter(Boolean);
            return {
              key: message.id,
              kind: 'assistant',
              speakerName,
              turn: {
                id: message.id,
                messageId: message.id,
                atMessageId: message.id,
                turnId: message.turnId || message.id,
                textContent: segments.join('\n\n'),
                textSegments: segments.map((content, index) => ({
                  key: `${message.id}:${index}`,
                  content,
                  kind: message.status === 'thinking' ? 'progress' : 'result',
                  isStreaming: message.status === 'thinking',
                })),
                isStreaming: message.status === 'thinking',
                speakerVpId: speakerId,
                speakerTimestamp: timestamp,
                showSpeakerHeader: true,
                timestamp,
                createdAt: timestamp,
                todoMsg: null,
                toolMsgs: [],
                toolSummaryCount: 0,
                imageMsgs: [],
                askMsg: null,
                attachments: Array.isArray(message.attachments) ? message.attachments : [],
              },
            };
          }
          return { key: message.id, kind: 'system', message };
        });
    },
    coordinatorThinking() {
      return (this.selected?.messages || []).some(message => (
        message?.role === 'assistant' && message.status === 'thinking'
      ));
    },
    coordinatorReadOnly() {
      return ['done', 'cancelled'].includes(this.selected?.status);
    },
    actionMessages() {
      const current = Array.isArray(this.selectedAction?.messages) ? this.selectedAction.messages : [];
      // Older Agents sent prior Action messages in generation-scoped thread entries.
      // Flatten that wire-compatible payload into the same conversation; generation
      // remains an execution fence, not a user-visible message boundary.
      const compatibilityMessages = (Array.isArray(this.selectedAction?.thread) ? this.selectedAction.thread : [])
        .flatMap(entry => Array.isArray(entry?.messages) ? entry.messages : []);
      const earlier = this.store.workCenterActionMessages[this.actionMessageKey]?.messages || [];
      const persisted = mergeActionMessages(compatibilityMessages, earlier, current);
      const live = this.selectedAction?.liveMessage;
      const liveAlreadyPersisted = live && persisted.some(message => (
        message.role === 'assistant'
          && message.runId != null
          && message.runId === live.runId
          && (live.status === 'running'
            ? message.text === live.text
            : message.status !== 'running')
      ));
      return mergeActionMessages(persisted, liveAlreadyPersisted ? null : live);
    },
    actionMessagesNextCursor() {
      const page = this.store.workCenterActionMessages[this.actionMessageKey];
      return page ? page.nextCursor : this.selectedAction?.messageCursor;
    },
    actionMessagesLoading() {
      return !!this.store.workCenterActionMessagesLoading[this.actionMessageKey];
    },
    actionMessagesError() {
      return this.store.workCenterActionMessagesError[this.actionMessageKey] || '';
    },
    orderedActions() {
      const actions = Array.isArray(this.selected?.actions) ? this.selected.actions : [];
      const priority = { running: 0, waiting: 1, failed: 2, ready: 3, completed: 4, done: 4, closed: 5, superseded: 6, cancelled: 7 };
      return actions.map((action, index) => ({ action, index })).sort((left, right) => {
        const leftPriority = priority[left.action?.status] ?? 7;
        const rightPriority = priority[right.action?.status] ?? 7;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        const leftSequence = Number(left.action?.sequence);
        const rightSequence = Number(right.action?.sequence);
        if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence) && leftSequence !== rightSequence) {
          return leftSequence - rightSequence;
        }
        return left.index - right.index;
      }).map(entry => entry.action);
    },
    boardLanes() {
      return [
        { id: 'active', title: this.tr('workCenter.board.active', 'Active') },
        { id: 'needs_attention', title: this.tr('workCenter.board.needsAttention', 'Needs attention') },
        { id: 'closed', title: this.tr('workCenter.board.closed', 'Closed') },
      ].map(lane => ({ ...lane, items: this.items.filter(item => item.boardLane === lane.id) }));
    },
    boardExecutorOptions() {
      const options = new Map();
      for (const item of this.items) {
        for (const executor of Array.isArray(item.executors) ? item.executors : []) {
          if (executor?.id) options.set(executor.id, executor.name || executor.id);
        }
      }
      return [...options.entries()].map(([id, name]) => ({ id, name }));
    },
    boardTypeOptions() {
      return [...new Set(this.items.map(item => item.workItemType).filter(Boolean))].sort();
    },
    emptyState() {
      return {
        title: this.search.trim()
          ? this.tr('workCenter.noMatchesTitle', 'No matching work items')
          : this.tr('workCenter.emptyTitle', 'No work items yet'),
        body: this.search.trim()
          ? this.tr('workCenter.noMatchesBody', 'Try a different search or filter.')
          : this.tr('workCenter.emptyBody', 'Create a persistent task when work must continue beyond one conversation turn.'),
        canCreate: !this.search.trim(),
      };
    },
  },
  watch: {
    'workbenchContext.workspaceGeneration'() { this.workbenchExpanded = false; },
    agents: {
      immediate: true,
      deep: true,
      handler() {
        this.loadUnavailableAgentStates();
      },
    },
    agentId: {
      immediate: true,
      handler(id, previousId) {
        invalidateWorkCenterUrlRestore(this);
        this.createGeneration = (Number(this.createGeneration) || 0) + 1;
        this.saving = false;
        this.selectedId = null;
        this.selectedActionId = null;
        this.contentPanelOpen = false;
        this.resetWorkItemComposer?.();
        this.resetContentStack?.();
        this.composerTargetValue = 'coordinator';
        this.narrowPane = 'items';
        this.filtersOpen = false;
        this.headerMenuOpen = false;
        this.previewingAttachmentId = null;
        this.attachmentPreviewError = '';
        this.attachmentPreviewGeneration = (Number(this.attachmentPreviewGeneration) || 0) + 1;
        if (previousId && id !== previousId) {
          this.closeFolderPicker();
          this.resetCreateExecutionContext(id);
        }
        if (this.store.workCenterAgentId !== id) {
          this.store.enterWorkCenter(id);
          return;
        }
        if (id) {
          const listRequest = typeof this.boardFilters === 'function'
            ? this.store.listWorkItems(id, this.boardFilters())
            : this.store.listWorkItems(id);
          listRequest.catch(() => {});
          this.store.loadWorkCenterSettings(id).catch(() => {});
        }
      },
    },
    actionsPaneWidth(width) {
      try { localStorage.setItem('work-center-actions-width', String(width)); } catch { /* Optional preference. */ }
    },
    createDefaultWorkDir() {
      this.applyCreateDefaults();
    },
    createDefaultStart() {
      this.applyCreateDefaults();
    },
    search() { this.scheduleBoardQuery(); },
    boardVpId() { this.scheduleBoardQuery(); },
    boardWorkItemType() { this.scheduleBoardQuery(); },
    boardUpdatedRange() { this.scheduleBoardQuery(); },
    'detail.coordinatorRevision'() {
      this.$nextTick(() => {
        const stream = this.$el?.querySelector?.('.work-center-conversation-scroll');
        if (stream) stream.scrollTop = stream.scrollHeight;
      });
    },
    pendingMessageEnvelope(next, previous) {
      if (!previous || next || previous.workItemId !== this.selectedId) return;
      if (this.preserveComposerOnEnvelopeClear) {
        this.preserveComposerOnEnvelopeClear = false;
        this.workItemMessageError = '';
        this.workItemMessageSending = false;
        return;
      }
      this.workItemMessage = '';
      this.workItemMessageQuote = null;
      this.workItemMessageAttachments = [];
      this.workItemMessageError = '';
      this.workItemMessageSending = false;
    },
    detail: {
      deep: true,
      handler(detail) {
        if (!detail || detail.id !== this.selectedId) return;
        const actions = Array.isArray(detail.actions) ? detail.actions : [];
        if (this.selectedActionId && !actions.some(action => action.id === this.selectedActionId)) {
          this.selectedActionId = null;
          this.contentPanelOpen = false;
          this.resetContentStack();
          this.syncWorkCenterUrl(true);
          this.previewingAttachmentId = null;
          this.attachmentPreviewError = '';
          this.attachmentPreviewGeneration = (Number(this.attachmentPreviewGeneration) || 0) + 1;
        }
        if (this.composerTargetAction == null && this.composerTargetValue !== 'coordinator') {
          this.staleComposerTarget = this.composerTargetValue;
        } else {
          this.staleComposerTarget = null;
        }
      },
    },
  },
  beforeUnmount() {
    invalidateWorkCenterUrlRestore(this);
    this.unavailableAgentStateGeneration += 1;
    if (this.boardQueryTimer) clearTimeout(this.boardQueryTimer);
    window.removeEventListener('popstate', this.restoreWorkCenterUrl);
    document.removeEventListener('click', this.closeHeaderPopovers);
  },
  mounted() {
    this.returnFocusElement = document.activeElement;
    this.$nextTick(() => this.$refs.backToChat?.focus({ preventScroll: true }));
    window.addEventListener('popstate', this.restoreWorkCenterUrl);
    document.addEventListener('click', this.closeHeaderPopovers);
    this.restoreWorkCenterUrl();
    const draft = this.store.workCenterCreateDraft;
    if (!draft) return;
    this.form = {
      requirement: draft.requirement || draft.goal || draft.title || '',
      workDir: draft.workDir || '',
      deliveryTarget: draft.deliveryTarget || '',
      reuseMemory: true,
      start: this.settings?.startImmediately !== false,
    };
    this.createOpen = true;
    this.workDirTouched = !!String(draft.workDir || '').trim();
    this.startTouched = false;
    this.applyCreateDefaults();
  },
  methods: {
    toggleWorkbench() {
      this.$refs.workbench?.toggle();
    },
    canOpenOutput(output) {
      return this.workbenchContext.available
        && this.store.hasAgentCapability(this.agentId, 'file_editor')
        && workCenterOutputTarget(output, this.workbenchContext.ownerWorkDir)?.type === 'file';
    },
    openOutput(output) {
      if (this.canOpenOutput(output)) this.workbenchContext.openOutput(output);
    },
    closeHeaderPopovers(event) {
      if (!event?.target?.closest?.('.work-center-filter-menu, .work-center-search')) this.filtersOpen = false;
      if (!event?.target?.closest?.('.work-center-header-menu')) this.headerMenuOpen = false;
    },
    backToChat() {
      this.store.leaveWorkCenter();
      this.$nextTick(() => {
        const source = this.returnFocusElement;
        const visible = element => element?.isConnected && element.getClientRects().length
          && getComputedStyle(element).visibility !== 'hidden'
          && element.getBoundingClientRect().right > 0;
        const target = visible(source) && source !== document.body ? source
          : [...document.querySelectorAll('.sidebar-work-center-trigger, .header-sidebar-toggle, .yeaft-topbar-sidebar-toggle')]
            .find(visible);
        target?.focus({ preventScroll: true });
      });
    },
    tr(key, fallback) {
      const translated = this.$t ? this.$t(key) : key;
      return translated && translated !== key ? translated : fallback;
    },
    async loadUnavailableAgentStates() {
      const generation = ++this.unavailableAgentStateGeneration;
      const candidates = this.agents.filter(agent => agent?.online
        && agent.capabilities?.includes('work_center_feature_settings')
        && !agent.capabilities.includes('work_center')
        && (this.store.workCenterFeatureSettingsByAgent?.[agent.id]?.loaded !== true
          || this.store.workCenterFeatureSettingsByAgent?.[agent.id]?.error));
      this.unavailableAgentStateLoading = candidates.length > 0;
      this.unavailableAgentStateError = '';
      if (candidates.length === 0) return;
      const results = await Promise.allSettled(candidates.map(agent => this.store.loadWorkCenterFeatureSettings(agent.id)));
      if (generation !== this.unavailableAgentStateGeneration) return;
      const failed = results.filter(result => result.status === 'rejected');
      this.unavailableAgentStateError = failed.length
        ? (failed[0].reason?.message || this.tr('workCenter.agentStatusLoadFailed', 'Could not check Work Center status.'))
        : '';
      this.unavailableAgentStateLoading = false;
    },
    openWorkCenterAgentSettings() {
      const target = this.configurableDisabledAgents[0]
        || this.configurableUnavailableAgents[0]
        || this.agents.find(agent => agent?.online)
        || null;
      this.agentSettingsTargetId = target?.id || null;
      this.agentSettingsOpen = true;
    },
    closeWorkCenterAgentSettings({ focusBack = false } = {}) {
      this.agentSettingsOpen = false;
      if (focusBack) this.$nextTick(() => this.$refs.backToChat?.focus({ preventScroll: true }));
    },
    selectWorkCenterAgent(nextAgentId) {
      if (!nextAgentId || nextAgentId === this.agentId) return;
      this.store.enterWorkCenter(nextAgentId);
    },
    statusLabel(status) {
      return this.tr(`workCenter.status.${status}`, String(status || '').replace('_', ' '));
    },
    goalStatusLabel(status) {
      return this.tr(`workCenter.goalStatus.${status}`, this.statusLabel(status));
    },
    deliveryTargetLabel(target) {
      const keys = { response: 'Response', workspace_files: 'Files', pull_request: 'Pr', merge: 'Merge' };
      return keys[target] ? this.tr(`workCenter.deliveryTarget${keys[target]}`, target)
        : target || this.tr('workCenter.deliveryTargetAsk', 'Ask me before delivery');
    },
    actionLabel(type) {
      return this.tr(`workCenter.action.${type}`, type || '—');
    },
    messageSpeakerRole(name, role) {
      if (!name) return role;
      return this.$t('workCenter.messageSpeakerRole', { name, role });
    },
    workItemMessageSpeaker(message) {
      if (message?.role === 'user') return this.tr('workCenter.you', 'You');
      if (message?.role === 'legacy_instruction') {
        return this.tr('workCenter.originalRequest', 'Original request');
      }
      const name = message?.speaker?.name || message?.speaker?.id || '';
      return this.messageSpeakerRole(name, this.tr('workCenter.coordinator', 'Coordinator'));
    },
    quoteWorkItemMessage(quote) {
      const normalized = normalizeSessionMessageQuote(quote);
      if (!normalized) return;
      this.workItemMessageQuote = normalized;
      this.saveComposerDraft();
      this.$nextTick(() => this.$refs.workItemComposer?.getTextarea?.()?.focus?.());
    },
    removeWorkItemMessageQuote() {
      this.workItemMessageQuote = null;
      this.saveComposerDraft();
    },
    editWorkItemMessageAsNew(text) {
      this.workItemMessageQuote = null;
      this.workItemMessage = String(text || '');
      this.saveComposerDraft();
      this.$nextTick(() => {
        const textarea = this.$refs.workItemComposer?.getTextarea?.();
        textarea?.focus?.();
        const length = textarea?.value?.length || 0;
        textarea?.setSelectionRange?.(length, length);
      });
    },
    openConversationAttachment(payload) {
      return this.previewAttachment(payload?.attachment || payload, payload?.trigger || null);
    },
    actionSequence(action) {
      const sequence = Number(action?.sequence);
      if (Number.isFinite(sequence) && sequence > 0) return sequence;
      const actions = Array.isArray(this.selected?.actions) ? this.selected.actions : [];
      const index = actions.findIndex(candidate => candidate?.id === action?.id);
      return index >= 0 ? index + 1 : 1;
    },
    actionBreadcrumbDescription(action) {
      const description = String(
        action?.brief?.objective || action?.objective || this.actionContentSummary(action) || '',
      ).trim().replace(/\s+/g, ' ');
      return description || this.tr('workCenter.untitledAction', 'Untitled Action');
    },
    itemActionProgress(item) {
      const total = Math.max(0, Number(item?.actionCount) || 0);
      const completed = Math.min(total, Math.max(0, Number(item?.completedActionCount) || 0));
      return this.$t('workCenter.actionProgress', { completed, total });
    },
    time(value) {
      if (!value) return '';
      try { return new Date(Number(value)).toLocaleString(); } catch { return ''; }
    },
    onWorkItemMessageInput() {
      this.saveComposerDraft();
    },
    onWorkItemMessageKeydown(event) {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      this.sendSelectedWorkItemMessage();
    },
    boardFilters() {
      const now = Date.now();
      const updatedFrom = this.boardUpdatedRange === 'day' ? now - 24 * 60 * 60 * 1000
        : this.boardUpdatedRange === 'week' ? now - 7 * 24 * 60 * 60 * 1000
          : this.boardUpdatedRange === 'month' ? now - 30 * 24 * 60 * 60 * 1000 : null;
      return {
        keyword: this.search.trim(),
        vpId: this.boardVpId,
        workItemType: this.boardWorkItemType,
        updatedFrom,
        limit: 200,
      };
    },
    scheduleBoardQuery() {
      if (this.boardQueryTimer) clearTimeout(this.boardQueryTimer);
      this.boardQueryTimer = setTimeout(() => {
        this.boardQueryTimer = null;
        if (this.agentId) this.refresh();
      }, 180);
    },
    refresh() {
      if (!this.agentId) return Promise.resolve([]);
      return this.store.listWorkItems(this.agentId, this.boardFilters()).catch(() => {});
    },
    refreshWorkCenterRuntime(agentId) {
      if (!agentId || agentId !== this.agentId) return;
      return this.store.refreshWorkCenterRuntime(agentId).catch(() => {});
    },
    loadMoreBoardItems() {
      return this.store.loadMoreWorkItems(this.agentId).catch(() => {});
    },
    boardAction(item) {
      return item.attentionAction || item.activeAction || item.currentAction || null;
    },
    boardActionCountLabel(item) {
      const counts = item.actionCounts || {};
      const parts = [];
      for (const status of ['running', 'failed', 'waiting', 'ready']) {
        if (Number(counts[status]) > 0) parts.push(`${counts[status]} ${this.statusLabel(status)}`);
      }
      return parts.join(' · ') || this.itemActionProgress(item);
    },
    boardExecutorLabel(item) {
      const executors = Array.isArray(item.executors) ? item.executors : [];
      if (executors.length > 0) return executors.map(executor => executor.name || executor.id).join(', ');
      const action = this.boardAction(item);
      return action?.assignedVp?.name || action?.assignedVp?.id
        || this.tr('workCenter.assignment.planned', 'Planned assignment');
    },
    sameContentRef(left, right) {
      return left?.type === right?.type
        && left?.actionId === right?.actionId
        && left?.runId === right?.runId
        && left?.resourceId === right?.resourceId;
    },
    resetContentStack(contentRefs = [{ type: 'action-list' }]) {
      const refs = Array.isArray(contentRefs) ? contentRefs : [contentRefs];
      const stack = refs[0]?.type === 'action-list' ? refs : [{ type: 'action-list' }, ...refs];
      this.contentStack = stack.length > 0 ? stack : [{ type: 'action-list' }];
      const actionRef = [...this.contentStack].reverse().find(ref => ref.type === 'action');
      this.selectedActionId = this.contentRef.actionId || actionRef?.actionId || null;
    },
    openContentPanel({ syncUrl = true } = {}) {
      this.contentPanelOpen = true;
      if (syncUrl) this.syncWorkCenterUrl();
    },
    closeContentPanel({ syncUrl = true } = {}) {
      this.contentPanelOpen = false;
      this.resetContentStack();
      if (syncUrl) this.syncWorkCenterUrl();
      this.$nextTick(() => this.$refs.actionsButton?.focus?.());
    },
    pushContentRef(contentRef, { replace = false, syncUrl = true } = {}) {
      const current = this.contentRef;
      this.contentPanelOpen = true;
      if (this.sameContentRef(current, contentRef)) {
        if (syncUrl) this.syncWorkCenterUrl(replace);
        return;
      }
      this.contentStack = contentRef.type === 'action-list'
        ? [{ type: 'action-list' }]
        : [...this.contentStack, contentRef];
      this.selectedActionId = contentRef.actionId || this.selectedActionId;
      if (syncUrl) this.syncWorkCenterUrl(replace);
    },
    popContentRef() {
      if (this.contentStack.length <= 1) return;
      this.contentStack = this.contentStack.slice(0, -1);
      const actionRef = [...this.contentStack].reverse().find(ref => ref.type === 'action');
      this.selectedActionId = actionRef?.actionId || null;
      this.syncWorkCenterUrl();
    },
    contentRefParam(contentRef) {
      if (contentRef.type === 'action' && contentRef.actionId) return `action:${contentRef.actionId}`;
      if (contentRef.type === 'run' && contentRef.actionId && contentRef.runId) {
        return `run:${contentRef.actionId}:${contentRef.runId}`;
      }
      if (contentRef.type === 'attachment' && contentRef.resourceId) {
        return `attachment:${contentRef.actionId || '-'}:${contentRef.resourceId}`;
      }
      return 'action-list';
    },
    contentStackParam() {
      return this.contentStack.map(ref => this.contentRefParam(ref)).join('/');
    },
    parseContentRef(value) {
      const text = String(value || '');
      if (text === 'action-list') return { type: 'action-list' };
      if (text.startsWith('action:')) return { type: 'action', actionId: text.slice('action:'.length) };
      if (text.startsWith('run:')) {
        const [, actionId, runId] = text.split(':');
        return { type: 'run', actionId, runId };
      }
      if (text.startsWith('attachment:')) {
        const [, actionId, resourceId] = text.split(':');
        return { type: 'attachment', actionId: actionId === '-' ? null : actionId, resourceId };
      }
      return { type: 'action-list' };
    },
    parseContentStack(value) {
      const refs = String(value || '').split('/').filter(Boolean)
        .map(part => this.parseContentRef(part));
      const actionRef = [...refs].reverse().find(ref => ref.actionId
        && ['action', 'run', 'attachment'].includes(ref.type));
      return actionRef
        ? [{ type: 'action-list' }, { type: 'action', actionId: actionRef.actionId }]
        : [{ type: 'action-list' }];
    },
    workCenterUrlRoute() {
      const params = new URLSearchParams(window.location.search);
      return {
        agentId: params.get('workAgentId'),
        itemId: params.get('workItemId'),
        content: params.has('workContent') ? params.get('workContent') : null,
      };
    },
    sameWorkCenterUrlRoute(left, right) {
      return left?.agentId === right?.agentId
        && left?.itemId === right?.itemId
        && left?.content === right?.content;
    },
    syncWorkCenterUrl(replace = false) {
      invalidateWorkCenterUrlRestore(this);
      const url = new URL(window.location.href);
      if (this.selectedId) {
        url.searchParams.set('workAgentId', this.agentId || '');
        url.searchParams.set('workItemId', this.selectedId);
        if (this.contentPanelOpen) url.searchParams.set('workContent', this.contentStackParam());
        else url.searchParams.delete('workContent');
      } else {
        url.searchParams.delete('workAgentId');
        url.searchParams.delete('workItemId');
        url.searchParams.delete('workContent');
      }
      const next = `${url.pathname}${url.search}${url.hash}`;
      if (`${window.location.pathname}${window.location.search}${window.location.hash}` === next) return;
      const state = {
        ...window.history.state,
        workCenter: !!this.selectedId,
        workCenterContent: !!this.selectedId && this.contentPanelOpen,
      };
      window.history[replace ? 'replaceState' : 'pushState'](state, '', next);
    },
    async restoreWorkCenterUrl() {
      const restoreGeneration = invalidateWorkCenterUrlRestore(this);
      const route = this.workCenterUrlRoute();
      const restoreIsCurrent = () => restoreGeneration === this.workCenterUrlRestoreGeneration
        && this.sameWorkCenterUrlRoute(route, this.workCenterUrlRoute());
      const workAgentId = route.agentId;
      const workItemId = route.itemId;
      if (!workItemId || (workAgentId && workAgentId !== this.agentId)) {
        if (this.selectedId) this.showItemsPane({ syncUrl: false });
        return;
      }
      const contentPanelOpen = route.content != null;
      const contentStack = this.parseContentStack(route.content);
      const contentRef = contentStack.at(-1);
      if (this.selectedId !== workItemId || this.detail?.id !== workItemId) {
        this.openWorkItem(workItemId, {
          syncUrl: false,
          contentRefs: contentStack,
          contentOpen: contentPanelOpen,
        });
        this.detailLoading = true;
        try {
          await this.store.getWorkItem(workItemId, this.agentId);
        } catch (error) {
          if (restoreIsCurrent()) this.detailError = error?.message || String(error);
        } finally {
          if (restoreIsCurrent()) this.detailLoading = false;
        }
      }
      if (!restoreIsCurrent()) return;
      const actionId = contentRef.actionId
        || [...contentStack].reverse().find(ref => ref.type === 'action')?.actionId;
      if (actionId && !this.selected?.actions?.some(action => action.id === actionId)) {
        this.resetContentStack();
        this.syncWorkCenterUrl(true);
        return;
      }
      this.resetContentStack(contentStack);
      this.contentPanelOpen = contentPanelOpen;
      this.narrowPane = 'work-item';
      if (contentPanelOpen && actionId) this.loadLatestActionMessages(this.selectedAction);
      if (contentPanelOpen && route.content !== this.contentStackParam()) {
        this.syncWorkCenterUrl(true);
      }
    },
    resetWorkItemComposer() {
      this.workItemComposerGeneration += 1;
      this.workItemMessage = '';
      this.workItemMessageQuote = null;
      this.workItemMessageAttachments = [];
      this.workItemMessageAttachmentsUploading = false;
      this.workItemMessageError = '';
      this.workItemMessageSending = false;
    },
    draftTarget() {
      const action = this.composerTargetAction;
      return action
        ? { kind: 'action', actionId: action.id, generation: Number(action.generation) }
        : this.composerTargetValue === 'coordinator'
          ? { kind: 'coordinator' }
          : (() => {
              const [, actionId = '', generationText = '0'] = this.composerTargetValue.split(':');
              return { kind: 'action', actionId, generation: Number(generationText) || 0 };
            })();
    },
    targetValue(target) {
      if (typeof target === 'string' && target.startsWith('action:')) return target;
      return target?.kind === 'action'
        ? `action:${target.actionId}:${target.generation}`
        : 'coordinator';
    },
    saveComposerDraft() {
      if (!this.selectedId || !this.agentId) return;
      this.store.saveWorkCenterComposerDraft(this.agentId, this.selectedId, {
        text: this.workItemMessage,
        quote: this.workItemMessageQuote,
        attachments: [...this.workItemMessageAttachments],
        target: this.draftTarget(),
        error: this.workItemMessageError,
      });
    },
    restoreComposerDraft(itemId) {
      const envelope = this.store.loadWorkCenterMessageEnvelope(this.agentId, itemId);
      const draft = envelope || this.store.loadWorkCenterComposerDraft(this.agentId, itemId);
      this.workItemMessage = draft?.text || '';
      this.workItemMessageQuote = normalizeSessionMessageQuote(draft?.quote);
      this.workItemMessageAttachments = [...(draft?.attachments || [])];
      this.composerTargetValue = this.targetValue(draft?.target);
      this.workItemMessageError = draft?.error || '';
      this.staleComposerTarget = null;
      this.workItemMessageSending = false;
      this.workItemMessageAttachmentsUploading = false;
      this.workItemComposerGeneration += 1;
    },
    openWorkItem(itemId, {
      syncUrl = true,
      contentRefs = [{ type: 'action-list' }],
      contentOpen = false,
    } = {}) {
      this.saveComposerDraft();
      this.selectedId = itemId;
      this.narrowPane = 'work-item';
      this.contentPanelOpen = contentOpen;
      this.resetContentStack(contentRefs);
      this.restoreComposerDraft(itemId);
      this.detailError = '';
      this.detailLoading = false;
      this.previewingAttachmentId = null;
      this.attachmentPreviewError = '';
      this.attachmentPreviewGeneration = (Number(this.attachmentPreviewGeneration) || 0) + 1;
      if (syncUrl) this.syncWorkCenterUrl();
    },
    async selectItem(item) {
      this.openWorkItem(item.id);
      this.detailLoading = true;
      try {
        await this.store.getWorkItem(item.id, this.agentId);
      } catch (error) {
        if (this.selectedId === item.id) this.detailError = error?.message || String(error);
      } finally {
        if (this.selectedId === item.id) this.detailLoading = false;
      }
    },
    selectAction(action) {
      if (this.selectedActionId !== action.id) {
        this.previewingAttachmentId = null;
        this.attachmentPreviewError = '';
        this.attachmentPreviewGeneration = (Number(this.attachmentPreviewGeneration) || 0) + 1;
      }
      this.pushContentRef({ type: 'action', actionId: action.id });
      this.loadLatestActionMessages(action);
    },
    loadLatestActionMessages(action = this.selectedAction) {
      if (!this.selected?.id || !action?.id || Array.isArray(action.messages)) return null;
      const key = workCenterActionMessageKey(
        this.agentId,
        this.selected.id,
        action.id,
        action.generation,
      );
      if (this.store.workCenterActionMessages[key]) return null;
      return this.store.loadWorkItemActionMessages(
        this.selected.id,
        action.id,
        action.generation,
        null,
        this.agentId,
      ).catch(() => null);
    },
    showItemsPane({ syncUrl = true } = {}) {
      this.saveComposerDraft();
      this.narrowPane = 'items';
      this.selectedId = null;
      this.contentPanelOpen = false;
      this.resetContentStack();
      this.composerTargetValue = 'coordinator';
      this.resetWorkItemComposer();
      if (syncUrl) this.syncWorkCenterUrl();
    },
    showActionsPane() {
      this.contentPanelOpen = true;
      if (!this.contentIsActionList) this.popContentRef();
      else this.syncWorkCenterUrl();
    },
    canMessageAction(action) {
      if (!action || ['done', 'cancelled'].includes(this.selected?.status)) return false;
      return ['idle', 'ready', 'running', 'paused', 'waiting', 'failed', 'completed', 'stopped']
        .includes(action.status) && action.admissionStatus !== 'blocked';
    },
    clearPendingMessageEnvelope({ preserveAttachments = false } = {}) {
      if (!this.selectedId || !this.pendingMessageEnvelope) return false;
      this.actionInputRequestGeneration = (Number(this.actionInputRequestGeneration) || 0) + 1;
      this.preserveComposerOnEnvelopeClear = true;
      if (!this.store.discardWorkCenterMessageEnvelope(this.agentId, this.selectedId)) {
        this.preserveComposerOnEnvelopeClear = false;
        return false;
      }
      if (!preserveAttachments) this.workItemMessageAttachments = [];
      this.workItemMessageError = '';
      this.workItemMessageSending = false;
      return true;
    },
    chooseCoordinatorTarget() {
      if (this.pendingMessageEnvelope
        && !this.clearPendingMessageEnvelope({ preserveAttachments: true })) return;
      this.composerTargetValue = 'coordinator';
      this.staleComposerTarget = null;
      this.saveComposerDraft();
    },
    onComposerTargetChange() {
      if (this.pendingMessageEnvelope
        && !this.clearPendingMessageEnvelope({ preserveAttachments: true })) return;
      this.staleComposerTarget = this.composerTargetAction == null
        && this.composerTargetValue !== 'coordinator'
        ? this.composerTargetValue : null;
      this.saveComposerDraft();
    },
    loadEarlierActionMessages() {
      if (!this.selected?.id || !this.selectedAction?.id || this.actionMessagesNextCursor == null) return null;
      return this.store.loadWorkItemActionMessages(
        this.selected.id,
        this.selectedAction.id,
        this.selectedAction.generation,
        this.actionMessagesNextCursor,
        this.agentId,
      ).catch(() => null);
    },
    actionExecutor(action) {
      return action?.assignedVp?.name || action?.assignedVp?.id
        || action?.requiredRole || action?.assignmentPolicy?.fixedVpId
        || action?.assignmentPolicy?.capability || this.tr('workCenter.assignment.auto', 'Auto');
    },
    actionContentSummary(action) {
      return String(action?.contentSummary || action?.response || action?.brief?.objective || '').trim();
    },
    executionStats(value) {
      return value?.executionStats || {};
    },
    formatCount(value) {
      return new Intl.NumberFormat().format(Math.max(0, Number(value) || 0));
    },
    formatTokens(value) {
      const tokens = Math.max(0, Number(value) || 0);
      if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
      if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
      return String(tokens);
    },
    resetCreateExecutionContext(agentId) {
      const hadUserExecutionInput = this.workDirTouched || this.startTouched;
      const draft = this.store.workCenterCreateDraft;
      if (draft) {
        this.store.workCenterCreateDraft = {
          sourceAgentId: agentId || null,
          requirement: draft.requirement || draft.goal || draft.title || '',
          workDir: '',
          deliveryTarget: draft.deliveryTarget || '',
          origin: null,
          linkedSessionIds: [],
        };
      }
      this.form.workDir = '';
      this.form.start = true;
      this.workDirTouched = false;
      this.startTouched = false;
      if (hadUserExecutionInput) this.createOpen = false;
      this.applyCreateDefaults();
    },
    applyCreateDefaults() {
      if (!this.createOpen) return;
      if (!this.workDirTouched && !this.form.workDir.trim()) this.form.workDir = this.createDefaultWorkDir;
      if (!this.startTouched) this.form.start = this.createDefaultStart;
    },
    folderPickerInitialDir() {
      return this.form.workDir.trim() || this.createDefaultWorkDir;
    },
    folderPickerSetWorkDir(path) {
      this.form.workDir = path;
      this.workDirTouched = true;
    },
    onCreateWorkDirInput() {
      this.workDirTouched = true;
    },
    onCreateStartInput() {
      this.startTouched = true;
    },
    async onCreateAttachmentInput(event) {
      if (!this.workItemAttachmentsSupported) {
        event.target.value = '';
        throw new Error(this.tr('workCenter.attachmentsUnsupported', 'The selected Agent does not support Work Item attachments.'));
      }
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (files.length === 0) return;
      const remaining = Math.max(0, 10 - this.createAttachments.length);
      const selected = files.slice(0, remaining);
      if (selected.length === 0) return;
      this.attachmentsUploading = true;
      try {
        const formData = new FormData();
        for (const file of selected) formData.append('files', file, file.name || 'attachment');
        const authStore = Pinia.useAuthStore();
        const token = authStore.getActiveToken?.() || authStore.token || null;
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch('/api/upload', { method: 'POST', headers, body: formData });
        if (!response.ok) throw new Error(this.tr('workCenter.attachmentsUploadFailed', 'Attachment upload failed'));
        const result = await response.json();
        this.createAttachments = [
          ...this.createAttachments,
          ...(Array.isArray(result.files) ? result.files : []),
        ].slice(0, 10);
      } finally {
        this.attachmentsUploading = false;
      }
    },
    removeCreateAttachment(index) {
      this.createAttachments = this.createAttachments.filter((_attachment, itemIndex) => itemIndex !== index);
    },
    discardPendingMessageEnvelope() {
      if (!this.clearPendingMessageEnvelope()) return;
      this.saveComposerDraft();
    },
    async onWorkItemMessageAttachmentInput(event) {
      if (!this.workItemAttachmentsSupported) {
        event.target.value = '';
        this.workItemMessageError = this.tr('workCenter.attachmentsUnsupported', 'The selected Agent does not support Work Item attachments.');
        return;
      }
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (files.length === 0) return;
      const scope = this.workItemComposerScope;
      if (!scope) return;
      const replacingPending = this.pendingEnvelopeAttachmentRecovery;
      const existingCount = Array.isArray(this.selected?.attachments) ? this.selected.attachments.length : 0;
      const remaining = Math.max(0, 10 - existingCount
        - (replacingPending ? 0 : this.workItemMessageAttachments.length));
      const selected = files.slice(0, remaining);
      if (selected.length === 0) return;
      this.workItemMessageAttachmentsUploading = true;
      this.workItemMessageError = '';
      try {
        const formData = new FormData();
        for (const file of selected) formData.append('files', file, file.name || 'attachment');
        const authStore = Pinia.useAuthStore();
        const token = authStore.getActiveToken?.() || authStore.token || null;
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch('/api/upload', { method: 'POST', headers, body: formData });
        if (!response.ok) throw new Error(this.tr('workCenter.attachmentsUploadFailed', 'Attachment upload failed'));
        const result = await response.json();
        if (this.workItemComposerScope !== scope) return;
        const uploaded = (Array.isArray(result.files) ? result.files : [])
          .slice(0, Math.max(0, 10 - existingCount));
        if (replacingPending) {
          const replaced = this.store.replaceWorkCenterMessageEnvelopeAttachments(
            this.agentId, this.selectedId, uploaded,
          );
          if (!replaced) throw new Error(this.tr(
            'workCenter.pendingEnvelopeChanged',
            'The pending request changed; reopen this Work Item and try again.',
          ));
          this.workItemMessageAttachments = [...replaced.attachments];
          this.workItemMessageError = '';
        } else {
          this.workItemMessageAttachments = [
            ...this.workItemMessageAttachments,
            ...uploaded,
          ].slice(0, Math.max(0, 10 - existingCount));
          this.saveComposerDraft();
        }
      } catch (error) {
        if (this.workItemComposerScope === scope) this.workItemMessageError = error?.message || String(error);
      } finally {
        if (this.workItemComposerScope === scope) this.workItemMessageAttachmentsUploading = false;
      }
    },
    removeWorkItemMessageAttachment(index) {
      this.workItemMessageAttachments = this.workItemMessageAttachments
        .filter((_attachment, itemIndex) => itemIndex !== index);
      this.saveComposerDraft();
    },
    async previewAttachment(attachment, trigger = null) {
      if (!this.selected?.id || !attachment?.id || this.previewingAttachmentId) return;
      const agentId = this.agentId;
      const workItemId = this.selected.id;
      const actionId = this.selectedActionId || '';
      const scope = `${agentId}:${workItemId}:${actionId}`;
      const requestGeneration = (Number(this.attachmentPreviewGeneration) || 0) + 1;
      this.attachmentPreviewGeneration = requestGeneration;
      const requestIsCurrent = () => this.attachmentPreviewGeneration === requestGeneration
        && `${this.agentId}:${this.selected?.id || ''}:${this.selectedActionId || ''}` === scope;
      const previewWindow = attachment.isImage ? null : window.open('', '_blank');
      if (!attachment.isImage && !previewWindow) {
        this.attachmentPreviewError = this.tr('workCenter.attachmentOpenBlocked', 'The browser blocked the attachment window. Allow pop-ups and try again.');
        return;
      }
      if (previewWindow) previewWindow.opener = null;
      this.previewingAttachmentId = attachment.id;
      this.attachmentPreviewError = '';
      try {
        const data = await this.store.previewWorkItemAttachment(workItemId, attachment.id, agentId);
        if (!requestIsCurrent()) {
          previewWindow?.close();
          return;
        }
        if (data?.preview && data.attachment?.isImage) {
          openImagePreview(data.preview, {
            alt: attachment.name || this.tr('workCenter.previewAttachment', 'Open attachment'),
            closeLabel: this.tr('common.close', 'Close'),
            trigger,
          });
        }
        else if (data?.preview && previewWindow) previewWindow.location.replace(data.preview);
        else previewWindow?.close();
      } catch (error) {
        previewWindow?.close();
        if (requestIsCurrent()) {
          this.attachmentPreviewError = error?.message
            || this.tr('workCenter.attachmentPreviewFailed', 'Could not open the attachment. Try again.');
        }
      } finally {
        if (requestIsCurrent()) this.previewingAttachmentId = null;
      }
    },
    isExternalOutput(output) {
      return ['link', 'pr'].includes(output?.kind)
        && /^https?:\/\//i.test(String(output?.ref || ''));
    },
    formatAttachmentSize(value) {
      const size = Math.max(0, Number(value) || 0);
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / 1024 / 1024).toFixed(1)} MB`;
    },
    openCreate() {
      this.createOpen = true;
      this.workDirTouched = false;
      this.startTouched = false;
      this.applyCreateDefaults();
    },
    closeCreate() {
      if (this.saving) return;
      this.closeFolderPicker();
      this.createOpen = false;
      this.store.workCenterCreateDraft = null;
    },
    async submitCreate() {
      const requirement = String(this.form.requirement || this.form.goal || this.form.title || '').trim();
      if (!requirement || !this.form.workDir.trim()) return;
      const requestAgentId = this.agentId;
      const requestGeneration = (Number(this.createGeneration) || 0) + 1;
      this.createGeneration = requestGeneration;
      this.saving = true;
      try {
        const draft = this.store.workCenterCreateDraft;
        const draftOwnedByAgent = draft?.sourceAgentId === requestAgentId;
        const detail = await this.store.createWorkItem({
          requirement,
          title: requirement,
          goal: requirement,
          acceptanceCriteria: [],
          workItemType: 'auto',
          workDir: this.form.workDir.trim(),
          deliveryTarget: this.form.deliveryTarget || null,
          origin: draftOwnedByAgent ? (draft.origin || null) : null,
          linkedSessionIds: draftOwnedByAgent ? (draft.linkedSessionIds || []) : [],
          attachments: this.workItemAttachmentsSupported
            ? (this.createAttachments || []).map(attachment => ({
            fileId: attachment.fileId,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
          }))
            : [],
          reuseMemory: this.form.reuseMemory,
          start: this.form.start,
        }, requestAgentId);
        if (this.agentId !== requestAgentId || this.createGeneration !== requestGeneration) return;
        this.openWorkItem(detail.id);
        this.form = {
          requirement: '',
          workDir: '',
          deliveryTarget: '',
          reuseMemory: true,
          start: this.settings?.startImmediately !== false,
        };
        this.store.workCenterCreateDraft = null;
        this.createAttachments = [];
        this.workDirTouched = false;
        this.startTouched = false;
        this.createOpen = false;
      } finally {
        if (this.agentId === requestAgentId && this.createGeneration === requestGeneration) {
          this.saving = false;
        }
      }
    },
    async startSelected() {
      if (!this.selected) return;
      await this.store.startWorkItem(this.selected.id, this.agentId);
    },
    async sendSelectedWorkItemMessage() {
      if (!this.selected || !this.composerCanSend) return;
      const scope = this.workItemComposerScope;
      const targetValue = this.composerTargetValue;
      const targetAction = this.composerTargetAction;
      if (!this.composerTargetIsCoordinator && !targetAction) return;
      const itemId = this.selected.id;
      const revision = this.selected.revision;
      const text = this.workItemMessage.trim();
      const quote = normalizeSessionMessageQuote(this.workItemMessageQuote);
      const attachments = this.workItemMessageAttachments.map(attachment => ({
        fileId: attachment.fileId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      }));
      const requestGeneration = (Number(this.actionInputRequestGeneration) || 0) + 1;
      this.actionInputRequestGeneration = requestGeneration;
      this.workItemMessageSending = true;
      this.workItemMessageError = '';
      this.saveComposerDraft();
      try {
        const fence = {
          planRevision: this.selected.planRevision,
          ledgerRevision: this.selected.ledgerRevision,
          coordinatorRevision: this.selected.coordinatorRevision,
        };
        if (this.canonicalMessageWireSupported) {
          await this.store.postWorkItemMessage(
            itemId,
            text,
            targetAction
              ? { kind: 'action', actionId: targetAction.id, generation: targetAction.generation }
              : { kind: 'coordinator' },
            revision,
            attachments,
            this.agentId,
            fence,
            quote,
          );
        } else if (targetAction) {
          await this.store.sendWorkItemActionInput(
            itemId, text, targetAction.id, revision, targetAction.generation, attachments, this.agentId, quote,
          );
        } else {
          await this.store.sendWorkItemMessage(itemId, text, revision, attachments, this.agentId, fence, quote);
        }
        if (this.workItemComposerScope === scope
            && this.actionInputRequestGeneration === requestGeneration
            && this.composerTargetValue === targetValue
            && this.workItemMessage.trim() === text
            && !this.store.loadWorkCenterMessageEnvelope(this.agentId, itemId)) {
          this.workItemMessage = '';
          this.workItemMessageQuote = null;
          this.workItemMessageAttachments = [];
          this.store.removeWorkCenterComposerDraft(this.agentId, itemId);
        }
      } catch (error) {
        if (this.workItemComposerScope === scope && this.actionInputRequestGeneration === requestGeneration) {
          this.workItemMessageError = error?.message || String(error);
          this.saveComposerDraft();
        }
      } finally {
        if (this.workItemComposerScope === scope && this.actionInputRequestGeneration === requestGeneration) {
          this.workItemMessageSending = false;
        }
      }
    },
    workItemCanDelete(item) {
      return ['done', 'cancelled', 'draft', 'needs_attention'].includes(item?.status);
    },
    workItemDeleting(item) {
      return !!this.deletingWorkItemIds[item?.id];
    },
    async deleteWorkItem(item) {
      if (!item || this.workItemDeleting(item)) return;
      const prompt = this.tr('workCenter.deleteConfirm', 'Permanently delete this Work Item, its execution history, and attachments?');
      if (!await confirmDialog(prompt, { destructive: true })) return;
      this.deleteWorkItemError = '';
      this.deletingWorkItemIds = { ...this.deletingWorkItemIds, [item.id]: true };
      try {
        const result = await this.store.deleteWorkItem(item.id, item.revision, this.agentId);
        if (result?.cleanupWarning) this.deleteWorkItemError = result.cleanupWarning;
        if (this.selectedId === item.id) {
            this.showItemsPane();
        }
      } catch (error) {
        this.deleteWorkItemError = error?.message || String(error);
      } finally {
        const deleting = { ...this.deletingWorkItemIds };
        delete deleting[item.id];
        this.deletingWorkItemIds = deleting;
      }
    },
    async cancelSelected() {
      if (!this.selected || ['done', 'cancelled'].includes(this.selected.status)) return;
      const prompt = this.tr('workCenter.cancelConfirm', 'Stop this work item and its unfinished Actions?');
      if (!await confirmDialog(prompt, { destructive: true })) return;
      await this.store.cancelWorkItem(this.selected.id, this.agentId);
    },
    async resumeSelected() {
      if (!this.selected || this.selected.status !== 'cancelled') return;
      await this.store.resumeWorkItem(this.selected.id, this.selected.revision, this.agentId, this.selected.executionControl?.revision);
    },
  },
  template: `
    <main class="work-center-main" :aria-label="tr('workCenter.title', 'Work Center')">
        <div class="work-center-shell" :class="{ 'showing-detail': narrowPane !== 'items' }">
          <header class="work-center-header">
            <div class="work-center-heading">
              <div v-if="onlineAgents.length" class="work-center-agent-picker">
                <span class="work-center-agent-dot" aria-hidden="true"></span>
                <ModernSelect
                  :model-value="agentId"
                  :options="workCenterAgentOptions"
                  :aria-label="tr('workCenter.selectAgent', 'Select Agent')"
                  :menu-min-width="160"
                  menu-class="work-center-agent-menu"
                  @update:model-value="selectWorkCenterAgent"
                />
              </div>
            </div>
            <div v-if="narrowPane === 'items' && agentId" class="work-center-toolbar">
              <label class="work-center-search work-center-desktop-search">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.5 3a6.5 6.5 0 1 0 4.02 11.61L19.91 21 21 19.91l-6.39-6.39A6.5 6.5 0 0 0 9.5 3Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z"/></svg>
                <input v-model="search" type="search" :aria-label="tr('workCenter.search', 'Search work items')" :placeholder="tr('workCenter.search', 'Search work items')">
              </label>
              <div class="work-center-filter-menu" @keydown.esc.stop="filtersOpen = false; $refs.filterButton.focus()">
                <button ref="filterButton" class="work-center-icon-button" :class="{ active: filtersOpen || search || boardVpId || boardWorkItemType || boardUpdatedRange !== 'week' }" type="button"
                        :aria-expanded="filtersOpen" aria-controls="work-center-filters" @click="filtersOpen = !filtersOpen"
                        :title="tr('workCenter.searchAndFilters', 'Search and filters')" :aria-label="tr('workCenter.searchAndFilters', 'Search and filters')">
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M4 7h16M7 12h10M10 17h4"/></svg>
                </button>
                <div v-if="filtersOpen" id="work-center-filters" class="work-center-header-popover">
                  <label class="work-center-mobile-search"><span>{{ tr('workCenter.search', 'Search work items') }}</span><input v-model="search" type="search" :aria-label="tr('workCenter.search', 'Search work items')" :placeholder="tr('workCenter.search', 'Search work items')"></label>
                  <label><span>{{ tr('workCenter.filterVp', 'Filter by VP') }}</span><select v-model="boardVpId">
                    <option value="">{{ tr('workCenter.allVps', 'All VPs') }}</option>
                    <option v-for="executor in boardExecutorOptions" :key="executor.id" :value="executor.id">{{ executor.name }}</option>
                  </select></label>
                  <label><span>{{ tr('workCenter.filterType', 'Filter by type') }}</span><select v-model="boardWorkItemType">
                    <option value="">{{ tr('workCenter.allTypes', 'All types') }}</option>
                    <option v-for="type in boardTypeOptions" :key="type" :value="type">{{ type }}</option>
                  </select></label>
                  <label><span>{{ tr('workCenter.filterUpdated', 'Filter by update time') }}</span><select v-model="boardUpdatedRange">
                    <option value="">{{ tr('workCenter.anyTime', 'Any time') }}</option>
                    <option value="day">{{ tr('workCenter.lastDay', 'Last 24 hours') }}</option>
                    <option value="week">{{ tr('workCenter.lastWeek', 'Last 7 days') }}</option>
                    <option value="month">{{ tr('workCenter.lastMonth', 'Last 30 days') }}</option>
                  </select></label>
                  <span v-if="watcher && watcher.enabled" class="work-center-watcher active"><span aria-hidden="true"></span>{{ tr('workCenter.watcherActive', 'Watcher active') }}</span>
                </div>
              </div>
            </div>
            <div class="work-center-header-actions">
              <button v-if="narrowPane !== 'items' && selected" class="work-center-icon-button work-center-workbench-toggle" type="button"
                      :disabled="!workbenchContext.available" :class="{ active: workbenchExpanded }" :aria-pressed="workbenchExpanded"
                      :title="workbenchContext.available ? $t('workbench.title') : $t('workCenter.workbenchUnavailable')"
                      :aria-label="$t('workbench.title')" @click="toggleWorkbench">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" d="M3 4h18v16H3zM14 4v16M3 9h11"/></svg>
              </button>
              <div v-if="agentId" class="work-center-header-menu" @keydown.esc.stop="headerMenuOpen = false; $refs.headerMenuButton.focus()">
                <button ref="headerMenuButton" class="work-center-icon-button" type="button" :aria-expanded="headerMenuOpen" aria-controls="work-center-header-options" @click="headerMenuOpen = !headerMenuOpen"
                        :title="tr('workCenter.moreActions', 'More actions')" :aria-label="tr('workCenter.moreActions', 'More actions')">
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></g></svg>
                </button>
                <div v-if="headerMenuOpen" id="work-center-header-options" class="work-center-header-popover">
                  <button type="button" @click="headerMenuOpen = false; settingsOpen = true">{{ tr('workCenter.settings.title', 'Work Center settings') }}</button>
                  <button type="button" @click="headerMenuOpen = false; refresh()" :disabled="loading">{{ tr('workCenter.refresh', 'Refresh') }}</button>
                  <button class="work-center-menu-create" type="button" @click="headerMenuOpen = false; openCreate()">{{ tr('workCenter.newWorkItem', 'New work item') }}</button>
                </div>
              </div>
              <button v-if="agentId" class="work-center-icon-button work-center-header-create" type="button" @click="openCreate"
                      :title="tr('workCenter.newWorkItem', 'New work item')" :aria-label="tr('workCenter.newWorkItem', 'New work item')">
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z"/></svg>
              </button>
              <button ref="backToChat" class="work-center-icon-button work-center-close-button" type="button" @click="backToChat"
                      :title="tr('workCenter.close', 'Close Work Center')" :aria-label="tr('workCenter.close', 'Close Work Center')">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="m6 6 12 12M18 6 6 18"/></svg>
              </button>
            </div>
          </header>

          <div v-if="onlineAgents.length === 0" class="work-center-notice">
            <p v-if="configurableAgentSettingsLoading">{{ tr('workCenter.checkingAgents', 'Checking Work Center availability…') }}</p>
            <p v-else-if="configurableAgentSettingsFailed">{{ tr('workCenter.agentStatusLoadFailed', 'Could not check Work Center status. Try again.') }}</p>
            <p v-else-if="configurableUnavailableAgents.length">{{ tr('workCenter.unavailableAgents', 'Work Center is configured on, but its runtime is unavailable. Review this Agent’s settings and logs.') }}</p>
            <p v-else-if="configurableDisabledAgents.length">
              {{ configurableDisabledAgents.length === 1
                ? tr('workCenter.disabledAgents', 'Work Center is disabled on the online Agent.')
                : $t('workCenter.disabledAgentsMany', { count: configurableDisabledAgents.length }) }}
            </p>
            <p v-else-if="hasOnlineAgents">{{ tr('workCenter.upgradeAgents', 'The online Agents do not support Work Center settings.') }}</p>
            <p v-else>{{ tr('workCenter.noOnlineAgents', 'No online Agents') }}</p>
            <button v-if="configurableAgentSettingsFailed" type="button" class="btn-secondary work-center-notice-action" @click="loadUnavailableAgentStates">
              {{ tr('workCenter.retryAgentStatus', 'Retry status check') }}
            </button>
            <button v-else-if="hasOnlineAgents && !configurableAgentSettingsLoading" type="button" class="btn-secondary work-center-notice-action" @click="openWorkCenterAgentSettings">
              {{ configurableDisabledAgents.length || configurableUnavailableAgents.length || hasConfigurableOnlineAgents
                ? tr('workCenter.openAgentSettings', 'Open Agent settings')
                : tr('workCenter.openAgentSettingsUpgrade', 'Open Agent settings to upgrade') }}
            </button>
          </div>
          <p v-if="error" class="work-center-error">{{ error }}</p>
          <p v-if="deleteWorkItemError" class="work-center-error" role="alert">{{ deleteWorkItemError }}</p>
          <div v-if="onlineAgents.length" class="work-center-body" :class="{ 'is-empty': loaded && !loading && items.length === 0 }" :data-pane="narrowPane">
            <section class="work-center-list work-center-board" :aria-busy="loading || boardLoadingMore ? 'true' : 'false'">
              <div class="work-center-board-lane-tabs" role="tablist" :aria-label="tr('workCenter.board.lanes', 'Work item lanes')">
                <button v-for="lane in boardLanes" :key="lane.id" type="button" role="tab"
                        :aria-selected="mobileBoardLane === lane.id ? 'true' : 'false'"
                        :class="{ active: mobileBoardLane === lane.id }" @click="mobileBoardLane = lane.id">
                  <span>{{ lane.title }}</span><small>{{ lane.items.length }}</small>
                </button>
              </div>
              <section v-for="lane in boardLanes" :key="lane.id" class="work-center-board-lane"
                       :class="{ 'mobile-active': mobileBoardLane === lane.id }"
                       :data-lane="lane.id" :aria-labelledby="'work-center-lane-' + lane.id">
                <header class="work-center-board-lane-header">
                  <div class="work-center-board-lane-title">
                    <h2 :id="'work-center-lane-' + lane.id">{{ lane.title }}</h2>
                    <span>{{ lane.items.length }}</span>
                  </div>
                </header>
                <div class="work-center-board-cards">
                  <article v-for="item in lane.items" :key="item.id"
                           class="work-center-card" :class="{ active: selectedId === item.id }">
                    <button class="work-center-card-open" type="button"
                            :aria-label="item.title || tr('workCenter.workItem', 'Work item')"
                            @click="selectItem(item)">
                      <span class="work-center-card-head">
                        <span class="work-center-status" :data-status="boardAction(item)?.status || item.status"><span aria-hidden="true"></span>{{ statusLabel(boardAction(item)?.status || item.status) }}</span>
                        <span class="work-center-card-updated">{{ time(item.updatedAt) }}</span>
                      </span>
                      <span class="work-center-card-title">{{ item.title }}</span>
                      <span v-if="boardAction(item)" class="work-center-card-current-action">
                        {{ boardAction(item).objective || actionLabel(boardAction(item).type) }}
                      </span>
                      <span v-else-if="item.goal && item.goal !== item.title" class="work-center-card-goal">{{ item.goal }}</span>
                      <span class="work-center-card-meta">
                        <span>{{ boardExecutorLabel(item) }}</span>
                        <span>{{ boardActionCountLabel(item) }}</span>
                      </span>
                      <span v-if="item.attachmentCount" class="work-center-card-files">{{ item.attachmentCount }} {{ tr('workCenter.files', 'files') }}</span>
                    </button>
                    <button class="work-center-card-delete" type="button" @click.stop="deleteWorkItem(item)"
                            :disabled="!workItemCanDelete(item) || workItemDeleting(item)"
                            :title="workItemCanDelete(item) ? tr('workCenter.deleteWorkItem', 'Delete Work Item') : tr('workCenter.deleteRequiresStop', 'Stop this Work Item before deleting it')"
                            :aria-label="tr('workCenter.deleteWorkItem', 'Delete Work Item')">
                      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12Zm3.46-7.12 1.41-1.41L12 11.59l1.12-1.12 1.41 1.41L13.41 13l1.12 1.12-1.41 1.41L12 14.41l-1.12 1.12-1.41-1.41L10.59 13l-1.13-1.12ZM15.5 4l-1-1h-5l-1 1H5v2h14V4h-3.5Z"/></svg>
                    </button>
                  </article>
                  <p v-if="!loading && items.length > 0 && lane.items.length === 0" class="work-center-board-empty">{{ tr('workCenter.board.emptyLane', 'No work items') }}</p>
                </div>
              </section>
              <div v-if="loading" class="work-center-loading">{{ tr('workCenter.loading', 'Loading work items…') }}</div>
              <button v-if="boardNextCursor && !loading" class="btn-secondary work-center-board-more" type="button"
                      @click="loadMoreBoardItems" :disabled="boardLoadingMore">
                {{ boardLoadingMore ? tr('workCenter.loading', 'Loading work items…') : tr('workCenter.loadMore', 'Load more') }}
              </button>
              <div v-if="loaded && !loading && items.length === 0" class="work-center-empty-state">
                <h2>{{ emptyState.title }}</h2>
                <p>{{ emptyState.body }}</p>
                <button v-if="emptyState.canCreate" class="btn-ghost work-center-empty-create" type="button" @click="openCreate" :disabled="onlineAgents.length === 0">
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z"/></svg>
                  {{ tr('workCenter.createFirst', 'Create first work item') }}
                </button>
              </div>
            </section>

            <section class="work-center-detail">
              <template v-if="selected">
                <div class="work-center-detail-layout" :class="{ 'content-open': contentPanelOpen }"
                     :style="{ '--work-center-actions-pane-width': actionsPaneWidth + 'px' }">
                  <div class="work-center-detail-main work-center-conversation-pane">
                    <header class="work-center-detail-heading work-center-conversation-topbar">
                      <nav class="work-center-detail-breadcrumb" :aria-label="tr('workCenter.navigation', 'Work item navigation')">
                        <button class="work-center-breadcrumb-button" type="button" @click="showItemsPane"
                                :title="tr('workCenter.backToWorkItems', 'Work items')" :aria-label="tr('workCenter.backToWorkItems', 'Work items')">
                          <span>{{ tr('workCenter.backToWorkItems', 'Work items') }}</span>
                        </button>
                        <span class="work-center-breadcrumb-separator" aria-hidden="true">/</span>
                        <div class="work-center-detail-heading-copy" :title="selected.title" aria-current="page">
                          <h2>{{ selected.title }}</h2>
                        </div>
                      </nav>
                      <div class="work-center-detail-actions">
                        <button v-if="selected.status === 'draft'" class="work-center-icon-button" type="button" @click="startSelected"
                                :title="tr('workCenter.start', 'Start')" :aria-label="tr('workCenter.start', 'Start')">
                          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="m8 5 11 7-11 7V5Z"/></svg>
                        </button>
                        <button v-else-if="selected.status === 'cancelled' && !selected.executionControl" class="work-center-icon-button work-center-resume-action" type="button" @click="resumeSelected"
                                :title="tr('workCenter.resumeWorkItem', 'Resume work item')" :aria-label="tr('workCenter.resumeWorkItem', 'Resume work item')">
                          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6a6 6 0 0 1-9.81 4.62l-1.42 1.42A8 8 0 1 0 12 5Z"/></svg>
                        </button>
                        <button v-else-if="!['done', 'cancelled'].includes(selected.status)" class="work-center-icon-button work-center-stop-action" type="button" @click="cancelSelected"
                                :title="tr('workCenter.stopWorkItem', 'Stop work item')" :aria-label="tr('workCenter.stopWorkItem', 'Stop work item')">
                          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>
                        </button>
                        <button
                          ref="actionsButton"
                          class="work-center-icon-button work-center-actions-button"
                          :class="{ active: contentPanelOpen }"
                          type="button"
                          :aria-expanded="contentPanelOpen ? 'true' : 'false'"
                          aria-controls="work-center-content-panel"
                          @click="contentPanelOpen ? closeContentPanel() : openContentPanel()"
                          :title="tr('workCenter.viewActions', 'View Actions')"
                          :aria-label="$t('workCenter.actionCount', { count: selected.actionCount || selected.actions?.length || 0 })"
                        >
                          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M5 5h2v2H5V5Zm4 0h10v2H9V5ZM5 11h2v2H5v-2Zm4 0h10v2H9v-2Zm-4 6h2v2H5v-2Zm4 0h10v2H9v-2Z"/></svg>
                          <span>{{ selected.actionCount || selected.actions?.length || 0 }}</span>
                        </button>
                      </div>
                    </header>

                    <section class="work-center-section work-center-item-messages work-center-conversation" :aria-label="tr('workCenter.conversation', 'Conversation')">
                      <div class="work-center-conversation-scroll">
                        <div class="work-center-conversation-column">
                          <div v-if="detailLoading" class="work-center-detail-notice" aria-live="polite">{{ tr('workCenter.detailLoading', 'Loading full details…') }}</div>
                          <div v-else-if="detailError" class="work-center-detail-notice work-center-detail-error" role="alert">
                            <strong>{{ tr('workCenter.detailLoadFailed', 'Could not load full details') }}</strong>
                            <span>{{ detailError }}</span>
                          </div>

                          <section class="work-center-work-item-overview" :aria-label="tr('workCenter.triageSummary', 'Work item metadata')">
                            <div class="work-center-work-item-kicker">
                              <span class="work-center-status" :data-status="selected.status"><span aria-hidden="true"></span>{{ statusLabel(selected.status) }}</span>
                              <span v-if="selected.workItemType">{{ selected.workItemType }}</span>
                              <span>{{ tr('workCenter.updated', 'Updated') }} {{ time(selected.updatedAt) || '—' }}</span>
                            </div>
                            <h1>{{ selected.title }}</h1>

                            <div v-if="selected.failureReason" class="work-center-section work-center-failure" role="alert">
                              <h3>{{ tr('workCenter.failureReason', 'Failure reason') }}</h3>
                              <p>{{ selected.failureReason }}</p>
                            </div>
                            <div v-if="selected.status === 'waiting' && selected.waitingReason" class="work-center-section work-center-resume">
                              <h3>{{ tr('workCenter.resumeAnswer', 'Answer the waiting question') }}</h3>
                              <p>{{ selected.waitingReason }}</p>
                              <small class="work-center-muted">{{ tr('workCenter.answerWithTarget', 'Choose the relevant target in the Conversation composer, then reply.') }}</small>
                            </div>
                            <WorkCenterResourceControl v-if="selected.executionControl" :key="agentId + '::' + selected.id"
                              :class="{ 'work-center-resources-priority': !!selected.executionControl.stopReason }"
                              :item="selected" :agent-id="agentId" :disabled="detailLoading || !!detailError || detail?.id !== selected.id" />
                            <section v-if="finalResponses.length" class="work-center-section work-center-responses work-center-primary-result">
                              <h3>{{ tr('workCenter.deliveredResponse', 'Delivered response') }}</h3>
                              <div v-for="(response, index) in finalResponses" :key="response.runId || index" class="work-center-response">
                                <p class="work-center-response-summary">{{ response.summary }}</p>
                                <details class="work-center-goal-evidence">
                                  <summary>{{ tr('workCenter.responseEvidence', 'Response source and evidence') }}</summary>
                                  <p v-if="response.runId">{{ tr('workCenter.evidenceRuns', 'Evidence Runs') }}: <code>{{ response.runId }}</code></p>
                                  <ul class="work-center-output-list">
                                    <li v-for="(evidence, evidenceIndex) in response.evidence || []" :key="evidenceIndex">
                                      <span>{{ evidence.label || evidence }}<template v-if="evidence.status"> · {{ goalStatusLabel(evidence.status) }}</template></span>
                                      <a v-if="isExternalOutput(evidence)" :href="evidence.ref" target="_blank" rel="noopener noreferrer">{{ evidence.ref }}</a>
                                      <code v-else-if="evidence.ref">{{ evidence.ref }}</code>
                                    </li>
                                  </ul>
                                </details>
                              </div>
                            </section>
                            <section v-if="selected.outputs?.length" class="work-center-section work-center-outputs work-center-primary-outputs">
                              <h3>{{ tr('workCenter.outputs', 'Outputs') }}</h3>
                              <ul class="work-center-output-list">
                                <li v-for="output in selected.outputs" :key="output.kind + ':' + output.ref">
                                  <strong>{{ output.label }}</strong>
                                  <a v-if="isExternalOutput(output)" :href="output.ref" target="_blank" rel="noopener noreferrer">{{ output.ref }}</a>
                                  <button v-else-if="canOpenOutput(output)" type="button" class="work-center-output-file" @click="openOutput(output)"
                                          :aria-label="$t('workCenter.openOutputFile', { name: output.label || output.ref })"><code>{{ output.ref }}</code></button>
                                  <code v-else>{{ output.ref }}</code>
                                </li>
                              </ul>
                            </section>
                            <section v-if="boardAction(selected) && !finalResponses.length" class="work-center-section work-center-current-progress">
                              <h3>{{ tr('workCenter.currentProgress', 'Current progress') }}</h3>
                              <p>{{ boardAction(selected).objective || boardAction(selected).brief?.objective || actionLabel(boardAction(selected).type) }}</p>
                              <small class="work-center-muted">{{ boardExecutorLabel(selected) }}</small>
                            </section>
                            <section v-if="goalProgress" class="work-center-section work-center-acceptance work-center-goal-progress" :aria-label="tr('workCenter.goalProgress', 'Goal progress')">
                              <h3>{{ tr('workCenter.goalProgress', 'Goal progress') }}</h3>
                              <p class="work-center-goal-count" aria-live="polite">
                                <strong>{{ $t('workCenter.criteriaProgress', { completed: goalProgress.completedCriteriaCount, total: goalProgress.totalCriteriaCount }) }}</strong>
                                <span v-if="goalProgress.totalCriteriaCount > goalProgress.completedCriteriaCount">{{ $t('workCenter.criteriaRemaining', { count: goalProgress.totalCriteriaCount - goalProgress.completedCriteriaCount }) }}</span>
                                <span v-else-if="goalProgress.totalCriteriaCount">{{ tr('workCenter.criteriaVerified', 'All criteria verified') }}</span>
                                <span v-else>{{ tr('workCenter.criteriaPending', 'Acceptance criteria have not been defined yet') }}</span>
                              </p>
                              <ul class="work-center-goal-criteria">
                                <li v-for="(check, index) in goalProgress.criteria" :key="index" :data-status="check.status">
                                  <span class="work-center-goal-status">{{ goalStatusLabel(check.status) }}</span>
                                  <div class="work-center-goal-criterion">
                                    <span>{{ check.criterion }}</span>
                                    <details v-if="check.evidenceRunIds?.length" class="work-center-goal-evidence">
                                      <summary>{{ tr('workCenter.evidenceRuns', 'Evidence Runs') }}</summary>
                                      <ul><li v-for="runId in check.evidenceRunIds" :key="runId"><code>{{ runId }}</code></li></ul>
                                    </details>
                                  </div>
                                </li>
                              </ul>
                              <p v-if="goalProgress.omittedCriteriaCount" class="work-center-muted">{{ $t('workCenter.criteriaOmitted', { count: goalProgress.omittedCriteriaCount }) }}</p>
                              <div v-if="goalProgress.blockers?.length" class="work-center-goal-blockers">
                                <h3>{{ tr('workCenter.goalBlockers', 'Blockers') }}</h3>
                                <ul><li v-for="blocker in goalProgress.blockers" :key="blocker.actionId"><strong>{{ statusLabel(blocker.status) }}</strong> · {{ blocker.reason || blocker.actionId }}</li></ul>
                              </div>
                              <div v-if="goalProgress.delivery" class="work-center-goal-delivery">
                                <h3>{{ tr('workCenter.deliveryTarget', 'Delivery target') }}</h3>
                                <p>{{ deliveryTargetLabel(goalProgress.delivery.target) }} · <span class="work-center-goal-status" :data-status="goalProgress.delivery.status">{{ goalStatusLabel(goalProgress.delivery.status) }}</span></p>
                                <details v-if="goalProgress.delivery.evidenceRunIds?.length" class="work-center-goal-evidence">
                                  <summary>{{ tr('workCenter.evidenceRuns', 'Evidence Runs') }}</summary>
                                  <ul><li v-for="runId in goalProgress.delivery.evidenceRunIds" :key="runId"><code>{{ runId }}</code></li></ul>
                                </details>
                              </div>
                            </section>
                            <details class="work-center-section work-center-progressive-section work-center-requirement-details" :open="!finalResponses.length">
                              <summary>{{ tr('workCenter.requirementAndAcceptance', 'Requirement and acceptance') }}</summary>
                              <section class="work-center-description">
                                <h3>{{ tr('workCenter.description', 'Description') }}</h3>
                                <p>{{ selected.goal }}</p>
                              </section>
                              <section v-if="!goalProgress && selected.acceptanceCriteria?.length" class="work-center-section work-center-acceptance">
                                <h3>{{ tr('workCenter.acceptanceCriteria', 'Acceptance criteria') }}</h3>
                                <ul><li v-for="criterion in selected.acceptanceCriteria" :key="criterion">{{ criterion }}</li></ul>
                              </section>
                            </details>
                            <details class="work-center-section work-center-progressive-section work-center-task-information">
                              <summary>{{ tr('workCenter.taskInformation', 'Task information and usage') }}</summary>
                              <dl class="work-center-detail-meta">
                                <div v-if="selected.workDir" class="work-center-meta-wide"><dt>{{ tr('workCenter.workDir', 'Working directory') }}</dt><dd :title="selected.workDir">{{ selected.workDir }}</dd></div>
                                <div><dt>{{ tr('workCenter.created', 'Created') }}</dt><dd>{{ time(selected.createdAt) || '—' }}</dd></div>
                                <div><dt>{{ tr('workCenter.updated', 'Updated') }}</dt><dd>{{ time(selected.updatedAt) || '—' }}</dd></div>
                                <div v-if="!selected.workItemType && selected.planningMode === 'ai'"><dt>{{ tr('workCenter.workItemType', 'Type') }}</dt><dd>{{ tr('workCenter.planning', 'Planning') }}</dd></div>
                              </dl>
                              <div class="work-center-usage-summary work-center-detail-usage">
                                <span v-if="!selected.executionControl">{{ $t('workCenter.llmRequestCount', { count: formatCount(executionStats(selected).llmRequestCount) }) }}</span>
                                <span>{{ $t('workCenter.loopCount', { count: formatCount(executionStats(selected).loopCount) }) }}</span>
                                <span>{{ $t('workCenter.toolCount', { count: formatCount(executionStats(selected).toolCount) }) }}</span>
                                <span v-if="!selected.executionControl" :title="$t('workCenter.tokenBreakdown', { input: formatCount(executionStats(selected).inputTokens), output: formatCount(executionStats(selected).outputTokens), cache: formatCount((executionStats(selected).cacheReadTokens || 0) + (executionStats(selected).cacheWriteTokens || 0)) })">{{ $t('workCenter.tokenCount', { count: formatTokens(executionStats(selected).totalTokens) }) }}</span>
                              </div>
                            </details>

                            <section v-if="selected.attachments?.length" class="work-center-section work-center-attachments">
                              <h3>{{ tr('workCenter.attachments', 'Attachments') }}</h3>
                              <div class="work-center-attachment-list">
                                <button v-for="attachment in selected.attachments" :key="attachment.id" type="button"
                                        class="work-center-attachment-chip work-center-attachment-preview"
                                        @click="previewAttachment(attachment, $event.currentTarget)" :disabled="previewingAttachmentId === attachment.id"
                                        :aria-label="$t('workCenter.openAttachmentNamed', { name: attachment.name })">
                                  <span>{{ attachment.name }}</span>
                                  <small>{{ previewingAttachmentId === attachment.id ? tr('workCenter.openingAttachment', 'Opening attachment…') : formatAttachmentSize(attachment.size) }}</small>
                                </button>
                              </div>
                              <p v-if="attachmentPreviewError" class="work-center-error" role="alert">{{ attachmentPreviewError }}</p>
                            </section>
                          </section>

                          <span v-if="coordinatorThinking" class="work-center-conversation-status" aria-live="polite">
                            <span aria-hidden="true"></span>{{ tr('workCenter.conversationThinking', 'Working…') }}
                          </span>
                          <div v-if="conversationBlocks.length" class="work-center-item-message-list" role="log" aria-live="polite">
                            <template v-for="block in conversationBlocks" :key="block.key">
                              <UserTurnBlock
                                v-if="block.kind === 'user'"
                                class="work-center-action-message role-user"
                                :message="block.message"
                                :external-attachment-open="true"
                                @quote="quoteWorkItemMessage"
                                @edit-as-new="editWorkItemMessageAsNew"
                                @open-attachment="openConversationAttachment"
                              />
                              <VpTurnBlock
                                v-else-if="block.kind === 'assistant'"
                                class="work-center-action-message role-assistant"
                                :turn="block.turn"
                                :display-name-override="block.speakerName"
                                :can-stop="false"
                                :interactive-speaker="false"
                                @quote="quoteWorkItemMessage"
                              >
                                <div v-if="block.turn.attachments?.length" class="work-center-attachment-list work-center-message-attachments">
                                  <button v-for="attachment in block.turn.attachments" :key="attachment.id" type="button"
                                          class="work-center-attachment-chip work-center-attachment-preview"
                                          @click="previewAttachment(attachment, $event.currentTarget)" :disabled="previewingAttachmentId === attachment.id"
                                          :aria-label="$t('workCenter.openAttachmentNamed', { name: attachment.name })">
                                    <span>{{ attachment.name }}</span><small>{{ formatAttachmentSize(attachment.size) }}</small>
                                  </button>
                                </div>
                              </VpTurnBlock>
                              <article v-else class="work-center-original-request">
                                <header><strong>{{ workItemMessageSpeaker(block.message) }}</strong><small>{{ time(block.message.updatedAt || block.message.createdAt) }}</small></header>
                                <p>{{ block.message.text }}</p>
                              </article>
                            </template>
                          </div>
                          <p v-if="workItemMessageError" class="work-center-error" role="alert">{{ workItemMessageError }}</p>
                        </div>
                      </div>

                      <div class="work-center-conversation-composer">
                        <div class="work-center-composer-column">
                          <div v-if="pendingMessageEnvelope" class="work-center-stale-target" role="status">
                            <span>{{ tr('workCenter.pendingEnvelopeLocked', 'An unconfirmed request is locked to its original identity.') }}</span>
                            <label v-if="pendingEnvelopeHasAttachments" class="btn-secondary">
                              {{ tr('workCenter.replacePendingAttachments', 'Replace attachments') }}
                              <input type="file" multiple class="sr-only" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.json,.js,.ts,.css,.html,.py,.yaml,.yml,.xml,.csv" @change="onWorkItemMessageAttachmentInput">
                            </label>
                            <button type="button" class="btn-ghost" @click="discardPendingMessageEnvelope">{{ tr('workCenter.discardPendingEnvelope', 'Discard pending request') }}</button>
                          </div>
                          <p v-if="coordinatorReadOnly" class="work-center-conversation-readonly">{{ tr('workCenter.conversationReadOnly', 'This work item is closed. The conversation remains available.') }}</p>
                          <template v-else>
                            <p v-if="composerTargetIsStale" class="work-center-error work-center-stale-target" role="alert">
                              {{ tr('workCenter.targetUnavailableHelp', 'Choose another target before sending. This draft was not redirected.') }}
                              <button type="button" class="btn-ghost" @click="chooseCoordinatorTarget">{{ tr('workCenter.sendToCoordinatorInstead', 'Send to Coordinator instead') }}</button>
                            </p>
                            <div v-if="workItemMessageQuote" class="input-quote-preview work-center-message-quote">
                              <div class="input-quote-main">
                                <div class="input-quote-meta">{{ $t('message.replyingTo', { author: workItemMessageQuote.author }) }}</div>
                                <div v-if="workItemMessageQuote.content" class="input-quote-content">{{ workItemMessageQuote.content }}</div>
                                <div v-if="workItemMessageQuote.todos?.length" class="input-quote-todos">
                                  <div v-for="todo in workItemMessageQuote.todos" :key="todo.content" class="input-quote-todo">
                                    <span class="input-quote-todo-status">{{ todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '→' : '○' }}</span>
                                    <span>{{ todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content }}</span>
                                  </div>
                                </div>
                              </div>
                              <button type="button" class="input-quote-remove" @click="removeWorkItemMessageQuote" :title="$t('message.removeQuote')" :aria-label="$t('message.removeQuote')">×</button>
                            </div>
                            <div v-if="workItemMessageAttachments.length" class="work-center-attachment-list work-center-message-draft-attachments">
                              <span v-for="(attachment, index) in workItemMessageAttachments" :key="attachment.fileId" class="work-center-attachment-chip">
                                <span>{{ attachment.name }}</span><small>{{ formatAttachmentSize(attachment.size) }}</small>
                                <button type="button" @click="removeWorkItemMessageAttachment(index)" :disabled="composerDraftLocked" :aria-label="tr('workCenter.removeAttachment', 'Remove from draft')">×</button>
                              </span>
                            </div>
                            <MessageComposer
                              ref="workItemComposer"
                              v-model="workItemMessage"
                              class="work-center-item-message-input"
                              :placeholder="composerPlaceholder"
                              :disabled="composerTargetUnavailable || composerDraftLocked"
                              :can-send="composerCanSend"
                              :sending="workItemMessageSending"
                              :send-label="$t('workCenter.sendToTarget', { target: composerTargetLabel })"
                              @input="onWorkItemMessageInput"
                              @keydown="onWorkItemMessageKeydown"
                              @send="sendSelectedWorkItemMessage"
                            >
                              <template #start-actions>
                                <label v-if="workItemAttachmentsSupported" class="attach-btn work-center-attachment-picker" :title="tr('workCenter.addAttachments', 'Add files')">
                                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
                                  <input type="file" multiple :disabled="composerDraftLocked" :aria-label="tr('workCenter.addAttachments', 'Add files')" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.json,.js,.ts,.css,.html,.py,.yaml,.yml,.xml,.csv" @change="onWorkItemMessageAttachmentInput">
                                </label>
                                <ModernSelect
                                  class="work-center-composer-target"
                                  data-testid="work-center-composer-target"
                                  :data-value="composerTargetValue"
                                  :model-value="composerTargetValue"
                                  :options="composerTargetOptions"
                                  :aria-label="tr('workCenter.composerTarget', 'Message target')"
                                  :disabled="composerDraftLocked"
                                  :menu-min-width="300"
                                  menu-class="work-center-composer-target-menu yeaft-model-dropdown"
                                  @update:model-value="composerTargetValue = $event"
                                  @change="onComposerTargetChange"
                                />
                              </template>
                            </MessageComposer>
                            <small v-if="workItemMessageAttachmentsUploading" class="work-center-message-uploading">{{ tr('workCenter.attachmentsUploading', 'Uploading…') }}</small>
                          </template>
                        </div>
                      </div>
                    </section>
                  </div>

                  <PaneResizeHandle v-if="contentPanelOpen" v-model="actionsPaneWidth"
                                    :label="tr('workCenter.resizeActions', 'Resize Actions panel')"
                                    controls="work-center-content-panel" />
                  <aside v-if="contentPanelOpen" id="work-center-content-panel" class="work-center-workflow work-center-content-pane" :aria-label="tr('workCenter.actionsPanel', 'Actions')">
                    <template v-if="contentIsActionList">
                      <header class="work-center-content-header">
                        <div class="work-center-content-title">
                          <strong>{{ tr('workCenter.actionsPanel', 'Actions') }}</strong>
                          <span>{{ selected.actionCount || selected.actions?.length || 0 }}</span>
                        </div>
                        <button class="work-center-icon-button work-center-content-close" type="button" @click="closeContentPanel"
                                :title="tr('workCenter.closeActions', 'Close Actions')" :aria-label="tr('workCenter.closeActions', 'Close Actions')">
                          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4l-6.3 6.31-1.42-1.42L9.17 12l-6.3-6.29 1.42-1.42 6.3 6.31 6.3-6.31 1.41 1.42Z"/></svg>
                        </button>
                      </header>
                      <div class="work-center-content-scroll">
                        <div v-if="selected.mainline?.progress" class="work-center-mainline-progress" :data-attention="selected.mainline.progress.attentionState">
                          <strong>{{ statusLabel(selected.mainline.progress.lifecycle) }}</strong>
                          <span>{{ selected.mainline.progress.counts.completed }} {{ tr('workCenter.status.completed', 'Completed') }}</span>
                          <span v-if="selected.mainline.progress.counts.closed">{{ selected.mainline.progress.counts.closed }} {{ tr('workCenter.status.closed', 'Closed') }}</span>
                          <span v-if="selected.mainline.progress.counts.running">{{ selected.mainline.progress.counts.running }} {{ tr('workCenter.status.running', 'Running') }}</span>
                          <span v-if="selected.mainline.progress.counts.waiting">{{ selected.mainline.progress.counts.waiting }} {{ tr('workCenter.status.waiting', 'Waiting') }}</span>
                          <span v-if="selected.mainline.progress.counts.failed">{{ selected.mainline.progress.counts.failed }} {{ tr('workCenter.status.failed', 'Failed') }}</span>
                        </div>
                        <div class="work-center-action-list">
                          <article v-for="action in orderedActions" :key="action.id" class="work-center-action-card" :data-status="action.status" :class="{ active: selectedActionId === action.id }">
                            <button class="work-center-action-summary" type="button" @click="selectAction(action)" :aria-current="selectedActionId === action.id ? 'true' : undefined">
                              <span class="work-center-action-index">{{ actionSequence(action) }}</span>
                              <span class="work-center-action-content">
                                <span class="work-center-action-primary">
                                  <strong>{{ action.brief?.objective || actionLabel(action.type) }}</strong>
                                  <span class="work-center-status" :data-status="action.status"><span aria-hidden="true"></span>{{ statusLabel(action.status) }}</span>
                                </span>
                                <span class="work-center-action-description" :title="action.canonicalResult?.summary || action.brief?.approach || actionContentSummary(action)">
                                  {{ action.canonicalResult?.summary || action.brief?.approach || actionContentSummary(action) || tr('workCenter.noActionSummary', 'No summary yet') }}
                                </span>
                                <small class="work-center-action-vp">{{ actionExecutor(action) }}</small>
                              </span>
                              <span class="work-center-action-chevron" aria-hidden="true"></span>
                            </button>
                          </article>
                        </div>
                        <p v-if="!selected.actions?.length" class="work-center-action-empty">{{ tr('workCenter.noActions', 'No Actions yet.') }}</p>
                      </div>
                    </template>
                    <WorkCenterActionDetail
                      v-else
                      :action="selectedAction"
                      :can-message="canMessageAction(selectedAction)"
                      :messages="actionMessages"
                      :messages-next-cursor="actionMessagesNextCursor"
                      :messages-loading="actionMessagesLoading"
                      :messages-error="actionMessagesError"
                      :previewing-attachment-id="previewingAttachmentId"
                      :attachment-error="attachmentPreviewError"
                      @back="showActionsPane"
                      @close="closeContentPanel"
                      @load-earlier-messages="loadEarlierActionMessages"
                      @quote="quoteWorkItemMessage"
                      @edit-as-new="editWorkItemMessageAsNew"
                      @open-attachment="previewAttachment"
                    />
                  </aside>
                </div>
              </template>
              <div v-else class="work-center-detail-empty"><strong>{{ tr('workCenter.selectTitle', 'Work item details') }}</strong></div>
            </section>

          </div>
        </div>
        <WorkbenchPanel v-if="workbenchContext.available" ref="workbench" :key="workbenchContext.workspaceGeneration"
                        :owner-route="workbenchContext.ownerRoute" :owner-work-dir="workbenchContext.ownerWorkDir"
                        @expanded-change="workbenchExpanded = $event" />
    </main>

      <WorkCenterSettingsModal v-if="settingsOpen" :key="agentId" :agent-id="agentId" @close="settingsOpen = false" @saved="refresh" @open-agent-models="settingsOpen = false; llmConfigOpen = true" />
      <AgentSettingsPanel v-if="llmConfigOpen" :initial-agent-id="agentId" initial-category="llm" @close="llmConfigOpen = false" @saved="refreshWorkCenterRuntime" />
      <AgentSettingsPanel v-if="agentSettingsOpen" :initial-agent-id="agentSettingsTargetId" initial-category="operations" initial-section="work-center" @close="closeWorkCenterAgentSettings()" @saved="closeWorkCenterAgentSettings({ focusBack: true })" />

      <div v-if="createOpen" class="modal-overlay work-center-modal-overlay" @click.self="closeCreate">
        <form class="modal work-center-modal" role="dialog" aria-modal="true" aria-labelledby="work-center-create-title" @submit.prevent="submitCreate">
          <header class="work-center-modal-header">
            <div>
              <h2 id="work-center-create-title">{{ tr('workCenter.newWorkItem', 'New work item') }}</h2>
              <p>{{ tr('workCenter.createHint', 'Describe what you need. The Coordinator will keep creating the next justified Actions until the acceptance criteria are verified.') }}</p>
            </div>
            <button class="modal-close" type="button" @click="closeCreate" :disabled="saving" :aria-label="tr('common.close', 'Close')">×</button>
          </header>
          <div class="work-center-modal-body">
            <section class="work-center-form-section work-center-requirement-section">
              <label>{{ tr('workCenter.requirement', 'Requirement') }}
                <textarea v-model="form.requirement" rows="8" required autofocus :placeholder="tr('workCenter.requirementHint', 'Describe the problem, desired outcome, and any constraints in your own words')"></textarea>
                <small class="work-center-field-help">{{ tr('workCenter.requirementHelp', 'The Coordinator will refine the goal and acceptance criteria, then create Actions dynamically as evidence arrives.') }}</small>
              </label>
            </section>
            <section class="work-center-form-section work-center-create-attachments">
              <div class="work-center-form-section-heading">
                <h3>{{ tr('workCenter.attachments', 'Attachments') }}</h3>
                <p>{{ tr('workCenter.attachmentsHelp', 'Screenshots and files stay bound to this Work Item and are available to every Action.') }}</p>
              </div>
              <label v-if="workItemAttachmentsSupported" class="btn-secondary work-center-attachment-picker">
                <input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,text/*,application/pdf,application/json,application/xml,.pdf,.json,.md,.py,.js,.ts,.css,.html,.xml,.yaml,.yml,.csv" @change="onCreateAttachmentInput">
                {{ attachmentsUploading ? tr('workCenter.attachmentsUploading', 'Uploading…') : tr('workCenter.addAttachments', 'Add files') }}
              </label>
              <p v-else class="work-center-muted">{{ tr('workCenter.attachmentsUnsupported', 'The selected Agent does not support Work Item attachments.') }}</p>
              <div v-if="workItemAttachmentsSupported && createAttachments.length" class="work-center-attachment-list">
                <span v-for="(attachment, index) in createAttachments" :key="attachment.fileId" class="work-center-attachment-chip">
                  <span>{{ attachment.name }}</span>
                  <small>{{ formatAttachmentSize(attachment.size) }}</small>
                  <button type="button" @click="removeCreateAttachment(index)" :aria-label="tr('workCenter.removeAttachment', 'Remove from draft')">×</button>
                </span>
              </div>
            </section>
            <section class="work-center-form-section work-center-execution-section">
              <div class="work-center-form-section-heading">
                <h3>{{ tr('workCenter.execution', 'Execution') }}</h3>
                <p>{{ tr('workCenter.executionHint', 'Choose where and how this work item starts.') }}</p>
              </div>
              <label>{{ tr('workCenter.workDir', 'Working directory') }}
                <div class="work-center-workdir-picker">
                  <input v-model="form.workDir" type="text" required @input="onCreateWorkDirInput" :placeholder="tr('workCenter.workDirHint', 'Choose an existing project directory')">
                  <button class="btn-secondary" type="button" @click="openFolderPicker" :disabled="!folderPickerAgentId">
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2Z"/></svg>
                    {{ tr('workCenter.chooseFolder', 'Choose folder') }}
                  </button>
                </div>
                <small class="work-center-field-help">{{ tr('workCenter.workDirPickerHelp', 'Select an existing folder on the chosen Agent.') }}</small>
              </label>
              <div class="work-center-create-options">
                <label><span>{{ tr('workCenter.deliveryTarget', 'Delivery target') }}</span><select v-model="form.deliveryTarget"><option value="">{{ tr('workCenter.deliveryTargetAsk', 'Ask me before delivery') }}</option><option value="response">{{ tr('workCenter.deliveryTargetResponse', 'Response') }}</option><option value="workspace_files">{{ tr('workCenter.deliveryTargetFiles', 'Workspace files') }}</option><option value="pull_request">{{ tr('workCenter.deliveryTargetPr', 'Open a pull request') }}</option><option value="merge">{{ tr('workCenter.deliveryTargetMerge', 'Merge an approved pull request') }}</option></select><small class="work-center-field-help">{{ tr('workCenter.deliveryTargetHelp', 'This is the completion boundary, not permission to bypass review or merge policy.') }}</small></label>
                <label class="work-center-checkbox"><input v-model="form.reuseMemory" type="checkbox"><span><strong>{{ tr('workCenter.reuseMemory', 'Use relevant Agent memory and completed work from this project') }}</strong><small>{{ tr('workCenter.reuseMemoryHelp', 'Uses scope-bounded Agent memory and structured results from completed WorkItems in the same project.') }}</small></span></label>
                <label class="work-center-checkbox"><input v-model="form.start" type="checkbox" @change="onCreateStartInput"><span><strong>{{ tr('workCenter.startImmediately', 'Start immediately') }}</strong><small>{{ tr('workCenter.startImmediatelyHint', 'Turn this off to create a draft you can review first.') }}</small></span></label>
              </div>
            </section>
            <section class="work-center-plan-preview">
              <div class="work-center-plan-preview-heading">
                <div><strong>{{ tr('workCenter.aiPlan', 'Coordinator-driven execution') }}</strong><small>{{ tr('workCenter.aiPlanHelp', 'The Coordinator chooses the next Actions and executors from current evidence instead of precomputing a workflow graph. Work Center settings control the model and effort.') }}</small></div>
                <button type="button" class="btn-secondary" @click="settingsOpen = true">{{ tr('workCenter.settings.title', 'Settings') }}</button>
              </div>
            </section>
          </div>
          <footer class="work-center-modal-footer">
            <button class="btn-secondary" type="button" @click="closeCreate">{{ tr('common.cancel', 'Cancel') }}</button>
            <button class="btn-primary" type="submit" :disabled="saving || attachmentsUploading || !form.requirement.trim() || !form.workDir.trim()">
              {{ saving ? tr('workCenter.creating', 'Creating…') : tr('workCenter.create', 'Create') }}
            </button>
          </footer>

          <div class="work-center-directory-overlay" v-if="folderPickerOpen" @click.self="closeFolderPicker">
            <div class="work-center-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="work-center-directory-title">
              <header class="work-center-directory-header">
                <div>
                  <h3 id="work-center-directory-title">{{ tr('modal.folderPicker.title', 'Select work directory') }}</h3>
                  <p>{{ tr('workCenter.folderPickerHint', 'Choose the project folder this Work Item can read and modify.') }}</p>
                </div>
                <button class="modal-close" type="button" @click="closeFolderPicker" :aria-label="tr('common.close', 'Close')">×</button>
              </header>
              <div class="work-center-directory-path">
                <button class="btn-ghost work-center-directory-up" type="button" @click="folderPickerNavigateUp" :disabled="!folderPickerPath" :aria-label="tr('modal.folderPicker.parentDir', 'Parent directory')">
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2Z"/></svg>
                </button>
                <span class="work-center-directory-current" :title="folderPickerPath">{{ folderPickerPath || tr('common.rootDir', 'Root') }}</span>
              </div>
              <div class="work-center-directory-list" role="listbox" :aria-busy="folderPickerLoading">
                <div class="work-center-directory-state" v-if="folderPickerLoading"><span class="spinner-mini"></span><span>{{ tr('common.loading', 'Loading') }}</span></div>
                <template v-else>
                  <button
                    v-for="entry in folderPickerEntries"
                    :key="entry.name"
                    class="work-center-directory-item"
                    :class="{ selected: folderPickerSelected === entry.name }"
                    type="button"
                    role="option"
                    :aria-selected="folderPickerSelected === entry.name"
                    @click="folderPickerSelectItem(entry)"
                    @dblclick="folderPickerEnter(entry)"
                  >
                    <span class="work-center-directory-icon"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2Z"/></svg></span>
                    <span>{{ entry.name }}</span>
                  </button>
                  <div class="work-center-directory-state" v-if="folderPickerEntries.length === 0">{{ tr('common.noSubdirectories', 'No subdirectories') }}</div>
                </template>
              </div>
              <footer class="work-center-directory-footer">
                <span>{{ tr('workCenter.folderPickerSelectionHint', 'Double-click to open a folder, or select it and confirm.') }}</span>
                <div>
                  <button class="btn-secondary" type="button" @click="closeFolderPicker">{{ tr('common.cancel', 'Cancel') }}</button>
                  <button class="btn-primary" type="button" @click="confirmFolderPicker" :disabled="!folderPickerPath">{{ tr('common.confirm', 'Confirm') }}</button>
                </div>
              </footer>
            </div>
          </div>
        </form>
      </div>
  `,
};
