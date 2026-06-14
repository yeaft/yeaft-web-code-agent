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
 *   - workDir set   → `sessionsInDir`: one disk-scanned list of every
 *     yeaft session physically present under `<workDir>/.yeaft/sessions/`.
 *     Each row carries an `inSidebar` flag (true when sessionsStore already
 *     holds it). Clicking dispatches through `selectSession`:
 *       inSidebar=true  → resume only (just pin + fire history)
 *       inSidebar=false → restore (register first, then pin)
 *     Pre-fix this was two stacked panels ("registered" + "on disk"), which
 *     looked like duplicate content to the user. Merged on 2026-06-09 per
 *     user directive: "此目录下所有 yeaft session，用户可以选择恢复".
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
import { folderPickerData, folderPickerMethods } from './mixins/folder-picker-mixin.js';

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

          <!-- Sessions for the chosen workDir — ONE list, sourced from a
               disk scan of the chosen workDir's .yeaft/sessions/ folder.
               Each row is tagged with inSidebar so the click handler can
               branch:
                 - inSidebar=true  -> resumeExisting (just pin + fire history)
                 - inSidebar=false -> onRestoreClick (register first, then pin)
               Pre-fix we showed TWO duplicate panels (the sidebar-filtered
               list AND the disk-minus-sidebar list) which confused users
               into thinking they were different things. The user's directive
               (2026-06-09): "此目录下所有 yeaft session，用户可以选择恢复". -->
          <div class="resume-panel" v-else>
            <div class="resume-panel-header">
              <div class="resume-panel-header-left">
                <button class="refresh-btn-mini" @click="form.workDir = ''" :title="$t('yeaft.session.create.back')">
                  <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                </button>
                <span>{{ $t('yeaft.session.create.sessionLabel') }} <span class="header-tag">{{ getLastPathSegment(form.workDir) }}</span></span>
              </div>
              <button
                class="refresh-btn-mini"
                type="button"
                @click="loadRestoreCandidates"
                :disabled="restoreScanning"
                :title="$t('common.refresh')"
              >
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.74 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
              </button>
            </div>
            <div class="resume-panel-list">
              <div class="git-loading restore-loading" v-if="restoreScanning"><span class="spinner-mini"></span> {{ $t('common.loading') }}</div>
              <template v-else>
                <div
                  v-for="session in sessionsInDir"
                  :key="session.id"
                  class="resume-list-item session-item-compact"
                  :class="{ 'is-busy': restoring === session.id, 'is-disabled': restoring && restoring !== session.id }"
                  @click="selectSession(session)"
                >
                  <div class="item-name">{{ session.name || session.id }}</div>
                  <div class="item-time">{{ formatDate(session.createdAt) }}</div>
                </div>
                <div class="resume-panel-empty" v-if="sessionsInDir.length === 0 && !restoreError">
                  {{ $t('yeaft.restore.modal.empty') }}
                </div>
                <div class="resume-panel-empty" v-if="restoreError">
                  {{ restoreError }}
                </div>
              </template>
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
      // Folder picker state — extracted to a shared mixin (originally
      // so SessionRestoreModal could reuse it; that modal has been
      // folded back in, but the mixin shape is preserved for future
      // consumers). Spreading the factory keeps field names + the WS
      // conversationId contract exactly the same (see
      // test/web/session-create-modal-workdir-picker.test.js).
      ...folderPickerData(),
      // Track whether the user has manually touched the picker; once true
      // we stop auto-mutating their selection from the hydration watcher.
      vpPickerTouched: false,
      // Collapsed-by-default VP roster. Most sessions use one VP, so we
      // hide the list behind a trigger and only open it when the user
      // wants to multi-select (mirrors the Copilot model picker pattern).
      vpRosterOpen: false,
      // Disk-scanned session list for the currently chosen workDir.
      // `scannedSessions` is the raw list the agent returns from
      // scan_workdir; the `sessionsInDir` computed annotates each row
      // with `inSidebar` (sourced from sessionsStore.sessionList, the
      // literal source the sidebar reads from) so the stale-flag bug
      // from the old standalone modal ("已在 sidebar 中" on items that
      // aren't) is physically impossible.
      //
      // We intentionally do NOT track `scannedWorkDir` / `scannedAgentId`
      // separately — the workdir/agent watchers below clear `scannedSessions`
      // on change, so the list is always for the current (form.workDir,
      // form.agentId) pair by construction. An extra cached pair would just
      // be a second source of truth waiting to drift.
      scannedSessions: [],
      restoreScanning: false,
      restoring: null,
      restoreError: '',
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
    // Sessions owned by the agent the user picked IN THIS MODAL
    // (form.agentId) — NOT the globally-active agent (chat.currentAgent /
    // the top-left agent list). The folder list and the on-disk session
    // scan must both follow the modal's own agent selection: a yeaft
    // session lives on one specific agent's disk, so showing folders from
    // other agents would list directories the chosen agent can't scan
    // (the scan then comes back empty — the "选了目录却没有 session" bug).
    // Rows without an agentId (legacy snapshots from un-upgraded agents)
    // are kept so single-agent setups still work.
    agentSessions() {
      const target = this.form.agentId || null;
      if (!target) return this.allSessions;
      return this.allSessions.filter(s => {
        const owner = s && s.agentId;
        return !owner || owner === target;
      });
    },
    // Distinct workDirs aggregated across the selected agent's sessions,
    // with a count. Sessions without a workDir are skipped — they don't
    // anchor to a folder so "resume here" is meaningless for them.
    folderAggregates() {
      const map = new Map();
      for (const s of this.agentSessions) {
        const wd = (s && typeof s.workDir === 'string') ? s.workDir.trim() : '';
        if (!wd) continue;
        const existing = map.get(wd) || { path: wd, count: 0 };
        existing.count += 1;
        map.set(wd, existing);
      }
      return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
    },
    sessionsInDir() {
      const inSidebar = new Set(
        (this.sessionsStore?.sessionList || []).map(s => s && s.id).filter(Boolean)
      );
      const list = Array.isArray(this.scannedSessions) ? this.scannedSessions : [];
      return list
        .filter(s => s && s.id)
        .map(s => ({ ...s, inSidebar: inSidebar.has(s.id) }));
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
    this.seedAgentDefault();
    // Subscribe to VP snapshot if not yet hydrated, OR if the cached
    // snapshot is from a different agent than we're now targeting.
    // fix-session-restore-modal-unify: pre-fix, this fired
    // `yeaft_vp_subscribe` with no agentId — the server then dropped it
    // silently when `client.currentAgent` was null (a fresh page load
    // with no chat session entered yet), and the modal stuck on
    // "VP 加载中..." indefinitely. `subscribeVpsFor` stamps the agentId
    // explicitly and re-subscribes when the user picks a different agent.
    this.subscribeVpsFor(this.form.agentId);
    this.applyDefaultSelection();
  },
  watch: {
    // Re-apply default selection once vpList hydrates after mount.
    'vpList.length'() { this.applyDefaultSelection(); },
    // The agent list arrives over the WebSocket, so on a cold page load it
    // can be empty at mount() — leaving form.agentId null. A <select>
    // bound to a null model still *visually* shows its first <option>
    // ("server"), so the user sees an agent picked while the model is
    // actually empty; the scan then goes out with no agentId and the
    // server silently falls back to client.currentAgent (the top-left
    // agent list) — scanning the wrong agent's disk and returning an
    // empty session list. Re-seed whenever the roster changes so the
    // bound value always matches a real, online option the user can see.
    'agentOptions.length'() { this.seedAgentDefault(); },
    // fix-session-restore-modal-unify: re-subscribe when the user picks
    // a different agent from the dropdown, since the VP library is
    // per-agent (one agent's VPs are not the other's). Also re-scan
    // the disk panel because the workdir registry is per-agent too.
    'form.agentId'(next, prev) {
      if (next === prev) return;
      this.subscribeVpsFor(next);
      // VP list is per-agent — clear stale selection so the user
      // doesn't accidentally create a session with a VP that doesn't
      // exist on the newly-targeted agent.
      this.form.vpIds = [];
      this.form.defaultVpId = null;
      this.vpPickerTouched = false;
      // Reset scanned-from-disk state; workDir + agent both contribute
      // to which sessions are visible.
      this.scannedSessions = [];
      this.restoreError = '';
      if ((this.form.workDir || '').trim()) this.loadRestoreCandidates();
    },
    // fix-session-restore-modal-unify: auto-load the "Restore from disk"
    // list whenever the user enters a workdir (matches the old standalone
    // modal's behavior — picking a directory immediately scans it).
    // Always zero scannedSessions before deciding what to do next so the
    // unified list never flashes the *previous* workdir's rows while the
    // new scan is in flight (matches the agentId watcher above).
    'form.workDir'(next, prev) {
      if (next === prev) return;
      this.restoreError = '';
      this.scannedSessions = [];
      const trimmed = (next || '').trim();
      if (!trimmed) return;
      this.loadRestoreCandidates();
    },
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onEsc);
    window.removeEventListener('workbench-message', this.handleFolderPickerMessage);
    document.removeEventListener('click', this.handleOutsideRosterClick, true);
    if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
  },
  methods: {
    /**
     * Seed (or re-seed) form.agentId to a real, online agent.
     *
     * Called from mounted() AND from the agentOptions.length watcher,
     * because the agent roster arrives asynchronously over the WebSocket
     * and may be empty at mount on a cold page load. Idempotent and
     * non-destructive: if form.agentId already points at an online agent
     * we leave the user's choice alone; we only (re)seed when it's unset
     * or has gone stale (agent went offline / disappeared). Never seeds an
     * offline agent — sending create/scan to a dead ws is silent failure.
     * If nothing is online we leave it null and let canSubmit gate the form.
     */
    seedAgentDefault() {
      try {
        const agents = this.agentOptions;
        if (!Array.isArray(agents) || agents.length === 0) return;
        // Keep an already-valid online selection — don't clobber the user.
        const current = agents.find(a => a.id === this.form.agentId && a.online);
        if (current) return;
        const chat = this.chat;
        const preferred = chat ? (chat.yeaftAgentId || chat.currentAgent || null) : null;
        const onlinePick = agents.find(a => a.id === preferred && a.online)
          || agents.find(a => a.online)
          || null;
        if (onlinePick) this.form.agentId = onlinePick.id;
      } catch (_) {}
    },
    /**
     * fix-session-restore-modal-unify: agent-aware vp_subscribe.
     *
     * Reasons we cannot rely on the bare `{ type: 'yeaft_vp_subscribe' }`
     * the old code shipped:
     *   1. Server routes yeaft_* on `msg.agentId || client.currentAgent`.
     *      A fresh page load with no Chat session entered yet has
     *      `currentAgent === null`, so the server silently swallows the
     *      message. The VP roster never hydrates and the Create button
     *      stays disabled (the "VP 加载中..." BLOCKER).
     *   2. The VP library is per-agent. Switching agents in the dropdown
     *      MUST re-subscribe; otherwise the cached roster from agent A
     *      lingers when targeting agent B.
     *
     * We compute the agent target with the same precedence the rest of
     * this modal uses (form.agentId wins; falls back to yeaftAgentId for
     * users who landed here from inside Yeaft; falls back to
     * currentAgent for chat-mode users who haven't entered Yeaft yet).
     * If nothing resolves, we WARN loudly — silent failure is what made
     * the original bug a multi-file root-cause hunt.
     */
    subscribeVpsFor(agentId) {
      const chat = this.chat;
      if (!chat || typeof chat.sendWsMessage !== 'function') return;
      const target = agentId || chat.yeaftAgentId || chat.currentAgent || null;
      if (!target) {
        console.warn(
          '[SessionCreateModal] cannot subscribe to VP library — no agent resolved'
          + ' (form.agentId / chat.yeaftAgentId / chat.currentAgent all null)'
        );
        return;
      }
      const vp = this.vpStore;
      // Skip re-subscribing when we already have a fresh snapshot from the
      // exact agent we're targeting. `lastVpSnapshotAgentId` is `null` on
      // legacy single-agent paths, so we re-subscribe in that case too.
      if (vp && vp.lastSnapshotAt > 0 && vp.lastVpSnapshotAgentId === target) {
        return;
      }
      chat.sendWsMessage({ type: 'yeaft_vp_subscribe', agentId: target });
    },
    /**
     * fix-session-restore-modal-unify: scan the workdir for on-disk
     * yeaft sessions. Folded in from the old standalone
     * SessionRestoreModal. The result lands in `scannedSessions`; the
     * `sessionsInDir` computed annotates each row with `inSidebar`
     * (sourced from sessionsStore.sessionList) before rendering, so a
     * stale "alreadyRegistered" flag from the agent never reaches the UI.
     *
     * Single-inflight guard: the agentId and workDir watchers both call
     * this method, and a user typing into the workdir input can trigger
     * a watcher cascade. Returning early when a scan is already in flight
     * keeps the UI from firing duplicate `scan_workdir` requests at the
     * agent. The watchers re-fire on the next change anyway, so we don't
     * lose any input — we just don't bombard the wire.
     */
    async loadRestoreCandidates() {
      if (this.restoreScanning) return;
      const workDir = (this.form.workDir || '').trim();
      if (!workDir) {
        this.scannedSessions = [];
        return;
      }
      const chat = this.chat;
      if (!chat || typeof chat.sessionCrudRequest !== 'function') {
        this.restoreError = this.$t('yeaft.restore.modal.scanError', { message: 'store unavailable' });
        return;
      }
      // Scan MUST be pinned to the agent the user picked in this modal,
      // with NO coupling to client.currentAgent / the top-left agent list.
      // We deliberately do NOT fall back to currentAgent: an empty agentId
      // makes the server guess (it routes on `msg.agentId ||
      // client.currentAgent`), which scans the wrong agent's disk and
      // returns an empty list — the root cause of the "选了目录却刷不出
      // session" bug. form.agentId is seeded/re-seeded by seedAgentDefault
      // whenever the roster changes, and the form.agentId watcher re-runs
      // this scan once seeding fills it in, so a null here only means "no
      // agent is online yet" — in which case we surface an error rather
      // than scanning some other agent.
      const agentId = this.form.agentId || null;
      if (!agentId) {
        this.scannedSessions = [];
        this.restoreError = this.$t('yeaft.restore.modal.scanError', { message: 'no agent selected' });
        return;
      }
      this.restoreScanning = true;
      this.restoreError = '';
      try {
        const res = await chat.sessionCrudRequest(
          'scan_workdir',
          { workDir },
          { agentId },
        );
        if (res && res.ok) {
          const list = Array.isArray(res.sessions) ? res.sessions
            : Array.isArray(res.groups) ? res.groups
            : [];
          this.scannedSessions = list;
        } else {
          this.scannedSessions = [];
          const msg = res?.error?.message || res?.error?.code || 'unknown';
          this.restoreError = this.$t('yeaft.restore.modal.scanError', { message: msg });
        }
      } catch (err) {
        this.scannedSessions = [];
        this.restoreError = this.$t('yeaft.restore.modal.scanError', { message: err?.message || String(err) });
      } finally {
        this.restoreScanning = false;
      }
    },
    /**
     * fix-session-restore-modal-unify: restore (= register-to-sidebar)
     * one of the scanned-from-disk sessions. On success the agent
     * rebroadcasts session_list_updated, so the sidebar refreshes itself
     * — we just emit `restored` (for parity with the old modal) and
     * close. Pin the active session / agent so the user lands on it.
     */
    async onRestoreClick(session) {
      if (!session || !session.id) return;
      if (this.restoring) return; // single inflight at a time
      const chat = this.chat;
      if (!chat || typeof chat.sessionCrudRequest !== 'function') {
        this.restoreError = this.$t('yeaft.restore.modal.restoreError', { message: 'store unavailable' });
        return;
      }
      this.restoring = session.id;
      this.restoreError = '';
      try {
        const res = await chat.sessionCrudRequest(
          'restore',
          { sessionId: session.id, workDir: (this.form.workDir || '').trim() },
          { agentId: this.form.agentId || null },
        );
        if (res && res.ok) {
          const restored = res.session || res.group || session;
          // Mirror resumeExisting / onSubmit: pin currentAgent +
          // sessionsStore.active + chat filter to the restored session so
          // the user doesn't get bounced back to whatever was active.
          const owner = restored && restored.agentId;
          if (owner && chat.currentAgent !== owner
              && typeof chat.selectAgent === 'function') {
            chat.selectAgent(owner);
          }
          if (this.sessionsStore) this.sessionsStore.setActive(restored.id || session.id);
          if (typeof chat.setActiveSessionFilter === 'function') {
            chat.setActiveSessionFilter(restored.id || session.id, { force: true });
          }
          this.$emit('created', restored);
          this.$emit('close');
          return;
        }
        const msg = res?.error?.message || res?.error?.code || 'unknown';
        this.restoreError = this.$t('yeaft.restore.modal.restoreError', { message: msg });
      } catch (err) {
        this.restoreError = this.$t('yeaft.restore.modal.restoreError', { message: err?.message || String(err) });
      } finally {
        this.restoring = null;
      }
    },
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
    /**
     * Single-list dispatch: branches on `inSidebar` so the unified panel
     * works for both already-registered sessions (resume only) and
     * disk-only ones (restore = register + resume).
     *
     * `inSidebar` is computed by `sessionsInDir` from sessionsStore.sessionList
     * (the literal source the sidebar reads from) — not the agent's stale
     * `alreadyRegistered` flag — so the branch decision is always correct.
     */
    selectSession(session) {
      if (!session || !session.id) return;
      if (session.inSidebar) {
        this.resumeExisting(session);
      } else {
        this.onRestoreClick(session);
      }
    },
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
    // Folder picker glue — see mixins/folder-picker-mixin.js for the
    // shared behavior. The two hooks below let the mixin's open/confirm
    // flow plug into this modal's local state (`form.workDir`).
    folderPickerInitialDir() {
      return this.form.workDir || this.defaultWorkDir || '';
    },
    folderPickerSetWorkDir(path) {
      this.form.workDir = path;
    },
    // Folder-picker behavior (open/close/navigate/confirm/incoming msg).
    // Spread from the shared mixin so future modals (e.g. workbench
    // workdir picker) can reuse the same picker without copy-paste.
    // Method names (`requestFolderPickerDir`, `handleFolderPickerMessage`)
    // are part of the wire contract pinned by
    // `test/web/session-create-modal-workdir-picker.test.js`.
    ...folderPickerMethods,
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
          // Mirror resumeExisting: pin currentAgent + sessionsStore.active
          // + chat filter to the new session so the next click doesn't
          // snap back. (See commit 54028e1a for the regression history.)
          const chat = this.chat;
          const created = res.session || res.group || null;
          const id = created && created.id;
          const owner = created && created.agentId;
          if (id) {
            if (owner && chat && chat.currentAgent !== owner
                && typeof chat.selectAgent === 'function') {
              chat.selectAgent(owner);
            }
            if (this.sessionsStore) this.sessionsStore.setActive(id);
            if (chat && typeof chat.setActiveSessionFilter === 'function') {
              chat.setActiveSessionFilter(id, { force: true });
            }
          }
          this.$emit('created', created);
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
