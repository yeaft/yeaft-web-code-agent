import { childDirectory, directoryBreadcrumbs, parentDirectory } from '../utils/folder-picker-path.js';

/** One presentation for all Agent-scoped work-directory pickers.
 * The parent workflow owns requests and confirmation; this component only navigates.
 */
export default {
  name: 'FolderPickerDialog',
  props: { state: { type: Object, required: true } },
  emits: ['navigate', 'edit-path', 'confirm', 'close'],
  computed: {
    breadcrumbs() { return directoryBreadcrumbs(this.state.path); },
    parentPath() { return parentDirectory(this.state.path); },
  },
  mounted() {
    this._previousFocus = document.activeElement;
    this.$refs.pathInput.focus();
    this.$refs.pathInput.select();
  },
  beforeUnmount() {
    if (this._previousFocus?.isConnected) this._previousFocus.focus();
  },
  methods: {
    navigate(path) {
      this.$emit('navigate', path);
      this.$nextTick(() => this.$refs.list?.focus());
    },
    go() {
      if (!this.state.draft.trim()) return;
      this.navigate(this.state.draft.trim());
    },
    enter(entry) { this.navigate(childDirectory(this.state.path, entry.name)); },
    onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.$emit('close');
      } else if (event.key === 'Tab') {
        const controls = [...this.$refs.dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    },
    onListKeydown(event) {
      const buttons = [...this.$refs.list.querySelectorAll('.folder-picker-item')];
      const index = buttons.indexOf(document.activeElement);
      let target;
      if (event.key === 'ArrowDown') target = buttons[Math.min(index + 1, buttons.length - 1)];
      else if (event.key === 'ArrowUp') target = buttons[Math.max(0, index - 1)];
      else if (event.key === 'Home') target = buttons[0];
      else if (event.key === 'End') target = buttons[buttons.length - 1];
      else if (event.key === 'ArrowLeft' && this.state.path !== this.parentPath) {
        event.preventDefault();
        this.navigate(this.parentPath);
        return;
      } else return;
      event.preventDefault();
      target?.focus();
    },
  },
  template: `
    <Teleport to="body">
      <div class="folder-picker-overlay workdir-picker" @click.self="$emit('close')" @keydown="onKeydown">
        <div class="folder-picker-dialog" ref="dialog" role="dialog" aria-modal="true" :aria-label="$t('modal.folderPicker.title')">
          <header class="folder-picker-header">
            <h3>{{ $t('modal.folderPicker.title') }}</h3>
            <button class="btn-ghost" type="button" @click="$emit('close')" :aria-label="$t('common.close')">×</button>
          </header>
          <div class="folder-picker-path">
            <div class="folder-picker-navigation">
              <button class="btn-secondary" type="button" @click="navigate('')">{{ $t('modal.folderPicker.root') }}</button>
              <button class="btn-ghost" type="button" @click="navigate(parentPath)" :disabled="!state.path || state.path === parentPath">{{ $t('modal.folderPicker.parentDir') }}</button>
            </div>
            <div class="folder-picker-address">
              <input ref="pathInput" class="folder-picker-input" type="text" :value="state.draft"
                :aria-label="$t('modal.folderPicker.path')" :placeholder="$t('modal.folderPicker.path')"
                autocomplete="off" autocapitalize="off" spellcheck="false"
                @input="$emit('edit-path', $event.target.value)" @keydown.enter.prevent.stop="go" />
              <button class="btn-secondary" type="button" @click="go" :disabled="!state.draft.trim()">{{ $t('modal.folderPicker.go') }}</button>
            </div>
            <nav class="folder-picker-breadcrumbs" :aria-label="$t('modal.folderPicker.ancestors')">
              <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
                <span v-if="index" aria-hidden="true">›</span>
                <button class="btn-ghost" type="button" @click="navigate(crumb.path)" :aria-current="index === breadcrumbs.length - 1 ? 'location' : undefined" :title="crumb.path">{{ crumb.label }}</button>
              </template>
              <span v-if="!breadcrumbs.length">{{ state.path || $t('modal.folderPicker.root') }}</span>
            </nav>
          </div>
          <div class="folder-picker-list" ref="list" tabindex="0" :aria-label="$t('modal.folderPicker.directories')" :aria-busy="state.loading" @keydown="onListKeydown">
            <div class="folder-picker-state" v-if="state.loading" role="status"><span class="spinner-mini"></span> {{ $t('common.loading') }}</div>
            <div class="folder-picker-state folder-picker-error" v-else-if="state.error" role="alert">
              <span>{{ $t('modal.folderPicker.' + state.error) }}</span>
              <span v-if="state.errorDetail" class="folder-picker-error-detail">{{ state.errorDetail }}</span>
              <button class="btn-secondary" type="button" @click="navigate(state.path)">{{ $t('common.retry') }}</button>
            </div>
            <template v-else>
              <button v-for="entry in state.entries" :key="entry.name" class="folder-picker-item" type="button" @click="enter(entry)">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                <span>{{ entry.name }}</span><span aria-hidden="true">›</span>
              </button>
              <div class="folder-picker-state" v-if="!state.entries.length" role="status">{{ $t('common.noSubdirectories') }}</div>
            </template>
          </div>
          <footer class="folder-picker-footer">
            <p>{{ $t('modal.folderPicker.navigationHint') }}</p>
            <div>
              <button class="btn-secondary" type="button" @click="$emit('close')">{{ $t('common.cancel') }}</button>
              <button class="btn-primary" type="button" @click="$emit('confirm')" :disabled="!state.canConfirm">{{ $t('modal.folderPicker.selectCurrent') }}</button>
            </div>
          </footer>
        </div>
      </div>
    </Teleport>
  `,
};
