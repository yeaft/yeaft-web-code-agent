import UserTurnBlock from './UserTurnBlock.js';
import MessageComposer from './MessageComposer.js';
import NavigationIcon from './NavigationIcon.js';
import ThemeToggle from './ThemeToggle.js';
import PersonThoughtJournal from './PersonThoughtJournal.js';
import PersonDebugLog from './PersonDebugLog.js';
import { useAuthStore } from '../stores/auth.js';
import { renderSafeMessageMarkdown } from '../utils/safe-message-markdown.js';
import { createPersonController, digitalPersonGate, personState } from '../stores/helpers/digital-person.js';

export default {
  name: 'DigitalPersonPage',
  components: { UserTurnBlock, MessageComposer, NavigationIcon, ThemeToggle, PersonThoughtJournal, PersonDebugLog },
  setup() {
    const chat = Pinia.useChatStore();
    const auth = useAuthStore();
    const state = Vue.reactive(personState());
    const agentId = Vue.ref(chat.agents.find(a => a.id === chat.currentAgent)?.id
      || chat.agents.find(a => a.online && a.capabilities?.includes('digital_person'))?.id
      || chat.agents[0]?.id || '');
    const draft = Vue.ref('');
    const view = Vue.ref('conversation');
    const previousView = Vue.ref('conversation');
    const messagePane = Vue.ref(null);
    const returnButton = Vue.ref(null);
    const viewNavigation = Vue.ref(null);
    const gate = Vue.computed(() => digitalPersonGate(chat, agentId.value));
    const scope = () => JSON.stringify([auth.userId, auth.authGeneration]);
    const controller = createPersonController({ chat, state, scope });
    Vue.watch(() => JSON.stringify([scope(), agentId.value]), () => { draft.value = ''; view.value = 'conversation'; });
    Vue.watch(() => JSON.stringify([scope(), agentId.value, gate.value, chat.chatHistoryConnectionGeneration]), () => {
      controller.open(agentId.value);
    // Batch auth_result mutations: authenticated is set before the new socket's
    // encryption key / plaintext negotiation. Opening synchronously sends with
    // the previous connection's key during reconnect.
    }, { immediate: true });
    Vue.watch(() => chat.agents.map(agent => agent.id).join(','), () => {
      if (!agentId.value && chat.agents.length) agentId.value = chat.agents[0].id;
    });
    Vue.onMounted(() => returnButton.value?.focus());
    Vue.onBeforeUnmount(() => controller.dispose());
    const ready = Vue.computed(() => !gate.value && state.configured && state.modelReady !== false && !!state.person && !state.loading);
    const canCompose = Vue.computed(() => ready.value && !state.busy && !state.commandPending && !state.retryCommand);
    async function command(op, retry = false) {
      const before = draft.value;
      if (await controller.command(op, before, retry)) {
        if (draft.value === before && op !== 'dream') draft.value = '';
      }
    }
    function onKeydown(event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        if (canCompose.value && draft.value.trim()) command('send');
      }
    }
    async function selectView(next) {
      if (next === 'debug') previousView.value = view.value;
      view.value = next;
      await Vue.nextTick();
      viewNavigation.value?.querySelector('[aria-current="page"]')?.focus();
    }
    Vue.watch(() => state.messages.at(-1)?.id, async () => {
      const pane = messagePane.value;
      const nearBottom = pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
      await Vue.nextTick();
      if (nearBottom && messagePane.value) messagePane.value.scrollTop = messagePane.value.scrollHeight;
    });
    function leave(destination) {
      chat.leaveDigitalPerson();
      if (destination === 'sessions') {
        chat.leaveWorkCenter();
        chat.closePluginCenter();
        if (window.innerWidth <= 768) chat.sessionSidebarOpen = true;
        Vue.nextTick(() => [...document.querySelectorAll('.sidebar-person-trigger')]
          .find(button => button.getClientRects().length)?.focus());
      }
      if (destination === 'work') chat.enterWorkCenter(agentId.value);
      if (destination === 'plugins') { chat.enterYeaft(); chat.openPluginCenter(agentId.value); }
    }
    const asUserMessage = message => ({ ...message, type: 'user', content: message.text, createdAt: new Date(message.createdAt).getTime() });
    const time = value => value ? new Date(value).toLocaleString() : '';
    return { chat, state, agentId, draft, view, previousView, messagePane, returnButton, viewNavigation, gate, ready, canCompose, controller, command, onKeydown, selectView, leave, asUserMessage, time, renderSafeMessageMarkdown };
  },
  template: `
    <div class="person-page">
      <header class="person-header">
        <nav class="person-navigation" :aria-label="$t('person.navigation')">
          <button ref="returnButton" type="button" class="btn-ghost person-icon-button" @click="leave('sessions')" :aria-label="$t('yeaft.session.title')" :title="$t('yeaft.session.title')"><NavigationIcon name="back" /></button>
        </nav>
        <div class="person-identity">
          <h1>{{ state.person?.name || $t('person.title') }}</h1>
          <span class="person-muted">{{ $t('person.title') }}</span>
        </div>
        <div class="person-header-actions">
          <label class="person-sr-only" for="person-agent">{{ $t('person.agent') }}</label>
          <select id="person-agent" v-model="agentId">
            <option v-if="!chat.agents.length" value="">{{ $t('person.noAgent') }}</option>
            <option v-for="agent in chat.agents" :key="agent.id" :value="agent.id">{{ agent.name || agent.id }}{{ agent.online ? '' : ' · ' + $t('person.offlineShort') }}</option>
          </select>
          <button type="button" class="btn-ghost person-icon-button" @click="controller.refresh()" :disabled="!!gate || state.loading || state.commandPending" :aria-label="$t('common.refresh')" :title="$t('common.refresh')"><NavigationIcon name="refresh" /></button>
          <details class="person-menu">
            <summary class="btn-ghost">{{ $t('person.more') }}</summary>
            <nav :aria-label="$t('person.navigation')">
              <button v-if="chat.workCenterUiEnabled" type="button" class="btn-ghost" @click="leave('work')">{{ $t('workCenter.title') }}</button>
              <button type="button" class="btn-ghost" @click="leave('plugins')" :disabled="!agentId || !!gate">{{ $t('person.plugins') }}</button>
              <ThemeToggle />
            </nav>
          </details>
        </div>
      </header>
      <nav ref="viewNavigation" class="session-tab-bar person-views" :aria-label="$t('person.views')">
        <template v-if="view !== 'debug'">
          <button type="button" class="session-tab" :class="{ active: view === 'conversation' }" :aria-current="view === 'conversation' ? 'page' : null" aria-controls="person-conversation" @click="selectView('conversation')">{{ $t('person.chat') }}</button>
          <button type="button" class="session-tab" :class="{ active: view === 'thoughts' }" :aria-current="view === 'thoughts' ? 'page' : null" aria-controls="person-thoughts" @click="selectView('thoughts')">{{ $t('person.thoughts') }}</button>
          <button type="button" class="btn-ghost person-debug-link" aria-controls="person-debug" @click="selectView('debug')">{{ $t('person.debug') }}</button>
        </template>
        <template v-else>
          <button type="button" class="btn-ghost" @click="selectView(previousView)"><NavigationIcon name="back" />{{ $t('person.back') }}</button>
          <button type="button" class="session-tab active" aria-current="page" aria-controls="person-debug">{{ $t('person.debug') }}</button>
        </template>
      </nav>
      <div class="person-status" role="status" aria-live="polite">
        <span class="person-status-dot" :class="{ ready, busy: state.busy || state.commandPending }" aria-hidden="true"></span>
        <span v-if="gate">{{ $t('person.' + gate) }}</span>
        <span v-else-if="state.loading">{{ $t('person.loading') }}</span>
        <span v-else-if="state.busy || state.commandPending">{{ $t('person.busy') }}</span>
        <span v-else-if="ready">{{ $t('person.ready') }}</span>
        <button v-if="gate === 'disconnected'" type="button" class="btn-ghost" @click="chat.manualReconnect()">{{ $t('chat.connection.reconnect') }}</button>
        <button v-if="state.busy" type="button" class="btn-ghost" @click="controller.cancel()" :disabled="!!gate || state.cancelPending">{{ $t(state.cancelPending ? 'person.cancelling' : 'common.cancel') }}</button>
      </div>
      <section v-if="(state.configured === false || state.storageReady === false || state.modelReady === false) && !gate" class="person-configuration" role="status">
        <h2>{{ $t('person.configureTitle') }}</h2>
        <p>{{ $t('person.configureAgent') }}</p>
        <p>{{ $t('person.configureSecrets') }}</p>
        <p>{{ $t('person.configureRefresh') }}</p>
        <p v-if="state.reason" class="person-muted">{{ state.reason }}</p>
      </section>
      <div v-if="state.latestEpisode && ['failed', 'interrupted', 'budget_exhausted'].includes(state.latestEpisode.status)" class="person-error" role="alert">
        {{ $t('person.episodeFailed') }}
      </div>
      <div v-if="state.error" class="person-error" role="alert">
        <p>{{ $t('person.requestFailed') }} {{ state.error.message }}</p>
        <p v-if="state.error.code === 'timeout'">{{ $t('person.timeout') }}</p>
      </div>
      <div v-if="state.retryCommand && !state.commandPending" class="person-retry" role="status">
        <p>{{ $t('person.uncertain') }}</p>
        <button type="button" class="btn-secondary" :disabled="!ready" @click="command(state.retryCommand.op, true)">{{ $t('person.retrySame') }}</button>
        <button type="button" class="btn-ghost" @click="controller.discardRetry()">{{ $t('person.discardRetry') }}</button>
      </div>
      <main v-show="view === 'conversation'" id="person-conversation" class="person-conversation" :aria-label="$t('person.conversation')">
        <div ref="messagePane" class="person-messages" tabindex="0" :aria-label="$t('person.messages')" :aria-busy="state.messagesLoading">
          <div class="person-reading-column">
            <button v-if="state.messageCursor != null" type="button" class="btn-ghost person-load-more" @click="controller.page('messages', true)" :disabled="!!gate || state.messagesLoading">{{ $t('person.olderMessages') }}</button>
            <div v-if="!state.messages.length && ready" class="person-welcome"><NavigationIcon name="activity" :size="28" /><h2>{{ $t('person.welcome') }}</h2><p>{{ $t('person.empty') }}</p></div>
            <template v-for="message in state.messages" :key="message.id">
              <UserTurnBlock v-if="message.role === 'user'" :message="asUserMessage(message)" :session-actions="false" />
              <article v-else class="person-message" :data-message-id="message.id">
                <header class="person-message-meta"><strong>{{ message.role === 'assistant' ? (state.person?.name || $t('person.title')) : $t('person.system') }}</strong><time>{{ time(message.createdAt) }}</time></header>
                <div class="person-message-text markdown-body" v-html="renderSafeMessageMarkdown(message.text)"></div>
              </article>
            </template>
          </div>
        </div>
        <div class="input-area person-composer">
          <label class="person-sr-only" for="person-input">{{ $t('person.input') }}</label>
          <MessageComposer v-model="draft" input-id="person-input" :disabled="!canCompose" :can-send="canCompose && !!draft.trim()" :sending="state.commandPending" :placeholder="$t('person.placeholder')" :send-label="$t('person.send')" @send="command('send')" @keydown="onKeydown">
            <template #start-actions>
              <button type="button" class="btn-ghost" :disabled="!canCompose" @click="command('think')" :title="$t('person.thinkHint')">{{ $t('person.think') }}</button>
              <button type="button" class="btn-ghost" :disabled="!canCompose" @click="command('dream')">{{ $t('person.dream') }}</button>
            </template>
          </MessageComposer>
        </div>
      </main>
      <PersonThoughtJournal v-if="view === 'thoughts'" :traces="state.traces" :loading="state.tracesLoading" :stale="state.tracesStale" :more="state.traceCursor != null" :disabled="!!gate || !state.person || state.loading" @refresh="controller.page('traces')" @more="controller.page('traces', true)" />
      <PersonDebugLog v-if="view === 'debug'" :traces="state.traces" :state="state.state" :loading="state.tracesLoading" :stale="state.tracesStale" :more="state.traceCursor != null" :disabled="!!gate || !state.person || state.loading" @refresh="controller.page('traces')" @more="controller.page('traces', true)" />
    </div>
  `,
};
