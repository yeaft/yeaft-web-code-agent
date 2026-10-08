import UserTurnBlock from './UserTurnBlock.js';
import MessageComposer from './MessageComposer.js';
import NavigationIcon from './NavigationIcon.js';
import ThemeToggle from './ThemeToggle.js';
import ModernSelect from './ModernSelect.js';
import PersonSettingsModal from './PersonSettingsModal.js';
import { useComposerAttachments } from '../utils/composer-attachments.js';
import { PERSON_FILE_ACCEPT, validatePersonFiles, uploadPersonFiles } from '../stores/helpers/person-attachments.js';
import PersonThoughtJournal from './PersonThoughtJournal.js';
import PersonDebugLog from './PersonDebugLog.js';
import { useAuthStore } from '../stores/auth.js';
import { renderSafeMessageMarkdown } from '../utils/safe-message-markdown.js';
import { createPersonController, digitalPersonGate, personState } from '../stores/helpers/digital-person.js';

export default {
  name: 'DigitalPersonPage',
  components: { UserTurnBlock, MessageComposer, NavigationIcon, ThemeToggle, ModernSelect, PersonSettingsModal, PersonThoughtJournal, PersonDebugLog },
  setup() {
    const chat = Pinia.useChatStore();
    const auth = useAuthStore();
    const state = Vue.reactive(personState());
    const agentId = Vue.ref(chat.agents.find(a => a.id === chat.currentAgent)?.id
      || chat.agents.find(a => a.online && a.capabilities?.includes('digital_person'))?.id
      || chat.agents[0]?.id || '');
    const draft = Vue.ref('');
    const settingsOpen = Vue.ref(false);
    let draftGeneration = 0;
    let pendingDraft = null;

    const panel = Vue.ref(null);
    const compactPanel = Vue.ref(window.innerWidth <= 900);
    const sidePanel = Vue.ref(null);
    const thoughtButton = Vue.ref(null);
    const closePanelButton = Vue.ref(null);
    const t = Vue.inject('t');
    const agentOptions = Vue.computed(() => chat.agents.map(agent => ({
      value: agent.id, label: agent.name || agent.id,
      badge: agent.online ? undefined : t('person.offlineShort'),
    })));
    const messagePane = Vue.ref(null);
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
      draftGeneration++;
      pendingDraft = null;
      draft.value = '';
      settingsOpen.value = false;
      closePanel();
    }, { flush: 'sync' });
    Vue.watch(() => JSON.stringify([scope(), agentId.value, gate.value, chat.chatHistoryConnectionGeneration]), () => {
      controller.open(agentId.value);
    // Batch auth_result mutations: authenticated is set before the new socket's
    // encryption key / plaintext negotiation. Opening synchronously sends with
    // the previous connection's key during reconnect.
    }, { immediate: true });
    Vue.watch(() => chat.agents.map(agent => agent.id).join(','), () => {
      if (!agentId.value && chat.agents.length) agentId.value = chat.agents[0].id;
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
      const accepted = await controller.command(op, draft.value, retry, op === 'dream' ? [] : attachments.value.slice());
      if (!accepted || g !== draftGeneration) return;
      if (op !== 'dream' && submitted) {
        if (draft.value === submitted.text) draft.value = '';
        // Person messages only retain server references, not local blob URLs.
        attachmentQueue.release(submitted.rows, { transferPreviews: false });
      }
      pendingDraft = null;
    }
    async function openPanel(next = 'thoughts') {
      panel.value = next;
      await Vue.nextTick();
      closePanelButton.value?.focus();
    }
    function closePanel() {
      const restoreFocus = compactPanel.value || sidePanel.value?.contains(document.activeElement);
      panel.value = null;
      if (restoreFocus) Vue.nextTick(() => thoughtButton.value?.focus());
    }
    function togglePanel() {
      if (panel.value) closePanel();
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
      const controls = [...sidePanel.value.querySelectorAll('button:not(:disabled), summary, [tabindex="0"]')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    Vue.watch(compactPanel, async compact => {
      if (compact && panel.value) { await Vue.nextTick(); closePanelButton.value?.focus(); }
    });
    Vue.watch(() => state.messages.at(-1)?.id, async () => {
      const pane = messagePane.value;
      const nearBottom = pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
      await Vue.nextTick();
      if (nearBottom && messagePane.value) messagePane.value.scrollTop = messagePane.value.scrollHeight;
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
    return { chat, state, agentId, draft, panel, compactPanel, sidePanel, thoughtButton, closePanelButton, agentOptions, messagePane, returnButton, gate, ready, canCompose, controller, command, openPanel, closePanel, togglePanel, panelKeydown, leave, asUserMessage, time, renderSafeMessageMarkdown, attachments, attachmentError, fileError, filesReady, canSend, addFiles, retryAttachment, removeAttachment, settingsOpen, saveSettings, PERSON_FILE_ACCEPT };
  },
  template: `
    <div class="person-page">
      <header class="chat-header person-header" :inert="compactPanel && panel ? true : undefined">
        <nav class="person-navigation" :aria-label="$t('person.navigation')">
          <button ref="returnButton" type="button" class="header-action-btn" @click="leave()" :aria-label="$t('yeaft.session.title')" :title="$t('yeaft.session.title')"><NavigationIcon name="back" /></button>
        </nav>
        <div class="person-identity">
          <h1>{{ state.person?.name || $t('person.title') }}</h1>
          <div class="person-status" role="status" aria-live="polite">
            <span class="person-status-dot" :class="{ ready, busy: state.busy || state.commandPending }" aria-hidden="true"></span>
            <span v-if="gate">{{ $t('person.' + gate) }}</span>
            <span v-else-if="state.loading">{{ $t('person.loading') }}</span>
            <span v-else-if="state.busy || state.commandPending">{{ $t('person.busy') }}</span>
            <span v-else-if="ready">{{ $t('person.ready') }}</span>
            <button v-if="gate === 'disconnected'" type="button" class="btn-ghost" @click="chat.manualReconnect()">{{ $t('chat.connection.reconnect') }}</button>
            <button v-if="state.busy" type="button" class="btn-ghost" @click="controller.cancel()" :disabled="!!gate || state.cancelPending">{{ $t(state.cancelPending ? 'person.cancelling' : 'common.cancel') }}</button>
          </div>
        </div>
        <div class="person-header-actions">
          <ModernSelect id="person-agent" class="person-agent-select" v-model="agentId" :options="agentOptions" :aria-label="$t('person.agent')" :placeholder="$t('person.noAgent')" :empty-text="$t('person.noAgent')" :disabled="!chat.agents.length" :menu-min-width="220" />
          <button type="button" class="header-action-btn" @click="controller.refresh()" :disabled="!!gate || state.loading || state.commandPending" :aria-label="$t('common.refresh')" :title="$t('common.refresh')"><NavigationIcon name="refresh" /></button>
          <ThemeToggle />
          <button ref="thoughtButton" type="button" class="header-action-btn person-thoughts-button" :class="{ active: !!panel }" :aria-expanded="!!panel" aria-controls="person-side-panel" :aria-label="$t('person.thoughts')" :title="$t('person.thoughts')" @click="togglePanel()"><NavigationIcon name="workbench" /></button>
          <button type="button" class="header-action-btn person-settings-button" :disabled="!!gate || state.loading || !state.person || state.busy || state.commandPending" @click="settingsOpen = true" :aria-label="$t('person.settings')" :title="$t('person.settings')"><NavigationIcon name="settings" /></button>
        </div>
      </header>
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
        <button type="button" class="btn-ghost" @click="controller.discardRetry()">{{ $t('person.discardRetry') }}</button>
      </div>
      <div class="person-workspace">
        <main id="person-conversation" :inert="compactPanel && panel ? true : undefined" class="person-conversation" :aria-label="$t('person.conversation')">
          <div ref="messagePane" class="person-messages" tabindex="0" :aria-label="$t('person.messages')" :aria-busy="state.messagesLoading">
            <div class="person-reading-column">
              <button v-if="state.messageCursor != null" type="button" class="btn-ghost person-load-more" @click="controller.page('messages', true)" :disabled="!!gate || state.messagesLoading">{{ $t('person.olderMessages') }}</button>
              <div v-if="!state.messages.length && ready" class="person-welcome"><NavigationIcon name="activity" :size="28" /><h2>{{ $t('person.welcome') }}</h2><p>{{ $t('person.empty') }}</p></div>
              <template v-for="message in state.messages" :key="message.id">
                <div v-if="message.role === 'user'">
                  <UserTurnBlock :message="asUserMessage(message)" :session-actions="false" />
                  <ul v-if="message.attachments?.length" class="person-sent-files" :aria-label="$t('person.attachedFiles')"><li v-for="(file, index) in message.attachments" :key="file.id || index">{{ file.name }}</li></ul>
                </div>
                <article v-else class="person-message" :data-message-id="message.id">
                  <header class="person-message-meta"><strong>{{ message.role === 'assistant' ? (state.person?.name || $t('person.title')) : $t('person.system') }}</strong><time>{{ time(message.createdAt) }}</time></header>
                  <div class="person-message-text markdown-body" v-html="renderSafeMessageMarkdown(message.text)"></div>
                </article>
              </template>
            </div>
          </div>
          <div class="input-area person-composer">
            <label class="person-sr-only" for="person-input">{{ $t('person.input') }}</label>
            <MessageComposer v-model="draft" input-id="person-input" :disabled="!canCompose" :can-send="canSend" :sending="state.commandPending" :placeholder="$t('person.placeholder')" :send-label="$t('person.send')"
              keyboard-send attachments-enabled :attachments="attachments" :attachment-accept="PERSON_FILE_ACCEPT"
              @send="command('send')" @files-selected="addFiles" @retry-attachment="retryAttachment" @remove-attachment="removeAttachment">
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
            <h2 id="person-panel-title">{{ $t(panel === 'debug' ? 'person.debug' : 'person.thoughts') }}</h2>
            <button v-if="panel === 'thoughts'" type="button" class="btn-ghost person-debug-link" @click="openPanel('debug')">{{ $t('person.debug') }}</button>
            <button v-else type="button" class="btn-ghost" @click="openPanel('thoughts')">{{ $t('person.back') }}</button>
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
          <PersonThoughtJournal v-if="panel === 'thoughts'" :traces="state.traces" :loading="state.tracesLoading" :stale="state.tracesStale" :more="state.traceCursor != null" :disabled="!!gate || !state.person || state.loading" @refresh="controller.page('traces')" @more="controller.page('traces', true)" />
          <PersonDebugLog v-else :traces="state.traces" :state="state.state" :loading="state.tracesLoading" :stale="state.tracesStale" :more="state.traceCursor != null" :disabled="!!gate || !state.person || state.loading" @refresh="controller.page('traces')" @more="controller.page('traces', true)" />
        </aside>
      </div>
      <PersonSettingsModal v-if="settingsOpen" :models="state.models" :candidates="state.modelCandidates" :saving="state.settingsPending" :loading="state.loading" :disabled="!!gate || state.loading || state.busy || state.commandPending" :error="state.error" @close="settingsOpen = false" @save="saveSettings" />
    </div>
  `,
};
