import UserTurnBlock from './UserTurnBlock.js';
import { useAuthStore } from '../stores/auth.js';
import { createPersonController, digitalPersonGate, personState } from '../stores/helpers/digital-person.js';

export default {
  name: 'DigitalPersonPage',
  components: { UserTurnBlock },
  setup() {
    const chat = Pinia.useChatStore();
    const auth = useAuthStore();
    const state = Vue.reactive(personState());
    const agentId = Vue.ref(chat.agents.find(a => a.id === chat.currentAgent)?.id
      || chat.agents.find(a => a.online && a.capabilities?.includes('digital_person'))?.id
      || chat.agents[0]?.id || '');
    const draft = Vue.ref('');
    const traceOpen = Vue.ref(false);
    const messagePane = Vue.ref(null);
    const returnButton = Vue.ref(null);
    const gate = Vue.computed(() => digitalPersonGate(chat, agentId.value));
    const scope = () => JSON.stringify([auth.userId, auth.authGeneration]);
    const controller = createPersonController({ chat, state, scope });
    Vue.watch(() => JSON.stringify([scope(), agentId.value, gate.value, chat.chatHistoryConnectionGeneration]), () => {
      draft.value = '';
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
      if (destination === 'plugins') { chat.currentView = 'yeaft'; chat.openPluginCenter(agentId.value); }
    }
    const asUserMessage = message => ({ ...message, type: 'user', content: message.text, createdAt: new Date(message.createdAt).getTime() });
    const format = value => JSON.stringify(value, null, 2);
    const time = value => value ? new Date(value).toLocaleString() : '';
    return { chat, state, agentId, draft, traceOpen, messagePane, returnButton, gate, ready, canCompose, controller, command, leave, asUserMessage, format, time };
  },
  template: `
    <div class="person-page">
      <nav class="person-navigation" :aria-label="$t('person.navigation')">
        <button ref="returnButton" type="button" class="btn-ghost" @click="leave('sessions')">{{ $t('yeaft.session.title') }}</button>
        <button v-if="chat.workCenterUiEnabled" type="button" class="btn-ghost" @click="leave('work')">{{ $t('workCenter.title') }}</button>
        <button type="button" class="btn-ghost" aria-current="page">{{ $t('person.title') }}</button>
        <button type="button" class="btn-ghost" @click="leave('plugins')" :disabled="!agentId || !!gate">{{ $t('person.plugins') }}</button>
        <button type="button" class="btn-ghost" @click="chat.toggleTheme()">{{ $t(chat.theme === 'dark' ? 'chat.sidebar.lightMode' : 'chat.sidebar.darkMode') }}</button>
      </nav>
      <header class="person-header">
        <h1>{{ state.person?.name || $t('person.title') }}</h1>
        <label class="person-agent-label" for="person-agent">{{ $t('person.agent') }}</label>
        <select id="person-agent" v-model="agentId">
          <option v-if="!chat.agents.length" value="">{{ $t('person.noAgent') }}</option>
          <option v-for="agent in chat.agents" :key="agent.id" :value="agent.id">{{ agent.name || agent.id }}{{ agent.online ? '' : ' · ' + $t('person.offlineShort') }}</option>
        </select>
        <button type="button" class="btn-secondary" @click="controller.refresh()" :disabled="!!gate || state.loading || state.commandPending">{{ $t('common.refresh') }}</button>
        <button type="button" class="btn-secondary" :aria-expanded="traceOpen" aria-controls="person-trace" @click="traceOpen = !traceOpen">{{ $t('person.trace') }}</button>
      </header>
      <div class="person-status" role="status" aria-live="polite">
        <span v-if="gate">{{ $t('person.' + gate) }}</span>
        <span v-else-if="state.loading">{{ $t('person.loading') }}</span>
        <span v-else-if="state.busy || state.commandPending">{{ $t('person.busy') }}</span>
        <span v-else-if="ready">{{ $t('person.ready') }}</span>
        <span v-if="state.state?.version != null"> · {{ $t('person.version', { version: state.state.version }) }}</span>
        <button v-if="gate === 'disconnected'" type="button" class="btn-ghost" @click="chat.manualReconnect()">{{ $t('chat.connection.reconnect') }}</button>
        <button v-if="state.busy" type="button" class="btn-secondary" @click="controller.cancel()" :disabled="!!gate || state.cancelPending">{{ $t(state.cancelPending ? 'person.cancelling' : 'common.cancel') }}</button>
      </div>
      <section v-if="(state.configured === false || state.storageReady === false || state.modelReady === false) && !gate" class="person-configuration" role="status">
        <h2>{{ $t('person.configureTitle') }}</h2>
        <p>{{ $t('person.configureAgent') }}</p>
        <p>{{ $t('person.configureSecrets') }}</p>
        <p>{{ $t('person.configureRefresh') }}</p>
        <p v-if="state.reason" class="person-muted">{{ state.reason }}</p>
      </section>
      <div v-if="state.latestEpisode && ['failed', 'interrupted', 'budget_exhausted'].includes(state.latestEpisode.status)" class="person-error" role="alert">
        {{ $t('person.episodeFailed') }} <code>{{ state.latestEpisode.terminalCode || state.latestEpisode.status }}</code>
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
      <div class="person-content" :class="{ 'trace-open': traceOpen }">
        <main class="person-conversation" :aria-label="$t('person.conversation')">
          <div ref="messagePane" class="person-messages" tabindex="0" :aria-label="$t('person.messages')" :aria-busy="state.messagesLoading">
            <button v-if="state.messageCursor != null" type="button" class="btn-ghost" @click="controller.page('messages', true)" :disabled="!!gate || state.messagesLoading">{{ $t('person.olderMessages') }}</button>
            <p v-if="!state.messages.length && ready" class="person-empty">{{ $t('person.empty') }}</p>
            <template v-for="message in state.messages" :key="message.id">
              <UserTurnBlock v-if="message.role === 'user'" :message="asUserMessage(message)" :session-actions="false" />
              <article v-else class="person-message" :data-message-id="message.id">
                <header><strong>{{ message.role === 'assistant' ? (state.person?.name || $t('person.title')) : $t('person.system') }}</strong><time>{{ time(message.createdAt) }}</time></header>
                <div class="person-message-text">{{ message.text }}</div>
              </article>
            </template>
          </div>
          <form class="person-composer" @submit.prevent="command('send')">
            <label for="person-input">{{ $t('person.input') }}</label>
            <textarea id="person-input" v-model="draft" rows="3" :disabled="!canCompose" :placeholder="$t('person.placeholder')" aria-describedby="person-think-hint" @keydown.ctrl.enter.prevent="!$event.isComposing && canCompose && command('send')" @keydown.meta.enter.prevent="!$event.isComposing && canCompose && command('send')"></textarea>
            <p id="person-think-hint" class="person-muted">{{ $t('person.thinkHint') }}</p>
            <div class="person-composer-actions">
              <button type="button" class="btn-secondary" :disabled="!canCompose" @click="command('dream')">{{ $t('person.dream') }}</button>
              <button type="button" class="btn-secondary" :disabled="!canCompose" @click="command('think')">{{ $t('person.think') }}</button>
              <button type="submit" class="btn-primary" :disabled="!canCompose || !draft.trim()">{{ $t('person.send') }}</button>
            </div>
          </form>
        </main>
        <aside v-if="traceOpen" id="person-trace" class="person-trace" :aria-label="$t('person.trace')">
          <div class="person-trace-heading"><h2>{{ $t('person.trace') }}</h2><button type="button" class="btn-ghost" @click="traceOpen = false">{{ $t('common.close') }}</button></div>
          <p class="person-muted">{{ $t('person.traceHint') }}</p>
          <button type="button" class="btn-ghost" @click="controller.page('traces')" :disabled="!ready || state.tracesLoading">{{ $t('person.refreshTrace') }}</button>
          <p v-if="state.tracesStale" role="status">{{ $t('person.traceStale') }}</p>
          <div class="person-trace-scroll" tabindex="0" :aria-label="$t('person.traceEvents')" :aria-busy="state.tracesLoading">
            <p v-if="!state.traces.length">{{ $t(state.tracesLoading ? 'person.loading' : 'person.noTrace') }}</p>
            <details v-if="state.state" class="person-trace-row"><summary>{{ $t('person.state') }}</summary><pre>{{ format(state.state) }}</pre></details>
            <details v-for="trace in state.traces" :key="trace.id" class="person-trace-row">
              <summary><strong>{{ trace.kind }}</strong> <time>{{ time(trace.createdAt) }}</time><small>{{ trace.episodeId }}</small></summary>
              <dl><dt>{{ $t('person.traceId') }}</dt><dd>{{ trace.id }}</dd></dl>
              <div v-if="trace.input !== undefined"><h3>{{ $t('person.traceInput') }}</h3><pre>{{ format(trace.input) }}</pre></div>
              <div v-if="trace.output !== undefined"><h3>{{ $t('person.traceOutput') }}</h3><pre>{{ format(trace.output) }}</pre></div>
              <h3>{{ $t('person.traceRecord') }}</h3><pre>{{ format(trace) }}</pre>
            </details>
            <button v-if="state.traceCursor != null" type="button" class="btn-secondary" @click="controller.page('traces', true)" :disabled="!!gate || state.tracesLoading">{{ $t('person.moreTrace') }}</button>
          </div>
        </aside>
      </div>
    </div>
  `,
};
