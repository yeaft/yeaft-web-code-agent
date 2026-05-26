import { getFileIconSvg, getFolderIconSvg } from '../utils/fileIcons.js';
import { highlightCode } from '../utils/syntaxHighlight.js';
import { parseDiff } from './git/diffParser.js';
import { createGitOperations } from './git/gitOperations.js';
import { createFolderPicker } from './git/folderPicker.js';

export default {
  name: 'GitStatusTab',
  template: `
    <div class="git-status-tab git-three-col">
      <!-- 左栏: 文件列表 -->
      <div class="git-col-files">
        <!-- 工作目录选择（始终可见） -->
        <div class="git-workdir-row">
          <button class="wb-btn-sm" @click="openFolderPicker" :title="$t('git.selectFolder')">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>
          </button>
          <input
            v-model="gitWorkDir"
            :placeholder="defaultWorkDir || $t('git.repoPathPlaceholder')"
            @keypress.enter="changeGitWorkDir"
            class="git-workdir-input"
            :title="$t('git.workDir')"
          />
          <button class="wb-btn-sm" @click="changeGitWorkDir" :title="$t('git.loadStatus')">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
          </button>
        </div>

        <div v-if="gitLoading && !gitBranch" class="git-loading">
          <span class="spinner-mini"></span> {{ $t('git.loadingStatus') }}
        </div>
        <div v-else-if="gitError" class="git-error-msg">
          <span>{{ gitError }}</span>
        </div>
        <template v-else-if="gitBranch !== null">
          <!-- 操作反馈条 -->
          <div class="git-op-feedback" v-if="gitOpFeedback" :class="gitOpFeedback.ok ? 'success' : 'error'">
            {{ gitOpFeedback.message }}
          </div>

          <!-- 分支信息 -->
          <div class="git-branch">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21.62 11.11l-8.73-8.73a1.32 1.32 0 00-1.87 0L8.89 4.51l2.35 2.35a1.57 1.57 0 012 2l2.27 2.27a1.57 1.57 0 11-.94.88l-2.12-2.12v5.57a1.57 1.57 0 11-1.29 0V9.72a1.57 1.57 0 01-.85-2.06L8 5.34 2.38 11a1.32 1.32 0 000 1.87l8.73 8.73a1.32 1.32 0 001.87 0l8.64-8.64a1.32 1.32 0 000-1.85z"/></svg>
            <span>{{ gitBranch }}</span>
            <span class="git-file-count" v-if="gitFiles.length > 0">{{ gitFiles.length }} changed</span>
            <button v-if="gitAhead > 0" class="git-push-btn" @click="pushChanges" :disabled="gitOperating" title="Push to remote">
              <svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M8 1L3 6h3v6h4V6h3L8 1z"/></svg>
              {{ gitAhead }}
            </button>
          </div>

          <!-- 无变更 -->
          <div v-if="gitFiles.length === 0" class="git-clean">
            <div class="placeholder-text">{{ $t('git.cleanWorkDir') }}</div>
          </div>

          <!-- 文件列表（按分组） -->
          <template v-else>
            <!-- Staged Changes -->
            <div class="git-file-group" v-if="stagedFiles.length > 0">
              <div class="group-header staged" @click="toggleGroup('staged')">
                <svg class="group-chevron" :class="{ collapsed: collapsedGroups.staged }" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M5.7 13.7L5 13l4.6-4.6L5 3.7l.7-.7 5.3 5.3z"/></svg>
                <span>Staged Changes</span>
                <span class="group-count">{{ stagedFiles.length }}</span>
                <button class="git-group-action" @click.stop="unstageAll" :disabled="gitOperating" title="Unstage All">−</button>
              </div>
              <template v-if="!collapsedGroups.staged">
                <div
                  v-for="f in stagedFiles" :key="'s-'+f.path"
                  class="git-file-item" :class="{ selected: selectedGitFile === f.path && selectedStaged }"
                  @click="selectGitFile(f, true)"
                >
                  <span class="git-file-icon" v-html="getFileIconHtml(f.path)"></span>
                  <span class="git-file-name">{{ getFileName(f.path) }}</span>
                  <span class="git-file-dir" v-if="getDirName(f.path)">{{ getDirName(f.path) }}</span>
                  <span class="git-file-actions">
                    <button class="git-action-btn" @click.stop="unstageFile(f.path)" :disabled="gitOperating" title="Unstage">−</button>
                  </span>
                  <span class="git-status-badge staged">{{ f.indexStatus }}</span>
                </div>
              </template>
            </div>

            <!-- Changes (Modified) -->
            <div class="git-file-group" v-if="modifiedFiles.length > 0">
              <div class="group-header modified" @click="toggleGroup('modified')">
                <svg class="group-chevron" :class="{ collapsed: collapsedGroups.modified }" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M5.7 13.7L5 13l4.6-4.6L5 3.7l.7-.7 5.3 5.3z"/></svg>
                <span>Changes</span>
                <span class="group-count">{{ modifiedFiles.length }}</span>
                <button class="git-group-action" @click.stop="stageAll" :disabled="gitOperating" title="Stage All">+</button>
              </div>
              <template v-if="!collapsedGroups.modified">
                <div
                  v-for="f in modifiedFiles" :key="'m-'+f.path"
                  class="git-file-item" :class="{ selected: selectedGitFile === f.path && !selectedStaged }"
                  @click="selectGitFile(f, false)"
                >
                  <span class="git-file-icon" v-html="getFileIconHtml(f.path)"></span>
                  <span class="git-file-name">{{ getFileName(f.path) }}</span>
                  <span class="git-file-dir" v-if="getDirName(f.path)">{{ getDirName(f.path) }}</span>
                  <span class="git-file-actions">
                    <button class="git-action-btn" @click.stop="discardFile(f.path)" :disabled="gitOperating" title="Discard Changes">↺</button>
                    <button class="git-action-btn" @click.stop="stageFile(f.path)" :disabled="gitOperating" title="Stage">+</button>
                  </span>
                  <span class="git-status-badge modified">{{ f.workTreeStatus }}</span>
                </div>
              </template>
            </div>

            <!-- Untracked Files -->
            <div class="git-file-group" v-if="untrackedFiles.length > 0">
              <div class="group-header untracked" @click="toggleGroup('untracked')">
                <svg class="group-chevron" :class="{ collapsed: collapsedGroups.untracked }" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M5.7 13.7L5 13l4.6-4.6L5 3.7l.7-.7 5.3 5.3z"/></svg>
                <span>Untracked</span>
                <span class="group-count">{{ untrackedFiles.length }}</span>
                <button class="git-group-action" @click.stop="stageAll" :disabled="gitOperating" title="Stage All">+</button>
              </div>
              <template v-if="!collapsedGroups.untracked">
                <div
                  v-for="f in untrackedFiles" :key="'u-'+f.path"
                  class="git-file-item" :class="{ selected: selectedGitFile === f.path && !selectedStaged }"
                  @click="selectGitFile(f, false)"
                >
                  <span class="git-file-icon" v-html="getFileIconHtml(f.path)"></span>
                  <span class="git-file-name">{{ getFileName(f.path) }}</span>
                  <span class="git-file-dir" v-if="getDirName(f.path)">{{ getDirName(f.path) }}</span>
                  <span class="git-file-actions">
                    <button class="git-action-btn" @click.stop="stageFile(f.path)" :disabled="gitOperating" title="Stage">+</button>
                  </span>
                  <span class="git-status-badge untracked">U</span>
                </div>
              </template>
            </div>

            <!-- Commit 区域 -->
            <div class="git-commit-section" v-if="stagedFiles.length > 0">
              <input
                class="commit-message-input"
                v-model="commitMessage"
                @keydown.enter="commitChanges"
                placeholder="Commit message..."
                :disabled="gitOperating"
              />
              <button class="commit-btn" @click="commitChanges" :disabled="gitOperating || !commitMessage.trim()">
                <template v-if="gitOperating">...</template>
                <template v-else>Commit</template>
              </button>
            </div>
          </template>
        </template>
        <div v-else class="git-placeholder" style="padding: 16px;">
          <div class="placeholder-text">{{ $t('git.selectAgentFirst') }}</div>
        </div>
      </div>

      <!-- 中+右栏: diff 面板 -->
      <div class="git-col-diff-wrapper" v-if="(diffContent !== null || diffLoading) && gitBranch">
        <div class="git-col-diff" :style="{ fontSize: fontSize + 'px' }" @wheel.ctrl.prevent="onWheel" ref="diffScrollContainer">
          <div class="diff-header" v-if="selectedGitFile">
            <span class="file-path">{{ selectedGitFile }}</span>
            <span class="diff-stats" v-if="diffStats">
              <span class="additions">+{{ diffStats.additions }}</span>
              <span class="deletions">-{{ diffStats.deletions }}</span>
            </span>
            <div class="diff-header-actions">
              <button class="diff-mode-toggle" @click="toggleDiffMode" :title="diffFullFile ? $t('git.diffOnly') : $t('git.fullFile')">
                {{ diffFullFile ? 'Diff' : 'Full' }}
              </button>
              <button class="zoom-btn" @click="zoomOut" :title="$t('git.zoomOut')">−</button>
              <span class="zoom-label">{{ fontSize }}</span>
              <button class="zoom-btn" @click="zoomIn" :title="$t('git.zoomIn')">+</button>
            </div>
          </div>
          <div v-if="diffLoading" class="git-loading" style="padding:16px">
            <span class="spinner-mini"></span> {{ $t('git.loadingDiff') }}
          </div>
          <div v-else-if="diffError" class="git-error-msg">{{ diffError }}</div>
          <div v-else class="diff-content">
            <div class="diff-split">
              <div class="diff-side old">
                <table class="diff-table">
                  <tr v-for="(line, i) in diffLines" :key="'o'+i" class="diff-line" :class="line.type">
                    <td class="diff-line-num" :class="{ old: line.type==='deletion' || line.type==='modification' }">{{ line.oldNum || '' }}</td>
                    <td class="diff-line-content" v-html="hlLine(line.oldText)"></td>
                  </tr>
                </table>
              </div>
              <div class="diff-side new">
                <table class="diff-table">
                  <tr v-for="(line, i) in diffLines" :key="'n'+i" class="diff-line" :class="line.type">
                    <td class="diff-line-num" :class="{ new: line.type==='addition' || line.type==='modification' }">{{ line.newNum || '' }}</td>
                    <td class="diff-line-content" v-html="hlLine(line.newText)"></td>
                  </tr>
                </table>
              </div>
            </div>
          </div>
        </div>
        <!-- Scrollbar markers overlay (outside scroll container) -->
        <div class="diff-scrollbar-markers" v-if="diffLines.length > 0" @click="onMarkerClick($event)">
          <div
            v-for="(marker, i) in scrollMarkers"
            :key="i"
            class="diff-marker"
            :class="marker.type"
            :style="{ top: marker.top + '%', height: marker.height + '%' }"
          ></div>
        </div>
      </div>

        <!-- 未选择文件时的占位 -->
        <div class="git-col-placeholder" v-if="diffContent === null && !diffLoading && gitFiles.length > 0 && gitBranch">
          <div class="placeholder-text">{{ $t('git.clickFileToView') }}</div>
        </div>

        <!-- 文件夹选择器对话框 -->
        <div class="folder-picker-overlay" v-if="folderPickerOpen" @click.self="folderPickerOpen = false">
          <div class="folder-picker-dialog">
            <div class="folder-picker-header">
              <span>{{ $t('git.selectRepo') }}</span>
              <button class="wb-btn-sm" @click="folderPickerOpen = false">&times;</button>
            </div>
            <div class="folder-picker-path">
              <button class="wb-btn-sm" @click="folderPickerNavigateUp" :disabled="!folderPickerPath" :title="$t('modal.folderPicker.parentDir')">
                <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
              </button>
              <span class="folder-picker-current">{{ folderPickerPath || $t('common.drives') }}</span>
            </div>
            <div class="folder-picker-list">
              <div class="git-loading" v-if="folderPickerLoading" style="padding:12px"><span class="spinner-mini"></span> {{ $t('common.loading') }}</div>
              <template v-else>
                <div
                  v-for="entry in folderPickerEntries"
                  :key="entry.name"
                  class="tree-item tree-dir folder-picker-item"
                  :class="{ 'folder-picker-selected': folderPickerSelected === entry.name }"
                  @click="folderPickerSelectItem(entry)"
                  @dblclick="folderPickerEnter(entry)"
                >
                  <span class="tree-icon" v-html="getFolderIcon(false)"></span>
                  <span class="tree-name">{{ entry.name }}</span>
                </div>
                <div class="tree-empty" v-if="folderPickerEntries.length === 0">{{ $t('common.noSubdirectories') }}</div>
              </template>
            </div>
            <div class="folder-picker-footer">
              <button class="wb-btn" @click="confirmFolderPicker" :disabled="!folderPickerPath">{{ $t('common.open') }}</button>
            </div>
          </div>
        </div>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const t = Vue.inject('t');

    // --- Helpers for VSCode-style file display ---
    const getFileName = (p) => p.split(/[/\\]/).pop() || p;
    const getDirName = (p) => {
      const parts = p.split(/[/\\]/);
      parts.pop();
      return parts.join('/');
    };
    const getFileIconHtml = (filePath) => getFileIconSvg(getFileName(filePath));

    // Scroll container ref
    const diffScrollContainer = Vue.ref(null);

    // --- Collapsible groups ---
    const collapsedGroups = Vue.reactive({ staged: false, modified: false, untracked: false });
    const toggleGroup = (group) => { collapsedGroups[group] = !collapsedGroups[group]; };

    // --- Git Status state ---
    const gitLoading = Vue.ref(false);
    const gitError = Vue.ref('');
    const gitBranch = Vue.ref(null);
    const gitFiles = Vue.ref([]);

    // --- Git work directory ---
    const defaultWorkDir = Vue.computed(() => store.effectiveWorkDir || '');
    const gitWorkDir = Vue.ref('');
    const effectiveGitWorkDir = Vue.computed(() => gitWorkDir.value.trim() || defaultWorkDir.value);

    // --- Git Diff state ---
    const selectedGitFile = Vue.ref(null);
    const selectedStaged = Vue.ref(false);
    const diffLoading = Vue.ref(false);
    const diffError = Vue.ref('');
    const diffContent = Vue.ref(null);
    const diffLines = Vue.ref([]);
    const diffStats = Vue.ref(null);
    const diffFullFile = Vue.ref(true);

    // --- Git operation state ---
    const gitOperating = Vue.ref(false);
    const commitMessage = Vue.ref('');
    const gitOpFeedback = Vue.ref(null);
    const gitAhead = Vue.ref(0);
    const gitBehind = Vue.ref(0);

    // Syntax highlighting for diff lines
    const hlLine = (text) => {
      if (text == null || text === '') return '';
      return highlightCode(text, selectedGitFile.value || '');
    };

    // --- Font size zoom ---
    const fontSize = Vue.ref(parseInt(localStorage.getItem('gitDiffFontSize')) || 12);
    const setFontSize = (size) => {
      fontSize.value = Math.max(8, Math.min(24, size));
      localStorage.setItem('gitDiffFontSize', fontSize.value.toString());
    };
    const zoomIn = () => setFontSize(fontSize.value + 1);
    const zoomOut = () => setFontSize(fontSize.value - 1);
    const onWheel = (e) => {
      if (e.deltaY < 0) zoomIn();
      else if (e.deltaY > 0) zoomOut();
    };

    // Scrollbar markers — computed from diffLines
    const scrollMarkers = Vue.computed(() => {
      const lines = diffLines.value;
      if (!lines || lines.length === 0) return [];
      const total = lines.length;
      const markers = [];
      let i = 0;
      while (i < total) {
        const line = lines[i];
        if (line.type === 'addition' || line.type === 'deletion' || line.type === 'modification') {
          const startType = line.type === 'modification' ? 'modification' : line.type;
          const start = i;
          while (i < total && (lines[i].type === startType || (lines[i].type === 'modification' && startType !== 'modification'))) {
            i++;
          }
          const count = i - start;
          markers.push({
            type: startType,
            top: (start / total) * 100,
            height: Math.max((count / total) * 100, 0.5)
          });
        } else {
          i++;
        }
      }
      return markers;
    });

    const onMarkerClick = (event) => {
      const container = diffScrollContainer.value;
      if (!container) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const clickPercent = (event.clientY - rect.top) / rect.height;
      container.scrollTop = clickPercent * (container.scrollHeight - container.clientHeight);
    };

    // Computed: file groups
    const stagedFiles = Vue.computed(() =>
      gitFiles.value.filter(f => f.indexStatus !== ' ' && f.indexStatus !== '?')
    );
    const modifiedFiles = Vue.computed(() =>
      gitFiles.value.filter(f => f.workTreeStatus === 'M' || f.workTreeStatus === 'D')
    );
    const untrackedFiles = Vue.computed(() =>
      gitFiles.value.filter(f => f.indexStatus === '?' && f.workTreeStatus === '?')
    );

    // --- Git operations (delegated) ---
    const ops = createGitOperations(store, {
      effectiveGitWorkDir, gitOperating, gitOpFeedback, commitMessage
    });

    const loadGitStatus = () => ops.loadGitStatus(gitLoading, gitError);

    const changeGitWorkDir = () => { loadGitStatus(); };

    // --- Folder picker (delegated) ---
    const picker = createFolderPicker(store, effectiveGitWorkDir);
    const getFolderIcon = (isOpen) => getFolderIconSvg(isOpen);
    const confirmFolderPicker = () => picker.confirmFolderPicker(gitWorkDir, loadGitStatus);

    // --- Diff operations ---
    const selectGitFile = (file, staged) => {
      selectedGitFile.value = file.path;
      selectedStaged.value = staged;
      diffLoading.value = true;
      diffError.value = '';
      diffContent.value = null;
      diffLines.value = [];
      diffStats.value = null;

      const isUntracked = file.indexStatus === '?' && file.workTreeStatus === '?';
      store.sendWsMessage({
        type: 'git_diff',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        workDir: effectiveGitWorkDir.value,
        filePath: file.path,
        staged: staged,
        untracked: isUntracked,
        fullFile: diffFullFile.value,
        _clientId: store.clientId
      });
    };

    const toggleDiffMode = () => {
      diffFullFile.value = !diffFullFile.value;
      if (selectedGitFile.value) {
        const file = gitFiles.value.find(f => f.path === selectedGitFile.value);
        if (file) {
          selectGitFile(file, selectedStaged.value);
        }
      }
    };

    // --- Handle messages from server ---
    const handleWorkbenchMessage = (event) => {
      const msg = event.detail;
      if (!msg) return;

      switch (msg.type) {
        case 'directory_listing': {
          if (picker.handleDirectoryListing(msg)) return;
          break;
        }
        case 'git_status_result': {
          gitLoading.value = false;
          if (msg.error) {
            gitError.value = msg.error;
            gitBranch.value = null;
            gitFiles.value = [];
            return;
          }
          gitError.value = '';
          gitBranch.value = msg.branch || 'HEAD';
          gitFiles.value = msg.files || [];
          gitAhead.value = msg.ahead || 0;
          gitBehind.value = msg.behind || 0;
          if (selectedGitFile.value) {
            const file = gitFiles.value.find(f => f.path === selectedGitFile.value);
            if (file) {
              const isStaged = file.indexStatus !== ' ' && file.indexStatus !== '?';
              selectedStaged.value = isStaged;
            } else {
              selectedGitFile.value = null;
              diffContent.value = null;
              diffLines.value = [];
              diffStats.value = null;
            }
          }
          break;
        }
        case 'git_diff_result': {
          diffLoading.value = false;
          if (msg.error) {
            diffError.value = msg.error;
            return;
          }
          diffError.value = '';
          const parsed = parseDiff(msg.diff, msg.newFileContent, t);
          diffStats.value = parsed.stats;
          diffLines.value = parsed.lines;
          diffContent.value = parsed.content;
          break;
        }
        case 'git_op_result': {
          ops.handleGitOpResult(msg, loadGitStatus);
          break;
        }
      }
    };

    // Watch agent changes
    Vue.watch(() => store.currentAgent, () => {
      gitBranch.value = null;
      gitFiles.value = [];
      gitError.value = '';
      selectedGitFile.value = null;
      diffContent.value = null;
      if (store.currentAgent) {
        Vue.nextTick(() => loadGitStatus());
      }
    });

    // Watch conversation changes
    Vue.watch(() => store.currentConversation, () => {
      if (store.currentAgent) {
        selectedGitFile.value = null;
        diffContent.value = null;
        diffLines.value = [];
        diffStats.value = null;
        Vue.nextTick(() => loadGitStatus());
      }
    });

    // Expose refresh for parent
    const refresh = () => loadGitStatus();

    Vue.onMounted(() => {
      window.addEventListener('workbench-message', handleWorkbenchMessage);
      if (store.currentAgent) loadGitStatus();
    });

    Vue.onUnmounted(() => {
      window.removeEventListener('workbench-message', handleWorkbenchMessage);
      ops.cleanup();
    });

    return {
      store,
      getFileName, getDirName, getFileIconHtml, hlLine,
      collapsedGroups, toggleGroup,
      gitLoading, gitError, gitBranch, gitFiles,
      gitWorkDir, defaultWorkDir, changeGitWorkDir,
      stagedFiles, modifiedFiles, untrackedFiles,
      selectedGitFile, selectedStaged,
      diffLoading, diffError, diffContent, diffLines, diffStats,
      diffFullFile, toggleDiffMode,
      scrollMarkers, diffScrollContainer, onMarkerClick,
      fontSize, zoomIn, zoomOut, onWheel,
      gitOperating, commitMessage, gitOpFeedback, gitAhead, gitBehind,
      stageFile: ops.stageFile, unstageFile: ops.unstageFile,
      discardFile: ops.discardFile, stageAll: ops.stageAll, unstageAll: ops.unstageAll,
      commitChanges: ops.commitChanges, pushChanges: ops.pushChanges,
      selectGitFile, refresh,
      // Folder picker
      folderPickerOpen: picker.folderPickerOpen, folderPickerPath: picker.folderPickerPath,
      folderPickerEntries: picker.folderPickerEntries,
      folderPickerLoading: picker.folderPickerLoading, folderPickerSelected: picker.folderPickerSelected,
      getFolderIcon, openFolderPicker: picker.openFolderPicker,
      folderPickerNavigateUp: picker.folderPickerNavigateUp,
      folderPickerSelectItem: picker.folderPickerSelectItem,
      folderPickerEnter: picker.folderPickerEnter, confirmFolderPicker,
    };
  }
};
