/**
 * CreationTab — Folder-level Creation Workspace inside Yeaft Workbench.
 *
 * Scans an Agent workspace folder recursively and organizes it into three
 * first-class modalities — Documents, Images, and Videos — reusing
 * `FileCanvasView` for distraction-free reading, editing, and media preview.
 *
 * All Workbench WS file requests (`list_directory`, `read_file`, `write_file`,
 * `create_file`, `video_metadata`, `upload_to_dir`) are route-bound via
 * `createRouteBoundWorkbenchStore` and correlated strictly by unique
 * `requestId` so `CreationTab` never interferes with `FilesTab`.
 */
import { useChatStore } from '../../stores/chat.js';
import { useCreationsStore } from '../../stores/creations.js';
import { createRouteBoundWorkbenchStore } from '../../utils/workbench-route.js';
import FileCanvasView from './FileCanvasView.js';
import CreationCreateModal from './CreationCreateModal.js';
import NavigationIcon from '../NavigationIcon.js';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.yeaft',
  'dist',
  '__pycache__',
  '.DS_Store',
]);

const DOC_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogg', '.ogv']);

const SCAN_MAX_DEPTH = 4;
const SCAN_MAX_ENTRIES = 600;
const THUMB_CONCURRENCY = 4;

export function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

export function joinPath(base, name) {
  const cleanBase = String(base || '').replace(/[/\\]+$/, '');
  const cleanName = String(name || '').replace(/^[/\\]+/, '');
  if (!cleanBase) return cleanName;
  const sep = cleanBase.includes('\\') && !cleanBase.includes('/') ? '\\' : '/';
  return `${cleanBase}${sep}${cleanName}`;
}

export function shortenPath(fullPath) {
  const norm = normalizePath(fullPath);
  if (!norm) return '';
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 3) return norm;
  return `…/${parts.slice(-3).join('/')}`;
}

function getExt(name) {
  const str = String(name || '');
  const dot = str.lastIndexOf('.');
  return dot > 0 ? str.slice(dot).toLowerCase() : '';
}

function relativePath(fullPath, rootDir) {
  const normFull = normalizePath(fullPath);
  const normRoot = normalizePath(rootDir);
  if (!normRoot) return normFull;
  const prefix = normRoot.endsWith('/') ? normRoot : `${normRoot}/`;
  if (normFull.startsWith(prefix)) return normFull.slice(prefix.length);
  return normFull;
}

/**
 * Build a nested directory tree from flat document file entries.
 * @param {Array<{path:string, name:string, relPath:string, size?:number}>} docFiles
 * @param {string} rootDir
 * @returns {Array<object>}
 */
export function buildDocTree(docFiles, rootDir) {
  const rootChildren = [];
  const folderMap = new Map();

  const ensureFolder = (relDirPath) => {
    if (!relDirPath) return rootChildren;
    if (folderMap.has(relDirPath)) return folderMap.get(relDirPath).children;
    const parts = relDirPath.split('/');
    let currentChildren = rootChildren;
    let accum = '';
    for (const part of parts) {
      accum = accum ? `${accum}/${part}` : part;
      let node = folderMap.get(accum);
      if (!node) {
        node = {
          type: 'folder',
          name: part,
          relPath: accum,
          path: joinPath(rootDir, accum),
          children: [],
        };
        folderMap.set(accum, node);
        currentChildren.push(node);
      }
      currentChildren = node.children;
    }
    return currentChildren;
  };

  for (const file of docFiles) {
    const rel = file.relPath || relativePath(file.path, rootDir);
    const slashIdx = rel.lastIndexOf('/');
    const parentDir = slashIdx > 0 ? rel.slice(0, slashIdx) : '';
    const container = ensureFolder(parentDir);
    container.push({
      type: 'file',
      name: file.name,
      relPath: rel,
      path: file.path,
      size: file.size || 0,
    });
  }

  const sortNodes = (nodes) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.type === 'folder') sortNodes(n.children);
    }
  };
  sortNodes(rootChildren);
  return rootChildren;
}

function flattenDocTree(nodes, expandedSet, depth = 0, out = []) {
  for (const node of nodes) {
    out.push({ ...node, depth });
    if (node.type === 'folder' && expandedSet.has(node.relPath)) {
      flattenDocTree(node.children, expandedSet, depth + 1, out);
    }
  }
  return out;
}

function kindSwatchClass(kind) {
  if (kind === 'deck') return 'is-deck';
  if (kind === 'gallery') return 'is-gallery';
  if (kind === 'video') return 'is-video';
  return 'is-book';
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default {
  name: 'CreationTab',
  components: { FileCanvasView, CreationCreateModal, NavigationIcon },
  props: {
    routeKey: { type: String, required: true },
    runtimeProvider: { type: String, required: true },
    agentId: { type: String, required: true },
    sessionId: { type: String, default: '' },
    workItemId: { type: String, default: '' },
    conversationId: { type: String, required: true },
    workDir: { type: String, default: '' },
    workspaceGeneration: { type: String, required: true },
    workspaceLocked: { type: Boolean, default: false },
  },
  template: `
    <div class="creation-wb-root" ref="rootEl" @keydown="onRootKeydown">
      <!-- ==================== ONBOARDING / SWITCHER VIEW ==================== -->
      <section v-if="showOnboarding" class="creation-wb-onboarding">
        <div class="creation-wb-onboarding-header">
          <div class="creation-wb-onboarding-copy">
            <h2>{{ tr('creation.workbench.onboardingTitle', 'Creation Workspace') }}</h2>
            <p>{{ tr('creation.workbench.onboardingDesc', 'Organize a workspace folder into Documents, Images, and Videos with live Canvas preview.') }}</p>
          </div>
          <button
            v-if="showingSwitcher && activeRootDir"
            type="button"
            class="btn-ghost creation-wb-back-btn"
            @click="showingSwitcher = false"
          >
            {{ tr('common.back', 'Back') }}
          </button>
        </div>

        <div v-if="onboardingError" class="creation-wb-banner is-error" role="alert">
          {{ onboardingError }}
        </div>

        <div class="creation-wb-action-grid">
          <button
            type="button"
            class="creation-wb-action-card"
            :disabled="bindingFolder"
            @click="openCreateModal"
          >
            <span class="creation-wb-action-icon is-accent" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path fill="currentColor" d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2z" />
              </svg>
            </span>
            <span class="creation-wb-action-body">
              <span class="creation-wb-action-title">{{ tr('creation.workbench.createNew', 'New Creation') }}</span>
              <span class="creation-wb-action-desc">{{ tr('creation.workbench.createNewDesc', 'Start a new Creation workspace with optional prompt and source files.') }}</span>
            </span>
          </button>

          <button
            v-if="workDir"
            type="button"
            class="creation-wb-action-card"
            :disabled="bindingFolder"
            @click="bindCurrentFolder"
          >
            <span class="creation-wb-action-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2zm0 12H4V8h16v10z" />
              </svg>
            </span>
            <span class="creation-wb-action-body">
              <span class="creation-wb-action-title">
                {{ bindingFolder ? tr('creation.workbench.openingFolder', 'Opening folder…') : tr('creation.workbench.useCurrentFolder', 'Open Current Folder as Creation') }}
              </span>
              <span class="creation-wb-action-desc creation-wb-mono" :title="workDir">{{ shortenPath(workDir) }}</span>
            </span>
          </button>
        </div>

        <div class="creation-wb-existing-section">
          <div class="creation-wb-section-head">
            <h3>{{ tr('creation.workbench.openExisting', 'Existing Creations on this Agent') }}</h3>
            <span class="creation-wb-count-pill">{{ agentCreations.length }}</span>
          </div>

          <div v-if="loadingCreations" class="creation-wb-empty-note">
            {{ tr('common.loading', 'Loading…') }}
          </div>
          <div v-else-if="agentCreations.length === 0" class="creation-wb-empty-note">
            {{ tr('creation.workbench.noExisting', 'No Creations on this Agent yet. Create one above or bind the current folder.') }}
          </div>
          <div v-else class="creation-wb-existing-list">
            <button
              v-for="item in agentCreations"
              :key="item.id"
              type="button"
              class="creation-wb-existing-card"
              :class="{ active: activeCreation && activeCreation.id === item.id }"
              @click="selectExistingCreation(item)"
            >
              <span class="creation-kind-swatch" :class="kindSwatchClass(item.kind)" aria-hidden="true"></span>
              <span class="creation-wb-existing-info">
                <span class="creation-wb-existing-title">{{ item.title || item.id }}</span>
                <span v-if="item.rootDir" class="creation-wb-existing-path creation-wb-mono" :title="item.rootDir">{{ shortenPath(item.rootDir) }}</span>
              </span>
              <span v-if="item.sessionId && item.sessionId === sessionId" class="creation-wb-linked-badge">
                {{ tr('creation.workbench.thisSession', 'Current') }}
              </span>
            </button>
          </div>
        </div>
      </section>

      <!-- ==================== ACTIVE WORKSPACE VIEW ==================== -->
      <div v-else class="creation-wb-workspace">
        <!-- Workspace Header -->
        <header class="creation-wb-header">
          <div class="creation-wb-title-block">
            <span class="creation-kind-swatch" :class="kindSwatchClass(activeCreation?.kind)" aria-hidden="true"></span>
            <div class="creation-wb-title-meta">
              <span class="creation-wb-title" :title="activeTitle">{{ activeTitle }}</span>
              <span class="creation-wb-path creation-wb-mono" :title="activeRootDir">{{ shortenPath(activeRootDir) }}</span>
            </div>
          </div>

          <div class="creation-wb-header-actions">
            <!-- [+] Add Menu -->
            <div class="creation-wb-menu-wrap" ref="addMenuWrap">
              <button
                type="button"
                class="creation-wb-icon-btn"
                :title="tr('creation.workbench.addMenu', 'Create or upload')"
                :aria-label="tr('creation.workbench.addMenu', 'Create or upload')"
                :aria-expanded="addMenuOpen"
                aria-haspopup="menu"
                @click.stop="addMenuOpen = !addMenuOpen"
              >
                <NavigationIcon name="add" :size="16" />
              </button>
              <div v-if="addMenuOpen" class="ctx-menu creation-wb-add-menu" role="menu">
                <button type="button" class="ctx-menu-item" role="menuitem" @click="openMiniDialog('doc')">
                  {{ tr('creation.workbench.newDoc', 'New Document') }}
                </button>
                <button type="button" class="ctx-menu-item" role="menuitem" @click="openMiniDialog('folder')">
                  {{ tr('creation.workbench.newFolder', 'New Folder') }}
                </button>
                <button type="button" class="ctx-menu-item" role="menuitem" @click="triggerMediaUpload('auto')">
                  {{ tr('creation.workbench.uploadMedia', 'Upload Media') }}
                </button>
              </div>
            </div>

            <!-- Refresh -->
            <button
              type="button"
              class="creation-wb-icon-btn"
              :disabled="scanning"
              :title="tr('creation.workbench.refresh', 'Refresh folder')"
              :aria-label="tr('creation.workbench.refresh', 'Refresh folder')"
              @click="scanWorkspace({ reloadActiveDoc: true })"
            >
              <svg :class="{ 'is-spinning': scanning }" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
              </svg>
            </button>

            <!-- Open in Files -->
            <button
              type="button"
              class="creation-wb-text-btn"
              :title="tr('creation.workbench.openInFiles', 'Open in Files')"
              @click="openWorkspaceInFiles()"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
              </svg>
              <span>{{ tr('creation.workbench.openInFiles', 'Files') }}</span>
            </button>

            <!-- Switch Creation -->
            <button
              type="button"
              class="creation-wb-icon-btn"
              :title="tr('creation.workbench.switchCreation', 'Switch Creation')"
              :aria-label="tr('creation.workbench.switchCreation', 'Switch Creation')"
              @click="showingSwitcher = true"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path fill="currentColor" d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z" />
              </svg>
            </button>
          </div>
        </header>

        <!-- Hidden Upload Input -->
        <input
          ref="uploadInputRef"
          type="file"
          multiple
          :accept="uploadAccept"
          class="creation-hidden-file-input"
          @change="onUploadInputChange"
        />

        <!-- Inline Mini-Dialog for New Document / New Folder -->
        <div v-if="miniDialog.visible" class="creation-wb-mini-dialog">
          <span class="creation-wb-mini-label">
            {{ miniDialog.mode === 'folder' ? tr('creation.workbench.newFolder', 'New Folder') : tr('creation.workbench.newDoc', 'New Document') }}
          </span>
          <input
            ref="miniDialogInputRef"
            v-model.trim="miniDialog.name"
            type="text"
            class="creation-wb-mini-input"
            :placeholder="miniDialog.mode === 'folder' ? tr('creation.workbench.folderNamePlaceholder', 'chapters/part-2') : tr('creation.workbench.docNamePlaceholder', 'notes.md')"
            :disabled="miniDialog.submitting"
            @keydown.enter.prevent="confirmMiniDialog"
            @keydown.escape.prevent="miniDialog.visible = false"
          />
          <button
            type="button"
            class="btn-primary creation-wb-mini-btn"
            :disabled="miniDialog.submitting || !miniDialog.name"
            @click="confirmMiniDialog"
          >
            {{ tr('common.create', 'Create') }}
          </button>
          <button
            type="button"
            class="btn-ghost creation-wb-mini-btn"
            :disabled="miniDialog.submitting"
            @click="miniDialog.visible = false"
          >
            {{ tr('common.cancel', 'Cancel') }}
          </button>
        </div>

        <!-- Feedback Banner -->
        <div v-if="feedback" class="creation-wb-banner" :class="feedback.ok ? 'is-success' : 'is-error'" role="status">
          <span>{{ feedback.message }}</span>
          <button type="button" class="creation-wb-banner-close" :aria-label="tr('common.close', 'Close')" @click="feedback = null">×</button>
        </div>

        <!-- 3-Modality Tab Bar -->
        <div class="creation-wb-tabs" role="tablist" :aria-label="tr('creation.workbench.modalities', 'Workspace views')">
          <button
            type="button"
            role="tab"
            class="creation-wb-tab"
            :class="{ active: activeModality === 'docs' }"
            :aria-selected="activeModality === 'docs'"
            @click="activeModality = 'docs'"
          >
            <span>{{ tr('creation.workbench.docs', 'Documents') }}</span>
            <span class="creation-wb-tab-count">{{ docFiles.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            class="creation-wb-tab"
            :class="{ active: activeModality === 'images' }"
            :aria-selected="activeModality === 'images'"
            @click="activeModality = 'images'"
          >
            <span>{{ tr('creation.workbench.images', 'Images') }}</span>
            <span class="creation-wb-tab-count">{{ imageFiles.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            class="creation-wb-tab"
            :class="{ active: activeModality === 'videos' }"
            :aria-selected="activeModality === 'videos'"
            @click="activeModality = 'videos'"
          >
            <span>{{ tr('creation.workbench.videos', 'Videos') }}</span>
            <span class="creation-wb-tab-count">{{ videoFiles.length }}</span>
          </button>
        </div>

        <!-- ==================== DOCUMENTS PANE ==================== -->
        <div v-show="activeModality === 'docs'" class="creation-wb-docs-pane" role="tabpanel">
          <!-- Collapsed tree rail -->
          <div v-if="!docTreeOpen" class="creation-wb-tree-rail">
            <button
              type="button"
              class="creation-wb-icon-btn"
              :title="tr('files.showTree', 'Show tree')"
              :aria-label="tr('files.showTree', 'Show tree')"
              @click="docTreeOpen = true"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2zm10 14H4V8h16v10z" />
              </svg>
            </button>
          </div>

          <!-- Collapsible Documents Directory Tree -->
          <aside v-else class="creation-wb-doc-tree">
            <div class="creation-wb-doc-tree-head">
              <span class="creation-wb-doc-tree-label">{{ tr('creation.workbench.docs', 'Documents') }}</span>
              <div class="creation-wb-doc-tree-actions">
                <button
                  type="button"
                  class="creation-wb-tree-btn"
                  :title="tr('creation.workbench.newDoc', 'New Document')"
                  @click="openMiniDialog('doc')"
                >+ {{ tr('creation.workbench.docShort', 'Doc') }}</button>
                <button
                  type="button"
                  class="creation-wb-tree-btn"
                  :title="tr('creation.workbench.newFolder', 'New Folder')"
                  @click="openMiniDialog('folder')"
                >+ {{ tr('creation.workbench.folderShort', 'Folder') }}</button>
                <button
                  type="button"
                  class="creation-wb-icon-btn is-sm"
                  :title="tr('files.hideTree', 'Hide tree')"
                  :aria-label="tr('files.hideTree', 'Hide tree')"
                  @click="docTreeOpen = false"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                    <path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                  </svg>
                </button>
              </div>
            </div>

            <div class="creation-wb-doc-tree-list">
              <div v-if="scanning && docFiles.length === 0" class="creation-wb-tree-empty">
                {{ tr('common.loading', 'Scanning…') }}
              </div>
              <div v-else-if="flattenedDocTree.length === 0" class="creation-wb-tree-empty">
                <p>{{ tr('creation.workbench.noDocs', 'No documents yet') }}</p>
                <button type="button" class="btn-secondary creation-wb-empty-cta" @click="openMiniDialog('doc')">
                  + {{ tr('creation.workbench.newDoc', 'New Document') }}
                </button>
              </div>
              <button
                v-for="node in flattenedDocTree"
                :key="node.type + ':' + node.relPath"
                type="button"
                class="creation-wb-tree-row"
                :class="{
                  'is-folder': node.type === 'folder',
                  'is-active': node.type === 'file' && activeDocFile && activeDocFile.path === node.path,
                }"
                :style="{ paddingLeft: (8 + node.depth * 14) + 'px' }"
                :title="node.relPath"
                @click="onDocTreeClick(node)"
              >
                <span v-if="node.type === 'folder'" class="creation-wb-tree-caret" aria-hidden="true">
                  <svg v-if="expandedDocFolders.has(node.relPath)" viewBox="0 0 16 16" width="11" height="11"><path fill="currentColor" d="M3.5 5.5L8 10l4.5-4.5z" /></svg>
                  <svg v-else viewBox="0 0 16 16" width="11" height="11"><path fill="currentColor" d="M5.5 3.5L10 8l-4.5 4.5z" /></svg>
                </span>
                <span v-else class="creation-wb-tree-caret is-spacer" aria-hidden="true"></span>
                <span class="creation-wb-tree-name">{{ node.name }}</span>
                <span
                  v-if="node.type === 'file' && activeDocFile && activeDocFile.path === node.path && activeDocFile.isDirty"
                  class="creation-wb-dirty-dot"
                  aria-hidden="true"
                >●</span>
              </button>
            </div>
          </aside>

          <!-- Document Canvas -->
          <div class="creation-wb-doc-canvas">
            <FileCanvasView
              v-if="activeDocFile"
              :file="activeDocFile"
              :route-key="routeKey"
              :saving="docSaving"
              :show-header="true"
              :show-open-in-files="true"
              :show-promote-folder="false"
              @update:content="onDocContentUpdate"
              @save="saveActiveDoc"
              @download="downloadFile(activeDocFile)"
              @open-in-files="openFileInFiles(activeDocFile)"
            />
            <div v-else class="creation-wb-canvas-empty">
              <p>{{ tr('creation.workbench.selectOrCreateDoc', 'Select a document from the tree or create a new one.') }}</p>
              <button type="button" class="btn-secondary" @click="openMiniDialog('doc')">
                + {{ tr('creation.workbench.newDoc', 'New Document') }}
              </button>
            </div>
          </div>
        </div>

        <!-- ==================== IMAGES PANE ==================== -->
        <div v-show="activeModality === 'images'" class="creation-wb-media-pane" role="tabpanel">
          <!-- Image Canvas Detail View -->
          <div v-if="activeImageFile" class="creation-wb-media-detail">
            <div class="creation-wb-media-bar">
              <button type="button" class="creation-wb-text-btn" @click="activeImageIndex = -1">
                ← {{ tr('creation.workbench.backToGrid', 'Back to Grid') }}
              </button>
              <span class="creation-wb-media-bar-name" :title="activeImageFile.relPath">{{ activeImageFile.name }}</span>
              <div class="creation-wb-media-nav">
                <button
                  type="button"
                  class="creation-wb-text-btn"
                  :disabled="activeImageIndex <= 0"
                  @click="selectImageAt(activeImageIndex - 1)"
                >{{ tr('common.prev', 'Prev') }}</button>
                <span class="creation-wb-media-counter">{{ activeImageIndex + 1 }} / {{ imageFiles.length }}</span>
                <button
                  type="button"
                  class="creation-wb-text-btn"
                  :disabled="activeImageIndex >= imageFiles.length - 1"
                  @click="selectImageAt(activeImageIndex + 1)"
                >{{ tr('common.next', 'Next') }}</button>
              </div>
            </div>
            <div class="creation-wb-media-canvas-host">
              <FileCanvasView
                :file="activeImageFile"
                :route-key="routeKey"
                :saving="false"
                :show-header="true"
                :show-open-in-files="true"
                :show-promote-folder="false"
                @download="downloadFile(activeImageFile)"
                @open-in-files="openFileInFiles(activeImageFile)"
              />
            </div>
          </div>

          <!-- Image Grid View -->
          <div v-else class="creation-wb-media-grid-wrap">
            <div class="creation-wb-media-toolbar">
              <span class="creation-wb-media-summary">
                {{ imageFiles.length }} {{ tr('creation.workbench.images', 'Images') }}
              </span>
              <button
                type="button"
                class="btn-secondary creation-wb-upload-btn"
                :disabled="uploading"
                @click="triggerMediaUpload('images')"
              >
                {{ uploading ? tr('creation.workbench.uploading', 'Uploading…') : tr('creation.workbench.uploadImages', 'Upload Images') }}
              </button>
            </div>

            <div v-if="imageFiles.length === 0" class="creation-wb-canvas-empty">
              <p>{{ tr('creation.workbench.noImages', 'No images in this workspace yet.') }}</p>
              <button type="button" class="btn-secondary" @click="triggerMediaUpload('images')">
                {{ tr('creation.workbench.uploadImages', 'Upload Images') }}
              </button>
            </div>

            <div v-else class="creation-wb-media-grid">
              <button
                v-for="(img, idx) in imageFiles"
                :key="img.path"
                type="button"
                class="creation-wb-image-card"
                :title="img.relPath"
                @click="selectImageAt(idx)"
              >
                <div class="creation-wb-image-thumb">
                  <img
                    v-if="img.previewUrl"
                    :src="img.previewUrl"
                    :alt="img.name"
                    loading="lazy"
                  />
                  <span v-else-if="img.thumbError" class="creation-wb-thumb-fallback">{{ tr('creation.workbench.previewUnavailable', 'No preview') }}</span>
                  <span v-else class="creation-wb-thumb-loading">{{ tr('common.loading', 'Loading…') }}</span>
                </div>
                <div class="creation-wb-media-meta">
                  <span class="creation-wb-media-name">{{ img.name }}</span>
                  <span v-if="img.size" class="creation-wb-media-size">{{ formatSize(img.size) }}</span>
                </div>
              </button>
            </div>
          </div>
        </div>

        <!-- ==================== VIDEOS PANE ==================== -->
        <div v-show="activeModality === 'videos'" class="creation-wb-media-pane" role="tabpanel">
          <!-- Video Canvas Detail View -->
          <div v-if="activeVideoFile" class="creation-wb-media-detail">
            <div class="creation-wb-media-bar">
              <button type="button" class="creation-wb-text-btn" @click="activeVideoIndex = -1">
                ← {{ tr('creation.workbench.backToGrid', 'Back to Grid') }}
              </button>
              <span class="creation-wb-media-bar-name" :title="activeVideoFile.relPath">{{ activeVideoFile.name }}</span>
              <div class="creation-wb-media-nav">
                <button
                  type="button"
                  class="creation-wb-text-btn"
                  :disabled="activeVideoIndex <= 0"
                  @click="selectVideoAt(activeVideoIndex - 1)"
                >{{ tr('common.prev', 'Prev') }}</button>
                <span class="creation-wb-media-counter">{{ activeVideoIndex + 1 }} / {{ videoFiles.length }}</span>
                <button
                  type="button"
                  class="creation-wb-text-btn"
                  :disabled="activeVideoIndex >= videoFiles.length - 1"
                  @click="selectVideoAt(activeVideoIndex + 1)"
                >{{ tr('common.next', 'Next') }}</button>
              </div>
            </div>
            <div class="creation-wb-media-canvas-host">
              <FileCanvasView
                :file="activeVideoFile"
                :route-key="routeKey"
                :saving="false"
                :show-header="true"
                :show-open-in-files="true"
                :show-promote-folder="false"
                @download="downloadFile(activeVideoFile)"
                @open-in-files="openFileInFiles(activeVideoFile)"
              />
            </div>
          </div>

          <!-- Video Grid View -->
          <div v-else class="creation-wb-media-grid-wrap">
            <div class="creation-wb-media-toolbar">
              <span class="creation-wb-media-summary">
                {{ videoFiles.length }} {{ tr('creation.workbench.videos', 'Videos') }}
              </span>
              <button
                type="button"
                class="btn-secondary creation-wb-upload-btn"
                :disabled="uploading"
                @click="triggerMediaUpload('videos')"
              >
                {{ uploading ? tr('creation.workbench.uploading', 'Uploading…') : tr('creation.workbench.uploadVideos', 'Upload Videos') }}
              </button>
            </div>

            <div v-if="videoFiles.length === 0" class="creation-wb-canvas-empty">
              <p>{{ tr('creation.workbench.noVideos', 'No videos in this workspace yet.') }}</p>
              <button type="button" class="btn-secondary" @click="triggerMediaUpload('videos')">
                {{ tr('creation.workbench.uploadVideos', 'Upload Videos') }}
              </button>
            </div>

            <div v-else class="creation-wb-video-grid">
              <button
                v-for="(vid, idx) in videoFiles"
                :key="vid.path"
                type="button"
                class="creation-wb-video-card"
                :title="vid.relPath"
                @click="selectVideoAt(idx)"
              >
                <div class="creation-wb-video-poster" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="28" height="28">
                    <path fill="currentColor" d="M8 5v14l11-7z" />
                  </svg>
                </div>
                <div class="creation-wb-media-meta">
                  <span class="creation-wb-media-name">{{ vid.name }}</span>
                  <span class="creation-wb-media-sub">{{ vid.relPath }}</span>
                  <span v-if="vid.size" class="creation-wb-media-size">{{ formatSize(vid.size) }}</span>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Shared CreationCreateModal -->
      <CreationCreateModal
        :visible="createModalOpen"
        :initial-agent-id="agentId"
        :initial-session-mode="sessionId ? 'existing' : 'new'"
        :initial-session-id="sessionId"
        @close="createModalOpen = false"
        @created="onCreationCreated"
      />
    </div>
  `,
  setup(props) {
    const liveStore = Vue.inject('workbench-store', null) || useChatStore();
    const creationsStore = useCreationsStore();
    const instance = Vue.getCurrentInstance();

    const tr = (key, fallback, params) => {
      const translated = instance?.proxy?.$t?.(key, params);
      if (translated && translated !== key) return translated;
      return fallback || key;
    };

    const rootEl = Vue.ref(null);
    const addMenuWrap = Vue.ref(null);
    const uploadInputRef = Vue.ref(null);
    const miniDialogInputRef = Vue.ref(null);

    const activeCreation = Vue.ref(null);
    const activeRootDir = Vue.ref('');
    const showingSwitcher = Vue.ref(false);
    const loadingCreations = Vue.ref(false);
    const bindingFolder = Vue.ref(false);
    const onboardingError = Vue.ref('');
    const createModalOpen = Vue.ref(false);

    const activeModality = Vue.ref('docs');
    const docTreeOpen = Vue.ref(true);
    const addMenuOpen = Vue.ref(false);
    const scanning = Vue.ref(false);
    const uploading = Vue.ref(false);
    const uploadTargetSubdir = Vue.ref('images');
    const feedback = Vue.ref(null);
    let feedbackTimer = null;

    const miniDialog = Vue.reactive({
      visible: false,
      mode: 'doc',
      name: '',
      submitting: false,
    });

    const docFiles = Vue.ref([]);
    const imageFiles = Vue.ref([]);
    const videoFiles = Vue.ref([]);
    const expandedDocFolders = Vue.reactive(new Set());

    const activeDocFile = Vue.ref(null);
    const docSaving = Vue.ref(false);
    const activeImageIndex = Vue.ref(-1);
    const activeVideoIndex = Vue.ref(-1);

    // Dynamic getter-backed route object so `workDir` always reflects `activeRootDir || props.workDir`
    const dynamicRoute = {
      get routeKey() { return props.routeKey; },
      get runtimeProvider() { return props.runtimeProvider; },
      get agentId() { return props.agentId; },
      get sessionId() { return props.sessionId; },
      get workItemId() { return props.workItemId; },
      get conversationId() { return props.conversationId; },
      get workDir() { return activeRootDir.value || props.workDir; },
      get workspaceGeneration() { return props.workspaceGeneration; },
      get workspaceLocked() { return false; },
    };
    const wbStore = createRouteBoundWorkbenchStore(liveStore, dynamicRoute);

    // Request correlation map (strictly scoped to CreationTab's own unique requestIds)
    const pendingRequests = new Map();
    let reqSeq = 0;
    let pendingFileOpFallback = null;
    let scanGeneration = 0;
    let disposed = false;
    let refreshTimer = null;
    let lastConsumedTargetSeq = 0;
    const svgBlobUrls = [];

    const nextReqId = (prefix) => (
      `creation-wb-${prefix}-${Date.now()}-${++reqSeq}-${Math.random().toString(36).slice(2, 7)}`
    );

    const showFeedback = (ok, message) => {
      if (feedbackTimer) clearTimeout(feedbackTimer);
      feedback.value = { ok, message };
      feedbackTimer = setTimeout(() => { feedback.value = null; }, 4500);
    };

    const sendCorrelatedRequest = (payload, { timeoutMs = 20000, expectFileOp = false } = {}) => {
      const requestId = nextReqId(payload.type || 'req');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          if (pendingFileOpFallback?.requestId === requestId) pendingFileOpFallback = null;
          reject(new Error(`Request ${payload.type} timed out`));
        }, timeoutMs);

        const entry = { requestId, resolve, reject, timer, expectFileOp };
        pendingRequests.set(requestId, entry);
        if (expectFileOp) pendingFileOpFallback = entry;

        const sent = wbStore.sendWsMessage({
          ...payload,
          requestId,
          conversationId: props.conversationId || '_explorer',
          agentId: props.agentId,
          workDir: activeRootDir.value || props.workDir,
          _clientId: liveStore.clientId,
        });

        if (sent === false) {
          clearTimeout(timer);
          pendingRequests.delete(requestId);
          if (pendingFileOpFallback?.requestId === requestId) pendingFileOpFallback = null;
          reject(new Error('WebSocket unavailable'));
        }
      });
    };

    const handleWorkbenchMessage = (event) => {
      const msg = event?.detail;
      if (!msg || disposed) return;

      if (msg.requestId && pendingRequests.has(msg.requestId)) {
        const pending = pendingRequests.get(msg.requestId);
        pendingRequests.delete(msg.requestId);
        if (pendingFileOpFallback?.requestId === msg.requestId) pendingFileOpFallback = null;
        clearTimeout(pending.timer);
        pending.resolve(msg);
        return;
      }

      // Fallback for older Agents that omit requestId on file_op_result
      if (msg.type === 'file_op_result' && !msg.requestId && pendingFileOpFallback) {
        if (!msg.agentId || msg.agentId === props.agentId) {
          const pending = pendingFileOpFallback;
          pendingFileOpFallback = null;
          pendingRequests.delete(pending.requestId);
          clearTimeout(pending.timer);
          pending.resolve(msg);
        }
      }
    };

    // ==================== Computed Views ====================
    const agentCreations = Vue.computed(() => (
      creationsStore.creationsForAgent(props.agentId) || []
    ));

    const showOnboarding = Vue.computed(() => (
      !activeRootDir.value || showingSwitcher.value
    ));

    const activeTitle = Vue.computed(() => {
      if (activeCreation.value?.title) return activeCreation.value.title;
      const norm = normalizePath(activeRootDir.value);
      return norm.split('/').filter(Boolean).pop() || tr('creation.workbench.onboardingTitle', 'Creation Workspace');
    });

    const docTree = Vue.computed(() => buildDocTree(docFiles.value, activeRootDir.value));
    const flattenedDocTree = Vue.computed(() => flattenDocTree(docTree.value, expandedDocFolders));

    const activeImageFile = Vue.computed(() => (
      activeImageIndex.value >= 0 && activeImageIndex.value < imageFiles.value.length
        ? imageFiles.value[activeImageIndex.value]
        : null
    ));

    const activeVideoFile = Vue.computed(() => (
      activeVideoIndex.value >= 0 && activeVideoIndex.value < videoFiles.value.length
        ? videoFiles.value[activeVideoIndex.value]
        : null
    ));

    const uploadAccept = Vue.computed(() => {
      if (uploadTargetSubdir.value === 'images') return 'image/*';
      if (uploadTargetSubdir.value === 'videos') return 'video/*';
      return 'image/*,video/*,.md,.txt';
    });

    // ==================== Recursive Folder Scanner ====================
    const buildPreviewUrl = (msg) => {
      const origin = `${location.protocol}//${location.host}`;
      if (msg.previewUrl) return new URL(msg.previewUrl, origin).href;
      if (msg.fileId && msg.previewToken) {
        return `${origin}/api/preview/${msg.fileId}?token=${msg.previewToken}`;
      }
      return '';
    };

    const loadImageThumbnail = async (item, expectedGen) => {
      if (!item || item.previewUrl || item.loadingThumb || disposed) return;
      item.loadingThumb = true;
      item.thumbError = null;
      try {
        const msg = await sendCorrelatedRequest({
          type: 'read_file',
          filePath: item.path,
        }, { timeoutMs: 20000 });
        if (disposed || expectedGen !== scanGeneration) return;
        if (msg.error) {
          item.thumbError = msg.error;
          item.previewError = msg.error;
          item.loadError = msg.error;
          return;
        }
        if (msg.binary) {
          const url = buildPreviewUrl(msg);
          item.previewUrl = url;
          item.blobUrl = url;
          item.previewLoading = false;
          item.loading = false;
        } else if (getExt(item.name) === '.svg' && typeof msg.content === 'string') {
          const blob = new Blob([msg.content], { type: 'image/svg+xml;charset=utf-8' });
          const blobUrl = URL.createObjectURL(blob);
          svgBlobUrls.push(blobUrl);
          item.content = msg.content;
          item.previewUrl = blobUrl;
          item.blobUrl = blobUrl;
          item.previewLoading = false;
          item.loading = false;
        }
      } catch (err) {
        if (!disposed && expectedGen === scanGeneration) {
          item.thumbError = err?.message || 'Failed to load thumbnail';
          item.previewError = item.thumbError;
        }
      } finally {
        item.loadingThumb = false;
      }
    };

    const pumpImageThumbnails = async (items, expectedGen) => {
      let cursor = 0;
      const worker = async () => {
        while (!disposed && expectedGen === scanGeneration && cursor < items.length) {
          const item = items[cursor++];
          if (!item.previewUrl) {
            await loadImageThumbnail(item, expectedGen);
          }
        }
      };
      const workers = Array.from({ length: Math.min(THUMB_CONCURRENCY, items.length) }, () => worker());
      await Promise.all(workers);
    };

    const openDocFile = async (entry) => {
      if (!entry?.path) return;
      const fileObj = Vue.reactive({
        path: entry.path,
        name: entry.name,
        relPath: entry.relPath || relativePath(entry.path, activeRootDir.value),
        fileType: 'text',
        content: '',
        originalContent: '',
        blobUrl: null,
        loading: true,
        loadError: null,
        previewLoading: false,
        previewError: null,
        isDirty: false,
      });
      activeDocFile.value = fileObj;

      try {
        const msg = await sendCorrelatedRequest({
          type: 'read_file',
          filePath: entry.path,
        });
        if (disposed || activeDocFile.value?.path !== entry.path) return;
        fileObj.loading = false;
        if (msg.error) {
          fileObj.loadError = msg.error;
          return;
        }
        const text = typeof msg.content === 'string' ? msg.content : '';
        fileObj.content = text;
        fileObj.originalContent = text;
        fileObj.isDirty = false;
      } catch (err) {
        if (activeDocFile.value?.path === entry.path) {
          fileObj.loading = false;
          fileObj.loadError = err?.message || tr('files.readSendFailed', 'Failed to read file');
        }
      }
    };

    const scanWorkspace = async ({ reloadActiveDoc = false, selectPath = '' } = {}) => {
      const rootDir = activeRootDir.value;
      if (!rootDir || disposed) return;

      const myGen = ++scanGeneration;
      scanning.value = true;

      const foundDocs = [];
      const foundImages = [];
      const foundVideos = [];
      const prevImageByPath = new Map(imageFiles.value.map(item => [item.path, item]));
      const prevVideoByPath = new Map(videoFiles.value.map(item => [item.path, item]));
      let totalEntries = 0;

      const queue = [{ dirPath: rootDir, depth: 0 }];

      try {
        while (queue.length > 0 && totalEntries < SCAN_MAX_ENTRIES && !disposed && myGen === scanGeneration) {
          const { dirPath, depth } = queue.shift();
          let msg;
          try {
            msg = await sendCorrelatedRequest({
              type: 'list_directory',
              dirPath,
            }, { timeoutMs: 15000 });
          } catch {
            continue;
          }
          if (disposed || myGen !== scanGeneration) return;
          if (msg.error || !Array.isArray(msg.entries)) continue;

          for (const entry of msg.entries) {
            if (!entry || !entry.name) continue;
            if (IGNORED_DIRS.has(entry.name)) continue;
            if (totalEntries >= SCAN_MAX_ENTRIES) break;
            totalEntries += 1;

            const fullPath = normalizePath(entry.path || joinPath(dirPath, entry.name));
            const rel = relativePath(fullPath, rootDir);

            if (entry.type === 'directory') {
              if (depth < SCAN_MAX_DEPTH) {
                queue.push({ dirPath: fullPath, depth: depth + 1 });
              }
              continue;
            }

            const ext = getExt(entry.name);
            if (DOC_EXTS.has(ext)) {
              foundDocs.push({ path: fullPath, name: entry.name, relPath: rel, size: entry.size || 0 });
            } else if (IMAGE_EXTS.has(ext)) {
              const prev = prevImageByPath.get(fullPath);
              foundImages.push(prev || Vue.reactive({
                path: fullPath,
                name: entry.name,
                relPath: rel,
                size: entry.size || 0,
                fileType: 'image',
                content: null,
                blobUrl: null,
                previewUrl: '',
                loading: false,
                loadError: null,
                previewLoading: false,
                previewError: null,
                loadingThumb: false,
                thumbError: null,
                isDirty: false,
              }));
            } else if (VIDEO_EXTS.has(ext)) {
              const prev = prevVideoByPath.get(fullPath);
              foundVideos.push(prev || Vue.reactive({
                path: fullPath,
                name: entry.name,
                relPath: rel,
                size: entry.size || 0,
                fileType: 'video',
                content: null,
                blobUrl: null,
                loading: false,
                loadError: null,
                previewLoading: false,
                previewError: null,
                isDirty: false,
              }));
            }
          }
        }

        if (disposed || myGen !== scanGeneration) return;

        foundDocs.sort((a, b) => a.relPath.localeCompare(b.relPath));
        foundImages.sort((a, b) => a.relPath.localeCompare(b.relPath));
        foundVideos.sort((a, b) => a.relPath.localeCompare(b.relPath));

        docFiles.value = foundDocs;
        imageFiles.value = foundImages;
        videoFiles.value = foundVideos;

        // Auto-expand top-level folders in Documents tree
        for (const node of docTree.value) {
          if (node.type === 'folder') expandedDocFolders.add(node.relPath);
        }

        // Document selection / reload
        const targetSelect = selectPath
          ? foundDocs.find(d => normalizePath(d.path) === normalizePath(selectPath))
          : null;

        if (targetSelect) {
          await openDocFile(targetSelect);
        } else if (activeDocFile.value) {
          const stillExists = foundDocs.find(d => d.path === activeDocFile.value.path);
          if (!stillExists) {
            activeDocFile.value = null;
          } else if (reloadActiveDoc && !activeDocFile.value.isDirty) {
            await openDocFile(stillExists);
          }
        }

        if (!activeDocFile.value && foundDocs.length > 0) {
          const readme = foundDocs.find(d => d.name.toLowerCase() === 'readme.md');
          const firstMd = foundDocs.find(d => getExt(d.name) === '.md');
          await openDocFile(readme || firstMd || foundDocs[0]);
        }

        // Clamp media detail indices
        if (activeImageIndex.value >= foundImages.length) activeImageIndex.value = -1;
        if (activeVideoIndex.value >= foundVideos.length) activeVideoIndex.value = -1;

        // Kick off lazy thumbnail loading when images exist
        if (activeModality.value === 'images' && foundImages.length > 0) {
          void pumpImageThumbnails(foundImages, myGen);
        }
      } finally {
        if (myGen === scanGeneration) scanning.value = false;
      }
    };

    // ==================== Document Actions ====================
    const onDocTreeClick = (node) => {
      if (node.type === 'folder') {
        if (expandedDocFolders.has(node.relPath)) expandedDocFolders.delete(node.relPath);
        else expandedDocFolders.add(node.relPath);
        return;
      }
      if (activeDocFile.value?.path === node.path) return;
      void openDocFile(node);
    };

    const onDocContentUpdate = (newContent) => {
      if (!activeDocFile.value) return;
      activeDocFile.value.content = newContent;
      activeDocFile.value.isDirty = newContent !== activeDocFile.value.originalContent;
    };

    const saveActiveDoc = async () => {
      const file = activeDocFile.value;
      if (!file || !file.isDirty || docSaving.value) return;
      docSaving.value = true;
      const contentToSave = file.content;
      try {
        const msg = await sendCorrelatedRequest({
          type: 'write_file',
          filePath: file.path,
          content: contentToSave,
        });
        if (msg.error) {
          showFeedback(false, msg.error);
          return;
        }
        file.originalContent = contentToSave;
        file.isDirty = file.content !== file.originalContent;
        showFeedback(true, tr('creation.workbench.saved', 'Saved'));
      } catch (err) {
        showFeedback(false, err?.message || tr('creation.workbench.saveFailed', 'Failed to save'));
      } finally {
        docSaving.value = false;
      }
    };

    // ==================== Media Selection & Video Metadata ====================
    const selectImageAt = async (index) => {
      if (index < 0 || index >= imageFiles.value.length) return;
      activeImageIndex.value = index;
      const item = imageFiles.value[index];
      if (!item.blobUrl && !item.previewUrl) {
        item.loading = true;
        item.previewLoading = true;
        await loadImageThumbnail(item, scanGeneration);
        item.loading = false;
        item.previewLoading = false;
      }
    };

    const selectVideoAt = async (index) => {
      if (index < 0 || index >= videoFiles.value.length) return;
      activeVideoIndex.value = index;
      const item = videoFiles.value[index];
      if (item.blobUrl) return;
      item.loading = true;
      item.loadError = null;
      item.previewLoading = true;
      item.previewError = null;
      try {
        const msg = await sendCorrelatedRequest({
          type: 'video_metadata',
          filePath: item.path,
        }, { timeoutMs: 20000 });
        item.loading = false;
        if (msg.error || !msg.videoStream || !msg.previewUrl) {
          const errText = msg.error || tr('files.videoStreamUnavailable', 'Video stream unavailable');
          item.loadError = errText;
          item.previewError = errText;
          item.previewLoading = false;
          return;
        }
        item.blobUrl = buildPreviewUrl(msg);
        item.previewLoading = false;
      } catch (err) {
        item.loading = false;
        item.previewLoading = false;
        item.loadError = err?.message || tr('files.videoStreamUnavailable', 'Video stream unavailable');
        item.previewError = item.loadError;
      }
    };

    // ==================== Create Doc / Folder & Upload Media ====================
    const openMiniDialog = (mode) => {
      addMenuOpen.value = false;
      miniDialog.mode = mode;
      miniDialog.name = '';
      miniDialog.visible = true;
      Vue.nextTick(() => miniDialogInputRef.value?.focus());
    };

    const confirmMiniDialog = async () => {
      const name = miniDialog.name.trim();
      if (!name || !activeRootDir.value || miniDialog.submitting) return;
      miniDialog.submitting = true;
      const filePath = joinPath(activeRootDir.value, name);
      const isDirectory = miniDialog.mode === 'folder';
      try {
        const msg = await sendCorrelatedRequest({
          type: 'create_file',
          filePath,
          isDirectory,
        }, { expectFileOp: true });
        if (msg.success === false || msg.error) {
          showFeedback(false, msg.error || tr('creation.workbench.createFailed', 'Create failed'));
          return;
        }
        miniDialog.visible = false;
        miniDialog.name = '';
        if (!isDirectory) activeModality.value = 'docs';
        await scanWorkspace({ selectPath: isDirectory ? '' : filePath });
      } catch (err) {
        showFeedback(false, err?.message || tr('creation.workbench.createFailed', 'Create failed'));
      } finally {
        miniDialog.submitting = false;
      }
    };

    const triggerMediaUpload = (target) => {
      addMenuOpen.value = false;
      if (target === 'images' || target === 'videos') {
        uploadTargetSubdir.value = target;
      } else {
        uploadTargetSubdir.value = activeModality.value === 'videos' ? 'videos' : 'images';
      }
      Vue.nextTick(() => uploadInputRef.value?.click());
    };

    const onUploadInputChange = async (event) => {
      const selected = Array.from(event.target?.files || []);
      if (event.target) event.target.value = '';
      if (!selected.length || !activeRootDir.value) return;

      uploading.value = true;
      try {
        const filesPayload = await Promise.all(selected.map(file => new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const bytes = new Uint8Array(reader.result);
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
            }
            resolve({ name: file.name, data: btoa(binary) });
          };
          reader.onerror = () => resolve(null);
          reader.readAsArrayBuffer(file);
        })));
        const validFiles = filesPayload.filter(Boolean);
        if (!validFiles.length) return;

        const targetDir = joinPath(activeRootDir.value, uploadTargetSubdir.value);
        // Ensure target subdir exists (ignore error if already exists)
        try {
          await sendCorrelatedRequest({
            type: 'create_file',
            filePath: targetDir,
            isDirectory: true,
          }, { expectFileOp: true, timeoutMs: 10000 });
        } catch {}

        const msg = await sendCorrelatedRequest({
          type: 'upload_to_dir',
          files: validFiles,
          dirPath: targetDir,
        }, { expectFileOp: true, timeoutMs: 30000 });

        if (msg.success === false || msg.error) {
          showFeedback(false, msg.error || tr('creation.workbench.uploadFailed', 'Upload failed'));
          return;
        }
        showFeedback(true, tr('creation.workbench.uploaded', 'Uploaded'));
        await scanWorkspace();
      } catch (err) {
        showFeedback(false, err?.message || tr('creation.workbench.uploadFailed', 'Upload failed'));
      } finally {
        uploading.value = false;
      }
    };

    // ==================== Cross-Capability Actions ====================
    const openWorkspaceInFiles = (dirOverride = '') => {
      const targetDir = dirOverride || activeRootDir.value;
      window.dispatchEvent(new CustomEvent('workbench-open-capability', {
        detail: {
          routeKey: props.routeKey,
          capabilityId: 'files',
        },
      }));
      if (targetDir) {
        Vue.nextTick(() => {
          window.dispatchEvent(new CustomEvent('workbench-files-open-dir', {
            detail: {
              routeKey: props.routeKey,
              agentId: props.agentId,
              dirPath: targetDir,
            },
          }));
        });
      }
    };

    const openFileInFiles = (file) => {
      if (!file?.path) return openWorkspaceInFiles();
      window.dispatchEvent(new CustomEvent('open-file-in-explorer', {
        detail: {
          filePath: file.path,
          agentId: props.agentId,
          conversationId: props.conversationId,
          workDir: activeRootDir.value || props.workDir,
          workbenchRouteKey: props.routeKey,
          workspaceGeneration: props.workspaceGeneration,
        },
      }));
    };

    const downloadFile = (file) => {
      if (!file) return;
      const name = file.name || 'download';
      if (file.blobUrl) {
        const a = document.createElement('a');
        try {
          const url = new URL(file.blobUrl, `${location.protocol}//${location.host}`);
          if (!file.blobUrl.startsWith('blob:')) url.searchParams.set('download', '1');
          a.href = url.href;
        } catch {
          a.href = file.blobUrl;
        }
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
      }
      if (typeof file.content === 'string') {
        const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    };

    // ==================== Creation Activation & Onboarding ====================
    const activateCreation = async (creation, rootDirOverride = '') => {
      onboardingError.value = '';
      let resolvedCreation = creation || null;
      let rootDir = rootDirOverride || resolvedCreation?.rootDir || '';

      if (resolvedCreation?.id && !rootDir && typeof creationsStore.ensureWorkspace === 'function') {
        try {
          const ensured = await creationsStore.ensureWorkspace(props.agentId, resolvedCreation.id, { rootDir });
          rootDir = ensured?.rootDir || ensured?.creation?.rootDir || rootDir;
          if (ensured?.creation) resolvedCreation = ensured.creation;
        } catch (err) {
          onboardingError.value = err?.message || tr('creation.workbench.workspaceFailed', 'Failed to prepare workspace');
          return;
        }
      }

      if (!rootDir) {
        onboardingError.value = tr('creation.workbench.missingRootDir', 'This Creation does not have a workspace folder yet.');
        return;
      }

      const changed = normalizePath(activeRootDir.value) !== normalizePath(rootDir);
      activeCreation.value = resolvedCreation;
      activeRootDir.value = normalizePath(rootDir);
      showingSwitcher.value = false;

      if (changed) {
        activeDocFile.value = null;
        activeImageIndex.value = -1;
        activeVideoIndex.value = -1;
        docFiles.value = [];
        imageFiles.value = [];
        videoFiles.value = [];
        expandedDocFolders.clear();
      }

      await scanWorkspace();
    };

    const resolveCreationTarget = async ({ creationId = '', rootDir = '' } = {}) => {
      const list = creationsStore.creationsForAgent(props.agentId) || [];
      let found = null;
      if (creationId) found = list.find(c => c && c.id === creationId) || null;
      if (!found && rootDir && typeof creationsStore.findByFolder === 'function') {
        found = creationsStore.findByFolder(props.agentId, rootDir) || null;
      }
      if (!found && rootDir) {
        found = list.find(c => c && c.rootDir && normalizePath(c.rootDir) === normalizePath(rootDir)) || null;
      }
      await activateCreation(found, rootDir || found?.rootDir || '');
    };

    const autoResolveFromRoute = async () => {
      if (activeRootDir.value || showingSwitcher.value) return;
      const list = creationsStore.creationsForAgent(props.agentId) || [];
      let match = null;
      if (props.sessionId) {
        match = list.find(c => c && c.sessionId === props.sessionId) || null;
      }
      if (!match && props.workDir) {
        if (typeof creationsStore.findByFolder === 'function') {
          match = creationsStore.findByFolder(props.agentId, props.workDir) || null;
        }
        if (!match) {
          const normWork = normalizePath(props.workDir);
          match = list.find(c => c && c.rootDir && normalizePath(c.rootDir) === normWork) || null;
        }
      }
      if (match) {
        await activateCreation(match, match.rootDir || '');
      }
    };

    const ensureCreationsLoaded = async () => {
      if (!props.agentId) return;
      const bucket = creationsStore.byAgent?.[props.agentId];
      if (!bucket?.loaded && typeof creationsStore.loadCreations === 'function') {
        loadingCreations.value = true;
        try {
          await creationsStore.loadCreations(props.agentId);
        } catch {} finally {
          loadingCreations.value = false;
        }
      }
      await autoResolveFromRoute();
    };

    const openCreateModal = () => {
      onboardingError.value = '';
      createModalOpen.value = true;
    };

    const onCreationCreated = async (payload) => {
      if (!payload) return;
      if (payload.agentId && payload.agentId !== props.agentId) return;
      await activateCreation(payload.creation || null, payload.rootDir || payload.creation?.rootDir || '');
    };

    const bindCurrentFolder = async () => {
      if (!props.workDir || bindingFolder.value) return;
      bindingFolder.value = true;
      onboardingError.value = '';
      try {
        const res = await creationsStore.bindFolderAsCreation({
          agentId: props.agentId,
          rootDir: props.workDir,
          sessionId: props.sessionId,
        });
        const creation = res?.creation || res || null;
        await activateCreation(creation, res?.rootDir || creation?.rootDir || props.workDir);
      } catch (err) {
        onboardingError.value = err?.message || tr('creation.workbench.bindFailed', 'Failed to open folder as Creation');
      } finally {
        bindingFolder.value = false;
      }
    };

    const selectExistingCreation = async (item) => {
      if (!item) return;
      await activateCreation(item, item.rootDir || '');
    };

    // ==================== Event Listeners & Watchers ====================
    const handleCreationTargetEvent = (event) => {
      const detail = event?.detail;
      if (!detail) return;
      if (detail.routeKey && detail.routeKey !== props.routeKey) return;
      if (detail.agentId && detail.agentId !== props.agentId) return;
      void resolveCreationTarget({
        creationId: detail.creationId || '',
        rootDir: detail.rootDir || '',
      });
    };

    const handleDocumentClick = (event) => {
      if (addMenuOpen.value && !addMenuWrap.value?.contains(event.target)) {
        addMenuOpen.value = false;
      }
    };

    const onRootKeydown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        if (activeModality.value === 'docs' && activeDocFile.value?.isDirty) {
          event.preventDefault();
          void saveActiveDoc();
        }
      }
    };

    // Watch injected target from WorkbenchPanel (covers first-mount race before window listener attaches)
    const injectedCreationTarget = Vue.inject('workbench-creation-target', null);
    let lastInjectedTargetSeq = 0;
    if (injectedCreationTarget) {
      Vue.watch(
        () => injectedCreationTarget.seq,
        (seq) => {
          if (!seq || seq === lastInjectedTargetSeq) return;
          if (injectedCreationTarget.routeKey && injectedCreationTarget.routeKey !== props.routeKey) return;
          if (injectedCreationTarget.agentId && injectedCreationTarget.agentId !== props.agentId) return;
          lastInjectedTargetSeq = seq;
          void resolveCreationTarget({
            creationId: injectedCreationTarget.creationId || '',
            rootDir: injectedCreationTarget.rootDir || '',
          });
        },
        { immediate: true },
      );
    }

    // Watch pendingWorkbenchTarget only when CreationTab is mounted standalone
    // (without a parent WorkbenchPanel). When inside WorkbenchPanel, the panel
    // owns consuming pendingWorkbenchTarget (so maximize/expand is always applied)
    // and forwards the target via `providedCreationTarget` + `workbench-creation-target`.
    if (!injectedCreationTarget) {
      Vue.watch(
        () => creationsStore.pendingWorkbenchTarget,
        (target) => {
          if (!target) return;
          if (target.seq && target.seq === lastConsumedTargetSeq) return;
          if (target.agentId && target.agentId !== props.agentId) return;
          if (target.sessionId && target.sessionId !== props.sessionId) return;
          lastConsumedTargetSeq = target.seq || Date.now();
          void resolveCreationTarget({
            creationId: target.creationId || '',
            rootDir: target.rootDir || '',
          });
          creationsStore.clearPendingWorkbenchTarget?.(target.seq);
        },
        { immediate: true },
      );
    }

    // Watch active modality to lazily pump thumbnails when switching to Images
    Vue.watch(activeModality, (mod) => {
      if (mod === 'images' && imageFiles.value.length > 0) {
        void pumpImageThumbnails(imageFiles.value, scanGeneration);
      }
    });

    // Auto-refresh when Agent finishes processing a turn in this Session
    const sessionProcessing = Vue.computed(() => (
      typeof liveStore.isYeaftSessionProcessing === 'function'
        ? Boolean(liveStore.isYeaftSessionProcessing(props.sessionId, props.agentId))
        : false
    ));

    Vue.watch(sessionProcessing, (nowProcessing, wasProcessing) => {
      if (wasProcessing && !nowProcessing && activeRootDir.value) {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          void scanWorkspace({ reloadActiveDoc: true });
        }, 450);
      }
    });

    Vue.watch(() => props.agentId, () => {
      void ensureCreationsLoaded();
    });

    Vue.onMounted(() => {
      window.addEventListener('workbench-message', handleWorkbenchMessage);
      window.addEventListener('workbench-creation-target', handleCreationTargetEvent);
      document.addEventListener('click', handleDocumentClick);
      void ensureCreationsLoaded();
    });

    Vue.onUnmounted(() => {
      disposed = true;
      window.removeEventListener('workbench-message', handleWorkbenchMessage);
      window.removeEventListener('workbench-creation-target', handleCreationTargetEvent);
      document.removeEventListener('click', handleDocumentClick);
      if (feedbackTimer) clearTimeout(feedbackTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const entry of pendingRequests.values()) {
        clearTimeout(entry.timer);
      }
      pendingRequests.clear();
      pendingFileOpFallback = null;
      for (const url of svgBlobUrls) {
        try { URL.revokeObjectURL(url); } catch {}
      }
      svgBlobUrls.length = 0;
    });

    return {
      rootEl,
      addMenuWrap,
      uploadInputRef,
      miniDialogInputRef,
      activeCreation,
      activeRootDir,
      showingSwitcher,
      showOnboarding,
      loadingCreations,
      bindingFolder,
      onboardingError,
      createModalOpen,
      agentCreations,
      activeTitle,
      activeModality,
      docTreeOpen,
      addMenuOpen,
      scanning,
      uploading,
      uploadAccept,
      feedback,
      miniDialog,
      docFiles,
      imageFiles,
      videoFiles,
      expandedDocFolders,
      flattenedDocTree,
      activeDocFile,
      docSaving,
      activeImageIndex,
      activeImageFile,
      activeVideoIndex,
      activeVideoFile,
      tr,
      shortenPath,
      kindSwatchClass,
      formatSize,
      openCreateModal,
      onCreationCreated,
      bindCurrentFolder,
      selectExistingCreation,
      scanWorkspace,
      onDocTreeClick,
      onDocContentUpdate,
      saveActiveDoc,
      selectImageAt,
      selectVideoAt,
      openMiniDialog,
      confirmMiniDialog,
      triggerMediaUpload,
      onUploadInputChange,
      openWorkspaceInFiles,
      openFileInFiles,
      downloadFile,
      onRootKeydown,
    };
  },
};
