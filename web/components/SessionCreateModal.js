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
 *   - workDir set   → `sessionsInDir`: currently a compatibility-only list;
 *     Yeaft Session data lives under the agent-local sessions root, while
 *     workDir is kept for project assets and runtime context. Older restore
 *     rows may still flow through the same `selectSession` path, but the
 *     backend no longer treats `<workDir>/.yeaft/sessions/` as canonical.
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
import ModernSelect from './ModernSelect.js';
import { getLastPathSegment, formatResumeDate } from '../utils/path-segments.js';
import { buildVpDomainSections } from '../utils/vp-domains.js';
import { folderPickerData, folderPickerMethods } from './mixins/folder-picker-mixin.js';

const OMNI_VP_ID = 'omni';

const VP_ROSTER_POPUP_GAP_PX = 4;

/**
 * Pick a popup direction and the exact height available inside both its modal
 * clipping boundary and the current visual viewport.
 *
 * Prefer opening down when the popup already fits there. Otherwise use the
 * upper side when it fits, falling back to whichever side exposes more room.
 * The returned height is consumed as a CSS max-height, so the last checklist
 * item remains reachable through the popup's own scroller.
 *
 * @param {{top: number, bottom: number}} anchorRect
 * @param {{top: number, bottom: number}} boundaryRect
 * @param {{top: number, bottom: number}} viewportRect
 * @param {number} desiredHeight
 * @returns {{placement: 'up'|'down', availableHeight: number}}
 */
export function resolveVpRosterPopupLayout(anchorRect, boundaryRect, viewportRect, desiredHeight = 0) {
  const clipTop = Math.max(boundaryRect.top, viewportRect.top);
  const clipBottom = Math.min(boundaryRect.bottom, viewportRect.bottom);
  const above = Math.max(0, anchorRect.top - clipTop - VP_ROSTER_POPUP_GAP_PX);
  const below = Math.max(0, clipBottom - anchorRect.bottom - VP_ROSTER_POPUP_GAP_PX);
  const target = Math.max(0, Number(desiredHeight) || 0);

  let placement = 'down';
  if (below < target && above >= target) placement = 'up';
  else if (below < target && above > below) placement = 'up';

  return {
    placement,
    availableHeight: Math.floor(placement === 'up' ? above : below),
  };
}

export default {
  name: 'SessionCreateModal',
  components: { VpAvatar, ModernSelect },
  props: {
    initialProvider: { type: String, default: 'yeaft' },
    initialAgentId: { type: String, default: null },
  },
  emits: ['close', 'created'],
  template: `
    <Teleport to="body">
    <div class="modal-overlay" @click.self="onOverlayClick" role="dialog" aria-modal="true" :aria-label="$t('yeaft.session.create.title')">
      <div class="modal resume-modal yeaft-session-create-modal">
        <div class="resume-modal-controls">
          <button class="resume-close-btn" type="button" @click="requestClose" :aria-label="$t('yeaft.session.create.close')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>

          <header class="yeaft-session-create-heading">
            <h2>{{ $t('yeaft.session.create.title') }}</h2>
            <p>{{ $t('yeaft.session.create.subtitle') }}</p>
          </header>

          <div class="yeaft-session-create-fields">
            <div class="resume-control-row">
            <label class="resume-control-label">{{ $t('yeaft.session.create.agentLabel') }}</label>
            <ModernSelect
              v-model="form.agentId"
              :options="agentSelectOptions"
              :aria-label="$t('yeaft.session.create.agentLabel')"
              menu-class="yeaft-session-create-select-menu"
            />
          </div>

          <div class="resume-control-row">
            <label class="resume-control-label">{{ $t('modal.newConv.provider') }}</label>
            <ModernSelect
              v-model="form.provider"
              :options="providerOptions"
              :aria-label="$t('modal.newConv.provider')"
              menu-class="yeaft-session-create-select-menu"
            />
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
          <div v-if="isYeaftProvider" class="resume-control-row resume-control-row-vp">
            <label class="resume-control-label">{{ $t('yeaft.session.create.vpPicker') }}</label>
            <div class="yeaft-roster" ref="vpRosterRoot">
              <div v-if="vpList.length === 0 && vpLibraryEmpty" class="yeaft-roster-empty">
                {{ $t('yeaft.session.create.rosterEmpty') }}
              </div>
              <div v-else-if="vpList.length === 0 && vpLibraryError" class="yeaft-roster-empty yeaft-roster-error" role="alert">
                <span>{{ $t('yeaft.session.create.rosterError') }}</span>
                <button type="button" class="btn-secondary yeaft-roster-retry" @click="retryVpSnapshot">
                  {{ $t('yeaft.session.create.rosterRetry') }}
                </button>
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
                  aria-controls="yeaft-session-create-vp-picker"
                  ref="vpRosterTrigger"
                  @click="toggleVpRoster"
                >
                  <span class="yeaft-roster-trigger-summary">{{ vpRosterSummary }}</span>
                  <span class="yeaft-roster-caret" aria-hidden="true">▾</span>
                </button>
                <div
                  v-if="vpRosterOpen"
                  class="yeaft-roster-list yeaft-roster-popup"
                  :class="{ 'opens-up': vpRosterPlacement === 'up' }"
                  :style="vpRosterPopupStyle"
                  id="yeaft-session-create-vp-picker"
                  role="group"
                  :aria-label="$t('yeaft.session.create.vpPicker')"
                  ref="vpRosterPopup"
                >
                  <section
                    v-for="domain in vpDomainSections"
                    :key="domain.id"
                    class="yeaft-roster-domain-section"
                    :aria-labelledby="'yeaft-create-vp-domain-' + domain.id"
                  >
                    <h3
                      class="vp-domain-heading yeaft-roster-domain"
                      :id="'yeaft-create-vp-domain-' + domain.id"
                    >
                      <span>{{ $t(domain.labelKey) }}</span>
                    </h3>
                    <ul class="yeaft-roster-domain-list">
                      <li
                        v-for="vp in domain.vps"
                        :key="vp.vpId"
                        class="yeaft-roster-item"
                        :class="{ 'is-selected': form.vpIds.includes(vp.vpId), 'is-default': form.defaultVpId === vp.vpId }"
                      >
                        <label class="yeaft-roster-row">
                          <input
                            type="checkbox"
                            :value="vp.vpId"
                            :checked="form.vpIds.includes(vp.vpId)"
                            @change="toggleVp(vp.vpId, $event.target.checked)"
                          />
                          <VpAvatar :vp-id="vp.vpId" :size="20" :aria-label="vpLabelFor(vp.vpId)" />
                          <span class="yeaft-roster-copy">
                            <span class="yeaft-roster-name" :style="{ color: vpTextColorFor(vp.vpId) }">{{ vpLabelFor(vp.vpId) }}</span>
                            <span v-if="vpDescriptionFor(vp.vpId)" class="yeaft-roster-description">{{ vpDescriptionFor(vp.vpId) }}</span>
                          </span>
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
                  </section>
                </div>
              </template>
            </div>
          </div>
          </div>
        </div>

        <!-- Content area: folders or existing Sessions for the chosen workDir -->
        <div class="resume-modal-content">
          <!-- Folder aggregation (workDir empty) -->
          <div class="resume-panel" v-if="!form.workDir">
            <div class="resume-panel-header">
              <span>{{ $t('yeaft.session.create.folderLabel') }}</span>
            </div>
            <div class="resume-panel-list">
              <div
                v-for="folder in createFolderRows"
                :key="folder.path"
                class="resume-list-item folder-item-compact"
                @click="selectFolder(folder.path)"
              >
                <div class="item-path">{{ folder.path }}</div>
                <span class="item-badge">{{ folder.count }}</span>
              </div>
              <div class="resume-panel-empty" v-if="createFolderRows.length === 0">
                {{ $t('yeaft.session.create.noWorkDirs') }}
              </div>
            </div>
          </div>

          <!-- Sessions for the chosen workDir — ONE list. Current rows come
               from the Agent-owned manifest regardless of sidebar visibility;
               only explicitly marked workDir-local legacy rows need import. -->
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
                @click="loadProviderSessions"
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
                  v-for="session in createSessionRows"
                  :key="session.id"
                  class="resume-list-item session-item-compact"
                  :class="{ 'is-busy': restoring === session.id, 'is-disabled': restoring && restoring !== session.id }"
                  @click="selectSession(session)"
                >
                  <div class="item-name">{{ session.name || session.id }}</div>
                  <div class="item-time">{{ formatDate(session.createdAt) }}</div>
                </div>
                <div class="resume-panel-empty" v-if="createSessionRows.length === 0 && !restoreError">
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
            class="modern-btn btn-primary yeaft-create-submit"
            type="button"
            @click="onSubmit"
            :disabled="busy || !canSubmit"
          >
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            {{ busy ? $t('yeaft.session.create.creating') : $t('yeaft.session.create.submit') }}
          </button>
        </div>

        <!-- Folder picker -->
        <div class="folder-picker-overlay yeaft-folder-picker-overlay" v-if="folderPickerOpen" @click.self="closeFolderPicker">
          <div class="folder-picker-dialog yeaft-folder-picker-dialog">
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
        provider: ['yeaft', 'copilot', 'claude-code'].includes(this.initialProvider) ? this.initialProvider : 'yeaft',
        name: '',
        // Pre-checked once vpList hydrates (see applyDefaultSelection).
        vpIds: [],
        defaultVpId: null,
        workDir: '',
        // Which agent owns the new session — populated in mounted().
        agentId: this.initialAgentId || null,
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
      vpRosterPlacement: 'down',
      vpRosterAvailableHeight: null,
      // Disk-scanned session list for the currently chosen workDir.
      // `scannedSessions` is the raw Agent response for the selected folder.
      // Current manifest rows remain here even when sidebar UI metadata hides
      // them; only legacy workDir-local rows carry `legacyImport`.
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
      vpSnapshotTimer: null,
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
    isYeaftProvider() { return this.form.provider === 'yeaft'; },
    vpLibraryReady() {
      const s = this.vpStore;
      return !!(s
        && s.snapshotStatus === 'ready'
        && s.snapshotAgentId === this.form.agentId
        && s.lastVpSnapshotAgentId === this.form.agentId);
    },
    vpList() { return this.vpLibraryReady ? (this.vpStore?.vpList || []) : []; },
    vpDomainSections() { return buildVpDomainSections(this.vpList); },
    vpListSignature() {
      return (this.vpList || []).map(vp => vp && vp.vpId).filter(Boolean).join(',');
    },
    vpLibraryEmpty() {
      const s = this.vpStore;
      if (!s || !this.vpLibraryReady) return false;
      if (s.emptyLibrary === true) return true;
      return !!(s.lastSnapshotAt && s.lastSnapshotAt > 0 && (s.vpOrder?.length || 0) === 0);
    },
    vpLibraryError() {
      const s = this.vpStore;
      if (!s || s.snapshotStatus !== 'error') return false;
      return !s.snapshotAgentId || s.snapshotAgentId === this.form.agentId;
    },
    agentOptions() {
      const s = this.chat;
      if (!s || !Array.isArray(s.agents)) return [];
      return s.agents.map(a => ({ id: a.id, name: a.name, online: !!a.online, workDir: a.workDir || '' }));
    },
    agentSelectOptions() {
      return this.agentOptions.map(agent => ({
        value: agent.id,
        label: agent.name || agent.id,
        sublabel: agent.online ? '' : this.$t('settings.dashboard.offline'),
        disabled: !agent.online,
      }));
    },
    providerOptions() {
      return [
        { value: 'yeaft', label: 'Yeaft' },
        { value: 'copilot', label: this.$t('provider.copilot') },
        { value: 'claude-code', label: this.$t('provider.claudeCode') },
      ];
    },
    // Identity+online signature of the agent roster. We watch THIS (not
    // agentOptions.length) to re-seed form.agentId: the UI keeps offline
    // agents in the list (rendered with "(offline)"), so an agent going
    // offline — or a simultaneous up/down swap — leaves the count
    // unchanged. A length watcher would miss those and strand form.agentId
    // on a dead agent (canSubmit blocks, scan hits a dead ws). The
    // signature changes whenever any agent's id or online flag changes.
    agentSignature() {
      return this.agentOptions.map(a => `${a.id}:${a.online ? 1 : 0}`).join(',');
    },
    folderPickerAgentId() {
      return this.form.agentId || this.chat?.currentAgent || '';
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
      // No agent resolved yet (roster still loading) — fall back to the
      // un-scoped list so the folder panel isn't blank during that brief
      // window. This does NOT reintroduce the wrong-agent bug: the actual
      // disk scan refuses to run without an agentId (loadRestoreCandidates),
      // so the worst case here is a momentary cross-agent folder list, not
      // a scan against the wrong agent.
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
      const selectedAgentId = this.form.agentId || null;
      const list = Array.isArray(this.scannedSessions) ? this.scannedSessions : [];
      return list
        .filter(s => s && s.id)
        .map(session => ({
          ...session,
          ...(session.agentId || selectedAgentId ? { agentId: session.agentId || selectedAgentId } : {}),
        }));
    },
    chatFolderRows() {
      return (this.chat?.folders || []).map(folder => ({
        path: folder.path || folder.name || '',
        count: Number(folder.sessionCount) || 0,
      })).filter(folder => folder.path);
    },
    createFolderRows() {
      return this.isYeaftProvider ? this.folderAggregates : this.chatFolderRows;
    },
    createSessionRows() {
      if (this.isYeaftProvider) return this.sessionsInDir;
      return (this.chat?.historySessions || []).map(session => ({
        ...session,
        id: session.sessionId,
        name: session.title,
        createdAt: session.lastModified,
      }));
    },
    canSubmit() {
      if (this.isYeaftProvider && (!this.vpLibraryReady || this.form.vpIds.length === 0)) return false;
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
    vpRosterPopupStyle() {
      if (!Number.isFinite(this.vpRosterAvailableHeight)) return {};
      return { '--vp-roster-available-height': `${this.vpRosterAvailableHeight}px` };
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onEsc);
    window.addEventListener('resize', this.scheduleVpRosterLayout);
    window.visualViewport?.addEventListener('resize', this.scheduleVpRosterLayout);
    window.visualViewport?.addEventListener('scroll', this.scheduleVpRosterLayout);
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
    // Watch the VP identity signature, not only length: switching agents can
    // return the same number of VPs in a different library. The create UI must
    // still prefer the generalist Omni VP whenever that target library has it.
    vpListSignature() {
      this.applyDefaultSelection();
      this.scheduleVpRosterLayout();
    },
    // The agent list arrives over the WebSocket, so on a cold page load it
    // can be empty at mount() — leaving form.agentId null. A <select>
    // bound to a null model still *visually* shows its first <option>
    // ("server"), so the user sees an agent picked while the model is
    // actually empty; the scan then goes out with no agentId and the
    // server silently falls back to client.currentAgent (the top-left
    // agent list) — scanning the wrong agent's disk and returning an
    // empty session list. Re-seed whenever the roster's identity/online
    // signature changes (NOT just its length — offline agents stay in the
    // list, so length alone misses an agent going offline) so the bound
    // value always matches a real, online option the user can see.
    agentSignature() {
      this.seedAgentDefault();
      this.scheduleVpRosterLayout();
    },
    // fix-session-restore-modal-unify: re-subscribe when the user picks
    // a different agent from the dropdown, since the VP library is
    // per-agent (one agent's VPs are not the other's). Also re-scan
    // the disk panel because the workdir registry is per-agent too.
    'form.provider'(next, prev) {
      if (next === prev) return;
      this.form.workDir = '';
      this.scannedSessions = [];
      this.restoreError = '';
      if (next === 'yeaft') {
        this.subscribeVpsFor(this.form.agentId);
        this.applyDefaultSelection();
      } else if (this.form.agentId) {
        this.chat?.listFoldersForAgent?.(this.form.agentId, next);
      }
    },
    'form.agentId'(next, prev) {
      if (next === prev) return;
      if (this.isYeaftProvider) this.subscribeVpsFor(next);
      // VP list is per-agent — clear stale selection so the user
      // doesn't accidentally create a session with a VP that doesn't
      // exist on the newly-targeted agent.
      this.form.vpIds = [];
      this.form.defaultVpId = null;
      this.vpPickerTouched = false;
      // If the VP library is already hydrated for this agent, subscribing is
      // intentionally skipped and vpListSignature will not change. Re-apply the
      // default immediately so a cold modal does not get stuck on "no VP" after
      // the async agent roster seeds form.agentId.
      if (this.isYeaftProvider) this.applyDefaultSelection();
      // Reset scanned-from-disk state; workDir + agent both contribute
      // to which sessions are visible.
      this.scannedSessions = [];
      this.restoreError = '';
      if (!this.isYeaftProvider && next) this.chat?.listFoldersForAgent?.(next, this.form.provider);
      if ((this.form.workDir || '').trim()) this.loadProviderSessions();
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
      this.loadProviderSessions();
    },
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onEsc);
    window.removeEventListener('resize', this.scheduleVpRosterLayout);
    window.visualViewport?.removeEventListener('resize', this.scheduleVpRosterLayout);
    window.visualViewport?.removeEventListener('scroll', this.scheduleVpRosterLayout);
    window.removeEventListener('workbench-message', this.handleFolderPickerMessage);
    document.removeEventListener('click', this.handleOutsideRosterClick, true);
    if (this._vpRosterLayoutFrame) cancelAnimationFrame(this._vpRosterLayoutFrame);
    if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
    if (this.vpSnapshotTimer) clearTimeout(this.vpSnapshotTimer);
  },
  methods: {
    toggleVpRoster() {
      if (this.vpRosterOpen) {
        this.closeVpRoster();
        return;
      }
      this.vpRosterPlacement = 'down';
      this.vpRosterAvailableHeight = null;
      this.vpRosterOpen = true;
      this.$nextTick(this.scheduleVpRosterLayout);
    },
    closeVpRoster() {
      this.vpRosterOpen = false;
      this.vpRosterAvailableHeight = null;
    },
    scheduleVpRosterLayout() {
      if (!this.vpRosterOpen || this._vpRosterLayoutFrame) return;
      this._vpRosterLayoutFrame = requestAnimationFrame(() => {
        this._vpRosterLayoutFrame = null;
        this.updateVpRosterLayout();
      });
    },
    updateVpRosterLayout() {
      if (!this.vpRosterOpen) return;
      const trigger = this.$refs.vpRosterTrigger;
      const popup = this.$refs.vpRosterPopup;
      const modal = trigger?.closest?.('.resume-modal');
      if (!trigger || !popup || !modal) return;

      const previousMaxHeight = popup.style.maxHeight;
      popup.style.maxHeight = 'none';
      const desiredHeight = popup.scrollHeight;
      popup.style.maxHeight = previousMaxHeight;
      const viewport = window.visualViewport;
      const viewportTop = viewport ? viewport.offsetTop : 0;
      const viewportHeight = viewport ? viewport.height : window.innerHeight;
      const viewportRect = { top: viewportTop, bottom: viewportTop + viewportHeight };
      const boundaryRect = modal.getBoundingClientRect();
      const layout = resolveVpRosterPopupLayout(
        trigger.getBoundingClientRect(),
        boundaryRect,
        viewportRect,
        desiredHeight,
      );
      this.vpRosterPlacement = layout.placement;
      this.vpRosterAvailableHeight = layout.availableHeight;
    },
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
        const preferred = chat ? (chat.currentAgent || null) : null;
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
     * this modal uses (form.agentId wins; falls back to currentAgent — the
     * single client-bound agent — for users who haven't picked one yet).
     * If nothing resolves, we WARN loudly — silent failure is what made
     * the original bug a multi-file root-cause hunt.
     */
    subscribeVpsFor(agentId, { force = false } = {}) {
      const chat = this.chat;
      const target = agentId || chat?.currentAgent || null;
      const vp = this.vpStore;
      if (!chat || typeof chat.sendWsMessage !== 'function' || !target) {
        const requestId = `vp_snapshot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        vp?.beginSnapshot?.(target, requestId);
        vp?.failSnapshot?.(target, requestId, 'No online Agent is available.');
        return false;
      }
      // The only reusable roster is the current ready scope. Historical source
      // metadata is insufficient: after A→B, `lastVpSnapshotAgentId === A` may
      // still be true while B owns the pending request.
      const reusable = !force
        && vp?.snapshotStatus === 'ready'
        && vp.snapshotAgentId === target
        && vp.lastVpSnapshotAgentId === target;
      if (reusable) {
        if (this.vpSnapshotTimer) clearTimeout(this.vpSnapshotTimer);
        this.vpSnapshotTimer = null;
        return true;
      }
      const requestId = `vp_snapshot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      vp?.beginSnapshot?.(target, requestId);
      const sent = chat.sendWsMessage({ type: 'yeaft_vp_subscribe', agentId: target, requestId });
      if (sent === false) {
        vp?.failSnapshot?.(target, requestId, 'WebSocket is not connected.');
        return false;
      }
      if (this.vpSnapshotTimer) clearTimeout(this.vpSnapshotTimer);
      this.vpSnapshotTimer = setTimeout(() => {
        this.vpSnapshotTimer = null;
        if (vp?.snapshotStatus === 'loading' && vp.snapshotRequestId === requestId) {
          vp.failSnapshot(target, requestId, 'VP library request timed out.');
        }
      }, 10_000);
      return true;
    },
    retryVpSnapshot() {
      this.subscribeVpsFor(this.form.agentId, { force: true });
    },
    loadProviderSessions() {
      if (this.isYeaftProvider) return this.loadRestoreCandidates();
      const workDir = (this.form.workDir || '').trim();
      if (!workDir || !this.form.agentId) return;
      this.chat?.listHistorySessionsForAgent?.(this.form.agentId, workDir, this.form.provider);
    },
    /**
     * fix-session-restore-modal-unify: scan the workdir for on-disk
     * yeaft sessions. Folded in from the old standalone
     * SessionRestoreModal. Current Sessions come from the Agent manifest;
     * workDir-local rows are explicitly marked as legacy imports.
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
      // Same rule as loadRestoreCandidates: restore must target the
      // modal's selected agent, never let the server fall back to
      // client.currentAgent on a null agentId (it would register the
      // session into the wrong agent's registry). onRestoreClick is NOT
      // gated by canSubmit — a row is clickable as soon as it renders — so
      // guard here explicitly.
      const agentId = this.form.agentId || null;
      if (!agentId) {
        this.restoreError = this.$t('yeaft.restore.modal.restoreError', { message: 'no agent selected' });
        return;
      }
      this.restoring = session.id;
      this.restoreError = '';
      try {
        const res = await chat.sessionCrudRequest(
          'restore',
          { sessionId: session.id, workDir: (this.form.workDir || '').trim() },
          { agentId },
        );
        if (res && res.ok) {
          const restored = res.session || res.group || session;
          // Mirror resumeExisting / onSubmit: pin currentAgent +
          // sessionsStore.active + chat filter to the restored session so
          // the user doesn't get bounced back to whatever was active.
          const owner = restored?.agentId || session.agentId || agentId;
          if (owner && chat.currentAgent !== owner
              && typeof chat.selectAgent === 'function') {
            chat.selectAgent(owner);
          }
          if (this.sessionsStore) this.sessionsStore.setActive(restored.id || session.id, owner);
          if (typeof chat.setActiveSessionFilter === 'function') {
            chat.setActiveSessionFilter(restored.id || session.id, { agentId: owner, force: true });
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
      const list = this.vpList || [];
      if (list.length === 0) return;
      const ids = list.map(vp => vp && vp.vpId).filter(Boolean);
      if (ids.length === 0) return;
      const currentIds = Array.isArray(this.form.vpIds) ? this.form.vpIds : [];
      const currentValid = currentIds.filter(id => ids.includes(id));
      const currentDefaultValid = this.form.defaultVpId && currentValid.includes(this.form.defaultVpId);
      if (currentValid.length > 0 && currentDefaultValid) {
        if (currentValid.length !== currentIds.length) this.form.vpIds = currentValid;
        return;
      }

      const pick = ids.includes(OMNI_VP_ID) ? OMNI_VP_ID : (currentValid[0] || ids[0]);
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
    vpDescriptionFor(vpId) {
      const fn = this.vpStore?.vpDescription;
      return typeof fn === 'function' ? fn(vpId) : '';
    },
    vpTextColorFor(vpId) {
      const fn = this.vpStore?.vpTextColor;
      return typeof fn === 'function' ? fn(vpId) : 'var(--text-primary)';
    },
    selectFolder(path) { this.form.workDir = path; },
    /**
     * Current manifest Sessions resume directly. If catalog metadata hides the
     * exact Agent + Session row, selecting it also restores sidebar visibility.
     * Only workDir-local legacy rows require the import operation.
     */
    selectSession(session) {
      if (!session || !session.id) return;
      if (!this.isYeaftProvider) {
        const workDir = session.workDir || (this.form.workDir || '').trim() || this.defaultWorkDir;
        this.chat?.selectAgent?.(this.form.agentId);
        this.chat._pendingSessionTitle = session.name || session.title || null;
        this.chat?.resumeConversation?.(session.id, workDir, this.form.agentId, this.chatProviderOptions());
        this.$emit('close');
        return;
      }
      if (session.legacyImport) {
        this.onRestoreClick(session);
      } else {
        this.resumeExisting(session);
      }
    },
    chatProviderOptions() {
      const options = { provider: this.form.provider };
      if (this.form.provider === 'copilot') options.providerOptions = { allowAllTools: true };
      return options;
    },
    resumeExisting(session) {
      if (!session || !session.id) return;
      const chat = this.chat;
      const owner = session.agentId || this.form.agentId || null;
      const hiddenRow = (chat?.hiddenSessionCatalog || []).find(row => (
        row?.runtimeProvider === 'yeaft'
        && row?.routeRef?.agentId === owner
        && row?.routeRef?.sessionId === session.id
      ));
      if (hiddenRow && chat?.restoreCatalogSession?.(hiddenRow) !== true) {
        this.restoreError = this.$t('yeaft.restore.modal.restoreError', { message: 'catalog unavailable' });
        return;
      }
      // 1. Cross-agent route — if the session belongs to a different
      //    agent than the one currently selected, switch first so any
      //    subsequent CRUD/messaging hits the owning agent. Mirrors
      //    YeaftSidebar.onSelectGroup.
      if (owner && chat && chat.currentAgent !== owner
          && typeof chat.selectAgent === 'function') {
        chat.selectAgent(owner);
      }
      // 2. UI pointer (which session the main pane shows).
      if (this.sessionsStore) this.sessionsStore.setActive(session.id, owner);
      // 3. The action that actually fires `yeaft_load_history` and
      //    sets `yeaftActiveSessionFilter`. Without this, the modal
      //    closes but the main pane stays empty — that's the bug
      //    users reported as "resume doesn't work". `force: true` so
      //    it re-fires even when re-picking the currently-active id.
      if (chat && typeof chat.setActiveSessionFilter === 'function') {
        chat.setActiveSessionFilter(session.id, { agentId: owner, force: true });
      }
      this.$emit('created', { ...session, ...(owner ? { agentId: owner } : {}) });
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
      this.closeVpRoster();
    },
    getLastPathSegment(p) { return getLastPathSegment(p); },
    formatDate(iso) { return formatResumeDate(iso, this.$t.bind(this)); },
    onEsc(e) {
      if (e.key !== 'Escape') return;
      if (this.folderPickerOpen) return;
      if (this.vpRosterOpen) {
        this.closeVpRoster();
        return;
      }
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
        if (!this.chat) {
          this.submitError = this.$t('yeaft.session.error.unknown', { message: 'store unavailable' });
          return;
        }
        if (!this.isYeaftProvider) {
          const workDir = this.form.workDir.trim() || this.defaultWorkDir;
          this.chat.selectAgent?.(this.form.agentId);
          this.chat.createConversation?.(workDir, this.form.agentId, null, this.chatProviderOptions());
          this.$emit('created', { provider: this.form.provider, workDir });
          this.$emit('close');
          return;
        }
        if (typeof this.chat.createYeaftSession !== 'function') {
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
          const owner = created?.agentId || this.form.agentId || null;
          if (id) {
            if (owner && chat && chat.currentAgent !== owner
                && typeof chat.selectAgent === 'function') {
              chat.selectAgent(owner);
            }
            if (this.sessionsStore) this.sessionsStore.setActive(id, owner);
            if (chat && typeof chat.setActiveSessionFilter === 'function') {
              chat.setActiveSessionFilter(id, { agentId: owner, force: true });
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
