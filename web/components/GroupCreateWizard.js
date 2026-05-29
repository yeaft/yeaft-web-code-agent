/**
 * GroupCreateWizard — single-page version (task-fix 5-bugs v2).
 *
 * One modal, one scroll:
 *   - Name field on top
 *   - Roster (VP checkboxes) below
 *   - Default-VP radio beside each selected member (compact)
 *   - Cancel + Create in the footer
 *
 * Previous 2-step flow felt 罗嗦 (redundant). All fields are visible
 * simultaneously now — if the user changes their mind about the name
 * after picking members, they don't have to click "back".
 *
 * Roster is authoritative — the wizard does NOT auto-expand to the full
 * VP library (D1 seed is the only place that does). An empty roster is
 * permitted; the group opens in the `no_default_vp` invite state and the
 * invite modal nudges the user on first send.
 *
 * Flow: useChatStore().groupCrudRequest('create', …) → 10s-timeout
 * WS round-trip → `{ok, op, group?, error?}`.
 */
// Stores are resolved lazily via window.Pinia to keep this module
// importable in node-only unit tests that don't mount Pinia.

export default {
  name: 'GroupCreateWizard',
  emits: ['close', 'created'],
  template: `
    <Teleport to="body">
    <div class="group-edit-overlay group-wizard-overlay" @click.self="onOverlayClick" role="dialog" aria-modal="true" :aria-label="$t('unify.group.wizard.title')">
      <div class="group-edit-modal group-wizard-modal">
        <header class="group-edit-header">
          <span class="group-edit-title">{{ $t('unify.group.wizard.title') }}</span>
          <button class="group-edit-close" type="button" @click="requestClose" :aria-label="$t('unify.group.wizard.close')">×</button>
        </header>

        <div class="group-wizard-body group-wizard-body-single">
          <!-- NAME -->
          <label class="group-wizard-field">
            <span class="group-wizard-field-label">{{ $t('unify.group.wizard.step.name') }}</span>
            <input
              type="text"
              v-model.trim="form.name"
              :placeholder="$t('unify.group.wizard.namePlaceholder')"
              maxlength="60"
              autocomplete="off"
              class="group-wizard-input"
              :class="{ 'is-error': !!nameError }"
              ref="nameInput"
              @keydown.enter.prevent="onSubmit"
            />
            <span class="group-wizard-hint">{{ $t('unify.group.wizard.nameHint') }}</span>
            <span v-if="nameError" class="group-wizard-error">{{ nameError }}</span>
          </label>

          <!-- WORK DIR -->
          <label class="group-wizard-field">
            <span class="group-wizard-field-label">{{ $t('unify.group.wizard.workDir') }}</span>
            <div class="group-wizard-workdir-row">
              <input
                type="text"
                v-model.trim="form.workDir"
                :placeholder="$t('unify.group.wizard.workDirPlaceholder')"
                autocomplete="off"
                class="group-wizard-input"
                @keydown.enter.prevent="onSubmit"
              />
              <button
                class="group-wizard-browse-btn"
                type="button"
                @click="openFolderPicker"
                :disabled="busy || !folderPickerAgentId"
                :title="$t('crewConfig.browse')"
              >
                <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
              </button>
            </div>
            <span class="group-wizard-hint">{{ $t('unify.group.wizard.workDirHint') }}</span>
          </label>

          <!-- ROSTER -->
          <div class="group-wizard-field">
            <span class="group-wizard-field-label">{{ $t('unify.group.wizard.roster') }}</span>
            <span class="group-wizard-hint">{{ $t('unify.group.wizard.rosterHint') }}</span>
            <div v-if="vpList.length === 0 && vpLibraryEmpty" class="group-wizard-empty">
              {{ $t('unify.group.wizard.rosterEmpty') }}
            </div>
            <div v-else-if="vpList.length === 0" class="group-wizard-empty group-wizard-empty-loading">
              {{ $t('unify.group.wizard.rosterLoading') }}
            </div>
            <ul v-else class="group-wizard-roster-list" role="listbox" aria-multiselectable="true">
              <li
                v-for="vp in vpList"
                :key="vp.vpId"
                class="group-wizard-roster-item"
                :class="{ 'is-selected': form.roster.includes(vp.vpId), 'is-default': form.defaultVpId === vp.vpId }"
                role="option"
                :aria-selected="form.roster.includes(vp.vpId)"
              >
                <label class="group-wizard-roster-row">
                  <input
                    type="checkbox"
                    class="group-wizard-roster-check"
                    :value="vp.vpId"
                    :checked="form.roster.includes(vp.vpId)"
                    @change="toggleMember(vp.vpId, $event.target.checked)"
                  />
                  <span class="group-wizard-roster-name" :style="{ color: vpTextColorFor(vp.vpId) }">{{ vpLabelFor(vp.vpId) }}</span>
                </label>
                <button
                  v-if="form.roster.includes(vp.vpId)"
                  type="button"
                  class="group-wizard-default-star"
                  :class="{ 'is-on': form.defaultVpId === vp.vpId }"
                  :aria-label="$t('unify.group.wizard.defaultVpHint')"
                  :aria-pressed="form.defaultVpId === vp.vpId"
                  :title="$t('unify.group.wizard.defaultVpHint')"
                  @click.stop="form.defaultVpId = vp.vpId"
                >
                  <span aria-hidden="true">{{ form.defaultVpId === vp.vpId ? '★' : '☆' }}</span>
                </button>
              </li>
            </ul>
          </div>

          <div v-if="submitError" class="group-wizard-error" role="alert">
            {{ submitError }}
          </div>

          <div class="group-wizard-actions">
            <button class="group-wizard-link-btn" type="button" @click="requestClose" :disabled="busy">
              {{ $t('unify.group.wizard.cancel') }}
            </button>
            <button
              class="group-wizard-primary-btn"
              type="button"
              @click="onSubmit"
              :disabled="busy || !canAdvanceFromName"
            >
              {{ busy ? $t('unify.group.wizard.creating') : $t('unify.group.wizard.create') }}
            </button>
          </div>
        </div>

        <div class="folder-picker-overlay" v-if="folderPickerOpen" @click.self="closeFolderPicker">
          <div class="folder-picker-dialog">
            <div class="folder-picker-header">
              <span>{{ $t('modal.folderPicker.title') }}</span>
              <button class="wb-btn-sm" type="button" @click="closeFolderPicker">&times;</button>
            </div>
            <div class="folder-picker-path">
              <button class="wb-btn-sm" type="button" @click="folderPickerNavigateUp" :disabled="!folderPickerPath" :title="$t('modal.folderPicker.parentDir')">
                <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
              </button>
              <span class="folder-picker-current">{{ folderPickerPath || $t('common.rootDir') }}</span>
            </div>
            <div class="folder-picker-list">
              <div class="git-loading" v-if="folderPickerLoading" style="padding:12px"><span class="spinner-mini"></span> {{ $t('common.loading') }}</div>
              <template v-else>
                <div
                  v-for="entry in folderPickerEntries"
                  :key="entry.name"
                  class="tree-item tree-dir folder-picker-item"
                  :class="{ 'folder-picker-selected': folderPickerSelected === entry.name }"
                  @click="folderPickerSelectItem(entry)"
                  @dblclick="folderPickerEnter(entry)"
                >
                  <span class="tree-icon"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg></span>
                  <span class="tree-name">{{ entry.name }}</span>
                </div>
                <div class="tree-empty" v-if="folderPickerEntries.length === 0">{{ $t('common.noSubdirectories') }}</div>
              </template>
            </div>
            <div class="folder-picker-footer">
              <button class="modern-btn primary" type="button" @click="confirmFolderPicker" :disabled="!folderPickerPath">{{ $t('common.confirm') }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    </Teleport>
  `,
  data() {
    return {
      form: {
        name: '',
        roster: [],
        defaultVpId: null,
        workDir: '',
      },
      busy: false,
      nameError: '',
      submitError: '',
      folderPickerOpen: false,
      folderPickerPath: '',
      folderPickerEntries: [],
      folderPickerLoading: false,
      folderPickerSelected: '',
      _folderPickerTimer: null,
    };
  },
  computed: {
    chat() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useChatStore) {
          return window.Pinia.useChatStore();
        }
      } catch (_) {}
      return null;
    },
    vpStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useVpStore) {
          return window.Pinia.useVpStore();
        }
      } catch (_) {}
      return null;
    },
    groupsStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useGroupsStore) {
          return window.Pinia.useGroupsStore();
        }
      } catch (_) {}
      return null;
    },
    vpList() { return this.vpStore?.vpList || []; },
    // task-339-F2 defensive: distinguish "snapshot received and empty" (emptyLibrary=true)
    // from "snapshot not received yet" (emptyLibrary=false && vpList=0 && lastSnapshotAt=0).
    vpLibraryEmpty() {
      const s = this.vpStore;
      if (!s) return false;
      if (s.emptyLibrary === true) return true;
      return !!(s.lastSnapshotAt && s.lastSnapshotAt > 0 && (s.vpOrder?.length || 0) === 0);
    },
    canAdvanceFromName() { return (this.form.name || '').trim().length > 0; },
    folderPickerAgentId() {
      const chat = this.chat;
      return chat?.currentAgent || chat?.agents?.[0]?.id || '';
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onEsc);
    window.addEventListener('workbench-message', this.handleFolderPickerMessage);
    this.$nextTick(() => {
      const el = this.$refs.nameInput;
      if (el && typeof el.focus === 'function') el.focus();
    });
    // task-347 Fix 2: proactively subscribe to VP snapshot on mount.
    try {
      if (this.vpStore && this.vpStore.lastSnapshotAt === 0) {
        const chat = this.chat;
        if (chat && typeof chat.sendWsMessage === 'function') {
          chat.sendWsMessage({ type: 'unify_vp_subscribe' });
        }
      }
    } catch (_) { /* test env without Pinia/ws — no-op */ }
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onEsc);
    window.removeEventListener('workbench-message', this.handleFolderPickerMessage);
    if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
  },
  methods: {
    onEsc(e) {
      if (e.key === 'Escape' && !this.busy) this.requestClose();
    },
    onOverlayClick() {
      if (!this.busy) this.requestClose();
    },
    requestClose() { this.$emit('close'); },
    toggleMember(vpId, checked) {
      if (checked) {
        if (!this.form.roster.includes(vpId)) this.form.roster.push(vpId);
        if (!this.form.defaultVpId) this.form.defaultVpId = vpId;
      } else {
        this.form.roster = this.form.roster.filter(id => id !== vpId);
      }
      if (this.form.defaultVpId && !this.form.roster.includes(this.form.defaultVpId)) {
        this.form.defaultVpId = this.form.roster[0] || null;
      }
    },
    vpLabelFor(vpId) {
      const fn = this.vpStore?.vpLabel;
      return typeof fn === 'function' ? fn(vpId) : vpId;
    },
    vpTextColorFor(vpId) {
      const fn = this.vpStore?.vpTextColor;
      return typeof fn === 'function' ? fn(vpId) : 'var(--vp-avatar-rat-fg)';
    },
    openFolderPicker() {
      const agentId = this.folderPickerAgentId;
      if (!agentId || !this.chat?.sendWsMessage) return;
      const agent = this.chat.agents?.find(a => a.id === agentId);
      const defaultDir = (this.form.workDir || agent?.workDir || '').trim();
      this.folderPickerOpen = true;
      this.folderPickerSelected = '';
      this.folderPickerLoading = true;
      this.folderPickerPath = defaultDir;
      this.folderPickerEntries = [];
      const sendRequest = () => {
        this.chat.sendWsMessage({
          type: 'list_directory',
          conversationId: '_workdir_picker',
          agentId,
          dirPath: defaultDir,
          workDir: agent?.workDir || '',
        });
      };
      sendRequest();
      if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
      this._folderPickerTimer = setTimeout(() => {
        if (this.folderPickerLoading && this.folderPickerOpen) sendRequest();
      }, 5000);
    },
    closeFolderPicker() {
      this.folderPickerOpen = false;
      if (this._folderPickerTimer) {
        clearTimeout(this._folderPickerTimer);
        this._folderPickerTimer = null;
      }
    },
    loadFolderPickerDir(dirPath) {
      const agentId = this.folderPickerAgentId;
      if (!agentId || !this.chat?.sendWsMessage) return;
      const agent = this.chat.agents?.find(a => a.id === agentId);
      this.folderPickerLoading = true;
      this.folderPickerSelected = '';
      this.folderPickerEntries = [];
      this.chat.sendWsMessage({
        type: 'list_directory',
        conversationId: '_workdir_picker',
        agentId,
        dirPath,
        workDir: agent?.workDir || '',
      });
    },
    folderPickerNavigateUp() {
      if (!this.folderPickerPath) return;
      const isWin = this.folderPickerPath.includes('\\');
      const sep = isWin ? '\\' : '/';
      const parts = this.folderPickerPath.replace(/[/\\]$/, '').split(/[/\\]/);
      parts.pop();
      if (parts.length === 0) {
        this.folderPickerPath = '';
        this.loadFolderPickerDir('');
      } else if (isWin && parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) {
        this.folderPickerPath = `${parts[0]}\\`;
        this.loadFolderPickerDir(`${parts[0]}\\`);
      } else {
        const parent = parts.join(sep);
        this.folderPickerPath = parent;
        this.loadFolderPickerDir(parent);
      }
    },
    folderPickerSelectItem(entry) {
      this.folderPickerSelected = entry.name;
    },
    folderPickerEnter(entry) {
      const isWin = this.folderPickerPath.includes('\\') || /^[A-Z]:/.test(entry.name);
      const sep = isWin ? '\\' : '/';
      let next;
      if (!this.folderPickerPath) {
        next = /^[A-Z]:$/.test(entry.name) ? `${entry.name}\\` : `/${entry.name}`;
      } else {
        next = this.folderPickerPath.replace(/[/\\]$/, '') + sep + entry.name;
      }
      this.folderPickerPath = next;
      this.loadFolderPickerDir(next);
    },
    confirmFolderPicker() {
      let path = this.folderPickerPath;
      if (!path) return;
      if (this.folderPickerSelected) {
        const sep = path.includes('\\') ? '\\' : '/';
        path = path.replace(/[/\\]$/, '') + sep + this.folderPickerSelected;
      }
      this.form.workDir = path;
      this.closeFolderPicker();
    },
    handleFolderPickerMessage(event) {
      const msg = event.detail;
      if (!msg || msg.type !== 'directory_listing' || msg.conversationId !== '_workdir_picker') return;
      if (this._folderPickerTimer) {
        clearTimeout(this._folderPickerTimer);
        this._folderPickerTimer = null;
      }
      this.folderPickerLoading = false;
      this.folderPickerEntries = (msg.entries || [])
        .filter(e => e.type === 'directory')
        .sort((a, b) => a.name.localeCompare(b.name));
      if (msg.dirPath != null) this.folderPickerPath = msg.dirPath;
    },
    async onSubmit() {
      this.submitError = '';
      this.nameError = '';
      if (this.busy) return;
      if (!this.canAdvanceFromName) {
        this.nameError = this.$t('unify.group.error.invalid_name');
        return;
      }
      this.busy = true;
      try {
        const defaultVpId = this.form.defaultVpId || this.form.roster[0] || null;
        if (!this.chat) {
          this.submitError = this.$t('unify.group.error.unknown', { message: 'store unavailable' });
          return;
        }
        const res = await this.chat.groupCrudRequest('create', {
          name: this.form.name.trim(),
          roster: this.form.roster.slice(),
          defaultVpId,
          workDir: this.form.workDir.trim(),
        });
        if (res && res.ok) {
          this.$emit('created', res.group);
          this.$emit('close');
          return;
        }
        const code = (res && res.error && res.error.code) || 'unknown';
        const message = (res && res.error && res.error.message) || '';
        const msgKey = `unify.group.error.${code}`;
        // Always pass `{ message }` so any translation containing the
        // `{message}` placeholder (e.g. unify.group.error.unknown) gets
        // interpolated. If the key is missing, $t falls back to the key
        // itself — in that case, render the unknown fallback explicitly.
        const translated = this.$t(msgKey, { message });
        if (translated === msgKey) {
          this.submitError = this.$t('unify.group.error.unknown', { message });
        } else {
          this.submitError = translated;
        }
      } catch (err) {
        this.submitError = this.$t('unify.group.error.unknown', { message: err && err.message || String(err) });
      } finally {
        this.busy = false;
      }
    },
  },
};
