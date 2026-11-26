/**
 * Yeaft Cosmos — Click-Planet Quick Auto-Route Composer
 *
 * Clicking a planet opens this weightless, single-lens planetary command deck:
 * - Sends via `yeaft_auto_route_send` bound to that Agent (with attachments, model, effort & optional scene).
 * - Consolidates Model, Effort & localized Scene into a single calm upward-floating tuning popover.
 * - Always provides a clean borderless "Open Chat" link into the right conversation drawer.
 */
import ChatInput from '../ChatInput.js';
import CosmosComposerTuning from './CosmosComposerTuning.js';
import { sessionScenesForAgent } from '../SessionSceneSelect.js';
import {
  buildModelSelectionRows,
  getSelectableModelEfforts,
  modelOptionMatchesRef,
} from '../../utils/modelRefs.js';

export default {
  name: 'CosmosQuickComposer',
  components: { ChatInput, CosmosComposerTuning },
  props: {
    agent: { type: Object, required: true },
    planetId: { type: String, required: true },
  },
  emits: ['close', 'open-conversation', 'open-search', 'routed', 'open-llm-config'],
  template: `
    <section
      class="cosmos-quick-composer cosmos-composer-surface"
      :data-planet-theme="planetId"
      role="dialog"
      :aria-label="agent.name"
      @pointerdown.stop
      @wheel.stop
    >
      <header class="cosmos-quick-head">
        <div class="cosmos-quick-id">
          <span class="cosmos-planet-emblem" aria-hidden="true"></span>
          <span class="cosmos-quick-name">{{ agent.name }}</span>
        </div>
        <div class="cosmos-quick-head-actions">
          <button
            type="button"
            class="cosmos-quick-open-btn"
            :class="{ 'is-prominent': !hasRunningSessions }"
            :title="$t('cosmos.quick.openConversationTitle')"
            @click="$emit('open-conversation', { agentId: agent.id, sessionId: firstSessionId })"
          >
            <span>{{ $t('cosmos.quick.openConversation') }}</span>
            <span v-if="agent.sessions && agent.sessions.length > 0" class="cosmos-quick-session-count">{{ agent.sessions.length }}</span>
            <span class="cosmos-quick-open-arrow" aria-hidden="true">↗</span>
          </button>
          <button
            type="button"
            class="cosmos-icon-btn cosmos-quick-close-btn"
            :title="$t('cosmos.panel.close')"
            :aria-label="$t('cosmos.panel.close')"
            @click="$emit('close')"
          >
            <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </header>

      <div v-if="statusBanner" class="cosmos-quick-status" :class="{ 'is-error': statusBanner.error }" role="status">
        <span class="cosmos-quick-status-text">{{ statusBanner.text }}</span>
        <button
          v-if="statusBanner.sessionId"
          type="button"
          class="cosmos-toast-action"
          @click="$emit('open-conversation', { agentId: agent.id, sessionId: statusBanner.sessionId })"
        >{{ $t('cosmos.quick.viewSession') }}</button>
      </div>

      <ChatInput
        ref="chatInputRef"
        class="cosmos-quick-chat-input"
        :draft-key="'cosmos-quick:' + agent.id"
        :send-fn="handleQuickSend"
        :hide-vp-mentions="true"
        :disabled="!agent.online || routing"
        placeholder-key="cosmos.quick.inputPlaceholder"
        disabled-placeholder-key="cosmos.quick.offlineInputPlaceholder"
      >
        <template #actions-end-before>
          <CosmosComposerTuning
            ref="tuningRef"
            :model-rows="modelRows"
            :active-model="selectedModel || (modelRows[0]?.modelRef || '')"
            :active-model-label="activeModelLabel"
            :effort-options="effortOptions"
            :active-effort="selectedEffort"
            :show-scene="true"
            :scene-options="sceneOptions"
            :active-scene="selectedScene"
            default-scene-id="auto"
            :scene-hint="$t('cosmos.composer.sceneAutoHint')"
            :disabled="!agent.online || routing"
            :scope-key="agent.id"
            @select-model="onSelectModel"
            @select-effort="selectEffort"
            @select-scene="selectScene"
            @open-llm-config="$emit('open-llm-config', agent.id)"
          />
        </template>
      </ChatInput>
    </section>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const { proxy } = Vue.getCurrentInstance();
    const $t = (k, p) => (proxy?.$t ? proxy.$t(k, p) : k);

    const chatInputRef = Vue.ref(null);
    const tuningRef = Vue.ref(null);
    const routing = Vue.ref(false);
    const statusBanner = Vue.ref(null);
    const selectedScene = Vue.ref('auto');
    const selectedModel = Vue.ref('');
    const selectedEffort = Vue.ref('');
    let userPickedModel = false;
    let activeSendSeq = 0;

    const hasRunningSessions = Vue.computed(() => (props.agent?.liveSessions?.length || 0) > 0);
    const firstSessionId = Vue.computed(() => props.agent?.sessions?.[0]?.id || null);

    const isCurrentStoreAgent = Vue.computed(() => Boolean(props.agent?.id && props.agent.id === store.currentAgent));

    const agentModels = Vue.computed(() => {
      const cfg = store.llmConfig?.[props.agent?.id];
      const list = cfg?.agentConfig?.availableModels ?? cfg?.effectiveConfig?.availableModels;
      if (Array.isArray(list) && list.length > 0) return list;
      // Never bleed another Agent's model catalog into an unloaded target Agent.
      if (isCurrentStoreAgent.value && Array.isArray(store.yeaftAvailableModels)) {
        return store.yeaftAvailableModels;
      }
      return [];
    });

    const modelRows = Vue.computed(() => buildModelSelectionRows(agentModels.value));

    const activeModelMeta = Vue.computed(() => {
      if (!modelRows.value.length) return null;
      const found = modelRows.value.find((r) => modelOptionMatchesRef(r.model, selectedModel.value));
      return (found || modelRows.value[0]).model;
    });

    const activeModelLabel = Vue.computed(() => {
      if (!modelRows.value.length) return $t('settings.llm.selectModel');
      const row = modelRows.value.find((r) => modelOptionMatchesRef(r.model, selectedModel.value)) || modelRows.value[0];
      return row?.label || $t('settings.llm.selectModel');
    });

    const effortOptions = Vue.computed(() => {
      const m = activeModelMeta.value;
      return m ? getSelectableModelEfforts(m.effortOptions, m) : [];
    });

    const sceneOptions = Vue.computed(() => {
      const list = [
        { id: 'auto', label: $t('cosmos.quick.sceneAuto') },
        { id: 'none', label: $t('cosmos.quick.sceneNone') },
      ];
      const supportedIds = sessionScenesForAgent(
        (capability) => store.hasAgentCapability?.(props.agent?.id, capability),
      );
      for (const sid of supportedIds) {
        if (sid === 'general') continue;
        const key = `yeaft.session.scene.${sid}`;
        const translated = $t(key);
        list.push({ id: sid, label: translated === key ? sid : translated });
      }
      return list;
    });

    const sceneLabel = Vue.computed(() => {
      const hit = sceneOptions.value.find((o) => o.id === selectedScene.value);
      return hit ? hit.label : $t('cosmos.quick.sceneAuto');
    });

    function syncDefaultModelFromConfig() {
      const agentId = props.agent?.id;
      const cfg = agentId ? store.llmConfig?.[agentId] : null;
      const cfgPrimary = cfg?.agentConfig?.primaryModel || cfg?.effectiveConfig?.primaryModel || '';
      const cfgEffort = cfg?.agentConfig?.defaultEffort || cfg?.effectiveConfig?.defaultEffort || '';
      if (cfgPrimary) {
        selectedModel.value = cfgPrimary;
        const opts = effortOptions.value;
        selectedEffort.value = (cfgEffort && opts.includes(cfgEffort)) ? cfgEffort : (opts[0] || '');
        return;
      }
      if (isCurrentStoreAgent.value) {
        selectedModel.value = store.yeaftModel || '';
        const opts = effortOptions.value;
        selectedEffort.value = opts.includes(store.yeaftModelEffort) ? store.yeaftModelEffort : (opts[0] || '');
        return;
      }
      // Keep empty until target Agent's own llm_config loads so quickSend stays null
      // and the target Agent safely uses its own configured default model.
      selectedModel.value = '';
      selectedEffort.value = '';
    }

    function ensureTargetLlmConfig() {
      const agentId = props.agent?.id;
      if (!agentId || !props.agent?.online) return;
      if (store.llmConfig?.[agentId]) return;
      store.sendWsMessage?.({ type: 'get_llm_config', agentId });
    }

    Vue.watch(
      () => [props.agent?.id, props.agent?.online],
      ([nextId], [prevId] = []) => {
        if (nextId !== prevId) {
          routing.value = false;
          statusBanner.value = null;
          tuningRef.value?.close?.(false);
          selectedScene.value = 'auto';
          userPickedModel = false;
          syncDefaultModelFromConfig();
          Vue.nextTick(() => chatInputRef.value?.focusInput?.());
        }
        ensureTargetLlmConfig();
      },
      { immediate: true },
    );

    Vue.watch(
      () => store.llmConfig?.[props.agent?.id],
      (cfg) => {
        if (!cfg || userPickedModel) return;
        syncDefaultModelFromConfig();
      },
    );

    Vue.watch(sceneOptions, (options) => {
      if (!options.some((opt) => opt.id === selectedScene.value)) {
        selectedScene.value = 'auto';
      }
    });

    const selectScene = (id) => {
      selectedScene.value = id;
    };

    const selectModel = (modelRef, defaultEffort) => {
      userPickedModel = true;
      selectedModel.value = modelRef;
      const opts = effortOptions.value;
      selectedEffort.value = (defaultEffort && opts.includes(defaultEffort)) ? defaultEffort : (opts[0] || '');
    };

    const onSelectModel = ({ modelRef, defaultEffort }) => {
      selectModel(modelRef, defaultEffort);
    };

    const selectEffort = (eff) => {
      userPickedModel = true;
      if (!selectedModel.value && modelRows.value[0]?.modelRef) {
        selectedModel.value = modelRows.value[0].modelRef;
      }
      selectedEffort.value = eff;
    };

    const handleQuickSend = async (text, attachmentInfos, quote) => {
      if (!props.agent?.online) return false;
      const targetAgentId = props.agent.id;
      const targetAgentName = props.agent.name || targetAgentId;
      const targetPlanetId = props.planetId;
      const sendSeq = ++activeSendSeq;

      tuningRef.value?.close?.(false);
      routing.value = true;
      statusBanner.value = { error: false, text: $t('cosmos.quick.routing', { name: targetAgentName }), sessionId: null };

      // Merely displaying the Agent default isn't a one-message override. A
      // normal send can attach to the active Turn and inherit its settings.
      const quickSend = userPickedModel && selectedModel.value
        ? { model: selectedModel.value, effort: selectedEffort.value || null }
        : null;

      try {
        const res = await store.sendYeaftAutoRouteMessage({
          agentId: targetAgentId,
          text,
          attachments: Array.isArray(attachmentInfos) ? attachmentInfos : undefined,
          preferredSceneId: selectedScene.value,
          quickSend,
          quote,
          cosmosDelivery: true,
        });

        const isStillSameTarget = props.agent?.id === targetAgentId && activeSendSeq === sendSeq;
        if (isStillSameTarget) routing.value = false;

        if (!res?.ok) {
          if (isStillSameTarget) {
            const msg = res?.code === 'session_auto_route_unsupported'
              ? $t('cosmos.quick.unsupported', { name: targetAgentName })
              : $t('cosmos.quick.routeFailed', { error: res?.error || res?.code || 'unknown' });
            statusBanner.value = { error: true, text: msg, sessionId: null };
          }
          return false;
        }

        const title = res.title || res.sessionId || targetAgentName;
        let okText;
        if (res.answeredAskUser) okText = $t('cosmos.quick.routedAskUser', { title });
        else if (res.delivery === 'appended') okText = $t('cosmos.quick.routedAppended', { title });
        else if (res.decision === 'created') okText = $t('cosmos.quick.routedCreated', { name: targetAgentName, title });
        else okText = $t('cosmos.quick.routedMatched', { title });
        if (isStillSameTarget) {
          statusBanner.value = { error: false, text: okText, sessionId: res.sessionId || null };
        }
        emit('routed', {
          agentId: targetAgentId,
          planetId: targetPlanetId,
          result: res,
          message: okText,
        });
        return true;
      } catch (err) {
        if (props.agent?.id === targetAgentId && activeSendSeq === sendSeq) {
          routing.value = false;
          statusBanner.value = { error: true, text: $t('cosmos.quick.routeFailed', { error: err?.message || 'error' }), sessionId: null };
        }
        return false;
      }
    };

    return {
      chatInputRef,
      tuningRef,
      routing,
      statusBanner,
      selectedScene,
      selectedModel,
      selectedEffort,
      hasRunningSessions,
      firstSessionId,
      modelRows,
      activeModelLabel,
      effortOptions,
      sceneOptions,
      sceneLabel,
      selectScene,
      selectModel,
      onSelectModel,
      selectEffort,
      handleQuickSend,
    };
  },
};
