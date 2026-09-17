/** Shared Agent-scoped, read-only work-directory picker workflow.
 * Consumers provide folderPickerAgentId, chat, folderPickerInitialDir() and
 * folderPickerSetWorkDir(path). Use the mixin, or spread data/computed/methods
 * and register handleFolderPickerMessage / invalidateFolderPickerRequest.
 */
export const folderPickerData = () => ({
  folderPickerOpen: false,
  folderPickerPath: '',
  folderPickerDraft: '',
  folderPickerEntries: [],
  folderPickerLoading: false,
  folderPickerLoaded: false,
  folderPickerLoadedAgentId: null,
  folderPickerError: '',
  folderPickerErrorDetail: '',
  _folderPickerTimer: null,
  _folderPickerRequestId: null,
  _folderPickerRequestAgentId: null,
});

export const folderPickerComputed = {
  folderPickerState() {
    return {
      path: this.folderPickerPath,
      draft: this.folderPickerDraft,
      entries: this.folderPickerEntries,
      loading: this.folderPickerLoading,
      error: this.folderPickerError,
      errorDetail: this.folderPickerErrorDetail,
      canConfirm: this.canConfirmFolderPicker(),
    };
  },
};

let folderPickerRequestSequence = 0;

export const folderPickerMethods = {
  openFolderPicker() {
    if (!this.folderPickerAgentId || !this.chat?.sendWsMessage) return;
    this.folderPickerOpen = true;
    this.loadFolderPickerDir(this.folderPickerInitialDir?.() || this.defaultWorkDir || '');
  },

  invalidateFolderPickerRequest() {
    this._folderPickerRequestId = null;
    this._folderPickerRequestAgentId = null;
    if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
    this._folderPickerTimer = null;
  },

  closeFolderPicker() {
    this.folderPickerOpen = false;
    this.invalidateFolderPickerRequest();
  },

  failFolderPicker(error, detail = '') {
    this.invalidateFolderPickerRequest();
    this.folderPickerLoading = false;
    this.folderPickerLoaded = false;
    this.folderPickerError = error;
    this.folderPickerErrorDetail = detail;
  },

  requestFolderPickerDir(dirPath, retry = false) {
    const agentId = this.folderPickerAgentId;
    this.invalidateFolderPickerRequest();
    if (!agentId || !this.chat?.sendWsMessage) {
      this.failFolderPicker('unavailable');
      return;
    }
    const requestId = `folder-picker-${Date.now()}-${++folderPickerRequestSequence}`;
    this._folderPickerRequestId = requestId;
    this._folderPickerRequestAgentId = agentId;
    try {
      const sent = this.chat.sendWsMessage({
        type: 'list_directory',
        conversationId: '_workdir_picker',
        directoryPickerScope: 'agent',
        requestId,
        agentId,
        dirPath,
      });
      if (sent === false) {
        this.failFolderPicker('unavailable');
        return;
      }
    } catch (_) {
      this.failFolderPicker('unavailable');
      return;
    }
    this._folderPickerTimer = setTimeout(() => {
      if (!this.folderPickerOpen || this._folderPickerRequestId !== requestId) return;
      if (this.folderPickerAgentId !== agentId) {
        this.failFolderPicker('unavailable');
      } else if (retry) {
        this.failFolderPicker('timeout');
      } else {
        this.requestFolderPickerDir(dirPath, true);
      }
    }, 5000);
  },

  loadFolderPickerDir(dirPath) {
    // A bare Windows drive means its root, not its per-drive working directory.
    const path = /^[a-z]:$/i.test(dirPath) ? dirPath + '\\' : dirPath;
    this.folderPickerPath = path;
    this.folderPickerDraft = path;
    this.folderPickerLoading = true;
    this.folderPickerLoaded = false;
    this.folderPickerLoadedAgentId = null;
    this.folderPickerError = '';
    this.folderPickerErrorDetail = '';
    this.folderPickerEntries = [];
    this.requestFolderPickerDir(path);
  },

  folderPickerEditPath(path) { this.folderPickerDraft = path; },

  canConfirmFolderPicker() {
    return !!(this.folderPickerOpen && this.folderPickerPath && this.folderPickerLoaded
      && !this.folderPickerLoading && !this.folderPickerError
      && this.folderPickerDraft === this.folderPickerPath
      && this.folderPickerLoadedAgentId === this.folderPickerAgentId);
  },

  confirmFolderPicker() {
    if (!this.canConfirmFolderPicker()) return;
    this.folderPickerSetWorkDir?.(this.folderPickerPath);
    this.closeFolderPicker();
  },

  handleFolderPickerMessage(event) {
    const msg = event.detail;
    if (!msg || msg.type !== 'directory_listing' || msg.conversationId !== '_workdir_picker') return;
    if (!this.folderPickerOpen || !this._folderPickerRequestId
      || msg.requestId !== this._folderPickerRequestId
      || this.folderPickerAgentId !== this._folderPickerRequestAgentId
      || (msg.agentId != null && msg.agentId !== this._folderPickerRequestAgentId)) return;
    if (msg.error || !Array.isArray(msg.entries) || typeof msg.dirPath !== 'string') {
      this.failFolderPicker('loadFailed', typeof msg.error === 'string' ? msg.error : '');
      return;
    }
    this.invalidateFolderPickerRequest();
    this.folderPickerLoading = false;
    this.folderPickerLoaded = true;
    this.folderPickerLoadedAgentId = this.folderPickerAgentId;
    this.folderPickerEntries = msg.entries
      .filter(e => e?.type === 'directory' && typeof e.name === 'string')
      .sort((a, b) => a.name.localeCompare(b.name));
    // Keep a path being edited while a request is in flight; it isn't confirmed.
    if (this.folderPickerDraft === this.folderPickerPath) this.folderPickerDraft = msg.dirPath;
    this.folderPickerPath = msg.dirPath;
  },
};

export const folderPickerMixin = {
  data: folderPickerData,
  computed: folderPickerComputed,
  methods: folderPickerMethods,
  watch: {
    folderPickerAgentId() { this.closeFolderPicker(); },
  },
  mounted() {
    window.addEventListener('workbench-message', this.handleFolderPickerMessage);
  },
  beforeUnmount() {
    window.removeEventListener('workbench-message', this.handleFolderPickerMessage);
    this.invalidateFolderPickerRequest();
  },
};

export default folderPickerMixin;
