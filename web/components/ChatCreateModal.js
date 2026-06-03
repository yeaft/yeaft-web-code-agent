/**
 * ChatCreateModal — Yeaft Chat Mode (1:1).
 *
 * Pick exactly one VP + give the chat a display name. Single page, single
 * scroll, mirrors GroupCreateWizard styling so the two creation flows feel
 * unified. Stores are resolved lazily for test compatibility.
 */
import VpAvatar from './VpAvatar.js';

export default {
  name: 'ChatCreateModal',
  components: { VpAvatar },
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
          <div class="group-wizard-field">
            <span class="group-wizard-field-label">{{ $t('yeaft.chat.create.vpLabel') }}</span>
            <div v-if="vps.length === 0" class="group-wizard-hint">{{ $t('yeaft.chat.create.noVps') }}</div>
            <div v-else class="group-wizard-roster">
              <label v-for="vp in vps" :key="vp.id"
                class="group-wizard-vp-row"
                :class="{ selected: form.vpId === vp.id }">
                <input type="radio" name="chat-vp" :value="vp.id" v-model="form.vpId" />
                <VpAvatar :vp="vp" size="sm" />
                <span class="group-wizard-vp-name">{{ vp.displayName || vp.id }}</span>
              </label>
            </div>
          </div>
          <p v-if="error" class="group-wizard-error">{{ error }}</p>
        </div>
        <footer class="group-edit-footer">
          <button type="button" class="btn-secondary" @click="requestClose">{{ $t('common.cancel') }}</button>
          <button type="button" class="btn-primary" :disabled="!canSubmit" @click="onSubmit">
            {{ busy ? $t('common.creating') : $t('common.create') }}
          </button>
        </footer>
      </div>
    </div>
    </Teleport>
  `,
  data() {
    return {
      form: { name: '', vpId: '' },
      busy: false,
      error: '',
    };
  },
  computed: {
    vpStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useVpStore) return window.Pinia.useVpStore();
      } catch (_) {}
      return null;
    },
    chatStore() {
      try {
        if (typeof window !== 'undefined' && window.Pinia?.useChatStore) return window.Pinia.useChatStore();
      } catch (_) {}
      return null;
    },
    vps() {
      const s = this.vpStore;
      if (!s) return [];
      return Array.isArray(s.vps) ? s.vps : (Array.isArray(s.list) ? s.list : []);
    },
    canSubmit() {
      return !!this.form.vpId && !this.busy;
    },
  },
  mounted() {
    this.$nextTick(() => { try { this.$refs.nameInput?.focus(); } catch (_) {} });
  },
  methods: {
    requestClose() { if (!this.busy) this.$emit('close'); },
    onSubmit() {
      if (!this.canSubmit) return;
      this.error = '';
      this.busy = true;
      try {
        this.chatStore?.createYeaftChat({
          displayName: this.form.name || '',
          vpId: this.form.vpId,
        });
        this.$emit('created', { vpId: this.form.vpId });
        this.$emit('close');
      } catch (err) {
        this.error = err?.message || String(err);
      } finally {
        this.busy = false;
      }
    },
  },
};
