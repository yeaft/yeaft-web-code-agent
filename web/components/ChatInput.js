import { DEFAULT_SLASH_COMMANDS, getCommandDescription, buildGroupedCommands } from '../utils/slash-commands.js';
import { buildAutocompleteItems as buildExpertAutocomplete, getSelectionLabel, EXPERT_ROLES, MAX_SELECTIONS } from '../utils/expert-roles.js';
import { parseMentions } from '../utils/parseMentions.js';
import VpMentionAutocomplete, { filterVpMentions, applyMentionSelection, selectMentionCandidates } from './VpMentionAutocomplete.js';

export default {
  name: 'ChatInput',
  components: { VpMentionAutocomplete },
  props: {
    /** Custom send function: (text, attachmentInfos) => void. Overrides store.sendMessage. */
    sendFn: { type: Function, default: null },
    /** Custom cancel/stop function. Overrides store.cancelExecution. */
    cancelFn: { type: Function, default: null },
    /** i18n key for placeholder text. Defaults to 'chatInput.placeholder'. */
    placeholderKey: { type: String, default: '' },
    /** External processing flag. Controls stop button visibility. */
    showStop: { type: Boolean, default: false },
    /** Explicit Chat conversation this input controls. Defaults to the active view conversation. */
    conversationId: { type: String, default: null },
    /** Explicit draft scope. Use this when one conversation contains multiple logical inputs. */
    draftKey: { type: String, default: null }
  },
  template: `
    <footer class="input-area" ref="inputAreaRef">
      <!-- Expert chips bar (above attachments) — hidden in custom send mode and btw mode -->
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
      <div class="attachments-preview" v-if="attachmentsAllowed && attachments.length > 0">
        <div class="attachment-item" v-for="(file, index) in attachments" :key="index">
          <img v-if="file.preview" :src="file.preview" class="attachment-thumb" />
          <span v-else class="attachment-icon">\u{1F4CE}</span>
          <span class="attachment-name">{{ file.name }}</span>
          <button class="attachment-remove" @click="removeAttachment(index)">&times;</button>
        </div>
      </div>
      <div class="input-wrapper" :class="{ 'btw-active': store.btwMode }">
        <input
          v-if="attachmentsAllowed"
          type="file"
          ref="fileInput"
          id="chat-file-input"
          @change="handleFileSelect"
          multiple
          accept="image/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.json,.md,.py,.js,.ts,.css,.html"
          class="file-input-hidden"
        />
        <label v-if="attachmentsAllowed" class="attach-btn" for="chat-file-input" :title="$t('chatInput.upload')">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
          </svg>
        </label>
        <span v-if="store.btwMode" class="btw-input-tag">BTW</span>
        <div class="textarea-wrapper">
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
            v-if="!store.btwMode && showVpAutocomplete && !showExpertAutocomplete"
            :vps="mentionVpCandidates"
            :query="vpMentionQuery"
            :selected-index="vpSelectedIndex"
            @select="selectVpMention"
            @hover-index="vpSelectedIndex = $event"
          />
          <textarea
            ref="inputRef"
            v-model="inputText"
            @input="handleInput"
            @keydown="handleKeydown"
            @paste="handlePaste"
            @blur="onBlur"
            :placeholder="store.btwMode ? $t('btw.placeholder') : (isCompacting ? $t('chatHeader.compacting') : $t(effectivePlaceholderKey))"
            :disabled="isCompacting"
            rows="1"
          ></textarea>
        </div>
        <button
          v-if="isStopVisible"
          class="send-btn stop-btn"
          @click="cancelExecution"
          :title="$t('chatInput.stop')"
        >
          <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        </button>
        <button
          class="send-btn"
          @click="send"
          :disabled="!canSend"
          :title="$t('chatInput.send')"
        >
          <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </footer>
  `,
  setup(props) {
    const store = Pinia.useChatStore();
    const authStore = Pinia.useAuthStore();
    const vpStore = Pinia.useVpStore();
    // task-338-F4: resolve groups store for Yeaft group-chat dispatch routing.
    const sessionsStore = (Pinia.useSessionsStore ? Pinia.useSessionsStore() : null);
    const inputText = Vue.ref('');
    const inputRef = Vue.ref(null);
    const fileInput = Vue.ref(null);
    const attachments = Vue.ref([]); // { file, name, preview?, uploading, fileId? }
    const uploading = Vue.ref(false);
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
      return selectMentionCandidates(vpStore.vpList, sessionsStore.sessions?.[activeSessionId]);
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
    // 优先读取当前 conversation 的 commands，fallback 到 agent 级别，再 fallback 到默认列表
    const availableCommands = Vue.computed(() => {
      const convId = store.currentConversation;
      const agentId = store.currentAgent;
      const dynamic = (convId && store.slashCommandsMap[convId])
        || (agentId && store.slashCommandsMap[`agent:${agentId}`])
        || [];
      const commands = [...new Set([...DEFAULT_SLASH_COMMANDS, ...dynamic])];
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
    const groupedCommands = Vue.computed(() => buildGroupedCommands(flatItems.value));

    // Keep filteredCommands as flat string array for keyboard nav compatibility
    const filteredCommands = Vue.computed(() => flatItems.value.map(item => item.cmd));

    const effectiveConversationId = Vue.computed(() => {
      return props.conversationId || store.activeConversationId || store.currentConversation || null;
    });

    const isCompacting = Vue.computed(() => {
      return store.compactStatus?.status === 'compacting'
        && store.compactStatus?.conversationId === effectiveConversationId.value;
    });

    const canSend = Vue.computed(() => {
      if (isCompacting.value) return false;
      const hasText = !!inputText.value.trim();
      const hasAttachments = attachments.value.length > 0;

      // Custom send mode (e.g. Yeaft page): simplified check — no conversation needed
      if (isCustomSend.value) {
        const notUploading = !uploading.value && attachments.value.every(a => a.fileId);
        return (hasText || hasAttachments) && notUploading;
      }

      const hasExperts = expertSelections.value.length > 0;
      // Can send if: (text OR attachments OR (experts with action — pure role needs text))
      const hasActionExpert = expertSelections.value.some(s => s.action);
      const hasContent = hasText || hasAttachments || (hasExperts && (hasText || hasActionExpert));
      const notUploading = !uploading.value && attachments.value.every(a => a.fileId);
      return hasContent && store.currentAgent && store.currentConversation && notUploading;
    });

    const autoResize = () => {
      const textarea = inputRef.value;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      }
    };

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
      // 延迟关闭以允许 mousedown 事件触发
      setTimeout(() => {
        showAutocomplete.value = false;
        showExpertAutocomplete.value = false;
        showVpAutocomplete.value = false;
      }, 150);
    };

    const handleFileSelect = async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        await addFiles(files);
      }
      e.target.value = '';
      Vue.nextTick(() => {
        inputRef.value?.focus();
      });
    };

    const handlePaste = async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        await addFiles(files);
      }
    };

    const addFiles = async (files) => {
      for (const file of files) {
        const attachment = {
          file,
          name: file.name,
          preview: null,
          uploading: true,
          fileId: null
        };

        if (file.type.startsWith('image/')) {
          attachment.preview = URL.createObjectURL(file);
        }

        attachments.value.push(attachment);
      }

      uploading.value = true;
      try {
        const formData = new FormData();
        for (const file of files) {
          formData.append('files', file);
        }

        const headers = {};
        if (authStore.token) {
          headers['Authorization'] = `Bearer ${authStore.token}`;
        }
        const response = await fetch('/api/upload', {
          method: 'POST',
          headers,
          body: formData
        });

        if (!response.ok) {
          throw new Error('Upload failed');
        }

        const result = await response.json();

        let resultIndex = 0;
        for (const attachment of attachments.value) {
          if (attachment.uploading && !attachment.fileId) {
            if (resultIndex < result.files.length) {
              attachment.fileId = result.files[resultIndex].fileId;
              attachment.uploading = false;
              resultIndex++;
            }
          }
        }
      } catch (error) {
        console.error('Upload error:', error);
        const failed = attachments.value.filter(a => !a.fileId);
        for (const f of failed) {
          if (f.preview) URL.revokeObjectURL(f.preview);
        }
        attachments.value = attachments.value.filter(a => a.fileId);
      } finally {
        uploading.value = false;
        Vue.nextTick(() => {
          inputRef.value?.focus();
        });
      }
    };

    const removeAttachment = (index) => {
      const attachment = attachments.value[index];
      if (attachment.preview) {
        URL.revokeObjectURL(attachment.preview);
      }
      attachments.value.splice(index, 1);
      Vue.nextTick(() => {
        inputRef.value?.focus();
      });
    };

    const send = () => {
      if (!canSend.value) return;

      showAutocomplete.value = false;
      showExpertAutocomplete.value = false;
      showVpAutocomplete.value = false;

      const trimmed = inputText.value.trim();

      // Custom send mode: delegate to provided function
      if (props.sendFn) {
        const attachmentInfos = attachments.value
          .filter(a => a.fileId)
          .map(a => ({
            fileId: a.fileId,
            name: a.name,
            preview: a.preview,
            isImage: a.file?.type?.startsWith('image/') || false,
            mimeType: a.file?.type || ''
          }));

        props.sendFn(trimmed, attachmentInfos.length > 0 ? attachmentInfos : undefined);

        attachments.value = [];
        inputText.value = '';
        if (effectiveDraftKey.value) delete store.inputDrafts[effectiveDraftKey.value];
        if (inputRef.value) inputRef.value.style.height = 'auto';
        return;
      }

      // Intercept /btw — enter btw mode (with or without initial question)
      if (trimmed === '/btw' || trimmed.startsWith('/btw ')) {
        const question = trimmed.substring(4).trim();
        store.enterBtwMode();
        if (question) store.sendBtwQuestion(question);
        inputText.value = '';
        if (effectiveDraftKey.value) delete store.inputDrafts[effectiveDraftKey.value];
        if (inputRef.value) inputRef.value.style.height = 'auto';
        return;
      }

      // In btw mode, all sends go through btw channel
      if (store.btwMode) {
        store.sendBtwQuestion(trimmed);
        inputText.value = '';
        if (effectiveDraftKey.value) delete store.inputDrafts[effectiveDraftKey.value];
        if (inputRef.value) inputRef.value.style.height = 'auto';
        return;
      }

      // Build attachmentInfos once — every send branch (chat / yeaft
      // group) wants the same shape. Previously the Yeaft branches
      // `return`ed before this, silently dropping the user's selected
      // files. Now the store-side helpers (`sendYeaft*`) know how to
      // forward them; we just need to make sure the array is available
      // before the dispatch.
      const attachmentInfos = attachments.value
        .filter(a => a.fileId)
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
        attachments.value = [];
        inputText.value = '';
        if (effectiveDraftKey.value) delete store.inputDrafts[effectiveDraftKey.value];
        if (inputRef.value) inputRef.value.style.height = 'auto';
        return;
      }

      const currentExpertSelections = [...expertSelections.value];
      store.sendMessage(inputText.value.trim(), attachmentInfos, { expertSelections: currentExpertSelections });

      attachments.value = [];
      inputText.value = '';
      store.expertSelections = [];
      if (effectiveDraftKey.value) delete store.inputDrafts[effectiveDraftKey.value];

      if (inputRef.value) {
        inputRef.value.style.height = 'auto';
      }
    };

    const handleKeydown = (e) => {
      // Esc exits btw mode
      if (e.key === 'Escape' && store.btwMode) {
        e.preventDefault();
        store.closeBtw();
        return;
      }
      // ★ task-334j: VP autocomplete keyboard nav (before expert, same contract)
      if (showVpAutocomplete.value) {
        const vpList = filterVpMentions(mentionVpCandidates.value, vpMentionQuery.value);
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

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    };

    const cancelExecution = () => {
      if (props.cancelFn) {
        props.cancelFn();
      } else {
        store.cancelExecution();
      }
    };

    return {
      store,
      inputText,
      inputRef,
      inputAreaRef,
      fileInput,
      attachments,
      uploading,
      canSend,
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
      // Methods
      autoResize,
      handleInput,
      selectCommand,
      onBlur,
      handleFileSelect,
      handlePaste,
      removeAttachment,
      send,
      handleKeydown,
      cancelExecution,
      // task-334j: VP autocomplete + reply-to
      vpStore,
      showVpAutocomplete,
      vpSelectedIndex,
      vpMentionQuery,
      mentionVpCandidates,
      selectVpMention,
      // feat-vp-list-ui-polish: imperative API for parents (YeaftPage)
      // to append an `@<vpId> ` token to the draft. Exposed via the
      // setup return so it shows up on the template ref.
      appendMention,
    };
  }
};
