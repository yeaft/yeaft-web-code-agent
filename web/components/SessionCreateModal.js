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
import VpAvatar from './VpAvatar.js';

const OMNI_VP_ID = 'omni';

export default {
  name: 'SessionCreateModal',
  components: { VpAvatar },
  emits: ['close', 'created'],
  template: `
    <Teleport to="body">
    <div class="group-edit-overlay group-wizard-overlay" @click.self="onOverlayClick" role="dialog" aria-modal="true" :aria-label="$t('yeaft.session.create.title')">
      <div class="group-edit-modal group-wizard-modal">
        <header class="group-edit-header">
          <span class="group-edit-title">{{ $t('yeaft.session.create.title') }}</span>
          <button class="group-edit-close" type="button" @click="requestClose" :aria-label="$t('yeaft.group.wizard.close')">×</button>
        </header>

        <div class="group-wizard-body group-wizard-body-single">
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
              {{ $t('yeaft.group.wizard.rosterEmpty') }}
            </div>
            <div v-else-if="vpList.length === 0" class="group-wizard-empty group-wizard-empty-loading">
              {{ $t('yeaft.group.wizard.rosterLoading') }}
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
                  <VpAvatar :vp-id="vp.vpId" :size="22" :aria-label="vpLabelFor(vp.vpId)" />
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
              {{ $t('yeaft.group.wizard.cancel') }}
            </button>
            <button
              class="group-wizard-primary-btn"
              type="button"
              @click="onSubmit"
              :disabled="busy || !canSubmit"
            >
              {{ busy ? $t('yeaft.group.wizard.creating') : $t('yeaft.session.create.submit') }}
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
        // Omni pre-checked per Phase 3 spec.
        vpIds: [OMNI_VP_ID],
      },
      busy: false,
      submitError: '',
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
    vpLibraryEmpty() {
      const s = this.vpStore;
      if (!s) return false;
      if (s.emptyLibrary === true) return true;
      return !!(s.lastSnapshotAt && s.lastSnapshotAt > 0 && (s.vpOrder?.length || 0) === 0);
    },
    canSubmit() { return this.form.vpIds.length > 0; },
  },
  mounted() {
    window.addEventListener('keydown', this.onEsc);
    this.$nextTick(() => {
      try { this.$refs.nameInput?.focus(); } catch (_) {}
    });
    // Subscribe to VP snapshot if not yet hydrated (mirrors GroupCreateWizard).
    try {
      if (this.vpStore && this.vpStore.lastSnapshotAt === 0) {
        const chat = this.chat;
        if (chat && typeof chat.sendWsMessage === 'function') {
          chat.sendWsMessage({ type: 'yeaft_vp_subscribe' });
        }
      }
    } catch (_) {}
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onEsc);
  },
  methods: {
    onEsc(e) { if (e.key === 'Escape' && !this.busy) this.requestClose(); },
    onOverlayClick() { if (!this.busy) this.requestClose(); },
    requestClose() { this.$emit('close'); },
    toggleVp(vpId, checked) {
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
          this.submitError = this.$t('yeaft.group.error.unknown', { message: 'store unavailable' });
          return;
        }
        const res = await this.chat.createYeaftSession({
          displayName: this.form.name.trim(),
          vpIds: this.form.vpIds.slice(),
        });
        if (res && res.ok) {
          this.$emit('created', res.group);
          this.$emit('close');
          return;
        }
        const code = res?.error?.code || 'unknown';
        const message = res?.error?.message || '';
        const key = `yeaft.group.error.${code}`;
        const translated = this.$t(key, { message });
        this.submitError = translated === key
          ? this.$t('yeaft.group.error.unknown', { message })
          : translated;
      } catch (err) {
        this.submitError = this.$t('yeaft.group.error.unknown', { message: err?.message || String(err) });
      } finally {
        this.busy = false;
      }
    },
  },
};
