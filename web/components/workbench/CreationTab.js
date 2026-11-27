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
import { useCreationsStore, sendInitialCreationPrompt } from '../../stores/creations.js';
import { isSafeSameOriginPreviewUrl } from '../cosmos/creations/sanitize.js';
import { createRouteBoundWorkbenchStore, workbenchRouteKey } from '../../utils/workbench-route.js';
import FileCanvasView, { binaryDraftWarning } from './FileCanvasView.js';
import { getLocale } from '../../utils/i18n.js';
import CreationCreateModal from './CreationCreateModal.js';
import NavigationIcon from '../NavigationIcon.js';
import SvgPreview from '../files/SvgPreview.js';

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

/**
 * Validate that a media preview/download URL is safe:
 * - Same-origin `/api/preview/...` or `/api/yeaft/creations/...`, OR
 * - A locally created non-SVG `blob:` URL tracked in `allowedBlobUrls`.
 * Rejects external origins, protocol-relative URLs, `data:`, `javascript:`, etc.
 * @param {string} url
 * @param {Set<string>|null} [allowedBlobUrls]
 * @returns {boolean}
 */
export function isSafeMediaUrl(url, allowedBlobUrls = null) {
  if (!isSafeSameOriginPreviewUrl(url)) return false;
  const trimmed = url.trim();
  return !/^blob:/i.test(trimmed) || Boolean(allowedBlobUrls?.has(trimmed));
}

/**
 * Validate a relative file or folder name before creating/uploading inside a Creation workspace.
 * Rejects empty strings, leading slashes, Windows drive prefixes, `..` or `.` segments,
 * NUL bytes, and ASCII control characters.
 * @param {string} name
 * @returns {boolean}
 */
export function isSafeRelativeChildName(name) {
  if (typeof name !== 'string') return false;
  const raw = name.trim();
  if (!raw) return false;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return false;
  if (/^[/\\]/.test(raw) || /^[a-zA-Z]:/.test(raw)) return false;
  const segments = raw.replace(/\\/g, '/').split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return false;
  }
  return true;
}

/**
 * Verify that `candidatePath` stays strictly inside `rootDir` (no traversal or root escape).
 * @param {string} candidatePath
 * @param {string} rootDir
 * @returns {boolean}
 */
export function isPathInsideRoot(candidatePath, rootDir) {
  if (typeof candidatePath !== 'string' || typeof rootDir !== 'string') return false;
  if (/[\u0000-\u001f\u007f]/.test(candidatePath)) return false;
  const normRoot = normalizePath(rootDir);
  const normCandidate = normalizePath(candidatePath);
  if (!normRoot || !normCandidate || normCandidate === normRoot) return false;
  const segments = normCandidate.split('/');
  if (segments.includes('..') || segments.includes('.')) return false;
  const prefix = normRoot === '/' ? '/' : `${normRoot}/`;
  return normCandidate.startsWith(prefix);
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
  components: { FileCanvasView, CreationCreateModal, NavigationIcon, SvgPreview },
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
    <div class="creation-wb creation-wb-root" ref="rootEl" @keydown="onRootKeydown">
      <div v-if="onboardingError" class="creation-wb-banner creation-wb-target-error is-error" role="alert">
        <span>{{ onboardingError }}</span>
        <button type="button" class="creation-wb-banner-close" :aria-label="tr('common.close', 'Close')" @click="onboardingError = ''">×</button>
      </div>
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
              @click="refreshWorkspace"
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
              @click="showCreationSwitcher"
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
        <div v-show="activeModality === 'docs'" class="creation-wb-docs-pane" :class="{ 'is-tree-open': docTreeOpen }" role="tabpanel">
          <!-- Narrow-container collapsible top bar -->
          <div class="creation-wb-docs-bar">
            <button
              type="button"
              class="creation-wb-text-btn creation-wb-docs-bar-toggle"
              :aria-expanded="docTreeOpen"
              :title="docTreeOpen ? tr('files.hideTree', 'Hide tree') : tr('files.showTree', 'Show tree')"
              @click="docTreeOpen = !docTreeOpen"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2zm10 14H4V8h16v10z" />
              </svg>
              <span>{{ tr('creation.workbench.docs', 'Documents') }}</span>
            </button>
            <span v-if="activeDocFile" class="creation-wb-docs-bar-name" :title="activeDocFile.relPath">
              {{ activeDocFile.name }}<span v-if="activeDocFile.isDirty" class="creation-wb-dirty-dot" aria-hidden="true"> ●</span>
            </span>
            <button
              type="button"
              class="creation-wb-tree-btn"
              :title="tr('creation.workbench.newDoc', 'New Document')"
              @click="openMiniDialog('doc')"
            >+ {{ tr('creation.workbench.docShort', 'Doc') }}</button>
          </div>

          <!-- Collapsed tree rail (wide container) -->
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
                  'is-active': node.type === 'file' && activeDocPath === node.path,
                  'is-dirty': node.type === 'file' && isDocDirty(node.path),
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
                  v-if="node.type === 'file' && isDocDirty(node.path)"
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
              :saving="Boolean(activeDocFile.saving)"
              :show-header="true"
              :show-open-in-files="true"
              :show-promote-folder="false"
              :resolve-media-url="resolveCreationRelativeMediaUrl"
              :media-url-version="mediaPreviewVersion"
              @update:content="onDocContentUpdate"
              @save="saveDoc()"
              @reload-from-disk="reloadActiveDocFromDisk"
              @overwrite-disk="overwriteActiveDocOnDisk"
              @download="downloadFile(activeDocFile)"
              @open-in-files="openFileInFiles(activeDocFile)"
              @open-relative-link="onCanvasRelativeLink"
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
              <button type="button" class="creation-wb-text-btn" @click="selectedImagePath = ''">
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
                @media-load="onMediaLoad"
                @media-error="onMediaError"
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
                  <div v-if="img.isSvg && img.svgText !== null" class="creation-wb-thumb-svg">
                    <SvgPreview :content="img.svgText" :name="img.name" :interactive="false" />
                  </div>
                  <img
                    v-else-if="img.previewUrl"
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
              <button type="button" class="creation-wb-text-btn" @click="selectedVideoPath = ''">
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
                @media-load="onMediaLoad"
                @media-error="onMediaError"
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
    const chatStore = useChatStore();
    const liveStore = Vue.inject('workbench-store', null) || chatStore;
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
    const isNarrowContainer = Vue.ref(false);
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
    const probedPathsThisVisit = new Set();
    let visitEpoch = 0;
    const resetDocProbes = () => {
      visitEpoch += 1;
      probedPathsThisVisit.clear();
    };

    // Only older hosts without a store draft API need component-owned buffers.
    const fallbackDrafts = Vue.reactive(new Map());
    const hasStoreDrafts = typeof creationsStore.getOrCreateDocDraft === 'function'
      || typeof creationsStore.getDocDraft === 'function';
    const activeDocPath = Vue.ref('');
    const selectedImagePath = Vue.ref('');
    const selectedVideoPath = Vue.ref('');
    const mediaPreviewVersion = Vue.ref(0);

    const makeDraftKey = (rootDir, docPath) => (
      `${normalizePath(rootDir)}::${normalizePath(docPath)}`
    );
    const fallbackKey = (agentId, rootDir, docPath) => JSON.stringify([agentId, makeDraftKey(rootDir, docPath)]);

    const getDraft = (rootDir, docPath, agentId = props.agentId) => {
      if (typeof creationsStore.getDocDraft === 'function') {
        return creationsStore.getDocDraft(agentId, rootDir, docPath);
      }
      if (hasStoreDrafts) return creationsStore.getOrCreateDocDraft?.(agentId, rootDir, docPath);
      return fallbackDrafts.get(fallbackKey(agentId, rootDir, docPath));
    };

    const getOrCreateDraft = (agentId, rootDir, docPath, initial) => {
      if (typeof creationsStore.getOrCreateDocDraft === 'function') {
        return creationsStore.getOrCreateDocDraft?.(agentId, rootDir, docPath, initial);
      }
      const existing = getDraft(rootDir, docPath, agentId);
      if (existing) return existing;
      if (hasStoreDrafts) {
        // Legacy stores can publish the initial buffer once; never mirror edits.
        creationsStore.setDocDraft?.(agentId, rootDir, docPath, initial);
      } else {
        fallbackDrafts.set(fallbackKey(agentId, rootDir, docPath), initial);
      }
      return getDraft(rootDir, docPath, agentId);
    };

    const dirtyDrafts = (rootDir = null) => {
      const agentId = props.agentId;
      if (!hasStoreDrafts) {
        return Array.from(fallbackDrafts.values()).filter(draft => draft.agentId === agentId
          && draft.isDirty && (!rootDir || draft.rootDir === normalizePath(rootDir)));
      }
      return (creationsStore.listDirtyDocDrafts?.(agentId, rootDir) || []).map(item => {
        const draft = item.draft || item;
        return { path: item.filePath || draft.path, name: draft.name, relPath: draft.relPath };
      });
    };

    const isDocDirty = (docPath, rootDir = activeRootDir.value) => (
      Boolean(rootDir && docPath && getDraft(rootDir, docPath)?.isDirty)
    );

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
    let scanGeneration = 0;
    let activationEpoch = 0;
    let workspaceEpoch = 0;
    let modalContext = null;
    let uploadPickerContext = null;
    let disposed = false;
    let isDeactivated = false;
    let registeredRouteKey = '';
    let pendingActivation = null;
    let refreshTimer = null;
    let lastHandledTargetSeq = 0;
    let lastConsumedTargetSeq = 0;
    let containerResizeObserver = null;
    const localBlobUrls = new Set();

    const currentAgentId = Vue.computed(() => props.agentId);
    const unregisterTabRoute = () => {
      if (!registeredRouteKey) return;
      creationsStore.unregisterCreationTabRoute?.(registeredRouteKey);
      registeredRouteKey = '';
    };
    const registerTabRoute = () => {
      unregisterTabRoute();
      if (disposed || !props.routeKey) return;
      registeredRouteKey = props.routeKey;
      creationsStore.registerCreationTabRoute?.(registeredRouteKey, {
        agentId: currentAgentId.value,
        sessionId: props.sessionId,
        workspaceGeneration: props.workspaceGeneration,
      });
    };

    const captureRoute = () => ({
      agentId: props.agentId,
      sessionId: props.sessionId,
      routeKey: props.routeKey,
      gen: props.workspaceGeneration,
      liveRouteKey: workbenchRouteKey(liveStore.activeSessionRoute),
    });

    const isRouteCurrent = ctx => !disposed
      && ctx.agentId === props.agentId && ctx.sessionId === props.sessionId
      && ctx.routeKey === props.routeKey && ctx.gen === props.workspaceGeneration
      && ctx.liveRouteKey === workbenchRouteKey(liveStore.activeSessionRoute);

    const captureOp = (dirPath = activeRootDir.value) => Object.freeze({
      ...captureRoute(),
      epoch: workspaceEpoch,
      creationId: activeCreation.value?.id || '',
      rootDir: activeRootDir.value,
      dirPath,
    });

    const isOpCurrent = ctx => isRouteCurrent(ctx)
      && ctx.epoch === workspaceEpoch && ctx.rootDir === activeRootDir.value
      && ctx.creationId === (activeCreation.value?.id || '');

    const revokeLocalBlobUrl = (url) => {
      if (typeof url === 'string' && localBlobUrls.has(url)) {
        localBlobUrls.delete(url);
        try { URL.revokeObjectURL(url); } catch {}
      }
    };

    const revokeAllLocalBlobUrls = () => {
      for (const url of localBlobUrls) {
        try { URL.revokeObjectURL(url); } catch {}
      }
      localBlobUrls.clear();
    };

    const nextReqId = (prefix) => (
      `creation-wb-${prefix}-${Date.now()}-${++reqSeq}-${Math.random().toString(36).slice(2, 7)}`
    );

    const showFeedback = (ok, message) => {
      if (feedbackTimer) clearTimeout(feedbackTimer);
      feedback.value = { ok, message };
      feedbackTimer = setTimeout(() => { feedback.value = null; }, 4500);
    };

    const sendCorrelatedRequest = (payload, { timeoutMs = 20000, opCtx = captureOp() } = {}) => {
      if (!isOpCurrent(opCtx) || !opCtx.creationId) return Promise.reject(new Error('Creation workspace is no longer current'));
      const requestId = nextReqId(payload.type || 'req');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error(`Request ${payload.type} timed out`));
        }, timeoutMs);

        const entry = { requestId, resolve, reject, timer };
        pendingRequests.set(requestId, entry);

        const sent = wbStore.sendWsMessage({
          ...payload,
          creationId: opCtx.creationId,
          requestId,
          conversationId: props.conversationId || '_explorer',
          agentId: opCtx.agentId,
          workDir: opCtx.rootDir,
          _clientId: liveStore.clientId,
        });

        if (sent === false) {
          clearTimeout(timer);
          pendingRequests.delete(requestId);
          reject(new Error('WebSocket unavailable'));
        }
      });
    };

    const handleWorkbenchMessage = (event) => {
      const msg = event?.detail;
      if (!msg || disposed) return;
      if (!msg.requestId || !pendingRequests.has(msg.requestId)) return;

      const pending = pendingRequests.get(msg.requestId);
      pendingRequests.delete(msg.requestId);
      clearTimeout(pending.timer);
      pending.resolve(msg);
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

    const activeDocDraft = Vue.computed(() => {
      if (!activeRootDir.value || !activeDocPath.value) return null;
      return getDraft(activeRootDir.value, activeDocPath.value) || null;
    });
    // Expose the workspace's loaded documents as a view, not a second buffer cache.
    const docDrafts = Vue.computed(() => {
      const rootDir = activeRootDir.value;
      const drafts = new Map();
      if (rootDir) {
        for (const file of docFiles.value) {
          const draft = getDraft(rootDir, file.path);
          if (draft) drafts.set(makeDraftKey(rootDir, file.path), draft);
        }
      }
      return drafts;
    });
    const activeDocFile = activeDocDraft;

    const activeImageIndex = Vue.computed(() => (
      selectedImagePath.value
        ? imageFiles.value.findIndex(item => item.path === selectedImagePath.value)
        : -1
    ));

    const activeImageFile = Vue.computed(() => {
      const idx = activeImageIndex.value;
      if (idx < 0 || idx >= imageFiles.value.length) return null;
      const item = imageFiles.value[idx];
      if (!item) return null;
      if (item.isSvg) {
        return {
          ...item,
          fileType: 'text',
          content: item.svgText ?? item.content ?? '',
          blobUrl: '',
        };
      }
      return item;
    });

    const activeVideoIndex = Vue.computed(() => (
      selectedVideoPath.value
        ? videoFiles.value.findIndex(item => item.path === selectedVideoPath.value)
        : -1
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
      let candidate = '';
      if (msg.previewUrl) {
        if (!isSafeMediaUrl(msg.previewUrl, localBlobUrls)) return '';
        try {
          candidate = new URL(msg.previewUrl, origin).href;
        } catch {
          return '';
        }
      } else if (msg.fileId && msg.previewToken) {
        candidate = `${origin}/api/preview/${encodeURIComponent(String(msg.fileId))}?token=${encodeURIComponent(String(msg.previewToken))}`;
      }
      return isSafeMediaUrl(candidate, localBlobUrls) ? candidate : '';
    };

    const loadImageThumbnail = async (item, expectedGen = scanGeneration) => {
      const opCtx = captureOp();
      if (!item || item.loadingThumb || !isOpCurrent(opCtx)) return;
      if (item.isSvg ? item.svgText !== null : Boolean(item.previewUrl)) return;
      item.loadingThumb = true;
      item.thumbError = null;
      try {
        const msg = await sendCorrelatedRequest({
          type: 'read_file',
          filePath: item.path,
        }, { timeoutMs: 20000, opCtx });
        if (!isOpCurrent(opCtx) || expectedGen !== scanGeneration) return;
        if (msg.error) {
          item.thumbError = msg.error;
          item.previewError = msg.error;
          item.loadError = msg.error;
          item.previewLoading = false;
          item.loading = false;
          return;
        }
        if (item.isSvg) {
          if (typeof msg.content === 'string') {
            item.fileType = 'text';
            item.content = msg.content;
            item.svgText = msg.content;
            item.previewUrl = '';
            item.blobUrl = '';
            item.previewLoading = false;
            item.loading = false;
          } else {
            const errText = tr('creation.workbench.previewUnavailable', 'Preview unavailable');
            item.thumbError = errText;
            item.previewError = errText;
            item.previewLoading = false;
            item.loading = false;
          }
          return;
        }
        if (msg.binary) {
          const url = buildPreviewUrl(msg);
          if (!url) {
            const errText = tr('creation.workbench.previewUnavailable', 'Preview unavailable');
            item.thumbError = errText;
            item.previewError = errText;
            item.previewLoading = false;
            item.loading = false;
            return;
          }
          revokeLocalBlobUrl(item.blobUrl);
          item.previewUrl = url;
          item.blobUrl = url;
          item.previewLoading = false;
          item.loading = false;
        }
      } catch (err) {
        if (isOpCurrent(opCtx) && expectedGen === scanGeneration) {
          item.thumbError = err?.message || 'Failed to load thumbnail';
          item.previewError = item.thumbError;
          item.previewLoading = false;
          item.loading = false;
        }
      } finally {
        item.loadingThumb = false;
        if (isOpCurrent(opCtx) && expectedGen === scanGeneration) {
          item.loading = false;
          item.previewLoading = false;
          mediaPreviewVersion.value += 1;
        }
      }
    };

    const pumpImageThumbnails = async (items, expectedGen) => {
      const opCtx = captureOp();
      let cursor = 0;
      const worker = async () => {
        while (isOpCurrent(opCtx) && expectedGen === scanGeneration && cursor < items.length) {
          const item = items[cursor++];
          const alreadyLoaded = item.isSvg ? item.svgText !== null : Boolean(item.previewUrl);
          if (!alreadyLoaded) {
            await loadImageThumbnail(item, expectedGen);
          }
        }
      };
      const workers = Array.from({ length: Math.min(THUMB_CONCURRENCY, items.length) }, () => worker());
      await Promise.all(workers);
    };

    const openDocFile = async (entry, { forceReload = false, skipProbe = false } = {}) => {
      const opCtx = captureOp();
      const { agentId, rootDir } = opCtx;
      if (!entry?.path || !rootDir || !isOpCurrent(opCtx)) return;
      const draft = getOrCreateDraft(agentId, rootDir, entry.path, {
        agentId, rootDir, path: entry.path,
        fileType: 'text', loaded: false, loadError: null, loading: false, saving: false,
        isDirty: false, bufferVersion: 0, isBinary: false, diskChangedToBinary: false,
        baseMtimeMs: null, baseSize: null, diskMtimeMs: null, diskSize: null,
        observedDiskMtimeMs: null, observedDiskSize: null,
        diskChangedOnDisk: false, diskConflictError: false,
      });
      if (!draft) return;
      draft.name = entry.name || draft.name;
      draft.relPath = entry.relPath || draft.relPath || relativePath(entry.path, rootDir);
      activeDocPath.value = entry.path;

      const probeOnly = Boolean(draft.isDirty);
      const shouldProbe = !skipProbe && (forceReload || !probedPathsThisVisit.has(entry.path));
      if (probeOnly && draft.probingDisk) {
        if (shouldProbe) draft.needsReprobe = true;
        return;
      }
      if (draft.loading || draft.probingDisk || draft.saving
        || (probeOnly ? !shouldProbe : draft.loaded && !forceReload && !draft.loadError)) return;

      const versionAtRead = draft.bufferVersion;
      const probeVisitEpoch = visitEpoch;
      const markProbed = () => {
        if (probeVisitEpoch === visitEpoch && isOpCurrent(opCtx)) probedPathsThisVisit.add(entry.path);
      };
      if (probeOnly) {
        probedPathsThisVisit.delete(entry.path);
        draft.probingDisk = true;
      } else draft.loading = true;
      draft.loadError = null;
      try {
        const msg = await sendCorrelatedRequest({ type: 'read_file', filePath: entry.path }, { opCtx });
        if (getDraft(rootDir, entry.path, agentId) !== draft) return;
        const preserveDraft = probeOnly || draft.isDirty || draft.bufferVersion !== versionAtRead;
        const binary = msg.isBinary === true || Boolean(msg.binary)
          || (!msg.error && typeof msg.content !== 'string');
        if (preserveDraft) {
          if (msg.error) return;
          if (binary) {
            draft.diskChangedToBinary = true;
            markProbed();
          } else if (typeof msg.content === 'string') {
            draft.diskChangedToBinary = false;
            // Probe results describe the disk, not the version this draft was based on.
            draft.observedDiskMtimeMs = msg.mtimeMs ?? null;
            draft.observedDiskSize = msg.size ?? null;
            if (draft.observedDiskMtimeMs !== (draft.baseMtimeMs ?? null)
              || draft.observedDiskSize !== (draft.baseSize ?? null)
              || msg.content !== draft.savedContent) {
              draft.diskChangedOnDisk = true;
            }
            markProbed();
          }
          return;
        }
        if (msg.error) {
          draft.loadError = msg.error;
          return;
        }
        draft.loaded = true;
        draft.isBinary = binary;
        draft.diskChangedToBinary = false;
        draft.diskChangedOnDisk = false;
        draft.diskConflictError = false;
        draft.observedDiskMtimeMs = null;
        draft.observedDiskSize = null;
        if (!binary) {
          draft.baseMtimeMs = msg.mtimeMs ?? null;
          draft.baseSize = msg.size ?? null;
          draft.diskMtimeMs = draft.baseMtimeMs;
          draft.diskSize = draft.baseSize;
          markProbed();
        }
        draft.blobUrl = binary ? buildPreviewUrl(msg) : null;
        const text = binary ? undefined : msg.content;
        draft.content = text;
        draft.savedContent = text;
        draft.originalContent = text;
        return true;
      } catch (err) {
        if (isOpCurrent(opCtx) && !probeOnly && !draft.isDirty && draft.bufferVersion === versionAtRead) {
          draft.loadError = err?.message || tr('files.readSendFailed', 'Failed to read file');
        }
      } finally {
        if (probeOnly) {
          draft.probingDisk = false;
          if (draft.needsReprobe) {
            draft.needsReprobe = false;
            if (!disposed && !isDeactivated && activeDocPath.value === entry.path && draft.isDirty
              && getDraft(activeRootDir.value, entry.path) === draft) {
              void openDocFile(entry, { forceReload: true });
            }
          }
        } else draft.loading = false;
      }
    };

    const scanWorkspace = async ({
      reloadActiveDoc = false,
      selectPath = '',
      opCtx = captureOp(),
    } = {}) => {
      const { rootDir } = opCtx;
      if (!rootDir || !opCtx.creationId || !isOpCurrent(opCtx)) return;

      const myGen = ++scanGeneration;
      scanning.value = true;

      const isScanCurrent = () => myGen === scanGeneration && isOpCurrent(opCtx);

      const foundDocs = [];
      const foundImages = [];
      const foundVideos = [];
      const prevImageByPath = new Map(imageFiles.value.map(item => [item.path, item]));
      const prevVideoByPath = new Map(videoFiles.value.map(item => [item.path, item]));
      let invalidatedSelectedImage = null;
      let invalidatedSelectedVideo = null;
      let totalEntries = 0;
      let scanHadErrors = false;
      let hitEntryCap = false;
      let hitDepthCap = false;

      const queue = [{ dirPath: rootDir, depth: 0 }];

      try {
        while (queue.length > 0 && totalEntries < SCAN_MAX_ENTRIES && isScanCurrent()) {
          const { dirPath, depth } = queue.shift();
          let msg;
          try {
            msg = await sendCorrelatedRequest({
              type: 'list_directory',
              dirPath,
            }, { timeoutMs: 15000, opCtx });
          } catch {
            scanHadErrors = true;
            continue;
          }
          if (!isScanCurrent()) return;
          if (msg.error || !Array.isArray(msg.entries)) {
            scanHadErrors = true;
            continue;
          }

          for (const entry of msg.entries) {
            if (!entry || !entry.name) continue;
            if (entry.isSymlink || entry.type === 'symlink') continue;
            if (IGNORED_DIRS.has(entry.name)) continue;
            if (totalEntries >= SCAN_MAX_ENTRIES) {
              hitEntryCap = true;
              break;
            }
            totalEntries += 1;

            const fullPath = normalizePath(entry.path || joinPath(dirPath, entry.name));
            if (!isPathInsideRoot(fullPath, rootDir)) continue;
            const rel = relativePath(fullPath, rootDir);

            if (entry.type === 'directory') {
              if (depth < SCAN_MAX_DEPTH) {
                queue.push({ dirPath: fullPath, depth: depth + 1 });
              } else {
                hitDepthCap = true;
              }
              continue;
            }

            const ext = getExt(entry.name);
            const entrySize = Number(entry.size) || 0;
            const entryMtimeMs = entry.mtimeMs ?? entry.mtime ?? entry.modified ?? 0;

            if (DOC_EXTS.has(ext)) {
              foundDocs.push({
                path: fullPath,
                name: entry.name,
                relPath: rel,
                size: entry.size ?? null,
                mtimeMs: entry.mtimeMs ?? entry.mtime ?? entry.modified ?? null,
              });
            } else if (IMAGE_EXTS.has(ext)) {
              const isSvg = ext === '.svg';
              const prev = prevImageByPath.get(fullPath);
              if (prev) {
                const prevMtimeMs = prev.mtimeMs ?? prev.mtime ?? 0;
                if (prev.size !== entrySize || prevMtimeMs !== entryMtimeMs) {
                  revokeLocalBlobUrl(prev.blobUrl);
                  prev.size = entrySize;
                  prev.mtimeMs = entryMtimeMs;
                  prev.mtime = entryMtimeMs;
                  prev.previewUrl = '';
                  prev.blobUrl = isSvg ? '' : null;
                  prev.svgText = null;
                  prev.content = null;
                  prev.thumbError = null;
                  prev.previewError = null;
                  prev.loadError = null;
                  if (selectedImagePath.value && prev.path === selectedImagePath.value) {
                    invalidatedSelectedImage = prev;
                  }
                }
                foundImages.push(prev);
              } else {
                foundImages.push(Vue.reactive({
                  path: fullPath,
                  name: entry.name,
                  relPath: rel,
                  size: entrySize,
                  mtimeMs: entryMtimeMs,
                  mtime: entryMtimeMs,
                  isSvg,
                  fileType: isSvg ? 'text' : 'image',
                  content: null,
                  svgText: null,
                  blobUrl: isSvg ? '' : null,
                  previewUrl: '',
                  loading: false,
                  loadError: null,
                  previewLoading: false,
                  previewError: null,
                  loadingThumb: false,
                  thumbError: null,
                  isDirty: false,
                }));
              }
            } else if (VIDEO_EXTS.has(ext)) {
              const prev = prevVideoByPath.get(fullPath);
              if (prev) {
                const prevMtimeMs = prev.mtimeMs ?? prev.mtime ?? 0;
                if (prev.size !== entrySize || prevMtimeMs !== entryMtimeMs) {
                  revokeLocalBlobUrl(prev.blobUrl);
                  prev.size = entrySize;
                  prev.mtimeMs = entryMtimeMs;
                  prev.mtime = entryMtimeMs;
                  prev.blobUrl = null;
                  prev.previewError = null;
                  prev.loadError = null;
                  if (selectedVideoPath.value && prev.path === selectedVideoPath.value) {
                    invalidatedSelectedVideo = prev;
                  }
                }
                foundVideos.push(prev);
              } else {
                foundVideos.push(Vue.reactive({
                  path: fullPath,
                  name: entry.name,
                  relPath: rel,
                  size: entrySize,
                  mtimeMs: entryMtimeMs,
                  mtime: entryMtimeMs,
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
        }

        if (queue.length > 0) {
          hitEntryCap = true;
        }
        if (!isScanCurrent()) return;

        const scanIncomplete = scanHadErrors || hitEntryCap || hitDepthCap;

        // Revoke any local blob URLs for media files removed on a clean, complete scan
        if (!scanIncomplete) {
          const nextImgPaths = new Set(foundImages.map(i => i.path));
          for (const [oldPath, oldItem] of prevImageByPath.entries()) {
            if (!nextImgPaths.has(oldPath)) revokeLocalBlobUrl(oldItem.blobUrl);
          }
          const nextVidPaths = new Set(foundVideos.map(v => v.path));
          for (const [oldPath, oldItem] of prevVideoByPath.entries()) {
            if (!nextVidPaths.has(oldPath)) revokeLocalBlobUrl(oldItem.blobUrl);
          }
        }

        // Merge any dirty documents in docDrafts belonging to this workspace that were
        // omitted by the scan (e.g. scan error or entry cap) so they stay reachable in the tree.
        const foundDocPathSet = new Set(foundDocs.map(d => normalizePath(d.path)));
        for (const draft of dirtyDrafts(rootDir)) {
          if (!isPathInsideRoot(draft.path, rootDir)) continue;
          const normDocPath = normalizePath(draft.path);
          if (foundDocPathSet.has(normDocPath)) continue;
          foundDocPathSet.add(normDocPath);
          foundDocs.push({
            path: draft.path,
            name: draft.name || normDocPath.split('/').pop() || draft.path,
            relPath: draft.relPath || relativePath(draft.path, rootDir),
          });
        }

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

        // Document selection / safe refresh (NEVER discard dirty docs or on partial/errored scans)
        const targetSelect = selectPath
          ? foundDocs.find(d => normalizePath(d.path) === normalizePath(selectPath))
          : null;

        if (targetSelect) {
          await openDocFile(targetSelect);
        } else if (activeDocPath.value) {
          const currentDraft = getDraft(rootDir, activeDocPath.value);
          const stillExists = foundDocs.find(d => d.path === activeDocPath.value);
          if (!stillExists) {
            if (!currentDraft?.isDirty && !scanIncomplete) {
              activeDocPath.value = '';
            }
          } else if (reloadActiveDoc || currentDraft?.isDirty) {
            await openDocFile(stillExists, { forceReload: reloadActiveDoc });
          }
        }

        if (!isScanCurrent()) return;

        if (!activeDocPath.value && foundDocs.length > 0) {
          const dirty = foundDocs.find(d => getDraft(rootDir, d.path, opCtx.agentId)?.isDirty);
          const readme = foundDocs.find(d => d.name.toLowerCase() === 'readme.md');
          const firstMd = foundDocs.find(d => getExt(d.name) === '.md');
          await openDocFile(dirty || readme || firstMd || foundDocs[0], { forceReload: true });
        }

        if (!isScanCurrent()) return;

        // Clear selected media path only if removed on a complete, error-free scan
        if (!scanIncomplete) {
          if (selectedImagePath.value && !foundImages.some(i => i.path === selectedImagePath.value)) {
            selectedImagePath.value = '';
          }
          if (selectedVideoPath.value && !foundVideos.some(v => v.path === selectedVideoPath.value)) {
            selectedVideoPath.value = '';
          }
        }

        // Immediately reload active selected media if its cached preview was invalidated on rescan
        if (invalidatedSelectedImage && selectedImagePath.value === invalidatedSelectedImage.path) {
          invalidatedSelectedImage.loading = true;
          invalidatedSelectedImage.previewLoading = true;
          void loadImageThumbnail(invalidatedSelectedImage, myGen);
        }
        if (invalidatedSelectedVideo && selectedVideoPath.value === invalidatedSelectedVideo.path) {
          void loadVideo(invalidatedSelectedVideo, myGen);
        }

        // Kick off lazy thumbnail loading when images exist
        if (activeModality.value === 'images' && foundImages.length > 0) {
          void pumpImageThumbnails(foundImages, myGen);
        }
      } finally {
        if (isScanCurrent()) scanning.value = false;
      }
    };

    const refreshWorkspace = () => {
      resetDocProbes();
      return scanWorkspace({ reloadActiveDoc: true });
    };

    // ==================== Document Actions ====================
    const onDocTreeClick = (node) => {
      if (node.type === 'folder') {
        if (expandedDocFolders.has(node.relPath)) expandedDocFolders.delete(node.relPath);
        else expandedDocFolders.add(node.relPath);
        return;
      }
      if (isNarrowContainer.value) {
        docTreeOpen.value = false;
      }
      void openDocFile(docFiles.value.find(file => file.path === node.path) || node);
    };

    const onDocContentUpdate = (newContent) => {
      const opCtx = captureOp();
      if (!isOpCurrent(opCtx)) return;
      const draft = activeDocDraft.value;
      if (typeof newContent !== 'string' || !draft || draft.loading || draft.isBinary || typeof draft.content !== 'string') return;
      draft.content = newContent;
      draft.bufferVersion = (draft.bufferVersion || 0) + 1;
      draft.isDirty = draft.saving || newContent !== draft.savedContent;
      probedPathsThisVisit.add(activeDocPath.value);
    };

    const saveDoc = async ({ forceOverwrite = false } = {}) => {
      const draft = activeDocDraft.value;
      const opCtx = captureOp();
      if (!draft || !isOpCurrent(opCtx)) return;
      if (draft.isBinary || draft.diskChangedToBinary) {
        showFeedback(false, binaryDraftWarning());
        return;
      }
      if (!draft.isDirty || draft.loading || draft.saving || typeof draft.content !== 'string') return;
      if (draft.probingDisk) {
        showFeedback(false, getLocale() === 'zh-CN'
          ? '正在检查磁盘上的文件，请稍后再保存。' : 'Checking the file on disk. Try saving again shortly.');
        return;
      }
      if (draft.diskChangedOnDisk && !forceOverwrite) return;
      const submittedVersion = draft.bufferVersion;
      const submittedContent = draft.content;
      draft.saving = true;
      try {
        const msg = await sendCorrelatedRequest({
          type: 'write_file',
          filePath: draft.path,
          content: submittedContent,
          requireTextTarget: true,
          ...(!forceOverwrite && draft.baseMtimeMs != null ? { expectedMtimeMs: draft.baseMtimeMs } : {}),
          ...(!forceOverwrite && draft.baseSize != null ? { expectedSize: draft.baseSize } : {}),
        }, { opCtx });
        // This ACK belongs to the shared buffer even if its submitting tab is now inactive.
        if (getDraft(opCtx.rootDir, draft.path, opCtx.agentId) !== draft) return;
        const report = (ok, message) => { if (isOpCurrent(opCtx)) showFeedback(ok, message); };
        if (msg?.errorCode === 'FILE_IS_BINARY') {
          draft.diskChangedToBinary = true;
          draft.isDirty = true;
          report(false, binaryDraftWarning());
        } else if (msg?.errorCode === 'FILE_CONFLICT') {
          draft.diskChangedOnDisk = true;
          draft.diskConflictError = true;
          draft.isDirty = true;
          report(false, getLocale() === 'zh-CN'
            ? '磁盘上的文件已更改，未保存的草稿已保留。' : 'The file changed on disk. Your unsaved draft is preserved.');
        } else if (msg?.type !== 'file_saved' || msg.error || msg.success === false) {
          report(false, msg?.error || tr('creation.workbench.saveFailed', 'Failed to save'));
        } else {
          draft.baseMtimeMs = msg.mtimeMs ?? draft.baseMtimeMs;
          draft.baseSize = msg.size ?? draft.baseSize;
          draft.diskMtimeMs = draft.baseMtimeMs;
          draft.diskSize = draft.baseSize;
          draft.observedDiskMtimeMs = null;
          draft.observedDiskSize = null;
          draft.diskChangedOnDisk = false;
          draft.diskConflictError = false;
          draft.savedContent = submittedContent;
          draft.originalContent = submittedContent;
          if (draft.bufferVersion === submittedVersion) draft.isDirty = false;
          report(true, tr('creation.workbench.saved', 'Saved'));
        }
      } catch (err) {
        if (isOpCurrent(opCtx)) showFeedback(false, err?.message || tr('creation.workbench.saveFailed', 'Failed to save'));
      } finally {
        draft.saving = false;
      }
    };

    const reloadActiveDocFromDisk = async () => {
      const draft = activeDocDraft.value;
      const opCtx = captureOp();
      if (!draft || !isOpCurrent(opCtx) || draft.loading || draft.saving || draft.probingDisk
        || !draft.diskChangedOnDisk || draft.diskChangedToBinary) return;
      const entry = docFiles.value.find(file => file.path === activeDocPath.value) || draft;
      const { isDirty, bufferVersion } = draft;
      draft.isDirty = false;
      draft.diskChangedOnDisk = false;
      draft.diskChangedToBinary = false;
      if (await openDocFile(entry, { forceReload: true })) return;
      // A failed reload must not make the existing buffer look saved.
      if (draft.bufferVersion !== bufferVersion) return;
      draft.isDirty = isDirty;
      draft.diskChangedOnDisk = true;
      const error = draft.loadError;
      draft.loadError = null;
      if (isOpCurrent(opCtx)) showFeedback(false, error || tr('files.readSendFailed', 'Failed to read file'));
    };

    const overwriteActiveDocOnDisk = () => saveDoc({ forceOverwrite: true });

    // ==================== Media Selection & Video Metadata ====================
    const findMediaItemByPath = (path) => (
      imageFiles.value.find(item => item.path === path)
      || videoFiles.value.find(item => item.path === path)
      || null
    );

    const onMediaLoad = (payload) => {
      const path = payload?.path;
      const url = payload?.url;
      if (!path) return;
      const item = findMediaItemByPath(path);
      if (!item) return;
      if (url && item.blobUrl && item.blobUrl !== url) return;
      item.previewLoading = false;
      item.previewError = null;
    };

    const onMediaError = (payload) => {
      const path = payload?.path;
      const url = payload?.url;
      if (!path) return;
      const item = findMediaItemByPath(path);
      if (!item) return;
      if (url && item.blobUrl && item.blobUrl !== url) return;
      item.previewLoading = false;
      item.previewError = payload?.message || tr('creation.workbench.previewUnavailable', 'Preview unavailable');
    };

    const selectImageAt = async (index) => {
      if (index < 0 || index >= imageFiles.value.length) return;
      const item = imageFiles.value[index];
      if (!item) return;
      selectedImagePath.value = item.path;
      const alreadyLoaded = item.isSvg ? item.svgText !== null : Boolean(item.blobUrl || item.previewUrl);
      if (!alreadyLoaded) {
        item.loading = true;
        item.previewLoading = true;
        await loadImageThumbnail(item, scanGeneration);
      }
    };

    const loadVideo = async (item, expectedGen = scanGeneration) => {
      const opCtx = captureOp();
      if (!item || !isOpCurrent(opCtx)) return;
      if (item.blobUrl) return;
      item.loading = true;
      item.loadError = null;
      item.previewLoading = true;
      item.previewError = null;
      try {
        const msg = await sendCorrelatedRequest({
          type: 'video_metadata',
          filePath: item.path,
        }, { timeoutMs: 20000, opCtx });
        if (!isOpCurrent(opCtx) || expectedGen !== scanGeneration) return;
        item.loading = false;
        if (msg.error || !msg.videoStream || !msg.previewUrl) {
          const errText = msg.error || tr('files.videoStreamUnavailable', 'Video stream unavailable');
          item.loadError = errText;
          item.previewError = errText;
          item.previewLoading = false;
          return;
        }
        const safeUrl = buildPreviewUrl(msg);
        if (!safeUrl) {
          const errText = tr('files.videoStreamUnavailable', 'Video stream unavailable');
          item.loadError = errText;
          item.previewError = errText;
          item.previewLoading = false;
          return;
        }
        item.blobUrl = safeUrl;
        item.previewLoading = false;
      } catch (err) {
        if (isOpCurrent(opCtx) && expectedGen === scanGeneration) {
          item.loading = false;
          item.previewLoading = false;
          item.loadError = err?.message || tr('files.videoStreamUnavailable', 'Video stream unavailable');
          item.previewError = item.loadError;
        }
      }
    };

    const selectVideoAt = async (index) => {
      if (index < 0 || index >= videoFiles.value.length) return;
      const item = videoFiles.value[index];
      if (!item) return;
      selectedVideoPath.value = item.path;
      await loadVideo(item, scanGeneration);
    };

    const matchesWorkspaceTargetPath = (item, normTarget) => {
      if (!item || !normTarget) return false;
      const normItemPath = normalizePath(item.path);
      if (normItemPath === normTarget) return true;
      if (item.relPath && normalizePath(item.relPath) === normTarget) return true;
      if (activeRootDir.value) {
        const joined = normalizePath(joinPath(activeRootDir.value, normTarget));
        if (joined === normItemPath) return true;
      }
      return false;
    };

    const resolveCreationRelativeMediaUrl = (resolvedPath) => {
      const norm = normalizePath(resolvedPath);
      if (!norm) return '';
      const img = imageFiles.value.find(item => matchesWorkspaceTargetPath(item, norm));
      if (!img || img.isSvg || getExt(img.name) === '.svg') return '';
      if (img.previewUrl && isSafeMediaUrl(img.previewUrl, localBlobUrls)) {
        return img.previewUrl;
      }
      if (!img.loadingThumb && !img.thumbError) {
        void loadImageThumbnail(img, scanGeneration);
      }
      return '';
    };

    const onCanvasRelativeLink = (payload) => {
      const norm = normalizePath(payload?.targetPath || '');
      if (!norm) return;
      const vidIdx = videoFiles.value.findIndex(item => matchesWorkspaceTargetPath(item, norm));
      if (vidIdx >= 0) {
        activeModality.value = 'videos';
        void selectVideoAt(vidIdx);
        return;
      }
      const imgIdx = imageFiles.value.findIndex(item => matchesWorkspaceTargetPath(item, norm));
      if (imgIdx >= 0) {
        activeModality.value = 'images';
        void selectImageAt(imgIdx);
        return;
      }
      const doc = docFiles.value.find(item => matchesWorkspaceTargetPath(item, norm));
      if (doc) {
        activeModality.value = 'docs';
        void openDocFile(doc);
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
      if (!isSafeRelativeChildName(name)) {
        showFeedback(false, tr('creation.workbench.invalidPath', 'Invalid file or folder name'));
        return;
      }
      const opCtx = captureOp();
      if (!isOpCurrent(opCtx)) return;
      const filePath = joinPath(opCtx.rootDir, name);
      if (!isPathInsideRoot(filePath, opCtx.rootDir)) {
        showFeedback(false, tr('creation.workbench.invalidPath', 'Path must stay inside the Creation folder'));
        return;
      }
      miniDialog.submitting = true;
      const isDirectory = miniDialog.mode === 'folder';
      try {
        const msg = await sendCorrelatedRequest({
          type: 'create_file',
          filePath,
          isDirectory,
        }, { opCtx });
        if (!isOpCurrent(opCtx)) return;
        if (msg.success === false || msg.error) {
          showFeedback(false, msg.error || tr('creation.workbench.createFailed', 'Create failed'));
          return;
        }
        miniDialog.visible = false;
        miniDialog.name = '';
        if (!isDirectory) activeModality.value = 'docs';
        await scanWorkspace({ selectPath: isDirectory ? '' : filePath, opCtx });
      } catch (err) {
        if (isOpCurrent(opCtx)) showFeedback(false, err?.message || tr('creation.workbench.createFailed', 'Create failed'));
      } finally {
        if (isOpCurrent(opCtx)) miniDialog.submitting = false;
      }
    };

    const triggerMediaUpload = (target) => {
      addMenuOpen.value = false;
      if (target === 'images' || target === 'videos') {
        uploadTargetSubdir.value = target;
      } else {
        uploadTargetSubdir.value = activeModality.value === 'videos' ? 'videos' : 'images';
      }
      const opCtx = captureOp(joinPath(activeRootDir.value, uploadTargetSubdir.value));
      uploadPickerContext = opCtx;
      Vue.nextTick(() => { if (isOpCurrent(opCtx)) uploadInputRef.value?.click(); });
    };

    const onUploadInputChange = async (event) => {
      const selected = Array.from(event.target?.files || []);
      if (event.target) event.target.value = '';
      const subdir = uploadTargetSubdir.value;
      const opCtx = uploadPickerContext || captureOp(joinPath(activeRootDir.value, subdir));
      uploadPickerContext = null;
      if (!selected.length || !opCtx.rootDir || uploading.value || !isOpCurrent(opCtx)) return;
      const { dirPath: targetDir, rootDir } = opCtx;
      if (!isSafeRelativeChildName(subdir)) {
        showFeedback(false, tr('creation.workbench.invalidPath', 'Invalid upload folder'));
        return;
      }
      if (!isPathInsideRoot(targetDir, rootDir)) {
        showFeedback(false, tr('creation.workbench.invalidPath', 'Upload destination must stay inside the Creation folder'));
        return;
      }

      const safeSelected = selected.filter(file => (
        file
        && isSafeRelativeChildName(file.name)
        && !String(file.name).includes('/')
        && !String(file.name).includes('\\')
        && isPathInsideRoot(joinPath(targetDir, file.name), rootDir)
      ));
      if (!safeSelected.length) {
        showFeedback(false, tr('creation.workbench.invalidPath', 'Invalid filename for upload'));
        return;
      }

      uploading.value = true;
      try {
        const filesPayload = await Promise.all(safeSelected.map(file => new Promise((resolve) => {
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
        if (!validFiles.length || !isOpCurrent(opCtx)) return;

        // Ensure target subdir exists (ignore error if already exists)
        try {
          await sendCorrelatedRequest({
            type: 'create_file',
            filePath: targetDir,
            isDirectory: true,
          }, { timeoutMs: 10000, opCtx });
        } catch {}

        if (!isOpCurrent(opCtx)) return;
        const msg = await sendCorrelatedRequest({
          type: 'upload_to_dir',
          files: validFiles,
          dirPath: targetDir,
        }, { timeoutMs: 30000, opCtx });

        if (!isOpCurrent(opCtx)) return;
        if (msg.success === false || msg.error) {
          showFeedback(false, msg.error || tr('creation.workbench.uploadFailed', 'Upload failed'));
          return;
        }
        showFeedback(true, tr('creation.workbench.uploaded', 'Uploaded'));
        await scanWorkspace({ opCtx });
      } catch (err) {
        if (isOpCurrent(opCtx)) showFeedback(false, err?.message || tr('creation.workbench.uploadFailed', 'Upload failed'));
      } finally {
        if (isOpCurrent(opCtx)) uploading.value = false;
      }
    };

    // ==================== Cross-Capability Actions ====================
    const openWorkspaceInFiles = (dirOverride = '') => {
      const opCtx = captureOp(dirOverride || activeRootDir.value);
      const targetDir = opCtx.dirPath;
      window.dispatchEvent(new CustomEvent('workbench-open-capability', {
        detail: {
          routeKey: props.routeKey,
          capabilityId: 'files',
        },
      }));
      if (targetDir) {
        Vue.nextTick(() => {
          if (!isOpCurrent(opCtx)) return;
          window.dispatchEvent(new CustomEvent('workbench-files-open-dir', {
            detail: {
              routeKey: props.routeKey,
              workspaceGeneration: props.workspaceGeneration,
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
      const isSvgFile = Boolean(file.isSvg) || getExt(name) === '.svg';

      // For SVGs (and any text content), download via attachment-only application/octet-stream Blob revoked immediately
      if (isSvgFile && typeof (file.svgText ?? file.content) === 'string') {
        const blob = new Blob([file.svgText ?? file.content], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        try {
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } finally {
          URL.revokeObjectURL(url);
        }
        return;
      }

      if (file.blobUrl) {
        if (!isSafeMediaUrl(file.blobUrl, localBlobUrls)) {
          showFeedback(false, tr('creation.workbench.unsafeUrl', 'Blocked unsafe download URL'));
          return;
        }
        const a = document.createElement('a');
        if (file.blobUrl.startsWith('blob:')) {
          a.href = file.blobUrl;
        } else {
          try {
            const url = new URL(file.blobUrl, `${location.protocol}//${location.host}`);
            url.searchParams.set('download', '1');
            a.href = url.href;
          } catch {
            showFeedback(false, tr('creation.workbench.unsafeUrl', 'Blocked unsafe download URL'));
            return;
          }
        }
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
      }

      if (typeof file.content === 'string') {
        const blob = new Blob([file.content], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        try {
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    };

    // ==================== Single Fenced Creation Activation ====================
    const activateWorkspace = async ({
      creation = null,
      creationId = '',
      rootDir = '',
      autoResolve = false,
      confirmDirty = true,
      bindCurrent = false,
      openSeq,
    } = {}, acceptActivation) => {
      if (autoResolve && (activeRootDir.value || showingSwitcher.value)) return { accepted: false };
      const epoch = ++activationEpoch;
      const ctx = captureRoute();
      const { agentId, sessionId } = ctx;
      const isCurrent = () => !isDeactivated && epoch === activationEpoch && isRouteCurrent(ctx)
        && (openSeq == null || openSeq === creationsStore.openWorkspaceSeq);
      if (!agentId || !isCurrent()) return { accepted: false };
      bindingFolder.value = false;
      loadingCreations.value = false;
      onboardingError.value = '';

      // 1. Ensure Creations list is loaded for this Agent (using actual `listCreations` method)
      const bucket = creationsStore.byAgent?.[agentId];
      if (!bucket?.loaded && typeof creationsStore.listCreations === 'function') {
        loadingCreations.value = true;
        try {
          await creationsStore.listCreations(agentId);
        } catch {} finally {
          if (isCurrent()) loadingCreations.value = false;
        }
        if (!isCurrent()) return { accepted: false };
      }

      const list = creationsStore.creationsForAgent(agentId) || [];
      let resolvedCreation = creation || null;
      let targetRootDir = rootDir || resolvedCreation?.rootDir || '';

      // 2. Resolve target Creation / folder
      if (autoResolve) {
        if (activeRootDir.value || showingSwitcher.value) return { accepted: false };
        if (props.sessionId) {
          resolvedCreation = list.find(c => c && c.sessionId === props.sessionId) || null;
        }
        if (!resolvedCreation && props.workDir) {
          if (typeof creationsStore.findByFolder === 'function') {
            try {
              resolvedCreation = (await creationsStore.findByFolder(agentId, props.workDir)) || null;
            } catch {
              resolvedCreation = null;
            }
            if (!isCurrent()) return { accepted: false };
          }
          if (!resolvedCreation) {
            const normWork = normalizePath(props.workDir);
            resolvedCreation = list.find(c => c && c.rootDir && normalizePath(c.rootDir) === normWork) || null;
          }
        }
        if (!resolvedCreation) return { accepted: false };
        targetRootDir = resolvedCreation.rootDir || '';
      } else {
        if (!resolvedCreation && creationId) {
          resolvedCreation = list.find(c => c?.id === creationId) || null;
          if (!resolvedCreation && typeof creationsStore.ensureWorkspace === 'function') {
            try {
              const prepared = await creationsStore.ensureWorkspace(agentId, creationId, { rootDir: targetRootDir });
              if (!isCurrent()) return { accepted: false };
              if (prepared?.creation?.id === creationId) {
                resolvedCreation = prepared.creation;
                targetRootDir = prepared.rootDir || targetRootDir;
              }
            } catch (err) {
              if (isCurrent()) onboardingError.value = err?.message || tr('creation.workbench.workspaceFailed', 'Failed to prepare workspace');
              return { accepted: false };
            }
          }
        }
        if (!resolvedCreation && !creationId && targetRootDir && !bindCurrent) {
          const normTarget = normalizePath(targetRootDir);
          resolvedCreation = list.find(c => c?.rootDir && normalizePath(c.rootDir) === normTarget) || null;
          if (!resolvedCreation) {
            try {
              const found = await creationsStore.findByFolder?.(agentId, targetRootDir);
              // Pending bindings still need the store to resume materialization.
              if (found?.rootDir) resolvedCreation = found;
            } catch {
              // The bind action does its own lookup; surface its authoritative error.
            }
            if (!isCurrent()) return { accepted: false };
          }
        }
        if (!resolvedCreation?.id && !creationId && targetRootDir) {
          bindingFolder.value = true;
          try {
            // The store's bind action accepts a single options object.
            const result = await creationsStore.bindFolderAsCreation({
              agentId, rootDir: targetRootDir, sessionId,
              ...(!bindCurrent ? { title: normalizePath(targetRootDir).split('/').filter(Boolean).pop() || 'Creation' } : {}),
            });
            if (!isCurrent()) return { accepted: false };
            if (result?.error) throw new Error(result.error);
            resolvedCreation = result?.creation || result;
            if (!resolvedCreation?.id || !resolvedCreation.rootDir?.trim()) throw new Error();
            targetRootDir = resolvedCreation.rootDir;
          } catch (err) {
            if (isCurrent()) onboardingError.value = err?.message || tr('creation.workbench.bindFailed', 'Failed to open folder as Creation');
            return { accepted: false };
          } finally {
            if (isCurrent()) bindingFolder.value = false;
          }
        }
        targetRootDir ||= resolvedCreation?.rootDir || '';

        if (resolvedCreation?.id && !targetRootDir && typeof creationsStore.ensureWorkspace === 'function') {
          try {
            const ensured = await creationsStore.ensureWorkspace(agentId, resolvedCreation.id, { rootDir: targetRootDir });
            if (!isCurrent()) return { accepted: false };
            targetRootDir = ensured?.rootDir || ensured?.creation?.rootDir || targetRootDir;
            if (ensured?.creation) resolvedCreation = ensured.creation;
          } catch (err) {
            if (isCurrent()) {
              onboardingError.value = err?.message || tr('creation.workbench.workspaceFailed', 'Failed to prepare workspace');
            }
            return { accepted: false };
          }
        }

        if (!targetRootDir) {
          onboardingError.value = tr('creation.workbench.missingRootDir', 'This Creation does not have a workspace folder yet.');
          return { accepted: false };
        }
      }

      if (!isCurrent()) return { accepted: false };
      if (!targetRootDir || !resolvedCreation?.id || (resolvedCreation.agentId && resolvedCreation.agentId !== agentId)) {
        onboardingError.value = tr('creation.workbench.workspaceFailed', 'Failed to prepare workspace');
        return { accepted: false };
      }

      const nextNormRoot = normalizePath(targetRootDir);
      const prevNormRoot = normalizePath(activeRootDir.value);
      const changed = prevNormRoot !== nextNormRoot || activeCreation.value?.id !== resolvedCreation.id;
      if (changed && prevNormRoot && confirmDirty && dirtyDrafts(prevNormRoot).length) {
        const confirmed = typeof window.confirm === 'function'
          ? window.confirm(tr('creation.workbench.unsavedSwitchConfirm', 'You have unsaved document changes in this Creation. Switch anyway?'))
          : true;
        if (!confirmed || !isCurrent()) return { accepted: false };
      }

      if (changed) resetWorkspace();
      activeCreation.value = resolvedCreation;
      activeRootDir.value = nextNormRoot;
      showingSwitcher.value = false;
      acceptActivation();
      void scanWorkspace({ opCtx: captureOp() });
      return { accepted: true };
    };

    const settleActivation = (receipt, accepted) => {
      if (!receipt || pendingActivation !== receipt) return;
      pendingActivation = null;
      creationsStore.resolveCreationActivation?.(receipt.openSeq, accepted && !isDeactivated
        && receipt.workspaceGeneration === props.workspaceGeneration, { workspaceGeneration: props.workspaceGeneration });
    };

    const activateTarget = async (target = {}) => {
      if (isDeactivated || (target.workspaceGeneration != null && target.workspaceGeneration !== props.workspaceGeneration)) {
        return { accepted: false };
      }
      if (target.openSeq != null && target.openSeq === pendingActivation?.openSeq) return;
      if (disposed || (target.autoResolve && (activeRootDir.value || showingSwitcher.value))) {
        if (target.openSeq != null) creationsStore.resolveCreationActivation?.(target.openSeq, false,
          { workspaceGeneration: props.workspaceGeneration });
        return { accepted: false };
      }
      settleActivation(pendingActivation, false);
      resetDocProbes();
      const receipt = target.openSeq != null
        ? { openSeq: target.openSeq, workspaceGeneration: props.workspaceGeneration } : null;
      pendingActivation = receipt;
      try {
        return await activateWorkspace(target, () => settleActivation(receipt, true));
      } finally {
        settleActivation(receipt, false);
      }
    };

    const resetWorkspace = () => {
      workspaceEpoch += 1;
      resetDocProbes();
      scanGeneration += 1;
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const [key, draft] of fallbackDrafts) {
        if (!draft.isDirty) fallbackDrafts.delete(key);
      }
      activeCreation.value = null;
      activeRootDir.value = '';
      activeDocPath.value = '';
      selectedImagePath.value = '';
      selectedVideoPath.value = '';
      docFiles.value = [];
      imageFiles.value = [];
      videoFiles.value = [];
      scanning.value = false;
      uploading.value = false;
      miniDialog.visible = false;
      miniDialog.submitting = false;
      feedback.value = null;
      expandedDocFolders.clear();
      revokeAllLocalBlobUrls();
    };

    const cancelTargetActivation = () => {
      if (!pendingActivation) return;
      activationEpoch += 1;
      settleActivation(pendingActivation, false);
      bindingFolder.value = false;
      loadingCreations.value = false;
    };

    const showCreationSwitcher = () => {
      cancelTargetActivation();
      creationsStore.cancelPendingWorkspaceOpen?.();
      showingSwitcher.value = true;
    };

    const openCreateModal = () => {
      cancelTargetActivation();
      creationsStore.cancelPendingWorkspaceOpen?.();
      onboardingError.value = '';
      modalContext = { ...captureRoute(), epoch: activationEpoch };
      createModalOpen.value = true;
    };

    const onCreationCreated = async (payload) => {
      const ctx = modalContext || { ...captureRoute(), epoch: activationEpoch };
      modalContext = null;
      if (!payload?.creation?.id || !isRouteCurrent(ctx) || ctx.epoch !== activationEpoch) return;
      const created = payload.creation;
      const targetAgentId = payload.agentId || created.agentId || ctx.agentId;
      const targetSessionId = payload.sessionId || created.sessionId || '';
      const rootDir = payload.rootDir || created.rootDir || '';
      const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
      const crossRoute = targetAgentId !== ctx.agentId || targetSessionId !== ctx.sessionId;
      creationsStore.cancelPendingWorkspaceOpen?.();
      if (crossRoute) cancelTargetActivation();
      const epoch = crossRoute ? ++activationEpoch : activationEpoch + 1;
      const isCurrent = () => isRouteCurrent(ctx) && epoch === activationEpoch;
      try {
        if (crossRoute) {
          const result = await creationsStore.openCreationWorkspace(targetAgentId, created, {
            sessionId: targetSessionId, rootDir, initialPrompt: prompt, uiMode: chatStore?.uiMode || 'classic',
          });
          if (result?.promptError && isCurrent()) onboardingError.value = result.promptError;
          return; // Only the destination Workbench may scan this Creation.
        }
        const res = await activateTarget({ creation: created, rootDir });
        if (res?.accepted !== true || !prompt || !targetSessionId) return;
        const deliverPrompt = creationsStore.sendInitialCreationPrompt?.bind(creationsStore) || sendInitialCreationPrompt;
        if (!isCurrent()) return;
        const result = await deliverPrompt(targetAgentId, targetSessionId, prompt, {
          isOpenStillCurrent: isCurrent, routeReady: true, cosmosDelivery: chatStore?.uiMode === 'cosmos',
        });
        if (result?.ok === false && isCurrent()) onboardingError.value = result.error || 'Failed to send initial prompt';
      } catch (err) {
        if (isCurrent()) onboardingError.value = err?.message || tr('creation.workbench.workspaceFailed', 'Failed to prepare workspace');
      }
    };

    const bindCurrentFolder = () => {
      if (!props.workDir || bindingFolder.value) return;
      creationsStore.cancelPendingWorkspaceOpen?.();
      void activateTarget({ rootDir: props.workDir, bindCurrent: true });
    };

    const selectExistingCreation = async (item) => {
      if (!item) return;
      creationsStore.cancelPendingWorkspaceOpen?.();
      await activateTarget({
        creation: item,
        creationId: item.id || '',
        rootDir: item.rootDir || '',
      });
    };

    // ==================== Event Listeners & Watchers ====================
    const handleCreationCheckDirty = (event) => {
      const detail = event?.detail;
      if (!detail || disposed) return;
      if (detail.routeKey && detail.routeKey !== props.routeKey) return;
      if (detail.workspaceGeneration && detail.workspaceGeneration !== props.workspaceGeneration) return;
      if (detail.agentId && detail.agentId !== props.agentId) return;
      const drafts = dirtyDrafts();
      detail.dirtyCount = (detail.dirtyCount || 0) + drafts.length;
      if (Array.isArray(detail.dirtyFiles)) {
        detail.dirtyFiles.push(...drafts.map(draft => draft.name || draft.relPath || draft.path));
      }
    };

    const receiveCreationTarget = (detail) => {
      if (!detail || isDeactivated || disposed) return;
      if (detail.workspaceGeneration != null && detail.workspaceGeneration !== props.workspaceGeneration) return;
      if (detail.routeKey && detail.routeKey !== props.routeKey) return;
      if (detail.agentId && detail.agentId !== props.agentId) return;
      if (detail.seq && detail.seq <= lastHandledTargetSeq) return;
      if (detail.seq) lastHandledTargetSeq = detail.seq;
      void activateTarget({
        creationId: detail.creationId || '',
        rootDir: detail.rootDir || '',
        openSeq: detail.openSeq,
        workspaceGeneration: detail.workspaceGeneration,
      });
    };
    const handleCreationTargetEvent = event => receiveCreationTarget(event?.detail);

    const handleDocumentClick = (event) => {
      if (addMenuOpen.value && !addMenuWrap.value?.contains(event.target)) {
        addMenuOpen.value = false;
      }
    };

    const onRootKeydown = (event) => {
      if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        if (activeModality.value === 'docs' && activeDocFile.value?.isDirty) {
          event.preventDefault();
          void saveDoc();
        }
      }
    };

    Vue.watch(() => [props.routeKey, props.agentId, props.sessionId, props.workspaceGeneration], registerTabRoute);
    Vue.watch(() => [props.agentId, props.sessionId, props.routeKey, props.workspaceGeneration], () => {
      resetWorkspace();
      showingSwitcher.value = false;
      void activateTarget({ autoResolve: true });
    });

    // Watch injected target from WorkbenchPanel (covers first-mount race before window listener attaches)
    const injectedCreationTarget = Vue.inject('workbench-creation-target', null);
    if (injectedCreationTarget) {
      Vue.watch(
        () => injectedCreationTarget.seq,
        seq => { if (seq) receiveCreationTarget(injectedCreationTarget); },
        { immediate: true },
      );
    }

    // Watch pendingWorkbenchTarget only when CreationTab is mounted standalone
    // (without a parent WorkbenchPanel). When inside WorkbenchPanel, the panel
    // owns consuming pendingWorkbenchTarget (so maximize/expand is always applied)
    // and forwards the target via `providedCreationTarget`.
    if (!injectedCreationTarget) {
      Vue.watch(
        () => creationsStore.pendingWorkbenchTarget,
        (target) => {
          if (!target || isDeactivated) return;
          if (target.workspaceGeneration != null && target.workspaceGeneration !== props.workspaceGeneration) return;
          if (target.seq && target.seq === lastConsumedTargetSeq) return;
          if (target.agentId && target.agentId !== props.agentId) return;
          if (target.sessionId && target.sessionId !== props.sessionId) return;
          lastConsumedTargetSeq = target.seq || Date.now();
          void activateTarget({
            creationId: target.creationId || '',
            rootDir: target.rootDir || '',
            openSeq: target.openSeq,
            workspaceGeneration: target.workspaceGeneration,
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
        const opCtx = captureOp();
        refreshTimer = setTimeout(() => {
          void scanWorkspace({ reloadActiveDoc: true, opCtx });
        }, 450);
      }
    });

    const syncContainerNarrowState = (width) => {
      if (!width || width <= 0) return;
      const narrow = width <= 680;
      if (narrow !== isNarrowContainer.value) {
        isNarrowContainer.value = narrow;
        docTreeOpen.value = !narrow;
      }
    };

    Vue.onMounted(() => {
      window.addEventListener('workbench-message', handleWorkbenchMessage);
      window.addEventListener('workbench-creation-target', handleCreationTargetEvent);
      window.addEventListener('creation-check-dirty', handleCreationCheckDirty);
      window.addEventListener('workbench-close-creation-capability', handleCreationCheckDirty);
      document.addEventListener('click', handleDocumentClick);
      registerTabRoute();
      if (rootEl.value) {
        const rectWidth = rootEl.value.getBoundingClientRect?.().width || rootEl.value.clientWidth || 0;
        syncContainerNarrowState(rectWidth);
        if (typeof ResizeObserver !== 'undefined') {
          containerResizeObserver = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect?.width || rootEl.value?.clientWidth || 0;
            syncContainerNarrowState(w);
          });
          containerResizeObserver.observe(rootEl.value);
        }
      }
      if (activationEpoch === 0) {
        void activateTarget({ autoResolve: true });
      }
    });

    Vue.onDeactivated(() => {
      isDeactivated = true;
      if (pendingActivation) cancelTargetActivation();
      else activationEpoch += 1;
      bindingFolder.value = false;
      loadingCreations.value = false;
    });

    Vue.onActivated(() => {
      const reactivated = isDeactivated;
      isDeactivated = false;
      resetDocProbes();
      receiveCreationTarget(injectedCreationTarget?.seq ? injectedCreationTarget : null);
      if (reactivated && !activeRootDir.value && !pendingActivation && !loadingCreations.value) {
        void activateTarget({ autoResolve: true });
      }
      if (activeDocFile.value?.isDirty) {
        const entry = docFiles.value.find(d => d.path === activeDocPath.value);
        if (entry) void openDocFile(entry, { forceReload: true });
      }
    });

    Vue.onBeforeUnmount(() => {
      disposed = true;
      settleActivation(pendingActivation, false);
      unregisterTabRoute();
      window.removeEventListener('creation-check-dirty', handleCreationCheckDirty);
      window.removeEventListener('workbench-close-creation-capability', handleCreationCheckDirty);
      revokeAllLocalBlobUrls();
    });

    Vue.onUnmounted(() => {
      activationEpoch += 1;
      window.removeEventListener('workbench-message', handleWorkbenchMessage);
      window.removeEventListener('workbench-creation-target', handleCreationTargetEvent);
      document.removeEventListener('click', handleDocumentClick);
      if (feedbackTimer) clearTimeout(feedbackTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (containerResizeObserver) {
        containerResizeObserver.disconnect();
        containerResizeObserver = null;
      }
      for (const entry of pendingRequests.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Creation workspace closed'));
      }
      pendingRequests.clear();
      revokeAllLocalBlobUrls();
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
      isNarrowContainer,
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
      docDrafts,
      activeDocPath,
      activeDocFile,
      activeDocDraft,
      selectedImagePath,
      activeImageIndex,
      activeImageFile,
      selectedVideoPath,
      activeVideoIndex,
      activeVideoFile,
      mediaPreviewVersion,
      tr,
      shortenPath,
      kindSwatchClass,
      formatSize,
      isDocDirty,
      showCreationSwitcher,
      openCreateModal,
      onCreationCreated,
      bindCurrentFolder,
      selectExistingCreation,
      scanWorkspace,
      refreshWorkspace,
      onDocTreeClick,
      onDocContentUpdate,
      saveDoc,
      reloadActiveDocFromDisk,
      overwriteActiveDocOnDisk,
      selectImageAt,
      selectVideoAt,
      resolveCreationRelativeMediaUrl,
      onCanvasRelativeLink,
      onMediaLoad,
      onMediaError,
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
