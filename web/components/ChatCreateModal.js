/**
 * ChatCreateModal — Yeaft Chat Mode (1:1 with Omni).
 *
 * Yeaft Chat Mode runs against the built-in Omni assistant — no VP picker.
 * Specialist VPs live in Group Mode. The modal only takes an optional
 * display name and uses the same overlay/button vocabulary as
 * GroupCreateWizard for visual parity.
 */
export default {
  name: 'ChatCreateModal',
  emits: ['close', 'created'],
  template: `
    <Teleport to="body">
    <div class="group-edit-overlay group-wizard-overlay" @click.self="requestClose" role="dialog" aria-modal="true" :aria-label="$t('yeaft.chat.create.title')">
      <div class="group-edit-modal group-wizard-modal">
        <header class="group-edit-header">
          <span class="group-edit-title">{{ $t('yeaft.chat.create.title') }}</span>
          <button class="group-edit-close" type="button" @click="requestClose" aria-label="close">×</button>
        </header>
        <div class="group-wizard-body group-wizard-body-single">
          <label class="group-wizard-field">
            <span class="group-wizard-field-label">{{ $t('yeaft.chat.create.nameLabel') }}</span>
            <input type="text" v-model.trim="form.name"
              :placeholder="$t('yeaft.chat.create.namePlaceholder')"
              maxlength="60" autocomplete="off" class="group-wizard-input"
              ref="nameInput" @keydown.enter.prevent="onSubmit" />
          </label>
          <p v-if="error" class="group-wizard-error" role="alert">{{ error }}</p>
          <div class="group-wizard-actions">
            <button class="group-wizard-link-btn" type="button" @click="requestClose" :disabled="busy">
              {{ $t('common.cancel') }}
            </button>
            <button class="group-wizard-primary-btn" type="button" @click="onSubmit" :disabled="busy">
              {{ busy ? $t('common.creating') : $t('common.create') }}
            </button>
          </div>
        </div>
      </div>
    </div>
    </Teleport>
  `,
  data() {
    return {
      form: { name: '' },
      busy: false,
      error: '',
    };
  },
  computed: {
    chatStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useChatStore) return window.Pinia.useChatStore();
      } catch (_) {}
      return null;
    },
  },
  mounted() {
    this.$nextTick(() => { try { this.$refs.nameInput?.focus(); } catch (_) {} });
  },
  methods: {
    requestClose() { if (!this.busy) this.$emit('close'); },
    onSubmit() {
      if (this.busy) return;
      this.error = '';
      this.busy = true;
      try {
        // No vpId — agent defaults to omni. The chat-store still keys
        // memory by (chatId, vpId) so a chat opened with omni gets its
        // own isolated memory at chat/<c>/vp/omni.
        this.chatStore?.createYeaftChat({ displayName: this.form.name || '' });
        this.$emit('created', {});
        this.$emit('close');
      } catch (err) {
        this.error = err?.message || String(err);
      } finally {
        this.busy = false;
      }
    },
  },
};
