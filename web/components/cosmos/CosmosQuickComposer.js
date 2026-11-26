/**
 * Yeaft Cosmos — Click-Planet Quick Auto-Route Composer
 *
 * Clicking a planet opens this lightweight planetary composer deck:
 * - Sends via `yeaft_auto_route_send` bound to that Agent (with attachments, model, effort & optional scene).
 * - Always provides an "Open Chat" entrance to the right conversation drawer (highlighted when no sessions are running).
 */
import ChatInput from '../ChatInput.js';
import { SESSION_SCENE_IDS } from '../SessionSceneSelect.js';
import {
  buildModelSelectionRows,
  getSelectableModelEfforts,
  modelOptionMatchesRef,
} from '../../utils/modelRefs.js';

export default {
  name: 'CosmosQuickComposer',
  components: { ChatInput },
  props: {
    agent: { type: Object, required: true },
    planetId: { type: String, required: true },
  },
  emits: ['close', 'open-conversation', 'routed', 'open-llm-config'],
  template: `
    <section
      class="cosmos-quick-composer"
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
          <span class="cosmos-quick-badge">{{ $t('cosmos.quick.badge') }}</span>
          <span v-if="!hasRunningSessions" class="cosmos-quick-idle-hint">{{ $t('cosmos.quick.noRunningHint') }}</span>
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
            <span aria-hidden="true">↗</span>
          </button>
          <button
            type="button"
            class="cosmos-icon-btn"
            :title="$t('cosmos.panel.close')"
            :aria-label="$t('cosmos.panel.close')"
            @click="$emit('close')"
          >
            <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </header>

      <div v-if="statusBanner" class="cosmos-quick-status" :class="{ 'is-error': statusBanner.error }" role="status">
        <span>{{ statusBanner.text }}</span>
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
        <template #actions-start>
          <div class="yeaft-composer-choice" :class="{ 'is-open': openMenu === 'scene' }">
            <button
              type="button"
              class="cosmos-quick-scene-btn"
              aria-haspopup="menu"
              :aria-expanded="openMenu === 'scene' ? 'true' : 'false'"
              @click.stop="toggleMenu('scene')"
            >
              <span>{{ sceneLabel }}</span>
              <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
            </button>
            <div v-if="openMenu === 'scene'" class="yeaft-model-dropdown" role="menu">
              <button
                v-for="opt in sceneOptions"
                :key="opt.id"
                type="button"
                class="yeaft-model-option"
                :class="{ active: selectedScene === opt.id }"
                role="menuitemradio"
                :aria-checked="selectedScene === opt.id ? 'true' : 'false'"
                @click="selectScene(opt.id)"
              >
                <span class="yeaft-model-check" aria-hidden="true">{{ selectedScene === opt.id ? '✓' : '' }}</span>
                <span class="yeaft-model-option-label">{{ opt.label }}</span>
              </button>
            </div>
          </div>
        </template>

        <template #actions-end-before>
          <div class="yeaft-composer-model-controls" v-if="modelRows.length > 0">
            <div class="yeaft-composer-choice" :class="{ 'is-open': openMenu === 'model' }">
              <button
                type="button"
                class="yeaft-composer-model"
                aria-haspopup="menu"
                :aria-expanded="openMenu === 'model' ? 'true' : 'false'"
                @click.stop="toggleMenu('model')"
              >
                <span class="yeaft-composer-model-name">{{ activeModelLabel }}</span>
                <svg class="yeaft-model-chevron" :class="{ open: openMenu === 'model' }" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
              </button>
              <div v-if="openMenu === 'model'" class="yeaft-model-dropdown yeaft-composer-model-dropdown" role="menu">
                <div class="yeaft-model-list">
                  <button
                    v-for="row in modelRows"
                    :key="row.modelRef"
                    type="button"
                    class="yeaft-model-option"
                    :class="{ active: modelOptionMatchesRef(row.model, selectedModel) }"
                    role="menuitemradio"
                    :aria-checked="modelOptionMatchesRef(row.model, selectedModel) ? 'true' : 'false'"
                    @click="selectModel(row.modelRef, row.defaultEffort)"
                  >
                    <span class="yeaft-model-check" aria-hidden="true">{{ modelOptionMatchesRef(row.model, selectedModel) ? '✓' : '' }}</span>
                    <span class="yeaft-model-option-main">
                      <span class="yeaft-model-option-label">{{ row.label }}</span>
                      <span class="yeaft-model-option-meta" v-if="row.model.provider">{{ row.model.provider }}</span>
                    </span>
                  </button>
                </div>
                <button type="button" class="yeaft-model-config-option" @click="$emit('open-llm-config', agent.id)">
                  <span class="yeaft-model-config-label">{{ $t('settings.llm.configureMenu') }}</span>
                </button>
              </div>
            </div>

            <div v-if="effortOptions.length > 0" class="yeaft-composer-choice" :class="{ 'is-open': openMenu === 'effort' }">
              <button
                type="button"
                class="yeaft-composer-effort"
                aria-haspopup="menu"
                :aria-expanded="openMenu === 'effort' ? 'true' : 'false'"
                @click.stop="toggleMenu('effort')"
              >
                <span>{{ $t('yeaft.modelMenu.effort.' + (selectedEffort || effortOptions[0])) }}</span>
                <svg class="yeaft-model-chevron" :class="{ open: openMenu === 'effort' }" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
              </button>
              <div v-if="openMenu === 'effort'" class="yeaft-model-dropdown yeaft-composer-effort-dropdown" role="menu">
                <button
                  v-for="eff in effortOptions"
                  :key="eff"
                  type="button"
                  class="yeaft-model-option yeaft-composer-effort-option"
                  :class="{ active: eff === selectedEffort }"
                  role="menuitemradio"
                  :aria-checked="eff === selectedEffort ? 'true' : 'false'"
                  @click="selectEffort(eff)"
                >
                  <span class="yeaft-model-check" aria-hidden="true">{{ eff === selectedEffort ? '✓' : '' }}</span>
                  <span class="yeaft-model-option-label">{{ $t('yeaft.modelMenu.effort.' + eff) }}</span>
                </button>
              </div>
            </div>
          </div>
        </template>
      </ChatInput>
    </section>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const { proxy } = Vue.getCurrentInstance();
    const $t = (k, p) => (proxy?.$t ? proxy.$t(k, p) : k);

    const chatInputRef = Vue.ref(null);
    const openMenu = Vue.ref(null);
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
      for (const sid of (SESSION_SCENE_IDS || [])) {
        if (sid === 'general') continue;
        const key = `yeaft.scene.${sid}`;
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
          openMenu.value = null;
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

    const toggleMenu = (name) => {
      openMenu.value = openMenu.value === name ? null : name;
    };

    const selectScene = (id) => {
      selectedScene.value = id;
      openMenu.value = null;
    };

    const selectModel = (modelRef, defaultEffort) => {
      userPickedModel = true;
      selectedModel.value = modelRef;
      const opts = effortOptions.value;
      selectedEffort.value = (defaultEffort && opts.includes(defaultEffort)) ? defaultEffort : (opts[0] || '');
      openMenu.value = null;
    };

    const selectEffort = (eff) => {
      userPickedModel = true;
      selectedEffort.value = eff;
      openMenu.value = null;
    };

    const closeOutside = (e) => {
      if (openMenu.value && !e.target.closest('.yeaft-composer-choice')) {
        openMenu.value = null;
      }
    };

    Vue.onMounted(() => document.addEventListener('click', closeOutside));
    Vue.onBeforeUnmount(() => document.removeEventListener('click', closeOutside));

    const handleQuickSend = async (text, attachmentInfos, quote) => {
      if (!props.agent?.online) return false;
      const targetAgentId = props.agent.id;
      const targetAgentName = props.agent.name || targetAgentId;
      const targetPlanetId = props.planetId;
      const sendSeq = ++activeSendSeq;

      routing.value = true;
      statusBanner.value = { error: false, text: $t('cosmos.quick.routing', { name: targetAgentName }), sessionId: null };

      const quickSend = selectedModel.value
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
        const okText = res.answeredAskUser
          ? $t('cosmos.quick.routedAskUser', { title })
          : (res.decision === 'created'
            ? $t('cosmos.quick.routedCreated', { name: targetAgentName, title })
            : $t('cosmos.quick.routedMatched', { title }));
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
      openMenu,
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
      modelOptionMatchesRef,
      toggleMenu,
      selectScene,
      selectModel,
      selectEffort,
      handleQuickSend,
    };
  },
};
