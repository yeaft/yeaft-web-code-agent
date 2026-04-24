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
              <li v-for="vp in vpList" :key="vp.vpId" class="group-wizard-roster-item" role="option" :aria-selected="form.roster.includes(vp.vpId)">
                <label>
                  <input
                    type="checkbox"
                    :value="vp.vpId"
                    :checked="form.roster.includes(vp.vpId)"
                    @change="toggleMember(vp.vpId, $event.target.checked)"
                  />
                  <span class="group-wizard-roster-avatar" :style="{ background: vpColorFor(vp.vpId) }">
                    {{ vpInitialFor(vp.vpId) }}
                  </span>
                  <span class="group-wizard-roster-name">{{ vpLabelFor(vp.vpId) }}</span>
                  <span class="group-wizard-roster-id">@{{ vp.vpId }}</span>
                  <span v-if="form.roster.includes(vp.vpId)" class="group-wizard-default-radio">
                    <input
                      type="radio"
                      name="group-wizard-default"
                      :value="vp.vpId"
                      :checked="form.defaultVpId === vp.vpId"
                      @click.stop
                      @change="form.defaultVpId = vp.vpId"
                      :title="$t('unify.group.wizard.defaultVpHint')"
                    />
                    <span class="group-wizard-default-label">{{ $t('unify.group.wizard.defaultVp') }}</span>
                  </span>
                </label>
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
      },
      busy: false,
      nameError: '',
      submitError: '',
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
  },
  mounted() {
    window.addEventListener('keydown', this.onEsc);
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
    vpColorFor(vpId) {
      const fn = this.vpStore?.vpColor;
      return typeof fn === 'function' ? fn(vpId) : '#5B8DEF';
    },
    vpInitialFor(vpId) {
      const fn = this.vpStore?.vpInitial;
      return typeof fn === 'function' ? fn(vpId) : (vpId ? vpId.charAt(0).toUpperCase() : '?');
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
