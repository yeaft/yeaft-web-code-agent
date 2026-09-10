import { confirmDialog } from '../utils/dialog.js';
import LlmTab from './LlmTab.js';
import ModernSelect from './ModernSelect.js';
import QuickSendSettings from './QuickSendSettings.js';

const DEFAULT_TELEMETRY = Object.freeze({
  enabled: true,
  retentionDays: 3,
  flushIntervalMs: 1000,
  maxQueueSize: 5000,
  rawExchangeMaxBytes: 524288,
  traceTextMaxBytes: 262144,
});

export default {
  name: 'AgentSettingsPanel',
  components: { LlmTab, ModernSelect, QuickSendSettings },
  props: {
    initialAgentId: { type: String, default: null },
    initialCategory: { type: String, default: 'operations' },
  },
  emits: ['close', 'saved'],
  template: `
    <div class="settings-overlay" @click.self="$emit('close')">
      <section class="agent-settings-dialog" role="dialog" aria-modal="true" :aria-label="$t('agentSettings.title')">
        <button class="settings-close agent-settings-close" type="button" :aria-label="$t('common.close')" @click="$emit('close')">&times;</button>

        <div class="agent-settings-body">
          <aside class="agent-settings-nav">
            <div class="agent-settings-agent-picker">
              <span class="agent-settings-picker-label">{{ $t('agentSettings.agentList') }}</span>
              <ModernSelect
                :model-value="selectedAgentId"
                :options="agentOptions"
                :aria-label="$t('agentSettings.agentList')"
                :empty-text="$t('agentSettings.empty')"
                menu-class="agent-settings-agent-menu"
                :menu-min-width="200"
                @update:model-value="selectAgent"
              />
            </div>

            <nav :aria-label="$t('agentSettings.categories')">
              <button type="button" class="agent-settings-nav-item" :class="{ active: activeCategory === 'operations' }" @click="activeCategory = 'operations'">
                <svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.4 7.4 0 0 0-1.62-.94L14.38 2.8a.49.49 0 0 0-.49-.41h-3.84a.49.49 0 0 0-.49.41L9.2 5.34c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.66 8.86a.5.5 0 0 0 .12.64l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.49.41h3.84c.25 0 .45-.17.49-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.02-1.6zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"/></svg>
                {{ $t('agentSettings.categories.operations') }}
              </button>
              <button type="button" class="agent-settings-nav-item" :class="{ active: activeCategory === 'trace' }" @click="activeCategory = 'trace'">
                <svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M3 3h2v16h16v2H3V3zm4 12 4-4 3 3 5-6 1.5 1.3-6.4 7.7-3.1-3.1-2.6 2.5L7 15z"/></svg>
                {{ $t('agentSettings.categories.trace') }}
              </button>
              <button type="button" class="agent-settings-nav-item" :class="{ active: activeCategory === 'llm' }" @click="activeCategory = 'llm'">
                <svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M12 2a4 4 0 0 1 3.87 3h.63a3.5 3.5 0 0 1 2.62 5.82A4 4 0 0 1 17 18.87V20h-2v-2h1a2 2 0 0 0 .45-3.95l-.8-.18.03-.82a1.5 1.5 0 0 0 1.72-2.43l-.68-.69.5-.84A1.5 1.5 0 0 0 16.5 7H14V6a2 2 0 1 0-4 0v12a2 2 0 1 0 4 0h2a4 4 0 0 1-7 2.65A4 4 0 0 1 4.13 15H4a3.5 3.5 0 0 1-1.7-6.56A4 4 0 0 1 9 4.35 4 4 0 0 1 12 2zM6 6a2 2 0 0 0-1.9 2.62l.3.9-.88.38A1.5 1.5 0 0 0 4 13h2v1a2 2 0 0 0 2 2V6.5A2 2 0 0 0 6 6z"/></svg>
                {{ $t('agentSettings.categories.llm') }}
              </button>
              <button type="button" class="agent-settings-nav-item" :class="{ active: activeCategory === 'quick-send' }" @click="activeCategory = 'quick-send'">
                <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="m13 2-9 12h7l-1 8 10-13h-7l1-7z"/></svg>
                {{ $t('quickSend.title') }}
              </button>
            </nav>
          </aside>

          <main v-if="selectedAgent" class="agent-settings-content">
            <div v-if="activeCategory !== 'llm'" class="agent-settings-identity">
              <div>
                <h3>{{ selectedAgent.name || selectedAgent.id }}</h3>
                <code>{{ selectedAgent.id }}</code>
              </div>
              <span class="agent-settings-status" :class="{ online: selectedAgent.online }">
                <span class="status-dot" :class="{ online: selectedAgent.online }"></span>
                {{ selectedAgent.online ? $t('agentSettings.online') : $t('agentSettings.offline') }}
              </span>
            </div>

            <template v-if="activeCategory === 'operations'">
              <section class="agent-settings-section">
                <div class="agent-settings-section-heading">
                  <h4>{{ $t('agentSettings.runtime.title') }}</h4>
                </div>
                <dl class="agent-settings-detail-list">
                  <div class="agent-settings-detail-item">
                    <dt>{{ $t('agentSettings.runtime.version') }}</dt>
                    <dd>
                      <strong>{{ selectedAgent.version ? 'v' + selectedAgent.version : '—' }}</strong>
                      <small v-if="selectedAgent.upgradeAvailable">{{ $t('agentSettings.runtime.updateAvailable', { version: selectedAgent.upgradeAvailable }) }}</small>
                      <small v-else>{{ $t('agentSettings.runtime.updateUnknown') }}</small>
                    </dd>
                  </div>
                  <div class="agent-settings-detail-item">
                    <dt>{{ $t('agentSettings.runtime.workDir') }}</dt>
                    <dd><strong :title="selectedAgent.workDir || ''">{{ selectedAgent.workDir || '—' }}</strong></dd>
                  </div>
                </dl>
                <div class="agent-settings-row">
                  <div>
                    <strong>{{ $t('chat.agent.dream') }}</strong>
                    <p>{{ $t('chat.agent.dreamHint') }}</p>
                  </div>
                  <label class="agent-settings-switch">
                    <input type="checkbox" :checked="selectedAgent.dreamEnabled === true" :disabled="!selectedAgent.online || dreamState.pending" @change="setDreamEnabled($event.target.checked)">
                    <span aria-hidden="true"></span>
                  </label>
                </div>
                <p v-if="dreamState.error" class="error">{{ dreamState.error }}</p>
                <div class="agent-settings-maintenance">
                  <p>{{ $t('agentSettings.maintenance.description') }}</p>
                  <div class="agent-settings-actions">
                    <button class="btn-secondary" type="button" :disabled="busy || !selectedAgent.online" @click="upgradeAgent">
                      {{ upgrading ? $t('chat.agent.upgrading') : $t('chat.agent.upgrade') }}
                    </button>
                    <button class="agent-settings-danger-button" type="button" :disabled="busy || !selectedAgent.online" @click="restartAgent">
                      {{ restarting ? $t('chat.agent.restarting') : $t('chat.agent.restart') }}
                    </button>
                  </div>
                </div>
              </section>
            </template>

            <section v-else-if="activeCategory === 'trace'" class="agent-settings-section">
              <div class="agent-settings-section-heading">
                <div>
                  <h4>{{ $t('agentSettings.telemetry.title') }}</h4>
                  <p>{{ $t('settings.general.telemetryDesc') }}</p>
                </div>
                <button class="btn-ghost" type="button" :disabled="telemetryLoading || !selectedAgent.online" @click="loadTelemetry">
                  {{ $t('common.refresh') }}
                </button>
              </div>
              <div v-if="telemetryLoading" class="agent-settings-loading"><span class="spinner-mini"></span> {{ $t('common.loading') }}</div>
              <template v-else>
                <div class="agent-settings-row">
                  <div>
                    <strong>{{ $t('settings.general.telemetry') }}</strong>
                    <p>{{ telemetryDraft.enabled !== false ? $t('settings.general.telemetryOn') : $t('settings.general.telemetryOff') }}</p>
                  </div>
                  <label class="agent-settings-switch">
                    <input type="checkbox" v-model="telemetryDraft.enabled" :disabled="telemetrySaving || !selectedAgent.online">
                    <span aria-hidden="true"></span>
                  </label>
                </div>
                <div class="agent-settings-save-row">
                  <span v-if="telemetryMessage" :class="{ error: telemetryError }">{{ telemetryMessage }}</span>
                  <button class="btn-primary" type="button" :disabled="telemetrySaving || !selectedAgent.online" @click="saveTelemetry">
                    {{ telemetrySaving ? $t('common.saving') : $t('common.save') }}
                  </button>
                </div>
              </template>
            </section>

            <QuickSendSettings v-else-if="activeCategory === 'quick-send'" :agent-id="selectedAgentId" @saved="$emit('saved', $event)" />

            <div v-else class="agent-settings-llm">
              <div v-if="llmMessage" class="agent-settings-inline-message" :class="{ error: llmMessageError }">{{ llmMessage }}</div>
              <LlmTab context="yeaft" :agent-id="selectedAgentId" @message="onLlmMessage" @saved="$emit('saved', selectedAgentId)" />
            </div>
          </main>
          <main v-else class="agent-settings-content agent-settings-empty">{{ $t('agentSettings.empty') }}</main>
        </div>
      </section>
    </div>
  `,
  data() {
    return {
      activeCategory: ['operations', 'trace', 'llm', 'quick-send'].includes(this.initialCategory) ? this.initialCategory : 'operations',
      selectedAgentId: null,
      telemetryDraft: { ...DEFAULT_TELEMETRY },
      telemetryLoading: false,
      telemetrySaving: false,
      telemetryMessage: '',
      telemetryError: false,
      telemetryGeneration: 0,
      llmMessage: '',
      llmMessageError: false,
    };
  },
  computed: {
    store() { return Pinia.useChatStore(); },
    agents() { return this.store.agents || []; },
    agentOptions() {
      return this.agents.map(agent => ({
        value: agent.id,
        label: agent.name || agent.id,
        badge: agent.online ? this.$t('agentSettings.online') : this.$t('agentSettings.offline'),
      }));
    },
    selectedAgent() { return this.agents.find(agent => agent.id === this.selectedAgentId) || null; },
    operations() { return this.store.agentOperations?.[this.selectedAgentId] || {}; },
    restarting() { return this.operations.restart?.pending === true; },
    upgrading() { return this.operations.upgrade?.pending === true; },
    dreamState() { return this.store.agentDreamState?.[this.selectedAgentId] || {}; },
    busy() { return this.restarting || this.upgrading; },
  },
  watch: {
    agents: {
      immediate: true,
      deep: true,
      handler(agents) {
        if (!agents.some(agent => agent.id === this.selectedAgentId)) {
          this.selectAgent(agents.find(agent => agent.id === this.initialAgentId)?.id || agents.find(agent => agent.id === this.store.currentAgent)?.id || agents[0]?.id || null);
        }
      },
    },
  },
  methods: {
    selectAgent(agentId) {
      if (this.selectedAgentId !== agentId) this.selectedAgentId = agentId;
      this.telemetryGeneration += 1;
      this.telemetryLoading = false;
      this.telemetrySaving = false;
      this.telemetryDraft = { ...DEFAULT_TELEMETRY };
      this.telemetryMessage = '';
      this.telemetryError = false;
      this.llmMessage = '';
      this.llmMessageError = false;
      if (agentId && this.agents.find(agent => agent.id === agentId)?.online) this.loadTelemetry();
    },
    onLlmMessage(message, isError = false) {
      this.llmMessage = message;
      this.llmMessageError = isError;
    },
    async loadTelemetry() {
      const agentId = this.selectedAgentId;
      if (!agentId) return;
      const generation = ++this.telemetryGeneration;
      this.telemetryLoading = true;
      this.telemetryMessage = '';
      try {
        const settings = await this.store.loadTelemetrySettings(agentId);
        if (generation !== this.telemetryGeneration || agentId !== this.selectedAgentId) return;
        if (settings?.error) throw new Error(settings.error);
        this.telemetryDraft = { ...DEFAULT_TELEMETRY, ...settings };
      } catch (error) {
        if (generation !== this.telemetryGeneration || agentId !== this.selectedAgentId) return;
        this.telemetryError = true;
        this.telemetryMessage = error?.message || this.$t('agentSettings.telemetry.loadFailed');
      } finally {
        if (generation === this.telemetryGeneration && agentId === this.selectedAgentId) this.telemetryLoading = false;
      }
    },
    async saveTelemetry() {
      const agentId = this.selectedAgentId;
      if (!agentId) return;
      const generation = ++this.telemetryGeneration;
      this.telemetrySaving = true;
      this.telemetryMessage = '';
      try {
        const settings = await this.store.updateTelemetrySettings(this.telemetryDraft, agentId);
        if (generation !== this.telemetryGeneration || agentId !== this.selectedAgentId) return;
        if (settings?.error) throw new Error(settings.error);
        this.telemetryDraft = { ...DEFAULT_TELEMETRY, ...settings };
        this.telemetryError = false;
        this.telemetryMessage = this.$t('agentSettings.telemetry.saved');
      } catch (error) {
        if (generation !== this.telemetryGeneration || agentId !== this.selectedAgentId) return;
        this.telemetryError = true;
        this.telemetryMessage = error?.message || this.$t('agentSettings.telemetry.saveFailed');
      } finally {
        if (generation === this.telemetryGeneration && agentId === this.selectedAgentId) this.telemetrySaving = false;
      }
    },
    setDreamEnabled(enabled) {
      if (this.selectedAgentId) this.store.setDreamEnabled(this.selectedAgentId, enabled);
    },
    async restartAgent() {
      const agent = this.selectedAgent;
      if (!agent || !await confirmDialog(this.$t('chat.agent.restartConfirm', { name: agent.name || agent.id }))) return;
      this.store.restartAgent(agent.id);
    },
    async upgradeAgent() {
      const agent = this.selectedAgent;
      if (!agent || !await confirmDialog(this.$t('chat.agent.upgradeConfirm', { name: agent.name || agent.id }))) return;
      this.store.upgradeAgent(agent.id);
    },
  },
};
