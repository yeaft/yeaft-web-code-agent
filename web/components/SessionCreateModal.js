/**
 * SessionCreateModal — chat-style "new session" modal.
 *
 * Mirrors Chat's new-conversation modal (chat-modals.css `.resume-modal*`)
 * so the two creation surfaces feel identical. The only Yeaft-specific
 * additions on top of chat's layout are:
 *   - VP roster row with per-row default-star button (replaces chat's
 *     provider/model rows — yeaft picks VPs, chat picks an agent).
 *   - Agent picker (only shown when more than one online agent exists),
 *     because Yeaft sessions are owned by a specific agent and a
 *     multi-agent deployment needs to decide where the session lands.
 *
 * Content area:
 *   - workDir empty → folderAggregates from the sessions store (distinct
 *     workDirs across all known sessions, sorted by path).
 *   - workDir set   → sessions whose workDir matches (resume list).
 *     Clicking a row sets that session active and closes the modal — no
 *     new session is created, matching chat's resumeSession semantics.
 *
 * Footer: Create button → `chat.createYeaftSession({...})`. We keep this
 * call path (rather than calling `sessionCrudRequest` directly) because
 * `createYeaftSession` routes `agentId` correctly for multi-agent setups.
 *
 * NOTE: Method names `requestFolderPickerDir` and `handleFolderPickerMessage`
 * are pinned by the existing test
 * (test/web/session-create-modal-workdir-picker.test.js) — do not rename
 * without also updating the test.
 */
import VpAvatar from './VpAvatar.js';
import { getLastPathSegment, formatResumeDate } from '../utils/path-segments.js';

const OMNI_VP_ID = 'omni';

export default {
  name: 'SessionCreateModal',
  components: { VpAvatar },
  emits: ['close', 'created'],
  template: `
    <Teleport to="body">
    <div class="modal-overlay" @click.self="onOverlayClick" role="dialog" aria-modal="true" :aria-label="$t('yeaft.session.create.title')">
      <div class="modal resume-modal">
        <div class="resume-modal-controls">
          <button class="resume-close-btn" type="button" @click="requestClose" :aria-label="$t('yeaft.session.create.close')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>

          <!-- Agent (only when more than one online agent) -->
          <div class="resume-control-row" v-if="agentOptions.length > 1">
            <label class="resume-control-label">{{ $t('yeaft.session.create.agentLabel') }}</label>
            <select v-model="form.agentId" class="resume-input">
              <option v-for="a in agentOptions" :key="a.id" :value="a.id" :disabled="!a.online">
                {{ a.name || a.id }}{{ a.online ? '' : ' (offline)' }}
              </option>
            </select>
          </div>

          <!-- Name (optional — only consulted on Create; ignored when
               clicking a row in the resume list). -->
          <div class="resume-control-row">
            <label class="resume-control-label">{{ $t('yeaft.session.create.nameLabel') }}</label>
            <input
              type="text"
              v-model.trim="form.name"
              :placeholder="$t('yeaft.session.create.namePlaceholder')"
              maxlength="60"
              autocomplete="off"
              class="resume-input"
              @keydown.enter.prevent="onSubmit"
            />
          </div>

          <!-- Work directory -->
          <div class="resume-control-row">
            <label class="resume-control-label">{{ $t('yeaft.session.create.workDirLabel') }}</label>
            <div class="workdir-input-group">
              <input
                type="text"
                v-model.trim="form.workDir"
                :placeholder="workDirPlaceholder"
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

          <!-- VP roster (yeaft-specific) — collapsed-by-default picker.
               Trigger shows the current selection summary (names if ≤3, else
               "N selected"); clicking opens the full list below. Mirrors the
               Copilot model picker pattern from ChatPage. -->
          <div class="resume-control-row resume-control-row-vp">
            <label class="resume-control-label">{{ $t('yeaft.session.create.vpPicker') }}</label>
            <div class="yeaft-roster" ref="vpRosterRoot">
              <div v-if="vpList.length === 0 && vpLibraryEmpty" class="yeaft-roster-empty">
                {{ $t('yeaft.session.create.rosterEmpty') }}
              </div>
              <div v-else-if="vpList.length === 0" class="yeaft-roster-empty">
                {{ $t('yeaft.session.create.rosterLoading') }}
              </div>
              <template v-else>
                <button
                  type="button"
                  class="yeaft-roster-trigger"
                  :class="{ 'is-open': vpRosterOpen }"
                  :aria-expanded="vpRosterOpen"
                  @click="vpRosterOpen = !vpRosterOpen"
                >
                  <span class="yeaft-roster-trigger-summary">{{ vpRosterSummary }}</span>
                  <span class="yeaft-roster-caret" aria-hidden="true">▾</span>
                </button>
                <ul
                  v-if="vpRosterOpen"
                  class="yeaft-roster-list yeaft-roster-popup"
                  role="listbox"
                  aria-multiselectable="true"
                >
                  <li
                    v-for="vp in vpList"
                    :key="vp.vpId"
                    class="yeaft-roster-item"
                    :class="{ 'is-selected': form.vpIds.includes(vp.vpId), 'is-default': form.defaultVpId === vp.vpId }"
                    role="option"
                    :aria-selected="form.vpIds.includes(vp.vpId)"
                  >
                    <label class="yeaft-roster-row">
                      <input
                        type="checkbox"
                        :value="vp.vpId"
                        :checked="form.vpIds.includes(vp.vpId)"
                        @change="toggleVp(vp.vpId, $event.target.checked)"
                      />
                      <VpAvatar :vp-id="vp.vpId" :size="20" :aria-label="vpLabelFor(vp.vpId)" />
                      <span class="yeaft-roster-name" :style="{ color: vpTextColorFor(vp.vpId) }">{{ vpLabelFor(vp.vpId) }}</span>
                    </label>
                    <button
                      v-if="form.vpIds.includes(vp.vpId)"
                      type="button"
                      class="yeaft-roster-default-star"
                      :class="{ 'is-on': form.defaultVpId === vp.vpId }"
                      :aria-label="$t('yeaft.session.create.defaultVpHint')"
                      :aria-pressed="form.defaultVpId === vp.vpId"
                      :title="$t('yeaft.session.create.defaultVpHint')"
                      @click.stop="form.defaultVpId = vp.vpId"
                    >
                      <span aria-hidden="true">{{ form.defaultVpId === vp.vpId ? '★' : '☆' }}</span>
                    </button>
                  </li>
                </ul>
              </template>
            </div>
          </div>
        </div>

        <!-- Content area: folders or existing sessions for the chosen workDir -->
        <div class="resume-modal-content">
          <!-- Folder aggregation (workDir empty) -->
          <div class="resume-panel" v-if="!form.workDir">
            <div class="resume-panel-header">
              <span>{{ $t('yeaft.session.create.folderLabel') }}</span>
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
                {{ $t('yeaft.session.create.noWorkDirs') }}
              </div>
            </div>
          </div>

          <!-- Sessions for the chosen workDir -->
          <div class="resume-panel" v-else>
            <div class="resume-panel-header">
              <div class="resume-panel-header-left">
                <button class="refresh-btn-mini" @click="form.workDir = ''" :title="$t('yeaft.session.create.back')">
                  <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                </button>
                <span>{{ $t('yeaft.session.create.sessionLabel') }} <span class="header-tag">{{ getLastPathSegment(form.workDir) }}</span></span>
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
                {{ $t('yeaft.session.create.noSessions') }}
              </div>
            </div>
          </div>
        </div>

        <div v-if="submitError" class="resume-modal-error" role="alert">
          {{ submitError }}
        </div>

        <div class="resume-modal-footer">
          <button
            class="modern-btn"
            type="button"
            @click="onSubmit"
            :disabled="busy || !canSubmit"
          >
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            {{ busy ? $t('yeaft.session.create.creating') : $t('yeaft.session.create.submit') }}
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
      form: {
        name: '',
        // Pre-checked once vpList hydrates (see applyDefaultSelection).
        vpIds: [],
        defaultVpId: null,
        workDir: '',
        // Which agent owns the new session — populated in mounted().
        agentId: null,
      },
      busy: false,
      submitError: '',
      folderPickerOpen: false,
      folderPickerPath: '',
      folderPickerEntries: [],
      folderPickerLoading: false,
      folderPickerSelected: '',
      _folderPickerTimer: null,
      // Track whether the user has manually touched the picker; once true
      // we stop auto-mutating their selection from the hydration watcher.
      vpPickerTouched: false,
      // Collapsed-by-default VP roster. Most sessions use one VP, so we
      // hide the list behind a trigger and only open it when the user
      // wants to multi-select (mirrors the Copilot model picker pattern).
      vpRosterOpen: false,
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
    sessionsStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useSessionsStore) return window.Pinia.useSessionsStore();
      } catch (_) {}
      return null;
    },
    vpList() { return this.vpStore?.vpList || []; },
    vpLibraryEmpty() {
      const s = this.vpStore;
      if (!s) return false;
      if (s.emptyLibrary === true) return true;
      return !!(s.lastSnapshotAt && s.lastSnapshotAt > 0 && (s.vpOrder?.length || 0) === 0);
    },
    agentOptions() {
      const s = this.chat;
      if (!s || !Array.isArray(s.agents)) return [];
      return s.agents.map(a => ({ id: a.id, name: a.name, online: !!a.online, workDir: a.workDir || '' }));
    },
    folderPickerAgentId() {
      return this.form.agentId || this.chat?.yeaftAgentId || this.chat?.currentAgent || '';
    },
    defaultWorkDir() {
      const selected = this.agentOptions.find(a => a.id === this.form.agentId);
      return selected?.workDir || this.chat?.currentAgentInfo?.workDir || '';
    },
    workDirPlaceholder() {
      return this.defaultWorkDir || this.$t('modal.newConv.inputOrSelect');
    },
    allSessions() {
      return this.sessionsStore?.sessionList || [];
    },
    // Distinct workDirs aggregated across all known sessions, with a count.
    // Sessions without a workDir are skipped — they don't anchor to a folder
    // so "resume here" is meaningless for them.
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
    canSubmit() {
      if (this.form.vpIds.length === 0) return false;
      if (!this.form.agentId) return false;
      const a = this.agentOptions.find(x => x.id === this.form.agentId);
      return !!(a && a.online);
    },
    // Trigger label: empty / "name1, name2, name3" / "N selected".
    // 3 is the threshold because the trigger line is narrow and 4 names
    // already start to ellide. "N selected" is a stable fallback shape.
    vpRosterSummary() {
      const ids = this.form.vpIds || [];
      if (ids.length === 0) return this.$t('yeaft.session.create.vpNone');
      if (ids.length <= 3) {
        return ids.map(id => this.vpLabelFor(id)).join(this.$t('common.comma'));
      }
      return this.$t('yeaft.session.create.vpCount', { n: ids.length });
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onEsc);
    window.addEventListener('workbench-message', this.handleFolderPickerMessage);
    document.addEventListener('click', this.handleOutsideRosterClick, true);
    // Name input is optional — do NOT auto-focus it. Focusing an
    // optional field signals to users that it's required.
    // Seed agent default: prefer current Yeaft agent, else first online.
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
    // Subscribe to VP snapshot if not yet hydrated.
    try {
      if (this.vpStore && this.vpStore.lastSnapshotAt === 0) {
        const chat = this.chat;
        if (chat && typeof chat.sendWsMessage === 'function') {
          chat.sendWsMessage({ type: 'yeaft_vp_subscribe' });
        }
      }
    } catch (_) {}
    this.applyDefaultSelection();
  },
  watch: {
    // Re-apply default selection once vpList hydrates after mount.
    'vpList.length'() { this.applyDefaultSelection(); },
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onEsc);
    window.removeEventListener('workbench-message', this.handleFolderPickerMessage);
    document.removeEventListener('click', this.handleOutsideRosterClick, true);
    if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
  },
  methods: {
    applyDefaultSelection() {
      if (this.vpPickerTouched) return;
      if (this.form.vpIds.length > 0) return;
      const list = this.vpList || [];
      if (list.length === 0) return;
      const hasOmni = list.some(vp => vp && vp.vpId === OMNI_VP_ID);
      const pick = hasOmni ? OMNI_VP_ID : list[0].vpId;
      this.form.vpIds = [pick];
      this.form.defaultVpId = pick;
    },
    toggleVp(vpId, checked) {
      this.vpPickerTouched = true;
      if (checked) {
        if (!this.form.vpIds.includes(vpId)) this.form.vpIds.push(vpId);
        if (!this.form.defaultVpId) this.form.defaultVpId = vpId;
      } else {
        this.form.vpIds = this.form.vpIds.filter(id => id !== vpId);
        if (this.form.defaultVpId && !this.form.vpIds.includes(this.form.defaultVpId)) {
          this.form.defaultVpId = this.form.vpIds[0] || null;
        }
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
    selectFolder(path) { this.form.workDir = path; },
    resumeExisting(session) {
      if (!session || !session.id) return;
      const chat = this.chat;
      // 1. Cross-agent route — if the session belongs to a different
      //    agent than the one currently selected, switch first so any
      //    subsequent CRUD/messaging hits the owning agent. Mirrors
      //    YeaftSidebar.onSelectGroup.
      if (session.agentId && chat && chat.currentAgent !== session.agentId
          && typeof chat.selectAgent === 'function') {
        chat.selectAgent(session.agentId);
      }
      // 2. UI pointer (which session the main pane shows).
      if (this.sessionsStore) this.sessionsStore.setActive(session.id);
      // 3. The action that actually fires `yeaft_load_history` and
      //    sets `yeaftActiveSessionFilter`. Without this, the modal
      //    closes but the main pane stays empty — that's the bug
      //    users reported as "resume doesn't work". `force: true` so
      //    it re-fires even when re-picking the currently-active id.
      if (chat && typeof chat.setActiveSessionFilter === 'function') {
        chat.setActiveSessionFilter(session.id, { force: true });
      }
      this.$emit('close');
    },
    // Outside-click handler for the collapsible VP roster popup.
    // Uses capture phase so clicks on overlapping elements (e.g. the
    // modal's own controls) still close the popup before the click
    // gets handled elsewhere.
    handleOutsideRosterClick(e) {
      if (!this.vpRosterOpen) return;
      const root = this.$refs.vpRosterRoot;
      if (!root) return;
      if (root.contains(e.target)) return;
      this.vpRosterOpen = false;
    },
    getLastPathSegment(p) { return getLastPathSegment(p); },
    formatDate(iso) { return formatResumeDate(iso, this.$t.bind(this)); },
    onEsc(e) {
      if (e.key !== 'Escape') return;
      if (this.folderPickerOpen) return;
      if (!this.busy) this.requestClose();
    },
    onOverlayClick() { if (!this.busy) this.requestClose(); },
    requestClose() { this.$emit('close'); },
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
    folderPickerSelectItem(entry) { this.folderPickerSelected = entry.name; },
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
        const defaultVpId = (this.form.defaultVpId && submittedVpIds.includes(this.form.defaultVpId))
          ? this.form.defaultVpId
          : submittedVpIds[0];
        // Auto-derive name when the user left it blank — the server
        // rejects empty names with `invalid_name`, and the user said
        // they shouldn't have to fill it. Prefer the workDir basename
        // (matches how chat names ad-hoc conversations); fall back to
        // a localized "Untitled".
        const trimmedName = this.form.name.trim();
        const derivedName = trimmedName
          || getLastPathSegment(this.form.workDir.trim())
          || this.$t('yeaft.session.create.untitled');
        const res = await this.chat.createYeaftSession({
          displayName: derivedName,
          vpIds: submittedVpIds,
          defaultVpId,
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
