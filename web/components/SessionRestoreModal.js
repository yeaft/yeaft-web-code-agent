/**
 * SessionRestoreModal — "I have a workdir with yeaft sessions on disk;
 * register them so the sidebar shows them again."
 *
 * Problem this solves: the sidebar only lists sessions whose workdir is
 * in `~/.yeaft/group-workdirs.json`. If that registry is lost / wiped /
 * the session dir was copied from another machine, the sessions are
 * physically on disk under `<workDir>/.yeaft/sessions/<id>/group.json`
 * but invisible. Creating a NEW session in the same workdir
 * accidentally restores its siblings (because create writes the workdir
 * into the registry, and the next snapshot walks every session under
 * registered workdirs). Restore makes that registration step explicit.
 *
 * UX (parallel to SessionCreateModal but smaller):
 *  - Agent picker (only when multiple agents are online)
 *  - Workdir input + folder-picker button (shared mixin)
 *  - List of sessions found at that workdir; click to restore
 *  - Sessions already in the sidebar are listed but disabled
 *
 * Wire: uses chat.sessionCrudRequest('scan_workdir', ...) and ('restore', ...).
 * Both ops resolve to `{ ok, sessions? | session? | error? }`. The agent
 * automatically rebroadcasts the session snapshot on a successful
 * restore, so the sidebar refresh is hands-off here.
 */
import { folderPickerMixin } from './mixins/folder-picker-mixin.js';
import { formatResumeDate } from '../utils/path-segments.js';

export default {
  name: 'SessionRestoreModal',
  mixins: [folderPickerMixin],
  emits: ['close', 'restored'],
  template: `
    <Teleport to="body">
    <div class="modal-overlay" @click.self="onOverlayClick" role="dialog" aria-modal="true" :aria-label="$t('yeaft.restore.modal.title')">
      <div class="modal resume-modal">
        <div class="resume-modal-controls">
          <button class="resume-close-btn" type="button" @click="requestClose" :aria-label="$t('common.close')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>

          <div class="resume-control-row" v-if="agentOptions.length > 1">
            <label class="resume-control-label">{{ $t('yeaft.session.create.agentLabel') }}</label>
            <select v-model="form.agentId" class="resume-input">
              <option v-for="a in agentOptions" :key="a.id" :value="a.id" :disabled="!a.online">
                {{ a.name || a.id }}{{ a.online ? '' : ' (offline)' }}
              </option>
            </select>
          </div>

          <div class="resume-control-row">
            <label class="resume-control-label">{{ $t('yeaft.restore.modal.workDirLabel') }}</label>
            <div class="workdir-input-group">
              <input
                type="text"
                v-model.trim="form.workDir"
                :placeholder="$t('yeaft.restore.modal.workDirHint')"
                autocomplete="off"
                class="resume-input"
                @keydown.enter.prevent="loadSessions"
              />
              <button
                class="workdir-browse-btn"
                type="button"
                @click="openFolderPicker"
                :disabled="!folderPickerAgentId"
                :title="$t('modal.newConv.browse')"
              >
                <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
              </button>
            </div>
          </div>
        </div>

        <div class="resume-modal-content">
          <div class="resume-panel">
            <div class="resume-panel-header">
              <span>{{ $t('yeaft.restore.modal.sessionsLabel') }}</span>
            </div>
            <div class="resume-panel-list">
              <div class="git-loading" v-if="scanning" style="padding:12px"><span class="spinner-mini"></span> {{ $t('common.loading') }}</div>
              <template v-else>
                <div
                  v-for="session in sessions"
                  :key="session.id"
                  class="resume-list-item session-item-compact"
                  :class="{ 'is-disabled': session.alreadyRegistered, 'is-busy': restoring === session.id }"
                  @click="onRestoreClick(session)"
                >
                  <div class="item-name">{{ session.name || session.id }}</div>
                  <div class="item-meta">
                    <span class="item-time">{{ formatDate(session.createdAt) }}</span>
                    <span v-if="session.alreadyRegistered" class="item-badge">{{ $t('yeaft.restore.modal.alreadyAdded') }}</span>
                  </div>
                </div>
                <div class="resume-panel-empty" v-if="!scanning && sessions.length === 0 && form.workDir">
                  {{ $t('yeaft.restore.modal.empty') }}
                </div>
                <div class="resume-panel-empty" v-if="!scanning && sessions.length === 0 && !form.workDir">
                  {{ $t('yeaft.restore.modal.workDirHint') }}
                </div>
              </template>
            </div>
          </div>
        </div>

        <div v-if="errorMessage" class="resume-modal-error" role="alert">
          {{ errorMessage }}
        </div>

        <!-- Folder picker dialog — shared mixin owns folderPicker* state -->
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
        workDir: '',
        agentId: null,
      },
      sessions: [],
      scanning: false,
      restoring: null, // sessionId of the row currently being restored
      scanError: '',
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
    errorMessage() {
      return this.restoreError || this.scanError || '';
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onEsc);
    // Seed agent: prefer current yeaft agent, else first online (matches
    // SessionCreateModal). Restore is an agent-local op so we never want
    // to silently fire it against the wrong agent.
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
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onEsc);
  },
  watch: {
    'form.workDir'(v) {
      // Clear stale scan results when user edits/clears the workdir.
      // We re-scan only on Enter / picker-confirm / explicit click —
      // typing should not spam the agent with FS scans.
      if (!v) this.sessions = [];
    },
    'form.agentId'() {
      // Switching agents: clear the list (workdir is agent-local).
      this.sessions = [];
      this.scanError = '';
      this.restoreError = '';
    },
  },
  methods: {
    onEsc(e) {
      if (e.key !== 'Escape') return;
      if (this.folderPickerOpen) return;
      this.requestClose();
    },
    onOverlayClick() { this.requestClose(); },
    requestClose() { this.$emit('close'); },
    formatDate(iso) { return formatResumeDate(iso, this.$t.bind(this)); },
    // Folder-picker mixin hooks.
    folderPickerInitialDir() {
      return this.form.workDir || this.defaultWorkDir || '';
    },
    folderPickerSetWorkDir(path) {
      this.form.workDir = path;
      // Auto-scan once the user picks a dir — matches the spec
      // ("当选择了 dir 后，就应该加载存在的所有 sessions").
      this.loadSessions();
    },
    async loadSessions() {
      const workDir = (this.form.workDir || '').trim();
      if (!workDir) { this.sessions = []; return; }
      if (!this.chat || typeof this.chat.sessionCrudRequest !== 'function') {
        this.scanError = this.$t('yeaft.restore.modal.scanError', { message: 'store unavailable' });
        return;
      }
      this.scanning = true;
      this.scanError = '';
      this.restoreError = '';
      try {
        const res = await this.chat.sessionCrudRequest(
          'scan_workdir',
          { workDir },
          { agentId: this.form.agentId || null },
        );
        if (res && res.ok) {
          // chat.js's `sessionCrudRequest` wrapper renames the agent's
          // `sessions` array to `groups` on the resolved promise (see
          // chat.js:1759-1771 — the wrap is shared with the group-style
          // ops and we must read its post-wrap shape, not the raw agent
          // shape). The `??` keeps us tolerant if the envelope ever
          // surfaces the raw name to make this less brittle.
          const list = Array.isArray(res.groups) ? res.groups
            : Array.isArray(res.sessions) ? res.sessions
            : [];
          this.sessions = list;
        } else {
          this.sessions = [];
          const msg = res?.error?.message || res?.error?.code || 'unknown';
          this.scanError = this.$t('yeaft.restore.modal.scanError', { message: msg });
        }
      } catch (err) {
        this.scanError = this.$t('yeaft.restore.modal.scanError', { message: err?.message || String(err) });
      } finally {
        this.scanning = false;
      }
    },
    async onRestoreClick(session) {
      if (!session || !session.id) return;
      if (session.alreadyRegistered) return; // silent no-op
      if (this.restoring) return;             // single inflight at a time
      if (!this.chat || typeof this.chat.sessionCrudRequest !== 'function') {
        this.restoreError = this.$t('yeaft.restore.modal.restoreError', { message: 'store unavailable' });
        return;
      }
      this.restoring = session.id;
      this.restoreError = '';
      try {
        const res = await this.chat.sessionCrudRequest(
          'restore',
          { sessionId: session.id, workDir: this.form.workDir.trim() },
          { agentId: this.form.agentId || null },
        );
        if (res && res.ok) {
          // chat.js's wrap renames the agent's `session` payload to
          // `group` on the resolved promise (see chat.js:1759-1771).
          // Reading `res.group` first gets the agentId-stamped payload
          // (server stamps msg.agentId, wrap forwards it) — falling
          // through to `res.session` or the click arg is just defense
          // against shape drift.
          this.$emit('restored', res.group || res.session || session);
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
  },
};
