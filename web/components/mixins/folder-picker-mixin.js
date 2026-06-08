/**
 * folder-picker-mixin — shared "browse + pick a directory" workflow.
 *
 * Extracted from SessionCreateModal so both the create modal and the new
 * SessionRestoreModal can share the same folder-picker UX without copying
 * 90 lines of glue. The mixin owns:
 *
 *  - Data:   folderPickerOpen / folderPickerPath / folderPickerEntries /
 *            folderPickerLoading / folderPickerSelected / _folderPickerTimer
 *  - Methods: openFolderPicker / closeFolderPicker / requestFolderPickerDir /
 *             loadFolderPickerDir / folderPickerNavigateUp /
 *             folderPickerSelectItem / folderPickerEnter / confirmFolderPicker /
 *             handleFolderPickerMessage
 *
 * Components consuming this mixin must provide:
 *  - computed `folderPickerAgentId` — string, currently-targeted agent id.
 *  - computed `defaultWorkDir` — string, workdir to seed picker if none set.
 *  - computed `chat` — chat store (must expose `sendWsMessage`).
 *  - method   `folderPickerInitialDir()` — string, dir to open the picker at
 *                                          (typically `this.workDir || this.defaultWorkDir`).
 *  - method   `folderPickerSetWorkDir(path)` — called when user confirms a path.
 *
 * The wire shape is pinned by `test/web/session-create-modal-workdir-picker.test.js`:
 *  - sends `{ type:'list_directory', conversationId:'_workdir_picker', agentId, dirPath, workDir }`
 *  - listens to `workbench-message` window events; reducer filters by
 *    `msg.conversationId === '_workdir_picker'`.
 * Do not rename `requestFolderPickerDir` / `handleFolderPickerMessage`.
 */

export const folderPickerData = () => ({
  folderPickerOpen: false,
  folderPickerPath: '',
  folderPickerEntries: [],
  folderPickerLoading: false,
  folderPickerSelected: '',
  _folderPickerTimer: null,
});

export const folderPickerMethods = {
  openFolderPicker() {
    const agentId = this.folderPickerAgentId;
    if (!agentId || !this.chat || typeof this.chat.sendWsMessage !== 'function') return;
    this.folderPickerOpen = true;
    this.folderPickerSelected = '';
    this.folderPickerLoading = true;
    const initial = typeof this.folderPickerInitialDir === 'function'
      ? (this.folderPickerInitialDir() || '')
      : (this.defaultWorkDir || '');
    this.folderPickerPath = initial;
    this.folderPickerEntries = [];
    this.requestFolderPickerDir(initial);
  },

  closeFolderPicker() {
    this.folderPickerOpen = false;
    if (this._folderPickerTimer) {
      clearTimeout(this._folderPickerTimer);
      this._folderPickerTimer = null;
    }
  },

  requestFolderPickerDir(dirPath) {
    const agentId = this.folderPickerAgentId;
    if (!agentId || !this.chat || typeof this.chat.sendWsMessage !== 'function') return;
    this.chat.sendWsMessage({
      type: 'list_directory',
      conversationId: '_workdir_picker',
      agentId,
      dirPath,
      workDir: this.defaultWorkDir || '',
    });
    if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
    this._folderPickerTimer = setTimeout(() => {
      if (this.folderPickerLoading && this.folderPickerOpen) this.requestFolderPickerDir(dirPath);
    }, 5000);
  },

  loadFolderPickerDir(dirPath) {
    this.folderPickerLoading = true;
    this.folderPickerSelected = '';
    this.folderPickerEntries = [];
    this.requestFolderPickerDir(dirPath);
  },

  folderPickerNavigateUp() {
    if (!this.folderPickerPath) return;
    const isWin = this.folderPickerPath.includes('\\');
    const sep = isWin ? '\\' : '/';
    const parts = this.folderPickerPath.replace(/[/\\]$/, '').split(/[/\\]/);
    parts.pop();
    if (parts.length === 0) {
      this.folderPickerPath = '';
      this.loadFolderPickerDir('');
    } else if (isWin && parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) {
      this.folderPickerPath = parts[0] + '\\';
      this.loadFolderPickerDir(this.folderPickerPath);
    } else {
      const parent = parts.join(sep);
      this.folderPickerPath = parent;
      this.loadFolderPickerDir(parent);
    }
  },

  folderPickerSelectItem(entry) { this.folderPickerSelected = entry.name; },

  folderPickerEnter(entry) {
    const isWin = this.folderPickerPath.includes('\\') || /^[A-Z]:/.test(entry.name);
    const sep = isWin ? '\\' : '/';
    let newPath;
    if (!this.folderPickerPath) {
      newPath = /^[A-Z]:$/.test(entry.name) ? entry.name + '\\' : '/' + entry.name;
    } else {
      newPath = this.folderPickerPath.replace(/[/\\]$/, '') + sep + entry.name;
    }
    this.folderPickerPath = newPath;
    this.loadFolderPickerDir(newPath);
  },

  confirmFolderPicker() {
    let path = this.folderPickerPath;
    if (!path) return;
    if (this.folderPickerSelected) {
      const sep = path.includes('\\') ? '\\' : '/';
      path = path.replace(/[/\\]$/, '') + sep + this.folderPickerSelected;
    }
    if (typeof this.folderPickerSetWorkDir === 'function') {
      this.folderPickerSetWorkDir(path);
    }
    this.closeFolderPicker();
  },

  handleFolderPickerMessage(event) {
    const msg = event.detail;
    if (!msg || msg.type !== 'directory_listing' || msg.conversationId !== '_workdir_picker') return;
    if (this._folderPickerTimer) {
      clearTimeout(this._folderPickerTimer);
      this._folderPickerTimer = null;
    }
    this.folderPickerLoading = false;
    this.folderPickerEntries = (msg.entries || [])
      .filter(e => e.type === 'directory')
      .sort((a, b) => a.name.localeCompare(b.name));
    if (msg.dirPath != null) this.folderPickerPath = msg.dirPath;
  },
};

/**
 * Convenience Options-API mixin object. Components can either:
 *   1. Spread the named exports above into their own data/methods, or
 *   2. Add this object to their `mixins: []`.
 *
 * SessionCreateModal uses option 1 to keep its tightly-co-located workdir
 * picker logic obvious; SessionRestoreModal uses option 2 because it has
 * no other state to mix in.
 */
export const folderPickerMixin = {
  data() { return folderPickerData(); },
  methods: { ...folderPickerMethods },
  mounted() {
    window.addEventListener('workbench-message', this.handleFolderPickerMessage);
  },
  beforeUnmount() {
    window.removeEventListener('workbench-message', this.handleFolderPickerMessage);
    if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
  },
};

export default folderPickerMixin;
