import { getFileIconSvg, getFolderIconSvg } from '../utils/fileIcons.js';
import { createFindReplace } from './files/findReplace.js';
import { createFileOperations } from './files/fileOperations.js';
import { createFileTree } from './files/fileTree.js';
import { createFileEditor, getFileType, isMarkdownFile } from './files/fileEditor.js';
import { createFilePreview } from './files/filePreview.js';
import { createQuickOpen } from './files/quickOpen.js';
import { createFolderPicker } from './files/folderPicker.js';
import { createFileTabs } from './files/fileTabs.js';
import { createWsHandler } from './files/wsHandler.js';

export default {
  name: 'FilesTab',
  template: `
    <div class="files-tab file-two-col" :class="{ 'mobile-editor-view': isMobile && mobileView === 'editor' }" ref="rootEl">
      <!-- 左栏: 层级目录树 -->
      <div class="file-col-tree" :class="{ 'drop-active': externalDropActive }" :style="{ flex: '0 0 ' + treePanelWidth + 'px', transition: isTreeResizing ? 'none' : undefined, fontSize: fontSize + 'px' }" @wheel.ctrl.prevent="onWheel"
        @dragover.prevent="onTreeDragOver($event)"
        @dragleave="onTreeDragLeave($event)"
        @drop.prevent="onTreeDrop($event)"
      >
        <!-- VS Code 风格 Header: 路径输入模式 -->
        <div class="file-tree-header" v-if="editingTreePath">
          <input
            ref="treePathInputRef"
            v-model="treePath"
            :placeholder="$t('files.enterPath')"
            @keypress.enter="confirmTreePath"
            @keydown.escape="cancelTreePathEdit"
            @blur="cancelTreePathEdit"
            class="tree-path-input"
          />
        </div>
        <!-- VS Code 风格 Header: 正常模式 -->
        <div class="file-tree-header vscode-header" v-else>
          <div class="vscode-folder-row" @click="toggleRootExpand">
            <span class="tree-arrow root-arrow" v-if="treeRootPath">
              <svg v-if="rootExpanded" viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M3.5 5.5L8 10l4.5-4.5z"/></svg>
              <svg v-else viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M5.5 3.5L10 8l-4.5 4.5z"/></svg>
            </span>
            <span class="vscode-folder-name" :title="treeRootPath || $t('files.notLoaded')">{{ rootFolderName }}</span>
            <div class="vscode-folder-actions" v-if="treeRootPath" @click.stop>
              <button class="vscode-action-btn" @click="showNewFileDialog('file')" :title="$t('files.newFile')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 14h-3v3h-2v-3H8v-2h3v-3h2v3h3v2zm-3-7V3.5L18.5 9H13z"/></svg>
              </button>
              <button class="vscode-action-btn" @click="showNewFileDialog('directory')" :title="$t('files.newFolder')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg>
              </button>
              <button class="vscode-action-btn" @click="loadRootDirectory" :title="$t('common.refresh')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
              </button>
              <button class="vscode-action-btn" @click="collapseAll" :title="$t('files.collapseAll')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 18.59L8.83 20 12 16.83 15.17 20l1.41-1.41L12 14l-4.59 4.59zm9.18-13.18L15.17 4 12 7.17 8.83 4 7.41 5.41 12 10l4.59-4.59z"/></svg>
              </button>
              <button class="vscode-action-btn" @click="openFolderPicker" :title="$t('files.openFolder')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>
              </button>
            </div>
          </div>
        </div>
        <!-- 文件选中操作 -->
        <div class="file-ops-toolbar" v-if="selectedPaths.size > 0">
          <button class="wb-btn-sm file-op-danger" @click="deleteSelected" :title="$t('files.deleteSelected')" :disabled="fileOperating">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            {{ selectedPaths.size }}
          </button>
          <button class="wb-btn-sm" @click="openMoveDialog" :title="$t('files.moveSelected')" :disabled="fileOperating">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 12l-4-4h3V10h2v4h3l-4 4z"/></svg>
          </button>
          <button class="wb-btn-sm" @click="clearSelection" :title="$t('files.clearSelection')">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <!-- 操作反馈 -->
        <div v-if="fileOpFeedback" class="file-op-feedback" :class="fileOpFeedback.ok ? 'success' : 'error'">
          {{ fileOpFeedback.message }}
        </div>
        <!-- 文件搜索行 -->
        <div class="file-search-row">
          <input v-model="searchQuery" @input="onSearchInput" placeholder="Search files... (Ctrl+P)" class="file-search-input" />
          <button v-if="searchQuery" class="file-search-clear" @click="clearSearch">&times;</button>
        </div>
        <div class="file-tree-content">
          <!-- 搜索结果模式 -->
          <template v-if="searchQuery && searchResults.length > 0">
            <div
              v-for="r in searchResults" :key="r.fullPath"
              class="tree-item tree-file file-search-result-item"
              @click="onSearchResultClick(r)"
            >
              <span class="tree-icon" v-html="r.type === 'directory' ? getFolderIcon(false) : getFileIconHtml(r.name)"></span>
              <span class="tree-name">{{ r.name }}</span>
              <span class="file-search-result-path">{{ r.path }}</span>
            </div>
          </template>
          <template v-else-if="searchQuery && searchResults.length === 0 && !searchLoading">
            <div class="tree-empty">{{ $t('files.noMatch') }}</div>
          </template>
          <template v-else-if="searchQuery && searchLoading">
            <div class="file-tree-loading">{{ $t('files.searching') }}</div>
          </template>
          <!-- 正常树模式 -->
          <template v-else>
            <div class="file-tree-loading" v-if="treeNodes[treeRootPath]?.loading">{{ $t('files.loadingTree') }}</div>
            <div class="file-tree-list" v-else>
              <div
                v-for="entry in flattenedTree"
                :key="entry.path"
                class="tree-item"
                :class="{
                  'tree-dir': entry.type === 'directory',
                  'tree-file': entry.type === 'file',
                  'tree-expanded': entry.type === 'directory' && treeNodes[entry.path]?.expanded,
                  'tree-selected': selectedPaths.has(entry.path),
                  'drag-over': dragState.dropTarget === entry.path && entry.type === 'directory'
                }"
                :style="{ paddingLeft: (8 + entry.depth * 16) + 'px' }"
                @click="onTreeItemClick(entry, $event)"
                @contextmenu.prevent="showContextMenu($event, entry)"
                :draggable="!isMobile"
                @dragstart="onDragStart($event, entry)"
                @dragover.prevent="onDragOver($event, entry)"
                @dragleave="onDragLeave($event)"
                @drop.prevent="onDrop($event, entry)"
              >
                <span class="tree-arrow" v-if="entry.type === 'directory'">
                  <svg v-if="treeNodes[entry.path]?.expanded" viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M3.5 5.5L8 10l4.5-4.5z"/></svg>
                  <svg v-else viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M5.5 3.5L10 8l-4.5 4.5z"/></svg>
                </span>
                <span class="tree-arrow tree-arrow-spacer" v-else></span>
                <span class="tree-icon" v-html="entry.type === 'directory' ? getFolderIcon(treeNodes[entry.path]?.expanded) : getFileIconHtml(entry.name)"></span>
                <span class="tree-name">{{ entry.name }}</span>
                <span class="tree-size" v-if="entry.type === 'file' && selectedPaths.size === 0">{{ formatSize(entry.size) }}</span>
                <span class="tree-file-actions" v-if="selectedPaths.size === 0">
                  <button class="tree-action-btn" @click.stop="deleteSingleFile(entry)" :title="$t('common.delete')">
                    <svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                  </button>
                </span>
              </div>
              <div class="tree-empty" v-if="flattenedTree.length === 0 && treeRootPath && !treeNodes[treeRootPath]?.loading">
                {{ $t('files.emptyDir') }}
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- 拖拽分割线 -->
      <div class="file-tree-splitter" @mousedown="startTreeResize" @touchstart.prevent="startTreeResize"></div>

      <!-- 右栏: 文件编辑器（带标签页） -->
      <div class="file-col-content" v-if="openFiles.length > 0 || fileLoading" @wheel.ctrl.prevent="onWheel">
        <!-- Mobile back navigation bar -->
        <div class="mobile-file-back-bar" v-if="isMobile">
          <button class="mobile-back-btn" @click="mobileGoBack">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
            {{ $t('common.back') }}
          </button>
          <span class="mobile-file-name">
            <span v-if="activeFile?.isDirty">● </span>{{ activeFile?.name }}
          </span>
          <button class="file-action-btn" :class="{ active: activeFile?.isDirty }" @click="saveFile" :disabled="!activeFile?.isDirty || fileSaving">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17 3H5c-1.11 0-2 .89-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
          </button>
        </div>
        <div class="file-tabs-bar" v-if="openFiles.length > 0">
          <div
            v-for="(file, index) in openFiles" :key="file.path"
            class="file-tab"
            :class="{ active: index === activeFileIndex }"
            :title="file.path"
            @click="switchToTab(index)"
          >
            <span class="file-tab-dirty" v-if="file.isDirty" :title="$t('files.unsaved')">●</span>
            <span class="file-tab-name">{{ file.name }}</span>
            <button class="file-tab-close" @click.stop="closeFileTab(index)" :title="$t('common.close')">&times;</button>
          </div>
          <div class="file-tabs-actions">
            <button class="zoom-btn" @click="zoomOut" :title="$t('git.zoomOut')">−</button>
            <span class="zoom-label">{{ fontSize }}</span>
            <button class="zoom-btn" @click="zoomIn" :title="$t('git.zoomIn')">+</button>
            <button class="file-action-btn" :class="{ active: activeFile?.isDirty }" @click="saveFile" :disabled="!activeFile?.isDirty || fileSaving" :title="$t('common.save') + ' (Ctrl+S)'">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17 3H5c-1.11 0-2 .89-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
            </button>
          </div>
        </div>
        <div v-if="fileLoading && (activeFileIndex < 0 || !activeFile)" class="git-loading" style="padding:16px">
          <span class="spinner-mini"></span> {{ $t('files.loadingFile') }}<span v-if="debugStatus" style="margin-left:8px;font-size:10px;color:var(--text-muted)">{{ debugStatus }}</span>
        </div>
        <template v-else-if="activeFile">
          <div v-if="debugStatus" style="padding:4px 8px;font-size:11px;color:var(--text-muted);background:var(--bg-sidebar);border-bottom:1px solid var(--border-color)">{{ debugStatus }}</div>
          <!-- 文本文件: CodeMirror 编辑器 -->
          <template v-if="!activeFile.fileType || activeFile.fileType === 'text'">
          <!-- Markdown 预览/编辑切换 -->
          <div v-if="isActiveMarkdown" class="md-toolbar">
            <button :class="['md-toggle-btn', { active: mdPreviewMode }]" @click="mdPreviewMode = true">
              <svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;margin-right:3px"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.76 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
              {{ $t && $t('files.preview') || 'Preview' }}
            </button>
            <button :class="['md-toggle-btn', { active: !mdPreviewMode }]" @click="switchToMdEdit">
              <svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;margin-right:3px"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
              {{ $t && $t('files.edit') || 'Edit' }}
            </button>
          </div>
          <!-- Markdown 渲染预览 -->
          <div v-if="isActiveMarkdown && mdPreviewMode" class="file-preview-container md-preview-container" ref="mdPreviewRef">
            <div class="markdown-body md-file-preview" v-html="mdRenderedHtml"></div>
          </div>
          <!-- 搜索/替换栏 + CodeMirror 编辑器 -->
          <template v-if="!isActiveMarkdown || !mdPreviewMode">
          <div class="find-replace-bar" v-if="findBarVisible">
            <div class="find-row">
              <input
                ref="findInputRef"
                class="find-input"
                v-model="findQuery"
                :placeholder="$t('files.searchPlaceholder')"
                @input="onFindInput"
                @keydown.enter.exact.prevent="findNext"
                @keydown.enter.shift.prevent="findPrev"
                @keydown.escape.prevent="closeFindBar"
              />
              <span class="find-count" v-if="findQuery">{{ findMatchIndex >= 0 ? (findMatchIndex + 1) : 0 }}/{{ findMatchCount }}</span>
              <button class="find-btn" @click="findPrev" :title="$t('files.findPrev')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
              </button>
              <button class="find-btn" @click="findNext" :title="$t('files.findNext')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
              </button>
              <label class="find-option" :title="$t('files.caseSensitive')">
                <input type="checkbox" v-model="findCaseSensitive" @change="onFindInput" /> Aa
              </label>
              <label class="find-option" :title="$t('files.regex')">
                <input type="checkbox" v-model="findUseRegex" @change="onFindInput" /> .*
              </label>
              <button class="find-btn" @click="toggleReplaceBar" :title="$t('files.replace') + ' (Ctrl+R)'">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11 6c1.38 0 2.63.56 3.54 1.46L12 10h6V4l-2.05 2.05A6.976 6.976 0 0011 4c-3.53 0-6.43 2.61-6.92 6H6.1A5.002 5.002 0 0111 6zm5.64 9.14A6.98 6.98 0 0011 20c-3.53 0-6.43-2.61-6.92-6h2.02A5.002 5.002 0 0011 18c1.38 0 2.63-.56 3.54-1.46L12 14h6v6l-2.05-2.05c-.27.3-.56.57-.88.82l.57.57z"/></svg>
              </button>
              <button class="find-btn" @click="closeFindBar" :title="$t('common.close') + ' (Esc)'">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
            <div class="find-row" v-if="replaceBarVisible">
              <input
                ref="replaceInputRef"
                class="find-input"
                v-model="replaceQuery"
                :placeholder="$t('files.replacePlaceholder')"
                @keydown.enter.prevent="replaceOne"
                @keydown.escape.prevent="closeFindBar"
              />
              <button class="find-btn find-btn-text" @click="replaceOne" :title="$t('files.replaceCurrent')">{{ $t('files.replace') }}</button>
              <button class="find-btn find-btn-text" @click="replaceAll" :title="$t('files.replaceAllTitle')">{{ $t('files.replaceAll') }}</button>
            </div>
          </div>
          <div ref="editorContainer" class="file-editor-container"></div>
          </template>
          </template>
          <!-- Office 文件预览 -->
          <div v-else-if="activeFile.fileType === 'office'" class="file-preview-container">
            <div v-if="activeFile.previewLoading" class="preview-loading">
              <span class="spinner-mini"></span> {{ $t('files.loadingPreview') }}
            </div>
            <iframe v-else-if="activeFile.previewUrl" :src="activeFile.previewUrl" class="file-preview-iframe" allowfullscreen></iframe>
            <div v-else-if="activeFile.localPreviewReady" ref="officePreviewContainer" class="office-local-preview"></div>
            <div v-else-if="activeFile.previewError" class="preview-error">{{ activeFile.previewError }}</div>
          </div>
          <!-- PDF 预览 -->
          <div v-else-if="activeFile.fileType === 'pdf'" class="file-preview-container">
            <div v-if="!activeFile.blobUrl" class="preview-loading"><span class="spinner-mini"></span> {{ $t('files.loadingPreview') }}</div>
            <iframe v-else :src="activeFile.blobUrl" class="file-preview-iframe"></iframe>
          </div>
          <!-- 图片预览 -->
          <div v-else-if="activeFile.fileType === 'image'" class="file-preview-container">
            <div v-if="!activeFile.blobUrl" class="preview-loading"><span class="spinner-mini"></span> {{ $t('files.loadingPreview') }}</div>
            <img v-else :src="activeFile.blobUrl" class="file-preview-image" />
          </div>
        </template>
      </div>
      <div class="file-col-placeholder" v-if="openFiles.length === 0 && !fileLoading">
        <div class="placeholder-text">{{ $t('files.clickToView') }}</div>
      </div>

      <!-- 文件夹选择器对话框 -->
      <div class="folder-picker-overlay" v-if="folderPickerOpen" @click.self="folderPickerOpen = false">
        <div class="folder-picker-dialog">
          <div class="folder-picker-header">
            <span>{{ $t('files.selectFolder') }}</span>
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

      <!-- Quick Open 对话框 (Ctrl+P) -->
      <div class="quick-open-overlay" v-if="quickOpenVisible" @click.self="closeQuickOpen">
        <div class="quick-open-dialog">
          <input
            ref="quickOpenInput"
            v-model="quickOpenQuery"
            @input="onQuickOpenInput"
            @keydown.down.prevent="quickOpenSelectNext"
            @keydown.up.prevent="quickOpenSelectPrev"
            @keydown.enter.prevent="quickOpenConfirm"
            @keydown.escape.prevent="closeQuickOpen"
            class="quick-open-input"
            placeholder="Search files by name..."
          />
          <div class="quick-open-list">
            <div
              v-for="(r, i) in quickOpenResults" :key="r.fullPath"
              class="quick-open-item"
              :class="{ selected: i === quickOpenSelectedIndex }"
              @click="quickOpenOpenFile(r)"
              @mouseenter="quickOpenSelectedIndex = i"
            >
              <span class="tree-icon" v-html="r.type === 'directory' ? getFolderIcon(false) : getFileIconHtml(r.name)"></span>
              <span class="quick-open-name">{{ r.name }}</span>
              <span class="quick-open-path">{{ r.path }}</span>
            </div>
            <div class="tree-empty" v-if="quickOpenQuery && quickOpenResults.length === 0 && !quickOpenLoading">{{ $t('files.noMatch') }}</div>
            <div class="file-tree-loading" v-if="quickOpenLoading">{{ $t('files.searching') }}</div>
          </div>
        </div>
      </div>

      <!-- Go to Line 对话框 (Ctrl+G) -->
      <div class="quick-open-overlay" v-if="goToLineVisible" @click.self="closeGoToLine">
        <div class="quick-open-dialog goto-line-dialog">
          <input
            ref="goToLineInput"
            v-model="goToLineValue"
            @keydown.enter.prevent="goToLineConfirm"
            @keydown.escape.prevent="closeGoToLine"
            class="quick-open-input"
            placeholder="Go to line number..."
            type="number"
            min="1"
          />
        </div>
      </div>

      <!-- 新建文件/文件夹对话框 -->
      <div class="quick-open-overlay" v-if="newFileDialogVisible" @click.self="newFileDialogVisible = false">
        <div class="quick-open-dialog goto-line-dialog">
          <input
            ref="newFileInput"
            v-model="newFileName"
            @keydown.enter.prevent="confirmNewFile"
            @keydown.escape.prevent="newFileDialogVisible = false"
            class="quick-open-input"
            :placeholder="newFileType === 'directory' ? $t('files.enterFolderName') : $t('files.enterFileName')"
          />
        </div>
      </div>

      <!-- 移动文件对话框 -->
      <div class="quick-open-overlay" v-if="moveDialogVisible" @click.self="moveDialogVisible = false">
        <div class="quick-open-dialog">
          <input
            ref="moveDestInput"
            v-model="moveDestination"
            @keydown.enter.prevent="confirmMove"
            @keydown.escape.prevent="moveDialogVisible = false"
            class="quick-open-input"
            :placeholder="$t('files.moveTarget')"
          />
          <div class="quick-open-list" style="padding: 8px 12px; color: var(--text-muted); font-size: 11px;">
            {{ $t('files.moveItems', { count: selectedPaths.size }) }}
          </div>
        </div>
      </div>

      <!-- 重命名对话框 -->
      <div class="quick-open-overlay" v-if="renameDialogVisible" @click.self="renameDialogVisible = false">
        <div class="quick-open-dialog goto-line-dialog">
          <input
            ref="renameInput"
            v-model="renameNewName"
            @keydown.enter.prevent="confirmRename"
            @keydown.escape.prevent="renameDialogVisible = false"
            class="quick-open-input"
            :placeholder="$t('files.enterNewName')"
          />
        </div>
      </div>

      <!-- 右键上下文菜单 -->
      <div v-if="contextMenu.visible" class="ctx-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @click.stop>
        <div class="ctx-menu-item" @click="ctxRename">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          {{ $t('files.rename') }}
        </div>
        <div class="ctx-menu-item" @click="ctxCopy">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
          {{ $t('files.copyHere') }}
        </div>
        <div class="ctx-menu-item" @click="ctxMoveTo">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 12l-4-4h3V10h2v4h3l-4 4z"/></svg>
          {{ $t('files.moveTo') }}
        </div>
        <div class="ctx-menu-separator"></div>
        <div class="ctx-menu-item ctx-menu-danger" @click="ctxDelete">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          {{ $t('common.delete') }}
        </div>
        <template v-if="contextMenu.entry?.type === 'file'">
          <div class="ctx-menu-separator"></div>
          <div class="ctx-menu-item" @click="ctxDownload">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            {{ $t('files.download') }}
          </div>
        </template>
      </div>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const t = Vue.inject('t');

    // --- Shared utilities ---
    const getEffectiveWorkDir = () => store.effectiveWorkDir || '';
    const normalizePath = (p) => p ? p.replace(/\\/g, '/') : '';
    const getFileIconHtml = (name) => getFileIconSvg(name);
    const getFolderIcon = (isOpen) => getFolderIconSvg(isOpen);
    const formatSize = (bytes) => {
      if (bytes == null) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    };

    // --- DOM refs ---
    const rootEl = Vue.ref(null);
    const editorContainer = Vue.ref(null);

    // --- Mobile responsive state ---
    const isMobile = Vue.ref(window.innerWidth <= 768);
    const mobileView = Vue.ref('tree'); // 'tree' | 'editor'
    const mobileGoBack = () => { mobileView.value = 'tree'; };

    // --- Font size zoom ---
    const fontSize = Vue.ref(parseInt(localStorage.getItem('filesFontSize')) || 15);
    const setFontSize = (size) => {
      fontSize.value = Math.max(8, Math.min(24, size));
      localStorage.setItem('filesFontSize', fontSize.value.toString());
      const file = tabs.activeFile.value;
      if (file?.cmInstance) {
        file.cmInstance.getWrapperElement().style.fontSize = fontSize.value + 'px';
        file.cmInstance.refresh();
      }
    };
    const zoomIn = () => setFontSize(fontSize.value + 1);
    const zoomOut = () => setFontSize(fontSize.value - 1);
    const onWheel = (e) => { e.deltaY < 0 ? zoomIn() : zoomOut(); };

    // --- Resizable tree panel ---
    const treePanelWidth = Vue.ref(parseInt(localStorage.getItem('filePanelWidth')) || 220);
    const isTreeResizing = Vue.ref(false);
    const startTreeResize = (e) => {
      e.preventDefault();
      const isTouch = e.type === 'touchstart';
      isTreeResizing.value = true;
      const startX = isTouch ? e.touches[0].clientX : e.clientX;
      const startWidth = treePanelWidth.value;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const container = e.target.closest('.file-two-col');
      const maxWidth = container ? container.offsetWidth * 0.5 : 400;
      const onMove = (ev) => {
        const clientX = isTouch ? ev.touches[0].clientX : ev.clientX;
        treePanelWidth.value = Math.max(120, Math.min(maxWidth, startWidth + (clientX - startX)));
      };
      const onEnd = () => {
        isTreeResizing.value = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('filePanelWidth', treePanelWidth.value.toString());
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
      };
      document.addEventListener(isTouch ? 'touchmove' : 'mousemove', onMove);
      document.addEventListener(isTouch ? 'touchend' : 'mouseup', onEnd);
    };

    // --- Initialize composables ---
    // Pre-declare variables used across composables to avoid TDZ issues.
    // Some composables have circular dependencies (e.g. find needs tabs.activeFile,
    // tabs needs find.clearFindMarkers), resolved via getter functions that defer access.
    let tabs, tree;

    // Shared computed refs: created before composables, passed to those that need them.
    // These use getter functions to safely defer access to `tabs` (assigned later).
    const activeFileRef = Vue.computed(() => tabs ? tabs.activeFile.value : null);
    const treePathRef = Vue.computed(() => tree ? tree.treePath.value : '');

    // 1. Find/Replace
    const find = createFindReplace(activeFileRef);

    // 2. File editor
    const editor = createFileEditor(store, {
      activeFile: activeFileRef,
      editorContainer, fontSize,
      clearFindMarkers: find.clearFindMarkers,
      openFindBar: find.openFindBar,
      saveFile: () => tabs.saveFile()
    });

    // 3. File preview
    const preview = createFilePreview(activeFileRef, {
      editorContainer, createEditor: editor.createEditor, t
    });

    // 4. File operations
    const ops = createFileOperations(store, { getEffectiveWorkDir, treePath: treePathRef });

    // 5. File tabs (depends on editor, find, preview)
    tabs = createFileTabs(store, {
      normalizePath, getEffectiveWorkDir,
      editorContainer,
      createEditor: editor.createEditor,
      destroyEditor: editor.destroyEditor,
      clearFindMarkers: find.clearFindMarkers,
      saveCurrentUndoHistory: editor.saveCurrentUndoHistory,
      saveAllUndoHistory: editor.saveAllUndoHistory,
      cleanupUndoHistory: editor.cleanupUndoHistory,
      deleteConversationHistory: editor.deleteConversationHistory,
      debugStatus: editor.debugStatus,
      mdPreviewMode: preview.mdPreviewMode,
      renderOfficeLocal: preview.renderOfficeLocal,
      performFind: find.performFind,
      findBarVisible: find.findBarVisible,
      findQuery: find.findQuery,
      t
    });

    // 6. File tree (depends on ops, tabs)
    tree = createFileTree(store, {
      getEffectiveWorkDir, normalizePath,
      selectedPaths: ops.selectedPaths,
      lastClickedIndex: ops.lastClickedIndex,
      openFileInTab: (...args) => tabs.openFileInTab(...args),
      clearSelection: ops.clearSelection
    });

    // 7. Quick Open (depends on tree, tabs)
    const qo = createQuickOpen(store, {
      getEffectiveWorkDir,
      treePath: tree.treePath,
      openFileInTab: (...args) => tabs.openFileInTab(...args),
      normalizePath,
      treeRootPath: tree.treeRootPath,
      treeNodes: tree.treeNodes,
      loadTreeDirectory: tree.loadTreeDirectory
    });

    // 8. Bind late-bound key bindings (resolves forward ref: editor → qo)
    editor.setKeyBindings({
      openQuickOpen: qo.openQuickOpen,
      openGoToLine: qo.openGoToLine
    });

    // 9. Folder picker (depends on tree)
    const fp = createFolderPicker(store, {
      getEffectiveWorkDir,
      treePath: tree.treePath, treeRootPath: tree.treeRootPath,
      treeNodes: tree.treeNodes, normalizePath, loadTreeDirectory: tree.loadTreeDirectory
    });

    // 10. WebSocket message handler (depends on all)
    const ws = createWsHandler({
      store, normalizePath, getEffectiveWorkDir,
      openFiles: tabs.openFiles,
      activeFileIndex: tabs.activeFileIndex,
      activeFile: tabs.activeFile,
      fileLoading: tabs.fileLoading,
      fileSaving: tabs.fileSaving,
      saveTabsState: tabs.saveTabsState,
      createEditor: editor.createEditor,
      openFileInTab: tabs.openFileInTab,
      tree, fp, qo, ops,
      mdPreviewMode: preview.mdPreviewMode,
      renderOfficeLocal: preview.renderOfficeLocal,
      editorContainer, debugStatus: editor.debugStatus
    });

    // --- Wrapped operation callbacks (pass t at init time) ---
    const deleteSingleFile = (entry) => ops.deleteSingleFile(entry, t);
    const deleteSelected = () => ops.deleteSelected(t);
    const ctxDelete = () => ops.ctxDelete(t);
    const onDrop = (event, entry) => ops.onDrop(event, entry, ops.handleExternalFileDrop);
    const onTreeDrop = (event) => ops.onTreeDrop(event, tree.treeRootPath.value, ops.handleExternalFileDrop);
    const goToLineConfirm = () => qo.goToLineConfirm(tabs.activeFile);

    // --- Watchers ---
    Vue.watch(() => store.currentAgent, () => {
      tabs.saveTabsState(store.currentConversation);
      editor.destroyEditor();
      tree.clearTreeNodes();
      tabs.openFiles.value = [];
      tabs.activeFileIndex.value = -1;
      tabs.fileLoading.value = false;
      if (store.currentAgent) Vue.nextTick(() => tree.initFileBrowser());
    });

    let previousConversation = store.currentConversation;
    Vue.watch(() => store.currentConversation, (newConv) => {
      tabs.saveTabsState(previousConversation);
      previousConversation = newConv;
      tabs.restoreTabsState(newConv);
      const dir = getEffectiveWorkDir();
      const nDir = normalizePath(dir);
      if (dir && nDir !== tree.treeRootPath.value) {
        tree.treePath.value = dir;
        tree.treeRootPath.value = nDir;
        tree.clearTreeNodes();
        tree.loadTreeDirectory(dir);
      }
    });

    Vue.watch(() => store.theme, (newTheme) => {
      const file = tabs.activeFile.value;
      if (file?.cmInstance) file.cmInstance.setOption('theme', newTheme === 'dark' ? 'material-darker' : 'default');
    });

    Vue.watch(() => getEffectiveWorkDir(), (dir) => {
      if (dir && !tree.treeRootPath.value) {
        const nDir = normalizePath(dir);
        tree.treePath.value = dir;
        tree.treeRootPath.value = nDir;
        tree.clearTreeNodes();
        tree.loadTreeDirectory(dir);
      }
    });

    Vue.watch(
      () => tabs.activeFile.value?.content,
      (newContent, oldContent) => {
        const file = tabs.activeFile.value;
        if (file && newContent != null && oldContent == null && !file.cmInstance && (!file.fileType || file.fileType === 'text')) {
          if (isMarkdownFile(file.name) && preview.mdPreviewMode.value) return;
          Vue.nextTick(() => { setTimeout(() => { if (!file.cmInstance) editor.createEditor(file); }, 150); });
        }
      }
    );

    Vue.watch(
      [preview.mdRenderedHtml, preview.mdPreviewMode],
      ([html, previewOn]) => {
        if (html && previewOn) Vue.nextTick(() => { setTimeout(() => preview.renderMermaidBlocks(), 50); });
      }
    );

    // --- Global keyboard shortcuts ---
    const handleGlobalKeydown = (e) => {
      const isVisible = rootEl.value && rootEl.value.offsetParent !== null;
      if (!isVisible && !qo.quickOpenVisible.value && !qo.goToLineVisible.value && !find.findBarVisible.value) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        qo.quickOpenVisible.value ? qo.closeQuickOpen() : qo.openQuickOpen();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
        e.preventDefault();
        qo.goToLineVisible.value ? qo.closeGoToLine() : qo.openGoToLine();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (tabs.activeFile.value) { e.preventDefault(); find.openFindBar(false); }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'h')) {
        if (tabs.activeFile.value) { e.preventDefault(); find.openFindBar(true); }
      } else if (e.key === 'Escape') {
        if (find.findBarVisible.value) find.closeFindBar();
        if (ops.selectedPaths.size > 0) ops.clearSelection();
        if (qo.quickOpenVisible.value) qo.closeQuickOpen();
        if (qo.goToLineVisible.value) qo.closeGoToLine();
      }
    };

    const handleDocumentClick = () => { ops.hideContextMenu(); };

    // --- Mobile view: auto-switch on file open / close ---
    const onResize = () => { isMobile.value = window.innerWidth <= 768; };

    Vue.watch(() => tabs.activeFileIndex.value, (newIdx, oldIdx) => {
      if (isMobile.value && newIdx >= 0 && newIdx !== oldIdx) {
        mobileView.value = 'editor';
      }
    });

    Vue.watch(() => tabs.openFiles.value.length, (len) => {
      if (isMobile.value && len === 0) {
        mobileView.value = 'tree';
      }
    });

    // --- Lifecycle ---
    Vue.onMounted(() => {
      window.addEventListener('workbench-message', ws.handleWorkbenchMessage);
      window.addEventListener('open-file-in-explorer', ws.handleOpenFile);
      window.addEventListener('conversation-deleted', tabs.handleConversationDeleted);
      window.addEventListener('keydown', handleGlobalKeydown);
      document.addEventListener('click', handleDocumentClick);
      window.addEventListener('resize', onResize);
      preview.initMermaid();
      if (store.currentAgent) {
        tree.initFileBrowser();
        store.sendWsMessage({ type: 'restore_file_tabs' });
      }
    });

    Vue.onUnmounted(() => {
      window.removeEventListener('workbench-message', ws.handleWorkbenchMessage);
      window.removeEventListener('open-file-in-explorer', ws.handleOpenFile);
      window.removeEventListener('conversation-deleted', tabs.handleConversationDeleted);
      window.removeEventListener('keydown', handleGlobalKeydown);
      document.removeEventListener('click', handleDocumentClick);
      window.removeEventListener('resize', onResize);
      editor.destroyEditor();
      ops.cleanup();
    });

    return {
      store, debugStatus: editor.debugStatus, rootEl,
      isMobile, mobileView, mobileGoBack,
      fontSize, zoomIn, zoomOut, onWheel,
      treePath: tree.treePath, treeRootPath: tree.treeRootPath,
      treeNodes: tree.treeNodes, flattenedTree: tree.flattenedTree,
      editingTreePath: tree.editingTreePath, treePathInputRef: tree.treePathInputRef,
      rootFolderName: tree.rootFolderName, rootExpanded: tree.rootExpanded,
      toggleRootExpand: tree.toggleRootExpand, collapseAll: tree.collapseAll,
      startTreePathEdit: tree.startTreePathEdit,
      confirmTreePath: tree.confirmTreePath, cancelTreePathEdit: tree.cancelTreePathEdit,
      treePanelWidth, isTreeResizing, startTreeResize,
      openFiles: tabs.openFiles, activeFileIndex: tabs.activeFileIndex,
      activeFile: tabs.activeFile, fileLoading: tabs.fileLoading, fileSaving: tabs.fileSaving,
      editorContainer, officePreviewContainer: preview.officePreviewContainer,
      mdPreviewRef: preview.mdPreviewRef,
      isActiveMarkdown: preview.isActiveMarkdown, mdPreviewMode: preview.mdPreviewMode,
      mdRenderedHtml: preview.mdRenderedHtml, switchToMdEdit: preview.switchToMdEdit,
      folderPickerOpen: fp.folderPickerOpen, folderPickerPath: fp.folderPickerPath,
      folderPickerEntries: fp.folderPickerEntries, folderPickerLoading: fp.folderPickerLoading,
      folderPickerSelected: fp.folderPickerSelected,
      searchQuery: qo.searchQuery, searchResults: qo.searchResults, searchLoading: qo.searchLoading,
      onSearchInput: qo.onSearchInput, clearSearch: qo.clearSearch,
      onSearchResultClick: qo.onSearchResultClick,
      quickOpenVisible: qo.quickOpenVisible, quickOpenQuery: qo.quickOpenQuery,
      quickOpenResults: qo.quickOpenResults, quickOpenSelectedIndex: qo.quickOpenSelectedIndex,
      quickOpenLoading: qo.quickOpenLoading, quickOpenInput: qo.quickOpenInput,
      openQuickOpen: qo.openQuickOpen, closeQuickOpen: qo.closeQuickOpen,
      onQuickOpenInput: qo.onQuickOpenInput,
      quickOpenSelectNext: qo.quickOpenSelectNext, quickOpenSelectPrev: qo.quickOpenSelectPrev,
      quickOpenConfirm: qo.quickOpenConfirm, quickOpenOpenFile: qo.quickOpenOpenFile,
      goToLineVisible: qo.goToLineVisible, goToLineValue: qo.goToLineValue,
      goToLineInput: qo.goToLineInput, openGoToLine: qo.openGoToLine,
      closeGoToLine: qo.closeGoToLine, goToLineConfirm,
      findBarVisible: find.findBarVisible, replaceBarVisible: find.replaceBarVisible,
      findQuery: find.findQuery, replaceQuery: find.replaceQuery,
      findCaseSensitive: find.findCaseSensitive, findUseRegex: find.findUseRegex,
      findMatchCount: find.findMatchCount, findMatchIndex: find.findMatchIndex,
      findInputRef: find.findInputRef, replaceInputRef: find.replaceInputRef,
      onFindInput: find.onFindInput, findNext: find.findNext, findPrev: find.findPrev,
      openFindBar: find.openFindBar, closeFindBar: find.closeFindBar,
      toggleReplaceBar: find.toggleReplaceBar, replaceOne: find.replaceOne, replaceAll: find.replaceAll,
      selectedPaths: ops.selectedPaths, fileOperating: ops.fileOperating,
      fileOpFeedback: ops.fileOpFeedback,
      newFileDialogVisible: ops.newFileDialogVisible, newFileName: ops.newFileName,
      newFileType: ops.newFileType, newFileInput: ops.newFileInput,
      moveDialogVisible: ops.moveDialogVisible, moveDestination: ops.moveDestination,
      moveDestInput: ops.moveDestInput,
      toggleSelection: ops.toggleSelection, clearSelection: ops.clearSelection,
      showNewFileDialog: ops.showNewFileDialog, confirmNewFile: ops.confirmNewFile,
      deleteSingleFile, deleteSelected,
      openMoveDialog: ops.openMoveDialog, confirmMove: ops.confirmMove,
      contextMenu: ops.contextMenu, showContextMenu: ops.showContextMenu,
      hideContextMenu: ops.hideContextMenu,
      ctxRename: ops.ctxRename, ctxCopy: ops.ctxCopy, ctxMoveTo: ops.ctxMoveTo,
      ctxDelete, ctxDownload: ops.ctxDownload,
      renameDialogVisible: ops.renameDialogVisible, renameNewName: ops.renameNewName,
      renameInput: ops.renameInput, confirmRename: ops.confirmRename,
      dragState: ops.dragState, externalDropActive: ops.externalDropActive,
      onDragStart: ops.onDragStart, onDragOver: ops.onDragOver,
      onDragLeave: ops.onDragLeave, onDrop,
      onTreeDragOver: ops.onTreeDragOver, onTreeDragLeave: ops.onTreeDragLeave, onTreeDrop,
      loadRootDirectory: tree.loadRootDirectory, onTreeItemClick: tree.onTreeItemClick,
      openFileInTab: tabs.openFileInTab,
      switchToTab: tabs.switchToTab, closeFileTab: tabs.closeFileTab, saveFile: tabs.saveFile,
      openFolderPicker: fp.openFolderPicker, folderPickerNavigateUp: fp.folderPickerNavigateUp,
      folderPickerSelectItem: fp.folderPickerSelectItem, folderPickerEnter: fp.folderPickerEnter,
      confirmFolderPicker: fp.confirmFolderPicker,
      getFileIcon: () => '', getFileIconHtml, getFolderIcon, formatSize,
      refresh: tree.refresh, placeholderPath: Vue.computed(() => {
        const dir = getEffectiveWorkDir();
        return dir ? t('files.workDir', { dir }) : t('files.enterDirPath');
      }),
    };
  }
};
