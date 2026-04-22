/**
 * GroupEditModal — task-338-F3 follow-up (N1).
 *
 * Modal replacement for the native window.prompt() / window.confirm() used
 * by GroupSelector for rename/archive. Styled after VpCrudModal's overlay
 * pattern so the unify surface is coherent.
 *
 * Props:
 *   mode     — 'rename' | 'archive'
 *   group    — { id, name, ... }  (the row the user is acting on)
 *
 * Emits:
 *   close    — user dismissed (overlay/cancel/Esc)
 *   confirm  — { mode, groupId, name? }
 *
 * The modal itself is dumb: parent (GroupSelector) owns the busy state + WS
 * round-trip so this stays easy to test in isolation.
 */

export default {
  name: 'GroupEditModal',
  props: {
    mode: { type: String, required: true },       // 'rename' | 'archive'
    group: { type: Object, required: true },
  },
  emits: ['close', 'confirm'],
  data() {
    return {
      nameDraft: this.group && this.group.name ? this.group.name : '',
      submitted: false,
    };
  },
  computed: {
    groupLabel() {
      return (this.group && (this.group.name || this.group.id)) || '';
    },
    isRename() { return this.mode === 'rename'; },
    isArchive() { return this.mode === 'archive'; },
    trimmed() { return String(this.nameDraft || '').trim(); },
    canSubmit() {
      if (this.submitted) return false;
      if (this.isArchive) return true;
      if (!this.trimmed) return false;
      // Disallow no-op rename (same as current name).
      if (this.trimmed === (this.group?.name || '')) return false;
      return true;
    },
    titleKey() {
      return this.isRename
        ? 'unify.group.editModal.renameTitle'
        : 'unify.group.editModal.archiveTitle';
    },
    bodyKey() {
      return this.isRename
        ? 'unify.group.editModal.renameBody'
        : 'unify.group.editModal.archiveBody';
    },
    submitKey() {
      return this.isRename
        ? 'unify.group.editModal.renameSubmit'
        : 'unify.group.editModal.archiveSubmit';
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onKey);
    this.$nextTick(() => {
      const el = this.$refs.nameInput;
      if (el && typeof el.focus === 'function') el.focus();
    });
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onKey);
  },
  methods: {
    onKey(ev) {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        this.requestClose();
      }
    },
    requestClose() {
      if (this.submitted) return;
      this.$emit('close');
    },
    onOverlayClick() { this.requestClose(); },
    onSubmit() {
      if (!this.canSubmit) return;
      this.submitted = true;
      if (this.isRename) {
        this.$emit('confirm', { mode: 'rename', groupId: this.group.id, name: this.trimmed });
      } else {
        this.$emit('confirm', { mode: 'archive', groupId: this.group.id });
      }
    },
    tr(key, params) {
      const fn = this.$t;
      if (typeof fn !== 'function') return key;
      return params ? fn(key, params) : fn(key);
    },
  },
  template: `
    <div class="group-edit-overlay" @click.self="onOverlayClick" role="dialog" aria-modal="true" :aria-label="tr(titleKey)">
      <div class="group-edit-modal">
        <header class="group-edit-header">
          <span class="group-edit-title">{{ tr(titleKey) }}</span>
          <button
            type="button"
            class="group-edit-close"
            @click="requestClose"
            :aria-label="tr('unify.group.editModal.close')"
          >×</button>
        </header>

        <form class="group-edit-body" @submit.prevent="onSubmit" novalidate>
          <p class="group-edit-message">{{ tr(bodyKey, { name: groupLabel }) }}</p>

          <label v-if="isRename" class="group-edit-field">
            <span class="group-edit-field-label">{{ tr('unify.group.editModal.newNameLabel') }}</span>
            <input
              ref="nameInput"
              type="text"
              v-model.trim="nameDraft"
              maxlength="80"
              class="group-edit-input"
              autocomplete="off"
              spellcheck="false"
            />
          </label>

          <div class="group-edit-actions">
            <button type="button" class="group-edit-btn" @click="requestClose" :disabled="submitted">
              {{ tr('unify.group.editModal.cancel') }}
            </button>
            <button
              type="submit"
              class="group-edit-btn is-primary"
              :class="{ 'is-danger': isArchive }"
              :disabled="!canSubmit"
            >
              {{ tr(submitKey) }}
            </button>
          </div>
        </form>
      </div>
    </div>
  `,
};
