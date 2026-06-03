/**
 * SessionCreateModal — Phase 3 unified Session creation.
 *
 * A session is operationally a group with N≥1 VPs (the coordinator
 * already handles N=1 fan-out). This single-screen modal replaces the
 * old chat / group split in the create-entry surface:
 *   - Name input (optional — agent derives a default if empty)
 *   - Work dir input (optional — placeholder mirrors the chat work-dir default)
 *   - Collapsed VP multi-picker (Omni pre-checked; user can pick more)
 *   - Create button → store.createYeaftSession({ displayName, vpIds, workDir })
 *
 * Visual vocabulary mirrors GroupCreateWizard (overlay + body + actions)
 * so the look-and-feel stays consistent. All colours pulled from
 * design tokens in web/styles/variables.css — no hardcoded values.
 */
const OMNI_VP_ID = 'omni';

export default {
  name: 'SessionCreateModal',
  emits: ['close', 'created'],
  template: `
    <Teleport to="body">
    <div class="group-edit-overlay group-wizard-overlay" @click.self="onOverlayClick" role="dialog" aria-modal="true" :aria-label="$t('yeaft.session.create.title')">
      <div class="group-edit-modal group-wizard-modal">
        <header class="group-edit-header">
          <span class="group-edit-title">{{ $t('yeaft.session.create.title') }}</span>
          <button class="group-edit-close" type="button" @click="requestClose" :aria-label="$t('yeaft.session.wizard.close')">×</button>
        </header>

        <div class="group-wizard-body group-wizard-body-single">
          <label class="group-wizard-field" v-if="agentOptions.length > 1">
            <span class="group-wizard-field-label">{{ $t('yeaft.session.create.agentLabel') }}</span>
            <select v-model="form.agentId" class="group-wizard-input">
              <option v-for="a in agentOptions" :key="a.id" :value="a.id" :disabled="!a.online">
                {{ a.name || a.id }}{{ a.online ? '' : ' (offline)' }}
              </option>
            </select>
          </label>

          <label class="group-wizard-field">
            <span class="group-wizard-field-label">{{ $t('yeaft.session.create.nameLabel') }}</span>
            <input
              type="text"
              v-model.trim="form.name"
              :placeholder="$t('yeaft.session.create.namePlaceholder')"
              maxlength="60"
              autocomplete="off"
              class="group-wizard-input"
              ref="nameInput"
              @keydown.enter.prevent="onSubmit"
            />
          </label>

          <label class="group-wizard-field">
            <span class="group-wizard-field-label">{{ $t('yeaft.session.create.workDirLabel') }}</span>
            <span class="group-wizard-workdir-row">
              <input
                type="text"
                v-model.trim="form.workDir"
                :placeholder="workDirPlaceholder"
                autocomplete="off"
                class="group-wizard-input"
                @keydown.enter.prevent="onSubmit"
              />
              <button class="group-wizard-browse-btn" type="button" @click="openFolderPicker" :disabled="!folderPickerAgentId" :title="$t('modal.newConv.browse')">
                <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
              </button>
            </span>
          </label>

          <div class="group-wizard-field group-wizard-member-picker" ref="memberPicker">
            <span class="group-wizard-field-label">{{ $t('yeaft.session.create.vpPicker') }}</span>
            <div v-if="vpList.length === 0 && vpLibraryEmpty" class="group-wizard-empty">
              {{ $t('yeaft.session.wizard.rosterEmpty') }}
            </div>
            <div v-else-if="vpList.length === 0" class="group-wizard-empty group-wizard-empty-loading">
              {{ $t('yeaft.session.wizard.rosterLoading') }}
            </div>
            <template v-else>
              <button
                type="button"
                class="group-wizard-member-trigger"
                :class="{ 'is-open': memberPickerOpen }"
                :aria-expanded="memberPickerOpen ? 'true' : 'false'"
                aria-haspopup="listbox"
                @click="toggleMemberPicker"
              >
                <span class="group-wizard-member-summary" :class="{ 'is-empty': form.vpIds.length === 0 }">
                  {{ memberSummary }}
                </span>
                <svg class="group-wizard-member-arrow" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
              </button>
              <ul v-if="memberPickerOpen" class="group-wizard-roster-list group-wizard-roster-dropdown" role="listbox" aria-multiselectable="true">
                <li
                  v-for="vp in vpList"
                  :key="vp.vpId"
                  class="group-wizard-roster-item"
                  :class="{ 'is-selected': form.vpIds.includes(vp.vpId) }"
                  role="option"
                  :aria-selected="form.vpIds.includes(vp.vpId)"
                >
                  <label class="group-wizard-roster-row">
                    <input
                      type="checkbox"
                      class="group-wizard-roster-check"
                      :value="vp.vpId"
                      :checked="form.vpIds.includes(vp.vpId)"
                      @change="toggleVp(vp.vpId, $event.target.checked)"
                    />
                    <span class="group-wizard-roster-name" :style="{ color: vpTextColorFor(vp.vpId) }">{{ vpLabelFor(vp.vpId) }}</span>
                  </label>
                </li>
              </ul>
            </template>
          </div>

          <div v-if="submitError" class="group-wizard-error" role="alert">
            {{ submitError }}
          </div>

          <div class="group-wizard-actions">
            <button class="group-wizard-link-btn" type="button" @click="requestClose" :disabled="busy">
              {{ $t('yeaft.session.wizard.cancel') }}
            </button>
            <button
              class="group-wizard-primary-btn"
              type="button"
              @click="onSubmit"
              :disabled="busy || !canSubmit"
            >
              {{ busy ? $t('yeaft.session.wizard.creating') : $t('yeaft.session.create.submit') }}
            </button>
          </div>

          <div v-if="folderPickerOpen" class="folder-picker-overlay" @click.self="closeFolderPicker">
            <div class="folder-picker-dialog group-wizard-folder-picker">
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
    </div>
    </Teleport>
  `,
  data() {
    return {
      form: {
        name: '',
        // Phase 3 spec: pre-check Omni when available. Defensive: if the
        // VP library hasn't hydrated yet, start empty and let the watcher
        // backfill once vpList arrives. If omni is somehow missing (user
        // deleted it — seed-topup will restore on next agent start), fall
        // back to the first available VP so the submit always produces a
        // session with at least one real roster member.
        vpIds: [],
        workDir: '',
        // Which agent owns the new session. Defaults to current Yeaft
        // agent (or first online) and is auto-populated in mounted().
        agentId: null,
      },
      memberPickerOpen: false,
      folderPickerOpen: false,
      folderPickerPath: '',
      folderPickerEntries: [],
      folderPickerLoading: false,
      folderPickerSelected: '',
      busy: false,
      submitError: '',
      // Track whether the user has manually touched the picker; once true
      // we stop auto-mutating their selection from the hydration watcher.
      vpPickerTouched: false,
    };
  },
  computed: {
    chat() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useChatStore) return window.Pinia.useChatStore();
      } catch (_) {}
      return null;
    },
    vpStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useVpStore) return window.Pinia.useVpStore();
      } catch (_) {}
      return null;
    },
    vpList() { return this.vpStore?.vpList || []; },
    agentOptions() {
      const s = this.chat;
      if (!s || !Array.isArray(s.agents)) return [];
      return s.agents.map(a => ({ id: a.id, name: a.name, online: !!a.online, workDir: a.workDir || '' }));
    },
    folderPickerAgentId() { return this.form.agentId || this.chat?.yeaftAgentId || this.chat?.currentAgent || ''; },
    vpLibraryEmpty() {
      const s = this.vpStore;
      if (!s) return false;
      if (s.emptyLibrary === true) return true;
      return !!(s.lastSnapshotAt && s.lastSnapshotAt > 0 && (s.vpOrder?.length || 0) === 0);
    },
    defaultWorkDir() {
      const selected = this.agentOptions.find(a => a.id === this.form.agentId);
      return selected?.workDir || this.chat?.currentAgentInfo?.workDir || '';
    },
    workDirPlaceholder() {
      return this.defaultWorkDir || this.$t('modal.newConv.inputOrSelect');
    },
    memberSummary() {
      const count = this.form.vpIds.length;
      if (count === 0) return this.$t('yeaft.session.create.selectMembers');
      if (count <= 3) return this.form.vpIds.map(id => this.vpLabelFor(id)).join(this.$t('common.comma'));
      return this.$t('yeaft.session.create.membersSelected', { count });
    },
    canSubmit() {
      // Need at least one VP and an agent that is currently online.
      if (this.form.vpIds.length === 0) return false;
      if (!this.form.agentId) return false;
      const a = this.agentOptions.find(x => x.id === this.form.agentId);
      return !!(a && a.online);
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onEsc);
    this.$nextTick(() => {
      try { this.$refs.nameInput?.focus(); } catch (_) {}
    });
    // Seed agent default: prefer the current Yeaft agent, else first online.
    // Never seed an offline agent — sending create to a dead ws is silent
    // failure. If nothing is online, leave agentId null and let canSubmit
    // gate the form.
    try {
      const chat = this.chat;
      if (chat) {
        const preferred = chat.yeaftAgentId || chat.currentAgent || null;
        const agents = this.agentOptions;
        const onlinePick = agents.find(a => a.id === preferred && a.online)
          || agents.find(a => a.online)
          || null;
        if (onlinePick) this.form.agentId = onlinePick.id;
      }
    } catch (_) {}
    // Subscribe to VP snapshot if not yet hydrated (mirrors GroupCreateWizard).
    try {
      if (this.vpStore && this.vpStore.lastSnapshotAt === 0) {
        const chat = this.chat;
        if (chat && typeof chat.sendWsMessage === 'function') {
          chat.sendWsMessage({ type: 'yeaft_vp_subscribe' });
        }
      }
    } catch (_) {}
    // Apply default member selection synchronously if stores are already populated.
    this.applyDefaultSelection();
    document.addEventListener('click', this.onDocumentClick);
    window.addEventListener('workbench-message', this.handleFolderPickerMessage);
  },
  watch: {
    // Re-apply default selection once vpList hydrates (snapshot arrives
    // after mount). Skip if the user already touched the picker.
    'vpList.length'() { this.applyDefaultSelection(); },
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onEsc);
    document.removeEventListener('click', this.onDocumentClick);
    window.removeEventListener('workbench-message', this.handleFolderPickerMessage);
    if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
  },
  methods: {
    applyDefaultSelection() {
      if (this.vpPickerTouched) return;
      if (this.form.vpIds.length > 0) return;
      const list = this.vpList || [];
      if (list.length === 0) return;
      const hasOmni = list.some(vp => vp && vp.vpId === OMNI_VP_ID);
      this.form.vpIds = [hasOmni ? OMNI_VP_ID : list[0].vpId];
    },
    toggleMemberPicker() { this.memberPickerOpen = !this.memberPickerOpen; },
    openFolderPicker() {
      const agentId = this.folderPickerAgentId;
      if (!agentId || !this.chat || typeof this.chat.sendWsMessage !== 'function') return;
      this.folderPickerOpen = true;
      this.folderPickerSelected = '';
      this.folderPickerLoading = true;
      const defaultDir = this.form.workDir || this.defaultWorkDir || '';
      this.folderPickerPath = defaultDir;
      this.folderPickerEntries = [];
      this.requestFolderPickerDir(defaultDir);
    },
    closeFolderPicker() {
      this.folderPickerOpen = false;
      if (this._folderPickerTimer) {
        clearTimeout(this._folderPickerTimer);
        this._folderPickerTimer = null;
      }
    },
    requestFolderPickerDir(dirPath) {
      const agentId = this.folderPickerAgentId;
      if (!agentId || !this.chat || typeof this.chat.sendWsMessage !== 'function') return;
      this.chat.sendWsMessage({
        type: 'list_directory',
        conversationId: '_workdir_picker',
        agentId,
        dirPath,
        workDir: this.defaultWorkDir || '',
      });
      if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
      this._folderPickerTimer = setTimeout(() => {
        if (this.folderPickerLoading && this.folderPickerOpen) this.requestFolderPickerDir(dirPath);
      }, 5000);
    },
    loadFolderPickerDir(dirPath) {
      this.folderPickerLoading = true;
      this.folderPickerSelected = '';
      this.folderPickerEntries = [];
      this.requestFolderPickerDir(dirPath);
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
        this.folderPickerPath = parts[0] + '\\';
        this.loadFolderPickerDir(this.folderPickerPath);
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
      let newPath;
      if (!this.folderPickerPath) {
        newPath = /^[A-Z]:$/.test(entry.name) ? entry.name + '\\' : '/' + entry.name;
      } else {
        newPath = this.folderPickerPath.replace(/[/\\]$/, '') + sep + entry.name;
      }
      this.folderPickerPath = newPath;
      this.loadFolderPickerDir(newPath);
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
    onDocumentClick(e) {
      if (!this.memberPickerOpen) return;
      const root = this.$refs.memberPicker;
      if (root && !root.contains(e.target)) this.memberPickerOpen = false;
    },
    onEsc(e) {
      if (e.key !== 'Escape') return;
      if (this.memberPickerOpen) {
        this.memberPickerOpen = false;
        return;
      }
      if (!this.busy) this.requestClose();
    },
    onOverlayClick() { if (!this.busy) this.requestClose(); },
    requestClose() { this.$emit('close'); },
    toggleVp(vpId, checked) {
      this.vpPickerTouched = true;
      if (checked) {
        if (!this.form.vpIds.includes(vpId)) this.form.vpIds.push(vpId);
      } else {
        this.form.vpIds = this.form.vpIds.filter(id => id !== vpId);
      }
    },
    vpLabelFor(vpId) {
      const fn = this.vpStore?.vpLabel;
      return typeof fn === 'function' ? fn(vpId) : vpId;
    },
    vpTextColorFor(vpId) {
      const fn = this.vpStore?.vpTextColor;
      return typeof fn === 'function' ? fn(vpId) : 'var(--text-primary)';
    },
    async onSubmit() {
      if (this.busy || !this.canSubmit) return;
      this.submitError = '';
      this.busy = true;
      try {
        if (!this.chat || typeof this.chat.createYeaftSession !== 'function') {
          this.submitError = this.$t('yeaft.session.error.unknown', { message: 'store unavailable' });
          return;
        }
        // Defensive: only submit vpIds that exist in the current VP
        // library. Guards against the picker carrying a stale id (e.g.
        // user deleted a VP in another tab between selection and submit).
        const known = new Set((this.vpList || []).map(vp => vp && vp.vpId).filter(Boolean));
        const submittedVpIds = this.form.vpIds.filter(id => known.has(id));
        if (submittedVpIds.length === 0) {
          this.submitError = this.$t('yeaft.session.error.unknown', { message: 'no valid VP selected' });
          return;
        }
        const res = await this.chat.createYeaftSession({
          displayName: this.form.name.trim(),
          vpIds: submittedVpIds,
          workDir: this.form.workDir.trim(),
          agentId: this.form.agentId || null,
        });
        if (res && res.ok) {
          this.$emit('created', res.group);
          this.$emit('close');
          return;
        }
        const code = res?.error?.code || 'unknown';
        const message = res?.error?.message || '';
        const key = `yeaft.session.error.${code}`;
        const translated = this.$t(key, { message });
        this.submitError = translated === key
          ? this.$t('yeaft.session.error.unknown', { message })
          : translated;
      } catch (err) {
        this.submitError = this.$t('yeaft.session.error.unknown', { message: err?.message || String(err) });
      } finally {
        this.busy = false;
      }
    },
  },
};
