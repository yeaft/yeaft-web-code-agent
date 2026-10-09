import UserTurnBlock from './UserTurnBlock.js';
import MessageComposer from './MessageComposer.js';
import NavigationIcon from './NavigationIcon.js';
import PersonKnowledgeBrowser from './PersonKnowledgeBrowser.js';
import PersonTaskBrowser from './PersonTaskBrowser.js';
import PersonTurnUsage from './PersonTurnUsage.js';
import ModernSelect from './ModernSelect.js';
import PersonSettingsModal from './PersonSettingsModal.js';
import { useComposerAttachments } from '../utils/composer-attachments.js';
import { PERSON_FILE_ACCEPT, validatePersonFiles, uploadPersonFiles } from '../stores/helpers/person-attachments.js';
import PersonThoughtJournal from './PersonThoughtJournal.js';
import PersonDebugLog from './PersonDebugLog.js';
import PersonActivity from './PersonActivity.js';
import { projectPersonActivity, projectPersonFeedback } from '../utils/person-activity.js';
import { useAuthStore } from '../stores/auth.js';
import { renderSafeMessageMarkdown } from '../utils/safe-message-markdown.js';
import { createPersonController, digitalPersonGate, personState } from '../stores/helpers/digital-person.js';

export default {
  name: 'DigitalPersonPage',
  components: { UserTurnBlock, MessageComposer, NavigationIcon, PersonKnowledgeBrowser, PersonTaskBrowser, PersonTurnUsage, ModernSelect, PersonSettingsModal, PersonThoughtJournal, PersonDebugLog, PersonActivity },
  setup() {
    const chat = Pinia.useChatStore();
    const auth = useAuthStore();
    const state = Vue.reactive(personState());
    const enabled = agent => chat.digitalPersonUiEnabledByAgent?.[agent.id] === true;
    const agentId = Vue.ref(chat.agents.find(a => enabled(a) && a.id === chat.digitalPersonAgentId)?.id
      || chat.agents.find(a => enabled(a) && a.id === chat.currentAgent)?.id
      || chat.agents.find(enabled)?.id || '');
    Vue.watch(agentId, value => { chat.digitalPersonAgentId = value; }, { immediate: true });
    const draft = Vue.ref('');
    const settingsOpen = Vue.ref(false);
    let draftGeneration = 0;
    let pendingDraft = null;

    const panel = Vue.ref(null);
    const compactPanel = Vue.ref(window.innerWidth <= 900);
    const sidePanel = Vue.ref(null);
    const thoughtButton = Vue.ref(null);
    const searchButton = Vue.ref(null);
    const searchInput = Vue.ref(null);
    const searchQuery = Vue.ref('');
    let panelOpener = null;
    const closePanelButton = Vue.ref(null);
    const t = Vue.inject('t');
    const agentOptions = Vue.computed(() => chat.agents.filter(enabled).map(agent => ({
      value: agent.id, label: agent.name || agent.id,
      badge: agent.online ? undefined : t('person.offlineShort'),
    })));
    const messagePane = Vue.ref(null);
    const readingColumn = Vue.ref(null);
    const responseStart = Vue.ref(null);
    const responseTail = Vue.ref(null);
    const focusedResponseId = Vue.ref('');
    const hasResponseFocus = Vue.ref(false);
    const responsePinned = Vue.ref(false);
    let responseFocus = null;
    let responseFocusGeneration = 0;
    let responseLayoutObserver = null;
    let responseLayoutFrame = null;
    let disposed = false;
    const returnButton = Vue.ref(null);
    const gate = Vue.computed(() => digitalPersonGate(chat, agentId.value));
    const scope = () => JSON.stringify([auth.userId, auth.authGeneration, auth.isAuthenticated]);
    const attachmentScope = () => JSON.stringify([scope(), agentId.value]);
    const attachmentQueue = useComposerAttachments({
      scope: attachmentScope,
      enabled: () => canCompose.value,
      validate: validatePersonFiles,
      upload: (rows, signal) => uploadPersonFiles(rows.map(row => row.file), auth, signal),
    });
    const { attachments, error: attachmentError, filesReady, addFiles, retryAttachment, removeAttachment } = attachmentQueue;
    const controller = createPersonController({ chat, state, scope, reupload: attachmentQueue.uploadFiles });
    Vue.watch(attachmentScope, () => {
      resetResponseFocus();
      draftGeneration++;
      pendingDraft = null;
      draft.value = '';
      settingsOpen.value = false;
      searchQuery.value = '';
      closePanel();
    }, { flush: 'sync' });
    Vue.watch(() => JSON.stringify([scope(), agentId.value, gate.value, chat.chatHistoryConnectionGeneration]), () => {
      controller.open(agentId.value);
    // Batch auth_result mutations: authenticated is set before the new socket's
    // encryption key / plaintext negotiation. Opening synchronously sends with
    // the previous connection's key during reconnect.
    }, { immediate: true });
    Vue.watch(() => chat.agents.map(agent => agent.id).join(','), () => {
      if (!agentId.value) agentId.value = chat.agents.find(enabled)?.id || '';
    });
    const resize = () => { compactPanel.value = window.innerWidth <= 900; };
    Vue.onMounted(() => {
      returnButton.value?.focus();
      window.addEventListener('resize', resize);
      document.addEventListener('keydown', panelKeydown);
      document.addEventListener('focusin', keepPanelFocus);
    });
    Vue.onBeforeUnmount(() => {
      draftGeneration++; controller.dispose();
      window.removeEventListener('resize', resize);
      document.removeEventListener('keydown', panelKeydown);
      document.removeEventListener('focusin', keepPanelFocus);
    });
    Vue.onUpdated(keepPanelFocus);
    const ready = Vue.computed(() => !gate.value && state.configured && state.modelReady !== false && !!state.person && !state.loading);
    const activity = Vue.computed(() => projectPersonActivity(state, gate.value));
    const feedback = Vue.computed(() => projectPersonFeedback(state, gate.value));
    const responding = Vue.computed(() => !gate.value && (state.busy || state.commandPending));
    const canCompose = Vue.computed(() => ready.value && !state.busy && !state.commandPending && !state.settingsPending && !state.retryCommand);
    const fileError = Vue.computed(() => attachmentError.value || (attachments.value.some(row => row.uploadError) ? 'person.filesFailed' : ''));
    const canSend = Vue.computed(() => canCompose.value && filesReady.value && (!!draft.value.trim() || !!attachments.value.length));
    async function saveSettings(candidates) {
      if (await controller.settings(candidates)) settingsOpen.value = false;
    }

    async function command(op, retry = false) {
      if (!retry && (op === 'send' ? !canSend.value : !canCompose.value || (op === 'think' && !filesReady.value))) return;
      const g = draftGeneration;
      if (!retry) pendingDraft = { text: draft.value, rows: attachments.value.slice() };
      const submitted = pendingDraft;
      // Focus only a locally submitted conversation turn, never a historical
      // snapshot, reconnect, or autonomous think/dream episode.
      const focusGeneration = op === 'send' ? (retry && responseFocus ? responseFocusGeneration : beginResponseFocus()) : null;
      const accepted = await controller.command(op, draft.value, retry, op === 'dream' ? [] : attachments.value.slice());
      if (g !== draftGeneration) return;
      if (focusGeneration === responseFocusGeneration && responseFocus) {
        if (accepted) {
          responseFocus.episodeId = state.commandEpisodeId || '';
          scheduleResponseLayout();
        } else if (!state.retryCommand) resetResponseFocus();
      }
      if (!accepted) return;
      if (op !== 'dream' && submitted) {
        if (draft.value === submitted.text) draft.value = '';
        // Person messages only retain server references, not local blob URLs.
        attachmentQueue.release(submitted.rows, { transferPreviews: false });
      }
      pendingDraft = null;
    }
    function discardRetry() {
      controller.discardRetry();
      pendingDraft = null;
      resetResponseFocus();
    }
    // A reconnect replaces cached pages. Refill the visible section after the
    // identity is ready, including when the drawer was opened during loading.
    Vue.watch([panel, () => state.loading, gate], () => {
      const section = panel.value;
      controller.showTasks(section === 'tasks' && !gate.value && !state.loading && !!state.person);
      controller.showTurns(section === 'turns' && !gate.value && !state.loading && !!state.person);
      if (['memory', 'skills'].includes(section) && !gate.value && !state.loading && state.person
        && !state[section].loaded && !state[section].loading) controller.inspect(section);
    }, { flush: 'post' });
    async function openPanel(next = 'thoughts') {
      if (!panel.value || next === 'search' || panel.value === 'search') panelOpener = next === 'search' ? searchButton.value : thoughtButton.value;
      panel.value = next;
      await Vue.nextTick();
      (next === 'search' ? searchInput.value : closePanelButton.value)?.focus();
    }
    function closePanel() {
      const restoreFocus = compactPanel.value || sidePanel.value?.contains(document.activeElement);
      panel.value = null;
      if (restoreFocus) Vue.nextTick(() => panelOpener?.focus());
    }
    function togglePanel() {
      if (panel.value && panel.value !== 'search') closePanel();
      else openPanel();
    }
    // Async refresh/reconnect can remove or disable the focused control. The
    // compact drawer owns focus, but must yield to the settings dialog above it.
    function keepPanelFocus() {
      if (!panel.value || !compactPanel.value || settingsOpen.value || !sidePanel.value) return;
      const active = document.activeElement;
      if (!sidePanel.value.contains(active) || active?.disabled) closePanelButton.value?.focus();
    }
    function panelKeydown(event) {
      if (!panel.value || settingsOpen.value || !sidePanel.value) return;
      if (!compactPanel.value && !sidePanel.value.contains(document.activeElement)) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closePanel();
      }
      if (event.key !== 'Tab' || !compactPanel.value) return;
      const controls = [...sidePanel.value.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')].filter(el => {
        for (let parent = el.parentElement; parent && parent !== sidePanel.value; parent = parent.parentElement) {
          if (parent.matches('details:not([open])') && parent.querySelector('summary') !== el) return false;
        }
        return true;
      });
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    Vue.watch(() => state.loading, loading => {
      if (!loading && ['memory', 'skills'].includes(panel.value) && !state[panel.value].loaded) controller.inspect(panel.value);
      if (!loading && panel.value === 'search' && searchQuery.value.trim()) controller.search(searchQuery.value);
    });
    Vue.watch(compactPanel, async compact => {
      if (compact && panel.value) { await Vue.nextTick(); closePanelButton.value?.focus(); }
    });
    function resetResponseFocus() {
      responseFocusGeneration++;
      responseFocus = null;
      focusedResponseId.value = '';
      hasResponseFocus.value = false;
      responsePinned.value = false;
      if (responseLayoutFrame !== null) cancelAnimationFrame(responseLayoutFrame);
      responseLayoutFrame = null;
      if (responseTail.value) responseTail.value.style.height = '0px';
    }
    function beginResponseFocus() {
      resetResponseFocus();
      responseFocus = {
        scope: attachmentScope(), episodeId: '',
        previousIds: new Set(state.messages.map(message => message.id)),
        locked: true,
      };
      hasResponseFocus.value = true;
      responsePinned.value = true;
      scheduleResponseLayout();
      return responseFocusGeneration;
    }
    function releaseResponseFocus(event) {
      if (event?.type === 'keydown') {
        if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
          || event.target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      }
      if (event?.type === 'pointerdown') {
        const pane = messagePane.value;
        const bounds = pane?.getBoundingClientRect();
        // Only a scrollbar drag is scroll intent; selecting reply text is not.
        if (!bounds || pane.offsetWidth <= pane.clientWidth
          || (event.clientX < bounds.right - (pane.offsetWidth - pane.clientWidth)
            && event.clientX > bounds.left + (pane.offsetWidth - pane.clientWidth))) return;
      }
      if (responseFocus) responseFocus.locked = false;
      responsePinned.value = false;
    }
    function reconcileResponseLayout() {
      const focus = responseFocus;
      const pane = messagePane.value;
      const tail = responseTail.value;
      if (disposed || !focus || focus.scope !== attachmentScope() || !pane || !tail) return;
      if (!focusedResponseId.value && focus.episodeId) {
        const firstReply = state.messages.find(message => message.role === 'assistant'
          && !focus.previousIds.has(message.id)
          && (!message.episodeId || message.episodeId === focus.episodeId));
        if (firstReply) focusedResponseId.value = firstReply.id;
      }
      if (!focus.locked) return;
      const target = focusedResponseId.value
        ? [...pane.querySelectorAll('.person-message')].find(element => element.dataset.messageId === focusedResponseId.value)
        : responseStart.value;
      if (!target) return;
      // Leave only the space needed to put a short response at the top. It is
      // independent of loading state, so completion cannot clamp it upwards.
      const afterTarget = tail.getBoundingClientRect().top - target.getBoundingClientRect().top;
      const bottomPadding = parseFloat(getComputedStyle(pane).paddingBottom) || 0;
      const needed = Math.max(0, pane.clientHeight - afterTarget - bottomPadding);
      if (Math.abs((parseFloat(tail.style.height) || 0) - needed) > 1) tail.style.height = `${needed}px`;
      const delta = target.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientTop;
      if (Math.abs(delta) > 1) pane.scrollTop += delta;
    }
    function scheduleResponseLayout() {
      const generation = responseFocusGeneration;
      Vue.nextTick(() => {
        if (disposed || generation !== responseFocusGeneration || responseLayoutFrame !== null) return;
        responseLayoutFrame = requestAnimationFrame(() => {
          responseLayoutFrame = null;
          if (!disposed && generation === responseFocusGeneration) reconcileResponseLayout();
        });
      });
    }
    Vue.watch(() => [state.messages.map(message => [message.id, message.text, message.episodeId]), activity.value.loading, feedback.value?.at, feedback.value?.label], () => {
      // Compensate removed loading space in the same DOM update, before the
      // browser paints a clamped scroll position for a completed short reply.
      reconcileResponseLayout();
      scheduleResponseLayout();
    }, { flush: 'post' });
    // A reconnect replaces the entire projection. Do not carry an old DOM
    // target or an admission awaiting acknowledgement into that generation.
    Vue.watch(() => [gate.value, chat.chatHistoryConnectionGeneration], resetResponseFocus, { flush: 'sync' });
    Vue.onMounted(() => {
      if (typeof ResizeObserver !== 'undefined') {
        responseLayoutObserver = new ResizeObserver(scheduleResponseLayout);
        if (messagePane.value) responseLayoutObserver.observe(messagePane.value);
        if (readingColumn.value) responseLayoutObserver.observe(readingColumn.value);
      }
    });
    Vue.onBeforeUnmount(() => {
      disposed = true;
      resetResponseFocus();
      responseLayoutObserver?.disconnect();
    });
    function leave() {
      chat.leaveDigitalPerson();
      chat.leaveWorkCenter();
      chat.closePluginCenter();
      if (window.innerWidth <= 768) chat.sessionSidebarOpen = true;
      Vue.nextTick(() => [...document.querySelectorAll('.sidebar-person-trigger')]
        .find(button => button.getClientRects().length)?.focus());
    }
    const asUserMessage = message => ({ id: message.id, type: 'user', content: message.text, createdAt: new Date(message.createdAt).getTime() });
    const time = value => value ? new Date(value).toLocaleString() : '';
    return { chat, state, agentId, draft, panel, compactPanel, sidePanel, thoughtButton, searchButton, searchInput, searchQuery, closePanelButton, agentOptions, messagePane, readingColumn, responseStart, responseTail, focusedResponseId, hasResponseFocus, responsePinned, releaseResponseFocus, returnButton, gate, ready, activity, feedback, responding, canCompose, controller, command, discardRetry, openPanel, closePanel, togglePanel, panelKeydown, leave, asUserMessage, time, renderSafeMessageMarkdown, attachments, attachmentError, fileError, filesReady, canSend, addFiles, retryAttachment, removeAttachment, settingsOpen, saveSettings, PERSON_FILE_ACCEPT };
  },
  template: `
    <div class="person-page">
      <header class="chat-header person-header" :inert="compactPanel && panel ? true : undefined">
        <nav class="person-navigation" :aria-label="$t('person.navigation')">
          <button ref="returnButton" type="button" class="header-action-btn" @click="leave()" :aria-label="$t('yeaft.session.title')" :title="$t('yeaft.session.title')"><NavigationIcon name="back" /></button>
          <div class="person-breadcrumb">
            <ModernSelect id="person-agent" class="person-agent-select" menu-class="agent-select-menu" v-model="agentId" :options="agentOptions" :aria-label="$t('person.agent')" :placeholder="$t('person.noAgent')" :empty-text="$t('person.noAgent')" :disabled="!agentOptions.length" :menu-min-width="220" />
          </div>
        </nav>
        <div class="person-identity">
          <h1 :title="state.person?.name || $t('person.title')">{{ state.person?.name || $t('person.title') }}</h1>
        </div>
        <div class="person-header-actions">
          <button type="button" class="header-action-btn" @click="controller.refresh()" :disabled="!!gate || state.loading || state.commandPending" :aria-label="$t('common.refresh')" :title="$t('common.refresh')"><NavigationIcon name="refresh" /></button>
          <button ref="searchButton" type="button" class="header-action-btn person-search-button" :class="{ active: panel === 'search' }" :aria-expanded="panel === 'search'" aria-controls="person-side-panel" :aria-label="$t('person.searchMessages')" :title="$t('person.searchMessages')" @click="panel === 'search' ? closePanel() : openPanel('search')"><NavigationIcon name="search" /></button>
          <button ref="thoughtButton" type="button" class="header-action-btn person-thoughts-button" :class="{ active: !!panel && panel !== 'search' }" :aria-expanded="!!panel && panel !== 'search'" aria-controls="person-side-panel" :aria-label="$t('person.inside')" :title="$t('person.inside')" @click="togglePanel()"><NavigationIcon name="eye" /></button>
          <button type="button" class="header-action-btn person-settings-button" :disabled="!!gate || state.loading || !state.person || state.busy || state.commandPending" @click="settingsOpen = true" :aria-label="$t('person.settings')" :title="$t('person.settings')"><NavigationIcon name="settings" /></button>
        </div>
      </header>
      <div v-if="gate || state.loading" class="person-connection-notice" :inert="compactPanel && panel ? true : undefined" role="status" aria-live="polite">
        <span>{{ $t('person.' + (gate || 'loading')) }}</span>
        <button v-if="gate === 'disconnected'" type="button" class="btn-ghost" @click="chat.manualReconnect()">{{ $t('chat.connection.reconnect') }}</button>
      </div>
      <section v-if="(state.configured === false || state.storageReady === false || state.modelReady === false) && !gate" class="person-configuration" :inert="compactPanel && panel ? true : undefined" role="status">
        <h2>{{ $t('person.configureTitle') }}</h2>
        <p>{{ $t('person.configureAgent') }}</p>
        <p>{{ $t('person.configureSecrets') }}</p>
        <p>{{ $t('person.configureRefresh') }}</p>
        <p v-if="state.reason" class="person-muted">{{ state.reason }}</p>
      </section>
      <div v-if="state.latestEpisode && ['failed', 'interrupted', 'budget_exhausted'].includes(state.latestEpisode.status)" class="person-error" :inert="compactPanel && panel ? true : undefined" role="alert">
        {{ $t('person.episodeFailed') }}
      </div>
      <div v-if="state.error" class="person-error" :inert="compactPanel && panel ? true : undefined" role="alert">
        <p>{{ $t('person.requestFailed') }} {{ state.error.message }}</p>
        <p v-if="state.error.code === 'timeout'">{{ $t('person.timeout') }}</p>
      </div>
      <div v-if="state.retryCommand && !state.commandPending" class="person-retry" :inert="compactPanel && panel ? true : undefined" role="status">
        <p>{{ $t('person.uncertain') }}</p>
        <button type="button" class="btn-secondary" :disabled="!!gate || state.loading || !state.person || state.settingsPending" @click="command(state.retryCommand.op, true)">{{ $t('person.retrySame') }}</button>
        <button type="button" class="btn-ghost" @click="discardRetry()">{{ $t('person.discardRetry') }}</button>
      </div>
      <div class="person-workspace">
        <main id="person-conversation" :inert="compactPanel && panel ? true : undefined" class="person-conversation" :aria-label="$t('person.conversation')">
          <div ref="messagePane" class="person-messages" :class="{ 'is-response-pinned': responsePinned }" tabindex="0" :aria-label="$t('person.messages')" :aria-busy="state.messagesLoading"
            @wheel.passive="releaseResponseFocus" @touchmove.passive="releaseResponseFocus" @keydown="releaseResponseFocus" @pointerdown.passive="releaseResponseFocus">
            <div ref="readingColumn" class="person-reading-column">
              <button v-if="state.messageCursor != null" type="button" class="btn-ghost person-load-more" @click="controller.page('messages', true)" :disabled="!!gate || state.messagesLoading">{{ $t('person.olderMessages') }}</button>
              <div v-if="!state.messages.length && ready && !responding" class="person-welcome"><NavigationIcon name="activity" :size="28" /><h2>{{ $t('person.welcome') }}</h2><p>{{ $t('person.empty') }}</p></div>
              <template v-for="message in state.messages" :key="message.id">
                <div v-if="message.role === 'user'">
                  <UserTurnBlock :message="asUserMessage(message)" :session-actions="false" />
                  <ul v-if="message.attachments?.length" class="person-sent-files" :aria-label="$t('person.attachedFiles')"><li v-for="(file, index) in message.attachments" :key="file.id || index">{{ file.name }}</li></ul>
                </div>
                <article v-else class="person-message" :data-message-id="message.id">
                  <header class="person-message-meta"><strong>{{ message.role === 'assistant' ? (state.person?.name || $t('person.title')) : $t('person.system') }}</strong><span v-if="message.role === 'assistant' && message.replyKind === 'progress'" class="person-reply-kind">{{ $t('person.progressReply') }}</span><time>{{ time(message.createdAt) }}</time></header>
                  <div class="person-message-text markdown-body" v-html="renderSafeMessageMarkdown(message.text)"></div>
                </article>
              </template>
              <div v-if="hasResponseFocus && !focusedResponseId" ref="responseStart" class="person-response-start" aria-hidden="true"></div>
              <div v-if="activity.loading" class="person-response-loading" role="status" aria-live="polite" aria-atomic="true" :aria-label="$t('sidebar.sessions.processing')">
                <div v-if="feedback" class="person-wait-feedback">
                  <span>{{ $t(feedback.label) }}</span>
                  <time :datetime="feedback.at">{{ $t('person.feedback.confirmedAt', { time: time(feedback.at) }) }}</time>
                </div>
                <span class="typing-indicator" aria-hidden="true"><span></span><span></span><span></span></span>
              </div>
              <div v-if="hasResponseFocus" ref="responseTail" class="person-response-tail" aria-hidden="true"></div>
            </div>
          </div>
          <div class="input-area person-composer">
            <label class="person-sr-only" for="person-input">{{ $t('person.input') }}</label>
            <MessageComposer v-model="draft" input-id="person-input" :disabled="!canCompose" :can-send="canSend" :sending="responding" :show-stop="!gate && state.busy" :stop-disabled="state.cancelPending" :stop-label="$t(state.cancelPending ? 'person.cancelling' : 'chatInput.stop')" :placeholder="$t('person.placeholder')" :send-label="$t('person.send')"
              keyboard-send attachments-enabled :attachments="attachments" :attachment-accept="PERSON_FILE_ACCEPT"
              @send="command('send')" @stop="controller.cancel()" @files-selected="addFiles" @retry-attachment="retryAttachment" @remove-attachment="removeAttachment">
              <template #start-actions>
                <button type="button" class="btn-ghost" :disabled="!canCompose || !filesReady" @click="command('think')" :title="$t('person.thinkHint')">{{ $t('person.think') }}</button>
                <button type="button" class="btn-ghost" :disabled="!canCompose" @click="command('dream')">{{ $t('person.dream') }}</button>
              </template>
            </MessageComposer>
            <p v-if="fileError" class="person-upload-error person-settings-error" role="alert">{{ $t(fileError) }}</p>
          </div>
        </main>
        <div v-if="panel && compactPanel" class="person-panel-backdrop" aria-hidden="true" @click="closePanel()"></div>
        <aside v-if="panel" id="person-side-panel" ref="sidePanel" class="person-side-panel" :role="compactPanel ? 'dialog' : 'complementary'" :aria-modal="compactPanel ? true : undefined" aria-labelledby="person-panel-title">
          <header class="person-panel-header">
            <h2 id="person-panel-title">{{ $t(panel === 'search' ? 'person.searchMessages' : 'person.inside') }}</h2>
            <button ref="closePanelButton" type="button" class="header-action-btn" :aria-label="$t('common.close')" :title="$t('common.close')" @click="closePanel()"><NavigationIcon name="close" /></button>
          </header>
          <div v-if="compactPanel && (gate || state.loading)" class="person-panel-notice" role="status">
            <span>{{ $t('person.' + (gate || 'loading')) }}</span>
            <button v-if="gate === 'disconnected'" type="button" class="btn-ghost" @click="chat.manualReconnect()">{{ $t('chat.connection.reconnect') }}</button>
          </div>
          <div v-if="compactPanel && state.error" class="person-panel-error" role="alert">
            <p>{{ $t('person.requestFailed') }} {{ state.error.message }}</p>
            <button type="button" class="btn-ghost" :disabled="!!gate || state.loading || state.tracesLoading" @click="controller.refresh()">{{ $t('common.refresh') }}</button>
          </div>
          <nav v-if="panel !== 'search'" class="person-inspector-nav" :aria-label="$t('person.inside')">
            <button v-for="section in ['overview', 'thoughts', 'turns', 'tasks', 'memory', 'skills']" :key="section" type="button" class="btn-ghost" :class="{ active: panel === section }" :aria-current="panel === section ? 'page' : undefined" @click="openPanel(section)">{{ $t('person.' + section) }}</button>
          </nav>
          <section v-if="panel === 'overview'" class="person-journal-scroll person-overview" tabindex="0" :aria-label="$t('person.overview')">
            <h3>{{ state.person?.name }}</h3>
            <p class="person-prose">{{ state.person?.soul }}</p>
            <h3>{{ $t('person.currentUnderstanding') }}</h3><p class="person-prose">{{ state.state?.summary || $t('person.knowledgeEmpty') }}</p>
            <p class="person-prose">{{ state.state?.appraisal }}</p>
            <dl><dt>{{ $t('person.revision') }}</dt><dd>{{ state.state?.version }}</dd><dt>{{ $t('person.createdAt') }}</dt><dd>{{ time(state.person?.createdAt) }}</dd></dl>
          </section>
          <section v-else-if="panel === 'search'" class="person-journal person-search">
            <form class="person-search-form" @submit.prevent="controller.search(searchQuery)">
              <input ref="searchInput" v-model="searchQuery" type="search" maxlength="200" :placeholder="$t('person.searchMessages')" :aria-label="$t('person.searchMessages')" @input="controller.search('')">
              <button type="submit" class="btn-ghost" :disabled="!!gate || state.loading || !state.person || !searchQuery.trim()">{{ $t('person.search') }}</button>
            </form>
            <div class="person-journal-scroll" tabindex="0" role="region" :aria-label="$t('person.searchMessages')" :aria-busy="state.search.loading">
              <p v-if="state.search.error" role="alert" class="person-settings-error">{{ $t('person.requestFailed') }} {{ state.search.error.message }}</p>
              <p v-if="state.search.loading" role="status" class="person-muted">{{ $t('person.loading') }}</p>
              <p v-else-if="state.search.loaded && !state.search.items.length" class="person-empty">{{ $t('person.noSearchResults') }}</p>
              <article v-for="message in state.search.items" :key="message.id" class="person-search-result">
                <header class="person-message-meta"><strong>{{ message.role === 'user' ? $t('person.you') : (state.person?.name || $t('person.title')) }}</strong><span v-if="message.role === 'assistant' && message.replyKind === 'progress'" class="person-reply-kind">{{ $t('person.progressReply') }}</span><time>{{ time(message.createdAt) }}</time></header>
                <p class="person-prose">{{ message.text }}</p>
              </article>
              <button v-if="state.search.nextCursor != null" type="button" class="btn-ghost person-load-more" :disabled="!!gate || state.search.loading" @click="controller.search(state.search.query, true)">{{ $t('person.loadMore') }}</button>
            </div>
          </section>
          <PersonTurnUsage v-else-if="panel === 'turns'" :page="state.turns" :disabled="!!gate || state.loading || !state.person" @refresh="controller.readTurns()" @more="controller.readTurns(true)" />
          <PersonTaskBrowser v-else-if="panel === 'tasks'" :page="state.tasks" :log="state.taskLog" :disabled="!!gate || state.loading || !state.person" @refresh="controller.readTasks()" @log="controller.readTaskLog" @stop="controller.stopTask" />
          <PersonKnowledgeBrowser v-else-if="panel === 'memory' || panel === 'skills'" :key="panel" :section="panel" :page="state[panel]" :disabled="!!gate || state.loading || !state.person" @refresh="controller.inspect(panel)" @more="controller.inspect(panel, true)" />
          <div v-if="panel === 'thoughts' || panel === 'debug'" class="person-journal-toolbar">
            <span class="person-muted">{{ $t('person.thoughts') }}</span>
            <button v-if="panel === 'thoughts'" type="button" class="btn-ghost person-debug-link" @click="openPanel('debug')">{{ $t('person.debug') }}</button>
            <button v-else type="button" class="btn-ghost" @click="openPanel('thoughts')">{{ $t('person.back') }}</button>
          </div>
          <PersonThoughtJournal v-if="panel === 'thoughts'" :traces="state.traces" :loading="state.tracesLoading" :stale="state.tracesStale" :more="state.traceCursor != null" :disabled="!!gate || !state.person || state.loading" @refresh="controller.page('traces')" @more="controller.page('traces', true)">
            <template #activity><PersonActivity :key="activity.episodeId || 'pending'" :activity="activity" /></template>
          </PersonThoughtJournal>
          <PersonDebugLog v-if="panel === 'debug'" :traces="state.traces" :state="state.state" :loading="state.tracesLoading" :stale="state.tracesStale" :more="state.traceCursor != null" :disabled="!!gate || !state.person || state.loading" @refresh="controller.page('traces')" @more="controller.page('traces', true)" />
        </aside>
      </div>
      <PersonSettingsModal v-if="settingsOpen" :name="state.person?.name || ''" :rename-supported="state.renameSupported" :models="state.models" :candidates="state.modelCandidates" :effective-candidates="state.effectiveModelCandidates" :default-model="state.defaultModel" :agent-default-model="state.agentDefaultModel" :effective-default-model="state.effectiveDefaultModel" :default-model-supported="state.defaultModelSupported" :saving="state.settingsPending" :loading="state.loading" :disabled="!!gate || state.loading || state.busy || state.commandPending" :error="state.error" @close="settingsOpen = false" @save="saveSettings" />
    </div>
  `,
};
