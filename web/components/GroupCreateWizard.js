/**
 * GroupCreateWizard — mirrors Chat's new-conversation modal (chat-modals.css).
 *
 * Layout:
 *   - Top controls: name, workDir (+ browse), VP roster row (yeaft-unique).
 *   - Content area: when workDir is empty, show distinct workDirs derived
 *     from the existing sessions snapshot. When workDir is set, show the
 *     sessions whose workDir matches (a "resume" list).
 *   - Footer: Create button — runs sessionCrudRequest('create', …).
 *
 * Clicking an existing session in the resume list does NOT create — it
 * sets that session active and closes the wizard (chat's resumeSession
 * semantics). Per-folder aggregation comes from the client-side sessions
 * store snapshot, no new agent op required.
 */
import VpAvatar from './VpAvatar.js';

export default {
  name: 'GroupCreateWizard',
  components: { VpAvatar },
  emits: ['close', 'created'],
  template: `
    <Teleport to="body">
    <div class="modal-overlay" @click.self="onOverlayClick" role="dialog" aria-modal="true" :aria-label="$t('yeaft.session.wizard.title')">
      <div class="modal resume-modal">
        <div class="resume-modal-controls">
          <button class="resume-close-btn" type="button" @click="requestClose" :aria-label="$t('yeaft.session.wizard.close')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>

          <!-- Name -->
          <div class="resume-control-row">
            <label class="resume-control-label">{{ $t('yeaft.session.wizard.step.name') }}</label>
            <input
              type="text"
              v-model.trim="form.name"
              :placeholder="$t('yeaft.session.wizard.namePlaceholder')"
              maxlength="60"
              autocomplete="off"
              class="resume-input"
              :class="{ 'is-error': !!nameError }"
              ref="nameInput"
              @keydown.enter.prevent="onSubmit"
            />
          </div>

          <!-- Work directory -->
          <div class="resume-control-row">
            <label class="resume-control-label">{{ $t('yeaft.session.wizard.workDir') }}</label>
            <div class="workdir-input-group">
              <input
                type="text"
                v-model.trim="form.workDir"
                :placeholder="$t('yeaft.session.wizard.workDirPlaceholder')"
                autocomplete="off"
                class="resume-input"
                @keydown.enter.prevent="onSubmit"
              />
              <button
                class="workdir-browse-btn"
                type="button"
                @click="openFolderPicker"
                :disabled="busy || !folderPickerAgentId"
                :title="$t('modal.newConv.browse')"
              >
                <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
              </button>
            </div>
          </div>

          <!-- VP roster (yeaft-unique) -->
          <div class="resume-control-row resume-control-row-vp">
            <label class="resume-control-label">{{ $t('yeaft.session.wizard.roster') }}</label>
            <div class="yeaft-wizard-roster">
              <div v-if="vpList.length === 0 && vpLibraryEmpty" class="yeaft-wizard-roster-empty">
                {{ $t('yeaft.session.wizard.rosterEmpty') }}
              </div>
              <div v-else-if="vpList.length === 0" class="yeaft-wizard-roster-empty">
                {{ $t('yeaft.session.wizard.rosterLoading') }}
              </div>
              <ul v-else class="yeaft-wizard-roster-list" role="listbox" aria-multiselectable="true">
                <li
                  v-for="vp in vpList"
                  :key="vp.vpId"
                  class="yeaft-wizard-roster-item"
                  :class="{ 'is-selected': form.roster.includes(vp.vpId), 'is-default': form.defaultVpId === vp.vpId }"
                  role="option"
                  :aria-selected="form.roster.includes(vp.vpId)"
                >
                  <label class="yeaft-wizard-roster-row">
                    <input
                      type="checkbox"
                      :value="vp.vpId"
                      :checked="form.roster.includes(vp.vpId)"
                      @change="toggleMember(vp.vpId, $event.target.checked)"
                    />
                    <VpAvatar :vp-id="vp.vpId" :size="20" :aria-label="vpLabelFor(vp.vpId)" />
                    <span class="yeaft-wizard-roster-name" :style="{ color: vpTextColorFor(vp.vpId) }">{{ vpLabelFor(vp.vpId) }}</span>
                  </label>
                  <button
                    v-if="form.roster.includes(vp.vpId)"
                    type="button"
                    class="yeaft-wizard-default-star"
                    :class="{ 'is-on': form.defaultVpId === vp.vpId }"
                    :aria-label="$t('yeaft.session.wizard.defaultVpHint')"
                    :aria-pressed="form.defaultVpId === vp.vpId"
                    :title="$t('yeaft.session.wizard.defaultVpHint')"
                    @click.stop="form.defaultVpId = vp.vpId"
                  >
                    <span aria-hidden="true">{{ form.defaultVpId === vp.vpId ? '★' : '☆' }}</span>
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <!-- Content area: folders or existing sessions for the chosen workDir -->
        <div class="resume-modal-content">
          <!-- Folder aggregation (workDir empty) -->
          <div class="resume-panel" v-if="!form.workDir">
            <div class="resume-panel-header">
              <span>{{ $t('yeaft.session.wizard.folderLabel') }}</span>
            </div>
            <div class="resume-panel-list">
              <div
                v-for="folder in folderAggregates"
                :key="folder.path"
                class="resume-list-item folder-item-compact"
                @click="selectFolder(folder.path)"
              >
                <div class="item-path">{{ folder.path }}</div>
                <span class="item-badge">{{ folder.count }}</span>
              </div>
              <div class="resume-panel-empty" v-if="folderAggregates.length === 0">
                {{ $t('yeaft.session.wizard.noWorkDirs') }}
              </div>
            </div>
          </div>

          <!-- Sessions for the chosen workDir -->
          <div class="resume-panel" v-else>
            <div class="resume-panel-header">
              <div class="resume-panel-header-left">
                <button class="refresh-btn-mini" @click="form.workDir = ''" :title="$t('yeaft.session.wizard.back')">
                  <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                </button>
                <span>{{ $t('yeaft.session.wizard.sessionLabel') }} <span class="header-tag">{{ getLastPathSegment(form.workDir) }}</span></span>
              </div>
            </div>
            <div class="resume-panel-list">
              <div
                v-for="session in sessionsForCurrentDir"
                :key="session.id"
                class="resume-list-item session-item-compact"
                @click="resumeExisting(session)"
              >
                <div class="item-name">{{ session.name || session.id }}</div>
                <div class="item-time">{{ formatDate(session.createdAt) }}</div>
              </div>
              <div class="resume-panel-empty" v-if="sessionsForCurrentDir.length === 0">
                {{ $t('yeaft.session.wizard.noSessions') }}
              </div>
            </div>
          </div>
        </div>

        <div v-if="submitError || nameError" class="resume-modal-error" role="alert">
          {{ submitError || nameError }}
        </div>

        <div class="resume-modal-footer">
          <button
            class="modern-btn"
            type="button"
            @click="onSubmit"
            :disabled="busy || !canSubmit"
          >
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            {{ busy ? $t('yeaft.session.wizard.creating') : $t('yeaft.session.wizard.create') }}
          </button>
        </div>

        <!-- Folder picker -->
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
      form: { name: '', roster: [], defaultVpId: null, workDir: '' },
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
      try { if (typeof window !== 'undefined' && window.Pinia?.useChatStore) return window.Pinia.useChatStore(); } catch (_) {}
      return null;
    },
    vpStore() {
      try { if (typeof window !== 'undefined' && window.Pinia?.useVpStore) return window.Pinia.useVpStore(); } catch (_) {}
      return null;
    },
    sessionsStore() {
      try { if (typeof window !== 'undefined' && window.Pinia?.useSessionsStore) return window.Pinia.useSessionsStore(); } catch (_) {}
      return null;
    },
    vpList() { return this.vpStore?.vpList || []; },
    vpLibraryEmpty() {
      const s = this.vpStore;
      if (!s) return false;
      if (s.emptyLibrary === true) return true;
      return !!(s.lastSnapshotAt && s.lastSnapshotAt > 0 && (s.vpOrder?.length || 0) === 0);
    },
    canSubmit() { return (this.form.name || '').trim().length > 0; },
    folderPickerAgentId() {
      const chat = this.chat;
      return chat?.currentAgent || chat?.agents?.[0]?.id || '';
    },
    allSessions() {
      return this.sessionsStore?.sessionList || [];
    },
    // Distinct workDirs aggregated across all known sessions, with a count.
    // Sessions without a workDir bucket under "" (skipped from the panel —
    // those are unrooted seed groups, not meaningful for "resume here").
    folderAggregates() {
      const map = new Map();
      for (const s of this.allSessions) {
        const wd = (s && typeof s.workDir === 'string') ? s.workDir.trim() : '';
        if (!wd) continue;
        const existing = map.get(wd) || { path: wd, count: 0 };
        existing.count += 1;
        map.set(wd, existing);
      }
      return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
    },
    sessionsForCurrentDir() {
      const wd = (this.form.workDir || '').trim();
      if (!wd) return [];
      return this.allSessions
        .filter(s => (s && typeof s.workDir === 'string' ? s.workDir.trim() : '') === wd)
        .slice()
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onEsc);
    window.addEventListener('workbench-message', this.handleFolderPickerMessage);
    this.$nextTick(() => {
      const el = this.$refs.nameInput;
      if (el && typeof el.focus === 'function') el.focus();
    });
    try {
      if (this.vpStore && this.vpStore.lastSnapshotAt === 0) {
        const chat = this.chat;
        if (chat && typeof chat.sendWsMessage === 'function') {
          chat.sendWsMessage({ type: 'yeaft_vp_subscribe' });
        }
      }
    } catch (_) { /* test env */ }
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onEsc);
    window.removeEventListener('workbench-message', this.handleFolderPickerMessage);
    if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
  },
  methods: {
    onEsc(e) { if (e.key === 'Escape' && !this.busy && !this.folderPickerOpen) this.requestClose(); },
    onOverlayClick() { if (!this.busy) this.requestClose(); },
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
    selectFolder(path) { this.form.workDir = path; },
    resumeExisting(session) {
      if (!session || !session.id) return;
      if (this.sessionsStore) this.sessionsStore.setActive(session.id);
      this.$emit('close');
    },
    getLastPathSegment(p) {
      if (!p) return '';
      const parts = String(p).replace(/[/\\]$/, '').split(/[/\\]/);
      return parts[parts.length - 1] || p;
    },
    formatDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleString();
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
      if (this._folderPickerTimer) { clearTimeout(this._folderPickerTimer); this._folderPickerTimer = null; }
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
    folderPickerSelectItem(entry) { this.folderPickerSelected = entry.name; },
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
      if (this._folderPickerTimer) { clearTimeout(this._folderPickerTimer); this._folderPickerTimer = null; }
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
      if (!this.canSubmit) {
        this.nameError = this.$t('yeaft.session.error.invalid_name');
        return;
      }
      this.busy = true;
      try {
        const defaultVpId = this.form.defaultVpId || this.form.roster[0] || null;
        if (!this.chat) {
          this.submitError = this.$t('yeaft.session.error.unknown', { message: 'store unavailable' });
          return;
        }
        const res = await this.chat.sessionCrudRequest('create', {
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
        const msgKey = `yeaft.session.error.${code}`;
        const translated = this.$t(msgKey, { message });
        this.submitError = translated === msgKey
          ? this.$t('yeaft.session.error.unknown', { message })
          : translated;
      } catch (err) {
        this.submitError = this.$t('yeaft.session.error.unknown', { message: err && err.message || String(err) });
      } finally {
        this.busy = false;
      }
    },
  },
};
