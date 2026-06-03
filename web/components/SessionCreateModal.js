/**
 * SessionCreateModal — Phase 3 unified Session creation.
 *
 * A session is operationally a group with N≥1 VPs (the coordinator
 * already handles N=1 fan-out). This single-screen modal replaces the
 * old chat / group split in the create-entry surface:
 *   - Name input (optional — agent derives a default if empty)
 *   - VP multi-picker (Omni pre-checked; user can pick more)
 *   - Create button → store.createYeaftSession({ displayName, vpIds })
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

          <div class="group-wizard-field">
            <span class="group-wizard-field-label">{{ $t('yeaft.session.create.vpPicker') }}</span>
            <div v-if="vpList.length === 0 && vpLibraryEmpty" class="group-wizard-empty">
              {{ $t('yeaft.session.wizard.rosterEmpty') }}
            </div>
            <div v-else-if="vpList.length === 0" class="group-wizard-empty group-wizard-empty-loading">
              {{ $t('yeaft.session.wizard.rosterLoading') }}
            </div>
            <ul v-else class="group-wizard-roster-list" role="listbox" aria-multiselectable="true">
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
        // Which agent owns the new session. Defaults to current Yeaft
        // agent (or first online) and is auto-populated in mounted().
        agentId: null,
      },
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
      return s.agents.map(a => ({ id: a.id, name: a.name, online: !!a.online }));
    },
    vpLibraryEmpty() {
      const s = this.vpStore;
      if (!s) return false;
      if (s.emptyLibrary === true) return true;
      return !!(s.lastSnapshotAt && s.lastSnapshotAt > 0 && (s.vpOrder?.length || 0) === 0);
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
    // Apply default selection synchronously if vpList already populated.
    this.applyDefaultSelection();
  },
  watch: {
    // Re-apply default selection once vpList hydrates (snapshot arrives
    // after mount). Skip if the user already touched the picker.
    'vpList.length'() { this.applyDefaultSelection(); },
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onEsc);
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
    onEsc(e) { if (e.key === 'Escape' && !this.busy) this.requestClose(); },
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
