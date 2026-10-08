import { DEFAULT_SLASH_COMMANDS, YEAFT_DEFAULT_SLASH_COMMANDS, getCommandDescription, buildGroupedCommands, mergeSlashCommands, resolveDynamicSlashCommands } from '../utils/slash-commands.js';
import { buildAutocompleteItems as buildExpertAutocomplete, getSelectionLabel, EXPERT_ROLES, MAX_SELECTIONS } from '../utils/expert-roles.js';
import { parseMentions } from '../utils/parseMentions.js';
import VpMentionAutocomplete, {
  filterVpMentions,
  applyMentionSelection,
  selectMentionCandidates,
  vpMentionListboxId,
  vpMentionOptionId,
} from './VpMentionAutocomplete.js';
import MessageComposer from './MessageComposer.js';
import { useComposerAttachments, uploadSessionAttachments, hasAttachmentFileId, SESSION_FILE_ACCEPT } from '../utils/composer-attachments.js';
import { useUserShortcuts, matchShortcut } from '../utils/user-shortcuts.js';

export default {
  name: 'ChatInput',
  components: { MessageComposer, VpMentionAutocomplete },
  props: {
    /** Custom send: (text, attachmentInfos, quote?, quickSend?) => value | Promise.
     * false/rejection retains the draft; acceptance transfers previews to messages. */
    sendFn: { type: Function, default: null },
    /** Explicit opt-in: CLI / Work Center do not support native per-turn model overrides. */
    quickSendEnabled: { type: Boolean, default: false },
    /** Custom cancel/stop function. Overrides store.cancelExecution. */
    cancelFn: { type: Function, default: null },
    /** i18n key for placeholder text. Defaults to 'chatInput.placeholder'. */
    placeholderKey: { type: String, default: '' },
    /** External processing flag. Controls stop button visibility. */
    showStop: { type: Boolean, default: false },
    /** Explicit Chat conversation this input controls. Defaults to the active view conversation. */
    conversationId: { type: String, default: null },
    /** Explicit draft scope. Use this when one conversation contains multiple logical inputs. */
    draftKey: { type: String, default: null },
    /** Structured Session message quote shown above the composer. */
    quote: { type: Object, default: null },
    disabled: { type: Boolean, default: false },
    disabledPlaceholderKey: { type: String, default: '' }
  },
  emits: ['remove-quote', 'quote-consumed'],
  template: `
    <footer class="input-area" ref="inputAreaRef">
      <!-- Expert chips bar (above attachments) — hidden in custom send mode and btw mode -->
      <div v-if="quote" class="input-quote-preview">
        <div class="input-quote-main">
          <div class="input-quote-meta">{{ $t('message.replyingTo', { author: quote.author }) }}</div>
          <div v-if="quote.content" class="input-quote-content">{{ quote.content }}</div>
          <div v-if="quote.todos && quote.todos.length" class="input-quote-todos">
            <div v-for="todo in quote.todos" :key="todo.content" class="input-quote-todo">
              <span class="input-quote-todo-status">{{ todoStatusSymbol(todo.status) }}</span>
              <span>{{ todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content }}</span>
            </div>
          </div>
        </div>
        <button type="button" class="input-quote-remove" @click="$emit('remove-quote')" :title="$t('message.removeQuote')" :aria-label="$t('message.removeQuote')">×</button>
      </div>
      <div class="expert-chips-bar" v-if="!sendFn && !store.btwMode && expertSelections.length > 0">
        <span
          v-for="(sel, index) in expertSelections"
          :key="sel.role + (sel.action || '')"
          class="expert-input-chip"
        >
          {{ getExpertLabel(sel) }}
          <button class="chip-remove" @click="removeExpertSelection(index)">&times;</button>
        </span>
      </div>
      <div
        v-if="quickSends.length && inputFocused"
        class="mobile-quick-send-bar"
        role="toolbar"
        :aria-label="$t('quickSend.composer.label')"
      >
        <button
          v-for="(preset, index) in quickSends"
          :key="preset.id || index"
          type="button"
          class="mobile-quick-send-button"
          :disabled="!canQuickSend"
          :title="preset.name"
          :aria-label="$t('quickSend.composer.send', { number: index + 1, name: preset.name })"
          @pointerdown.prevent
          @click="sendQuick(preset)"
        >
          <span>{{ preset.name }}</span>
        </button>
      </div>
      <MessageComposer
        ref="messageComposerRef"
        v-model="inputText"
        :class="{ 'btw-active': store.btwMode, 'is-disabled': disabled }"
        :placeholder="disabled && disabledPlaceholderKey ? $t(disabledPlaceholderKey) : (store.btwMode ? $t('btw.placeholder') : (isCompacting ? $t('chatHeader.compacting') : $t(effectivePlaceholderKey)))"
        :disabled="isCompacting || disabled"
        :can-send="canSend"
        :sending="sending"
        keyboard-send
        :attachments-enabled="attachmentsAllowed"
        :attachments="attachments"
        :attachment-accept="SESSION_FILE_ACCEPT"
        @files-selected="addFiles"
        @retry-attachment="retryAttachment"
        @remove-attachment="removeAttachment"
        :show-stop="isStopVisible"
        :input-id="inputElementId"
        :send-label="$t('chatInput.send')"
        :stop-label="$t('chatInput.stop')"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        :aria-controls="vpMentionPopupOpen ? vpMentionPopupId : null"
        :aria-activedescendant="vpMentionActiveOptionId"
        @input="handleInput"
        @keydown="handleKeydown"
        @focus="inputFocused = true"
        @blur="onBlur"
        @send="send"
        @stop="cancelExecution"
      >
        <template #overlays>
          <!-- Slash command autocomplete -->
          <div class="slash-autocomplete" v-if="!store.btwMode && showAutocomplete && flatItems.length > 0" ref="autocompleteRef">
            <template v-for="group in groupedCommands" :key="group.label">
              <div class="slash-group-label">{{ group.label }}</div>
              <div
                v-for="item in group.items"
                :key="item.cmd"
                class="slash-autocomplete-item"
                :class="{ active: item.flatIndex === selectedIndex }"
                @mousedown.prevent="selectCommand(item.cmd)"
                @mouseenter="selectedIndex = item.flatIndex"
              >
                <span class="slash-cmd-name">{{ item.cmd }}</span>
                <span class="slash-cmd-desc">{{ item.desc }}</span>
              </div>
              <div v-if="!group.isLast" class="slash-group-separator"></div>
            </template>
          </div>
          <!-- @ Expert autocomplete -->
          <div class="slash-autocomplete expert-autocomplete" v-if="!store.btwMode && showExpertAutocomplete && expertAutocompleteFiltered.length > 0" ref="expertAutocompleteRef">
            <div class="slash-group-label">Experts</div>
            <div
              v-for="(item, idx) in expertAutocompleteFiltered"
              :key="item.roleId + (item.actionId || '')"
              class="slash-autocomplete-item"
              :class="{ active: idx === expertSelectedIndex }"
              @mousedown.prevent="selectExpertItem(item)"
              @mouseenter="expertSelectedIndex = idx"
            >
              <span class="slash-cmd-name">{{ item.displayText }}</span>
              <span class="slash-cmd-desc">{{ item.roleTitle }}</span>
            </div>
          </div>
          <!-- task-334j: VP @ autocomplete (mutually exclusive with expert) -->
          <VpMentionAutocomplete
            v-if="vpMentionPopupOpen"
            :vps="mentionVpCandidates"
            :query="vpMentionQuery"
            :selected-index="vpSelectedIndex"
            :input-id="inputElementId"
            @select="selectVpMention"
            @hover-index="vpSelectedIndex = $event"
          />
        </template>
        <template #start-actions>
          <span v-if="store.btwMode" class="btw-input-tag">BTW</span>
          <slot name="actions-start"></slot>
        </template>
        <template #end-actions-before>
          <slot name="actions-end-before"></slot>
        </template>
      </MessageComposer>
    </footer>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const authStore = Pinia.useAuthStore();
    const vpStore = Pinia.useVpStore();
    // task-338-F4: resolve groups store for Yeaft group-chat dispatch routing.
    const sessionsStore = (Pinia.useSessionsStore ? Pinia.useSessionsStore() : null);
    const inputText = Vue.ref('');
    const inputFocused = Vue.ref(false);
    const messageComposerRef = Vue.ref(null);
    const inputRef = Vue.computed(() => messageComposerRef.value?.getTextarea?.() || null);
    const componentUid = Vue.getCurrentInstance()?.uid ?? 0;
    const inputElementId = `chat-input-${componentUid}`;
    const sending = Vue.ref(false);
    const inputAreaRef = Vue.ref(null);
    const autocompleteRef = Vue.ref(null);
    const expertAutocompleteRef = Vue.ref(null);

    // Derived: is this a custom-send context?
    const isCustomSend = Vue.computed(() => !!props.sendFn);

    const attachmentsAllowed = Vue.computed(() => {
      if (store.btwMode) return false;
      return true;
    });

    // Placeholder i18n key
    const effectivePlaceholderKey = Vue.computed(() => props.placeholderKey || 'chatInput.placeholder');

    // Stop button visibility: use prop or fall back to store.isProcessing
    const isStopVisible = Vue.computed(() => props.showStop || (!isCustomSend.value && store.isProcessing));

    // Expert panel selections: synced with store
    const expertSelections = Vue.computed({
      get: () => store.expertSelections || [],
      set: (val) => { store.expertSelections = val; }
    });

    // @ expert autocomplete state
    const showExpertAutocomplete = Vue.ref(false);
    const expertSelectedIndex = Vue.ref(0);
    const allExpertItems = Vue.computed(() => buildExpertAutocomplete(store.customExpertRoles));

    const expertAutocompleteFiltered = Vue.computed(() => {
      const text = inputText.value;
      const atIdx = text.lastIndexOf('@');
      if (atIdx === -1 || !showExpertAutocomplete.value) return [];
      const query = text.slice(atIdx + 1).toLowerCase();
      return allExpertItems.value
        .filter(item => {
          if (!query) return true;
          return item.searchText.includes(query);
        })
        .filter(item => {
          // Exclude already-selected roles
          return !expertSelections.value.some(s => s.role === item.roleId);
        })
        .slice(0, 12); // limit results
    });

    const selectExpertItem = (item) => {
      if (expertSelections.value.length >= MAX_SELECTIONS) return;
      const newSelection = { role: item.roleId, action: item.actionId };
      store.expertSelections = [...expertSelections.value, newSelection];
      // Remove @query from input text
      const text = inputText.value;
      const atIdx = text.lastIndexOf('@');
      if (atIdx !== -1) {
        inputText.value = text.slice(0, atIdx).trimEnd();
      }
      showExpertAutocomplete.value = false;
      Vue.nextTick(() => inputRef.value?.focus());
    };

    const removeExpertSelection = (index) => {
      const arr = [...expertSelections.value];
      arr.splice(index, 1);
      store.expertSelections = arr;
    };

    const getExpertLabel = (sel) => getSelectionLabel(sel, store.customExpertRoles);
    const todoStatusSymbol = (status) => {
      if (status === 'completed') return '✓';
      if (status === 'in_progress') return '→';
      return '○';
    };

    // ★ task-334j: VP @ autocomplete state (mutually exclusive with expert autocomplete).
    // Gating: show VP autocomplete when in Yeaft multi-VP context; otherwise expert.
    const showVpAutocomplete = Vue.ref(false);
    const vpSelectedIndex = Vue.ref(0);

    const isInYeaftGroupContext = () => {
      // task-338-F5: decouple gate from VP list hydration state so Yeaft
      // view always routes `@` to VP candidates. Empty-state rendering is
      // handled downstream by VpMentionAutocomplete. But keep the gate tied
      // to the actual send surface: Chat mode must stay on the expert path,
      // while group/Yeaft mode alone gets VP mentions. This prevents a mode
      // check from making ordinary Chat messages follow group semantics.
      return store.currentView === 'yeaft' && !!store.currentAgent;
    };

    const vpMentionQuery = Vue.computed(() => {
      const text = inputText.value;
      const atIdx = text.lastIndexOf('@');
      if (atIdx < 0 || !showVpAutocomplete.value) return '';
      return text.slice(atIdx + 1);
    });

    // Group-scoped `@` autocomplete: only roster VPs are mentionable.
    // Active-group resolution mirrors YeaftPage's middle-column resolver
    // (filter wins, then sessionsStore.activeSessionId, then no group).
    //
    // TODO(arch): this `yeaftActiveSessionFilter || activeSessionId` chain is
    //   duplicated in YeaftPage.js (timeline + topbar) and MessageList.js
    //   (IM layout gate). Consolidate into a `sessionsStore.activeGroupIdResolved`
    //   getter and migrate all call sites in a follow-up PR.
    const mentionVpCandidates = Vue.computed(() => {
      if (!sessionsStore) return vpStore.vpList || [];
      const activeSessionId = store.yeaftActiveSessionFilter || sessionsStore.activeSessionId || null;
      const activeSession = typeof sessionsStore.sessionById === 'function'
        ? sessionsStore.sessionById(activeSessionId, store.currentAgent || null)
        : sessionsStore.sessions?.[activeSessionId];
      return selectMentionCandidates(vpStore.vpList, activeSession);
    });
    const filteredVpMentions = Vue.computed(() => (
      filterVpMentions(mentionVpCandidates.value, vpMentionQuery.value)
    ));
    const vpMentionPopupOpen = Vue.computed(() => (
      !store.btwMode
      && showVpAutocomplete.value
      && !showExpertAutocomplete.value
      && filteredVpMentions.value.length > 0
    ));
    const vpMentionPopupId = vpMentionListboxId(inputElementId);
    const vpMentionActiveOptionId = Vue.computed(() => {
      if (!vpMentionPopupOpen.value) return null;
      const activeVp = filteredVpMentions.value[vpSelectedIndex.value];
      return activeVp ? vpMentionOptionId(inputElementId, activeVp.vpId) : null;
    });

    const selectVpMention = (vp) => {
      if (!vp || !vp.vpId) return;
      inputText.value = applyMentionSelection(inputText.value, vp.vpId);
      showVpAutocomplete.value = false;
      vpSelectedIndex.value = 0;
      Vue.nextTick(() => inputRef.value?.focus());
    };

    const effectiveDraftKey = Vue.computed(() => {
      return props.draftKey || props.conversationId || store.currentConversation || null;
    });

    // 恢复当前会话的草稿
    if (effectiveDraftKey.value && store.inputDrafts[effectiveDraftKey.value]) {
      inputText.value = store.inputDrafts[effectiveDraftKey.value];
    }

    // 监听输入变化，保存草稿到 store
    Vue.watch(inputText, (val) => {
      const key = effectiveDraftKey.value;
      if (key) {
        if (val) {
          store.inputDrafts[key] = val;
        } else {
          delete store.inputDrafts[key];
        }
      }
    });
    Vue.watch(filteredVpMentions, (list) => {
      if (list.length === 0) {
        vpSelectedIndex.value = 0;
        return;
      }
      if (vpSelectedIndex.value >= list.length) vpSelectedIndex.value = list.length - 1;
    });

    // 切换会话时恢复/保存草稿
    Vue.watch(effectiveDraftKey, (newId, oldId) => {
      if (oldId && inputText.value) {
        store.inputDrafts[oldId] = inputText.value;
      }
      inputText.value = (newId && store.inputDrafts[newId]) || '';
    });

    // feat-vp-list-ui-polish: external mention API. Parents that need to
    // inject an `@<vpId> ` token into the draft (e.g. YeaftPage when its
    // Session status pane gets clicked) call this via a template ref. Keeping
    // the mechanism imperative — and the Yeaft-specific knowledge
    // (`@<vpId>` syntax, which view it lives in) out of this generic
    // component — avoids a reverse dependency where the shared input
    // would need to know about Yeaft state. A leading space is added so
    // the boundary regex in parseMentions accepts the mention; trailing
    // space gives the user a clean place to keep typing.
    const appendMention = (vpId) => {
      if (!vpId || typeof vpId !== 'string') return;
      const current = inputText.value || '';
      const needsSpace = current.length > 0 && !/\s$/.test(current);
      const next = current + (needsSpace ? ' ' : '') + '@' + vpId + ' ';
      inputText.value = next;
      Vue.nextTick(() => {
        const ta = inputRef.value;
        if (!ta) return;
        ta.focus();
        // Caret to end so the user can keep typing after the mention.
        ta.setSelectionRange(next.length, next.length);
        // Re-run the autosize hook so the textarea grows if the appended
        // mention pushed past one line.
        autoResize();
      });
    };

    // Slash command 自动补全状态
    const showAutocomplete = Vue.ref(false);
    const selectedIndex = Vue.ref(0);

    // 获取可用的 slash commands（确保都有 / 前缀）
    // Custom-send contexts (Yeaft) pass their logical conversationId explicitly;
    // `store.currentConversation` can still point at the previous Chat pane until
    // session_ready migrates the placeholder. Prefer the prop so Yeaft `/` sees
    // agent-level skill commands immediately.
    const availableCommands = Vue.computed(() => {
      const convId = props.conversationId || store.activeConversationId || store.currentConversation;
      const agentId = store.currentAgent;
      const dynamic = resolveDynamicSlashCommands(store, convId, agentId);
      const defaults = store.currentView === 'yeaft'
        ? YEAFT_DEFAULT_SLASH_COMMANDS
        : DEFAULT_SLASH_COMMANDS;
      const commands = mergeSlashCommands(defaults, dynamic);
      return commands.map(cmd => cmd.startsWith('/') ? cmd : '/' + cmd);
    });

    // Flat list of filtered items: { cmd, desc }[]
    const flatItems = Vue.computed(() => {
      const text = inputText.value.trim();
      if (!text.startsWith('/')) return [];
      const prefix = text.toLowerCase();
      return availableCommands.value
        .filter(cmd => cmd.toLowerCase().startsWith(prefix) && cmd.toLowerCase() !== prefix)
        .map(cmd => ({
          cmd,
          desc: getCommandDescription(cmd, store.slashCommandDescriptions)
        }));
    });

    // Grouped commands for rendering: [{ label, items: [{ cmd, desc, flatIndex }], isLast }]
    const groupedCommands = Vue.computed(() => buildGroupedCommands(flatItems.value, store.slashCommandDescriptions, availableCommands.value));

    // Keep filteredCommands as flat string array for keyboard nav compatibility
    const filteredCommands = Vue.computed(() => flatItems.value.map(item => item.cmd));

    const effectiveConversationId = Vue.computed(() => {
      return props.conversationId || store.activeConversationId || store.currentConversation || null;
    });

    const isCompacting = Vue.computed(() => {
      return store.compactStatus?.status === 'compacting'
        && store.compactStatus?.conversationId === effectiveConversationId.value;
    });

    const attachmentScope = () => JSON.stringify([
      authStore.userId, authStore.authGeneration, authStore.isAuthenticated,
      // Explicit logical drafts survive the placeholder -> real conversation migration.
      store.currentAgent, effectiveDraftKey.value,
    ]);
    const attachmentQueue = useComposerAttachments({
      scope: attachmentScope,
      enabled: () => attachmentsAllowed.value && !props.disabled && !isCompacting.value && !sending.value,
      upload: (rows, signal) => uploadSessionAttachments(rows, authStore, signal),
    });
    const { attachments, uploading, filesReady, addFiles, retryAttachment, removeAttachment } = attachmentQueue;
    const hasValidFileId = hasAttachmentFileId;
    let sendGeneration = 0;
    Vue.watch(attachmentScope, () => { sendGeneration++; sending.value = false; }, { flush: 'sync' });
    Vue.onBeforeUnmount(() => { sendGeneration++; });

    const canSend = Vue.computed(() => {
      if (props.disabled || isCompacting.value) return false;
      if (sending.value) return false;
      const hasText = !!inputText.value.trim();
      const hasAttachments = attachments.value.length > 0;

      // Custom send mode (e.g. Yeaft page): simplified check — no conversation needed
      if (isCustomSend.value) {
        const notUploading = filesReady.value;
        return (hasText || hasAttachments) && notUploading;
      }

      const hasExperts = expertSelections.value.length > 0;
      // Can send if: (text OR attachments OR (experts with action — pure role needs text))
      const hasActionExpert = expertSelections.value.some(s => s.action);
      const hasContent = hasText || hasAttachments || (hasExperts && (hasText || hasActionExpert));
      const notUploading = filesReady.value;
      return hasContent && store.currentAgent && store.currentConversation && notUploading;
    });

    const { preferences: shortcutPreferences } = useUserShortcuts();
    const quickSends = Vue.computed(() => {
      if (!props.quickSendEnabled || store.btwMode) return [];
      const config = store.llmConfig?.[store.currentAgent];
      if (!config?.loaded || config.error) return [];
      const items = config.agentConfig?.quickSends || config.effectiveConfig?.quickSends || [];
      return Array.isArray(items) ? items.slice(0, 5) : [];
    });
    const canQuickSend = Vue.computed(() => canSend.value && store.connectionState === 'connected'
      && store.agents?.some(agent => agent.id === store.currentAgent && agent.online));
    Vue.watch(() => [props.quickSendEnabled,
      store.currentAgent, store.connectionState, store.agents?.find(agent => agent.id === store.currentAgent)?.online],
    ([enabled, agentId, connection, online]) => {
      if (enabled && agentId && connection === 'connected' && online) {
        store.sendWsMessage({ type: 'get_llm_config', agentId });
      }
    }, { immediate: true });
    const sendQuick = (preset) => {
      if (!canQuickSend.value || !quickSends.value.includes(preset)) return;
      send({ model: preset.model, effort: preset.effort ?? null, maxOutputTokens: preset.maxOutputTokens ?? null });
    };

    const isMobileViewport = () => {
      if (typeof window === 'undefined') return false;
      try {
        return typeof window.matchMedia === 'function'
          ? window.matchMedia('(max-width: 768px)').matches
          : Number(window.innerWidth) <= 768;
      } catch (_) {
        return false;
      }
    };
    const exitMobileInput = () => {
      if (!isMobileViewport()) return;
      inputRef.value?.blur();
      const activeElement = globalThis.document?.activeElement;
      if (activeElement?.closest?.('[data-message-composer]')) activeElement.blur?.();
      inputFocused.value = false;
    };

    const autoResize = () => messageComposerRef.value?.autoResize?.();

    const resetTextareaSize = () => messageComposerRef.value?.resetTextareaSize?.();

    const handleInput = () => {
      autoResize();
      const text = inputText.value.trim();
      // Slash command autocomplete
      if (text.startsWith('/') && !text.includes(' ')) {
        showAutocomplete.value = true;
        selectedIndex.value = 0;
        showExpertAutocomplete.value = false;
      } else {
        showAutocomplete.value = false;
      }
      // @ autocomplete: VP (task-334j) vs Expert — mutually exclusive.
      const rawText = inputText.value;
      const atIdx = rawText.lastIndexOf('@');
      if (atIdx !== -1 && !showAutocomplete.value) {
        const charBefore = atIdx > 0 ? rawText[atIdx - 1] : ' ';
        if (charBefore === ' ' || charBefore === '\n' || atIdx === 0) {
          if (isInYeaftGroupContext()) {
            showVpAutocomplete.value = true;
            vpSelectedIndex.value = 0;
            showExpertAutocomplete.value = false;
          } else {
            showExpertAutocomplete.value = true;
            expertSelectedIndex.value = 0;
            showVpAutocomplete.value = false;
          }
        } else {
          showExpertAutocomplete.value = false;
          showVpAutocomplete.value = false;
        }
      } else if (atIdx === -1) {
        showExpertAutocomplete.value = false;
        showVpAutocomplete.value = false;
      }
    };

    const selectCommand = (cmd) => {
      inputText.value = cmd + ' ';
      showAutocomplete.value = false;
      Vue.nextTick(() => {
        inputRef.value?.focus();
      });
    };

    const onBlur = () => {
      inputFocused.value = false;
      // 延迟关闭以允许 mousedown 事件触发
      setTimeout(() => {
        showAutocomplete.value = false;
        showExpertAutocomplete.value = false;
        showVpAutocomplete.value = false;
      }, 150);
    };

    const send = (quickSend = null) => {
      if (!canSend.value) return;
      // Vue's ordinary send event has no preset; never treat a DOM event as configuration.
      if (!quickSend || typeof quickSend.model !== 'string') quickSend = null;

      showAutocomplete.value = false;
      showExpertAutocomplete.value = false;
      showVpAutocomplete.value = false;

      const trimmed = inputText.value.trim();

      // Custom send mode: delegate to provided function
      if (props.sendFn) {
        const attachmentInfos = attachments.value
          .filter(hasValidFileId)
          .map(a => ({
            fileId: a.fileId,
            name: a.name,
            preview: a.preview,
            isImage: a.file?.type?.startsWith('image/') || false,
            mimeType: a.file?.type || ''
          }));

        const attachmentPayload = attachmentInfos.length > 0 ? attachmentInfos : undefined;
        const sentRows = attachments.value.slice();
        const sentQuote = props.quote;
        const before = inputText.value;
        const identity = attachmentScope();
        const g = ++sendGeneration;
        const accept = accepted => {
          if (accepted === false || g !== sendGeneration || identity !== attachmentScope()) return;
          // Sent previews belong to the message projection, not the composer.
          attachmentQueue.release(sentRows);
          if (sentQuote && props.quote === sentQuote) emit('quote-consumed');
          if (inputText.value === before) {
            inputText.value = '';
            if (effectiveDraftKey.value) delete store.inputDrafts[effectiveDraftKey.value];
            resetTextareaSize();
          }
          exitMobileInput();
        };
        sending.value = true;
        try {
          const accepted = quickSend
            ? props.sendFn(trimmed, attachmentPayload, sentQuote, quickSend)
            : sentQuote ? props.sendFn(trimmed, attachmentPayload, sentQuote) : props.sendFn(trimmed, attachmentPayload);
          if (accepted && typeof accepted.then === 'function') {
            Promise.resolve(accepted).then(accept).catch(error => console.error('Send failed:', error))
              .finally(() => { if (g === sendGeneration) sending.value = false; });
          } else {
            accept(accepted);
            sending.value = false;
          }
        } catch (error) {
          sending.value = false;
          console.error('Send failed:', error);
        }
        return;
      }

      // Intercept /btw — enter btw mode (with or without initial question)
      if (trimmed === '/btw' || trimmed.startsWith('/btw ')) {
        const question = trimmed.substring(4).trim();
        store.enterBtwMode();
        if (question) store.sendBtwQuestion(question);
        inputText.value = '';
        if (effectiveDraftKey.value) delete store.inputDrafts[effectiveDraftKey.value];
        resetTextareaSize();
        exitMobileInput();
        return;
      }

      // In btw mode, all sends go through btw channel
      if (store.btwMode) {
        store.sendBtwQuestion(trimmed);
        inputText.value = '';
        if (effectiveDraftKey.value) delete store.inputDrafts[effectiveDraftKey.value];
        resetTextareaSize();
        exitMobileInput();
        return;
      }

      // Build attachmentInfos once — every send branch (chat / yeaft
      // group) wants the same shape. Previously the Yeaft branches
      // `return`ed before this, silently dropping the user's selected
      // files. Now the store-side helpers (`sendYeaft*`) know how to
      // forward them; we just need to make sure the array is available
      // before the dispatch.
      const attachmentInfos = attachments.value
        .filter(hasValidFileId)
        .map(a => ({
          fileId: a.fileId,
          name: a.name,
          preview: a.preview,
          isImage: a.file?.type?.startsWith('image/') || false,
          mimeType: a.file?.type || ''
        }));

      // Yeaft group-chat branch — Yeaft is conceptually a single conversation
      // backed by a group (default: grp_default). All Yeaft turns go through
      // the group path so the agent builds a coordinator and wires
      // ctx.router for the per-VP Engine query; otherwise `route_forward`
      // would bomb out with `router_unavailable` the moment a VP @-mentions
      // another VP. There is no longer a no-group backstop — the legacy
      // `yeaft_chat` WS frame and `handleYeaftChat` agent handler were
      // removed in v0.1.672.
      //
      // PR #721: also fire when text is empty but attachments are present
      // (image-only send). The store helper synthesizes a placeholder
      // text so the agent path runs end-to-end.
      if (store.currentView === 'yeaft' && (trimmed || attachmentInfos.length > 0)) {
        const mentions = parseMentions(trimmed).mentions;
        const groupId = store.yeaftActiveSessionFilter || sessionsStore?.activeSessionId || 'grp_default';
        store.sendYeaftSessionMessage({
          groupId,
          text: trimmed,
          mentions,
          attachments: attachmentInfos,
        });
        attachmentQueue.release();
        inputText.value = '';
        if (effectiveDraftKey.value) delete store.inputDrafts[effectiveDraftKey.value];
        resetTextareaSize();
        exitMobileInput();
        return;
      }

      const currentExpertSelections = [...expertSelections.value];
      store.sendMessage(inputText.value.trim(), attachmentInfos, { expertSelections: currentExpertSelections });

      attachmentQueue.release();
      inputText.value = '';
      store.expertSelections = [];
      if (effectiveDraftKey.value) delete store.inputDrafts[effectiveDraftKey.value];

      resetTextareaSize();
      exitMobileInput();
    };

    const handleKeydown = (e) => {
      // IME owns every key while composing. Safari can report isComposing=false
      // for the confirmation keydown but keeps the standard process keyCode.
      if (e.isComposing || e.keyCode === 229) return;
      if (!e.defaultPrevented && props.quickSendEnabled) {
        const slot = [1, 2, 3, 4, 5].find(number => matchShortcut(e, shortcutPreferences.value.bindings[`quickSend${number}`]));
        const preset = slot ? quickSends.value[slot - 1] : null;
        // An unconfigured or currently unavailable quick-send shortcut is inert:
        // do not consume Alt+1..5 unless this keypress can actually send.
        if (!e.repeat && preset && canQuickSend.value) {
          e.preventDefault();
          e.stopPropagation();
          sendQuick(preset);
          return;
        }
      }

      // Esc exits btw mode
      if (e.key === 'Escape' && store.btwMode) {
        e.preventDefault();
        store.closeBtw();
        return;
      }
      // ★ task-334j: VP autocomplete keyboard nav (before expert, same contract)
      if (showVpAutocomplete.value) {
        const vpList = filteredVpMentions.value;
        if (vpList.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            vpSelectedIndex.value = (vpSelectedIndex.value + 1) % vpList.length;
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            vpSelectedIndex.value = (vpSelectedIndex.value - 1 + vpList.length) % vpList.length;
            return;
          }
          if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
            e.preventDefault();
            selectVpMention(vpList[vpSelectedIndex.value]);
            return;
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          showVpAutocomplete.value = false;
          return;
        }
      }
      // @ Expert autocomplete keyboard nav
      if (showExpertAutocomplete.value && expertAutocompleteFiltered.value.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          expertSelectedIndex.value = (expertSelectedIndex.value + 1) % expertAutocompleteFiltered.value.length;
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          expertSelectedIndex.value = (expertSelectedIndex.value - 1 + expertAutocompleteFiltered.value.length) % expertAutocompleteFiltered.value.length;
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          selectExpertItem(expertAutocompleteFiltered.value[expertSelectedIndex.value]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          showExpertAutocomplete.value = false;
          return;
        }
      }
      // Slash command autocomplete keyboard nav
      if (showAutocomplete.value && filteredCommands.value.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectedIndex.value = (selectedIndex.value + 1) % filteredCommands.value.length;
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedIndex.value = (selectedIndex.value - 1 + filteredCommands.value.length) % filteredCommands.value.length;
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          selectCommand(filteredCommands.value[selectedIndex.value]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          showAutocomplete.value = false;
          return;
        }
      }

    };

    const cancelExecution = () => {
      if (props.cancelFn) {
        props.cancelFn();
      } else {
        store.cancelExecution();
      }
    };

    const replaceDraft = (text) => {
      inputText.value = typeof text === 'string' ? text : '';
      Vue.nextTick(() => {
        autoResize();
        inputRef.value?.focus();
        const length = inputText.value.length;
        inputRef.value?.setSelectionRange(length, length);
      });
    };

    const focusInput = () => Vue.nextTick(() => inputRef.value?.focus());

    return {
      store,
      inputText,
      inputFocused,
      inputRef,
      messageComposerRef,
      inputAreaRef,
      attachments,
      uploading,
      sending,
      SESSION_FILE_ACCEPT,
      canSend,
      quickSends,
      canQuickSend,
      shortcutPreferences,
      sendQuick,
      isCompacting,
      isStopVisible,
      effectivePlaceholderKey,
      attachmentsAllowed,
      showAutocomplete,
      selectedIndex,
      filteredCommands,
      flatItems,
      groupedCommands,
      autocompleteRef,
      // Props passed through for template access
      sendFn: Vue.toRef(props, 'sendFn'),
      // Expert panel
      expertSelections,
      showExpertAutocomplete,
      expertSelectedIndex,
      expertAutocompleteFiltered,
      expertAutocompleteRef,
      selectExpertItem,
      removeExpertSelection,
      getExpertLabel,
      todoStatusSymbol,
      // Methods
      autoResize,
      handleInput,
      selectCommand,
      onBlur,
      addFiles,
      retryAttachment,
      removeAttachment,
      send,
      handleKeydown,
      cancelExecution,
      // task-334j: VP autocomplete + reply-to
      vpStore,
      inputElementId,
      showVpAutocomplete,
      vpMentionPopupOpen,
      vpMentionPopupId,
      vpMentionActiveOptionId,
      vpSelectedIndex,
      vpMentionQuery,
      mentionVpCandidates,
      selectVpMention,
      // feat-vp-list-ui-polish: imperative API for parents (YeaftPage)
      // to append an `@<vpId> ` token to the draft. Exposed via the
      // setup return so it shows up on the template ref.
      appendMention,
      replaceDraft,
      focusInput,
    };
  }
};
