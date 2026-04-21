/**
 * GroupCreateWizard — task-334m.
 *
 * Two-step wizard for creating a new group:
 *   Step 1 (Name)     — free-form name; required, trimmed.
 *   Step 2 (Members)  — multi-select VP roster + default-VP radio.
 *
 * Roster is authoritative — the wizard does NOT default to the full VP
 * library (D1 seed is the only place that auto-expands). An empty roster
 * is permitted on create (the group just opens in the no_default_vp invite
 * state); the UI nudges with the invite modal on first send.
 *
 * All data flows through useChatStore().groupCrudRequest('create', …) which
 * wraps the WS round-trip in a 10s-timeout Promise and resolves with a
 * uniform `{ok, op, group?, error?}` shape.
 */
// Stores are resolved lazily via window.Pinia to keep this module
// importable in node-only unit tests that don't mount Pinia.
// (See UnifySidebarV2 for the same pattern.)

export default {
  name: 'GroupCreateWizard',
  emits: ['close', 'created'],
  template: `
    <div class="group-wizard-overlay" @click.self="onOverlayClick" role="dialog" aria-modal="true" :aria-label="$t('unify.group.wizard.title')">
      <div class="group-wizard-modal">
        <header class="group-wizard-header">
          <span class="group-wizard-title">{{ $t('unify.group.wizard.title') }}</span>
          <button class="group-wizard-close" type="button" @click="requestClose" :aria-label="$t('unify.group.wizard.close')">×</button>
        </header>

        <div class="group-wizard-steps" role="tablist">
          <span class="group-wizard-step" :class="{ 'is-active': step === 1 }" role="tab" :aria-selected="step === 1">
            1. {{ $t('unify.group.wizard.step.name') }}
          </span>
          <span class="group-wizard-step" :class="{ 'is-active': step === 2 }" role="tab" :aria-selected="step === 2">
            2. {{ $t('unify.group.wizard.step.members') }}
          </span>
        </div>

        <!-- STEP 1: NAME -->
        <div v-if="step === 1" class="group-wizard-body">
          <label class="group-wizard-field">
            <input
              type="text"
              v-model.trim="form.name"
              :placeholder="$t('unify.group.wizard.namePlaceholder')"
              maxlength="60"
              autocomplete="off"
              class="group-wizard-input"
              :class="{ 'is-error': !!nameError }"
              ref="nameInput"
              @keydown.enter.prevent="advanceFromName"
            />
            <span class="group-wizard-hint">{{ $t('unify.group.wizard.nameHint') }}</span>
            <span v-if="nameError" class="group-wizard-error">{{ nameError }}</span>
          </label>

          <div class="group-wizard-actions">
            <button class="group-wizard-link-btn" type="button" @click="requestClose">
              {{ $t('unify.group.wizard.cancel') }}
            </button>
            <button class="group-wizard-primary-btn" type="button" @click="advanceFromName" :disabled="!canAdvanceFromName">
              {{ $t('unify.group.wizard.next') }}
            </button>
          </div>
        </div>

        <!-- STEP 2: MEMBERS -->
        <div v-else class="group-wizard-body">
          <div class="group-wizard-field">
            <span class="group-wizard-field-label">{{ $t('unify.group.wizard.roster') }}</span>
            <span class="group-wizard-hint">{{ $t('unify.group.wizard.rosterHint') }}</span>
            <div v-if="vpList.length === 0" class="group-wizard-empty">
              {{ $t('unify.group.wizard.rosterEmpty') }}
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
                  <span class="group-wizard-roster-name">{{ vp.displayName || vp.vpId }}</span>
                  <span class="group-wizard-roster-id">@{{ vp.vpId }}</span>
                </label>
              </li>
            </ul>
          </div>

          <div class="group-wizard-field" v-if="form.roster.length > 0">
            <span class="group-wizard-field-label">{{ $t('unify.group.wizard.defaultVp') }}</span>
            <span class="group-wizard-hint">{{ $t('unify.group.wizard.defaultVpHint') }}</span>
            <ul class="group-wizard-default-list">
              <li v-for="vpId in form.roster" :key="vpId">
                <label>
                  <input
                    type="radio"
                    name="group-wizard-default"
                    :value="vpId"
                    :checked="form.defaultVpId === vpId"
                    @change="form.defaultVpId = vpId"
                  />
                  {{ vpLabelFor(vpId) }}
                </label>
              </li>
            </ul>
          </div>

          <div v-if="submitError" class="group-wizard-error" role="alert">
            {{ submitError }}
          </div>

          <div class="group-wizard-actions">
            <button class="group-wizard-link-btn" type="button" @click="step = 1" :disabled="busy">
              {{ $t('unify.group.wizard.back') }}
            </button>
            <button class="group-wizard-primary-btn" type="button" @click="onSubmit" :disabled="busy">
              {{ busy ? $t('unify.group.wizard.creating') : $t('unify.group.wizard.create') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
  data() {
    return {
      step: 1,
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
    canAdvanceFromName() { return (this.form.name || '').trim().length > 0; },
  },
  mounted() {
    this.$nextTick(() => {
      const el = this.$refs.nameInput;
      if (el && typeof el.focus === 'function') el.focus();
    });
    window.addEventListener('keydown', this.onEsc);
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
    advanceFromName() {
      this.nameError = '';
      if (!this.canAdvanceFromName) {
        this.nameError = this.$t('unify.group.error.invalid_name');
        return;
      }
      this.step = 2;
    },
    toggleMember(vpId, checked) {
      if (checked) {
        if (!this.form.roster.includes(vpId)) this.form.roster.push(vpId);
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
      if (this.busy) return;
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
        const msgKey = `unify.group.error.${code}`;
        const translated = this.$t(msgKey);
        // If the key didn't resolve (i18n returns the key back on miss), fall
        // back to the generic `unknown` template with the raw message.
        if (translated === msgKey) {
          this.submitError = this.$t('unify.group.error.unknown', { message: (res && res.error && res.error.message) || '' });
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
