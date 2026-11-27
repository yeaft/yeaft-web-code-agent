/**
 * Yeaft Cosmos Creations — CreationInteriorModal (L3 Full-Screen Creation Shell)
 *
 * Rendered when creationsStore.activeCreation is non-null.
 * Wired to creationsStore's Agent-scoped state (`activeCreation`, `activeDetail`,
 * `activeNode`, `activeNodeContent`, `pendingProposalsForActive`, `activeRunsForActive`).
 */
import { useCreationsStore } from '../../../stores/creations.js';
import BookReader from './readers/BookReader.js';
import DeckReader from './readers/DeckReader.js';
import GalleryReader from './readers/GalleryReader.js';
import VideoReader from './readers/VideoReader.js';
import StudioTreeRail from './studio/StudioTreeRail.js';
import OutlineBoard from './studio/OutlineBoard.js';
import CanonEditor from './studio/CanonEditor.js';
import ProposalDiffBar from './studio/ProposalDiffBar.js';
import CanonSyncBanner from './studio/CanonSyncBanner.js';
import DirectorChatPane from './studio/DirectorChatPane.js';

function isFolderNode(n) {
  if (!n) return false;
  return n.kind === 'folder' || n.nodeType === 'folder' || n.type === 'folder' || n.isFolder === true;
}

export default {
  name: 'CreationInteriorModal',
  components: {
    BookReader,
    DeckReader,
    GalleryReader,
    VideoReader,
    StudioTreeRail,
    OutlineBoard,
    CanonEditor,
    ProposalDiffBar,
    CanonSyncBanner,
    DirectorChatPane,
  },
  setup() {
    const creationsStore = useCreationsStore();
    return { creationsStore };
  },
  data() {
    return {
      renamingTitle: false,
      titleDraft: '',
      readTocOpen: true,
      studioLeftOpen: true,
      studioRightOpen: true,
      mobileTab: 'canvas', // 'tree' | 'canvas' | 'director'
      showRootOutlineBoard: false,
      anchorDrawerOpen: false,
      activeAnchor: null,
      revisionsOpen: false,
      exportMenuOpen: false,
      directorPrefill: '',
      exporting: false,
      saving: false,
    };
  },
  computed: {
    activeRef() {
      return this.creationsStore.activeCreation || null;
    },
    agentId() {
      return this.activeRef?.agentId || '';
    },
    creationId() {
      return this.activeRef?.creationId || '';
    },
    detail() {
      return this.creationsStore.activeDetail || null;
    },
    creation() {
      return this.detail?.creation || null;
    },
    mode() {
      return this.activeRef?.mode || 'read';
    },
    nodes() {
      return Array.isArray(this.detail?.nodes) ? this.detail.nodes : [];
    },
    unitNodes() {
      return this.nodes
        .filter((n) => n && !isFolderNode(n))
        .sort((a, b) => (a.sortOrder ?? a.order ?? 0) - (b.sortOrder ?? b.order ?? 0));
    },
    canon() {
      return Array.isArray(this.detail?.canon) ? this.detail.canon : [];
    },
    sources() {
      return Array.isArray(this.detail?.sources) ? this.detail.sources : [];
    },
    activeNode() {
      return this.creationsStore.activeNode || null;
    },
    effectiveReadUnit() {
      if (this.activeNode && !isFolderNode(this.activeNode)) return this.activeNode;
      return this.unitNodes[0] || null;
    },
    activeCanon() {
      const id = this.activeRef?.activeCanonId;
      if (!id) return null;
      return this.canon.find((c) => c && c.id === id) || null;
    },
    activeSource() {
      const id = this.activeRef?.activeSourceId;
      if (!id) return null;
      return this.sources.find((s) => s && s.id === id) || null;
    },
    activeSelection() {
      if (this.showRootOutlineBoard) return { type: 'root-board', id: null };
      if (this.activeCanon) return { type: 'canon', id: this.activeCanon.id };
      if (this.activeSource) return { type: 'source', id: this.activeSource.id };
      if (this.activeNode) return { type: 'node', id: this.activeNode.id };
      return { type: null, id: null };
    },
    activeNodeContentObj() {
      return this.creationsStore.activeNodeContent || null;
    },
    activeNodeContent() {
      const raw = this.activeNodeContentObj?.content;
      if (typeof raw === 'string') return raw;
      if (raw && typeof raw === 'object') {
        try { return JSON.stringify(raw, null, 2); } catch { return ''; }
      }
      return '';
    },
    revisions() {
      return Array.isArray(this.activeNodeContentObj?.revisions)
        ? this.activeNodeContentObj.revisions
        : [];
    },
    pendingUnitProposals() {
      const nodeId = this.activeNode?.id;
      if (!nodeId) return [];
      const list = this.creationsStore.pendingProposalsForActive?.unitProposals || [];
      return list.filter((p) => (p.nodeId || p.targetNodeId) === nodeId);
    },
    pendingCanonProposals() {
      return this.creationsStore.pendingProposalsForActive?.canonProposals || [];
    },
    activeBatchRun() {
      const runs = this.creationsStore.activeRunsForActive || [];
      return runs.find((r) => r && r.type === 'batch') || runs[0] || null;
    },
    isBatchRun() {
      return this.activeBatchRun?.type === 'batch';
    },
    batchDoneCount() {
      const r = this.activeBatchRun;
      return r ? (r.completedUnits ?? r.progress?.completed ?? r.completedCount ?? 0) : 0;
    },
    batchTotalCount() {
      const r = this.activeBatchRun;
      return r ? (r.totalUnits ?? r.progress?.total ?? r.totalCount ?? 0) : 0;
    },
    activeSourceUrl() {
      if (!this.activeSource) return '';
      return this.creationsStore.mediaUrl(this.agentId, this.creationId, 'source', this.activeSource.id);
    },
    activeSourceBytes() {
      const s = this.activeSource;
      if (!s) return null;
      const val = s.byteLength ?? s.size;
      return typeof val === 'number' && Number.isFinite(val) ? val : null;
    },
    activeSourceText() {
      const s = this.activeSource;
      if (!s) return '';
      const chunks = Array.isArray(s.chunks)
        ? s.chunks
        : (Array.isArray(s.parsed?.chunks) ? s.parsed.chunks : null);
      if (chunks && chunks.length > 0) {
        return chunks
          .map((c) => (typeof c === 'string' ? c : (c?.text || c?.content || '')))
          .filter(Boolean)
          .join('\n\n');
      }
      return s.extractedText || s.text || '';
    },
    isSourceImage() {
      return String(this.activeSource?.mimeType || '').toLowerCase().startsWith('image/');
    },
  },
  watch: {
    creationId() {
      this.renamingTitle = false;
      this.showRootOutlineBoard = false;
      this.anchorDrawerOpen = false;
      this.activeAnchor = null;
      this.revisionsOpen = false;
      this.exportMenuOpen = false;
      this.mobileTab = 'canvas';
    },
    mode(newMode) {
      if (newMode === 'studio') {
        this.anchorDrawerOpen = false;
      }
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onKeyDown);
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onKeyDown);
  },
  methods: {
    isFolderNode,
    readerComponentFor(node) {
      const mod = node?.modality || 'markdown_doc';
      if (mod === 'slide_deck') return 'DeckReader';
      if (mod === 'image_gallery') return 'GalleryReader';
      if (mod === 'video_episode') return 'VideoReader';
      return 'BookReader';
    },
    onKeyDown(e) {
      if (!this.activeRef) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        this.setMode(this.mode === 'read' ? 'studio' : 'read');
        return;
      }
      if (e.key === 'Escape') {
        if (this.renamingTitle) {
          this.renamingTitle = false;
          return;
        }
        if (this.exportMenuOpen) {
          this.exportMenuOpen = false;
          return;
        }
        if (this.revisionsOpen) {
          this.revisionsOpen = false;
          return;
        }
        if (this.anchorDrawerOpen) {
          this.anchorDrawerOpen = false;
          this.activeAnchor = null;
          return;
        }
        this.ascendToGalaxy();
      }
    },
    ascendToGalaxy() {
      this.creationsStore.closeCreation();
    },
    setMode(nextMode) {
      this.creationsStore.setActiveMode(nextMode);
    },
    startRenameTitle() {
      this.titleDraft = this.creation?.title || '';
      this.renamingTitle = true;
      this.$nextTick(() => this.$refs.titleInput?.focus());
    },
    async commitRenameTitle() {
      if (!this.renamingTitle) return;
      this.renamingTitle = false;
      const next = this.titleDraft.trim();
      if (!next || next === this.creation?.title) return;
      await this.creationsStore.updateCreation(this.agentId, this.creationId, { title: next });
    },
    async toggleRevisions() {
      this.exportMenuOpen = false;
      this.revisionsOpen = !this.revisionsOpen;
      const nodeId = this.activeNode?.id || this.effectiveReadUnit?.id;
      if (this.revisionsOpen && nodeId) {
        await this.creationsStore.loadNode(this.agentId, this.creationId, nodeId);
      }
    },
    async restoreRevision(revId) {
      const nodeId = this.activeNode?.id || this.effectiveReadUnit?.id;
      if (!nodeId || !revId) return null;
      return this.creationsStore.restoreRevision(this.agentId, this.creationId, nodeId, revId, {
        baseRevId: this.activeNode?.currentRevId ?? null,
      });
    },
    async handleExport(format) {
      this.exportMenuOpen = false;
      this.exporting = true;
      try {
        const result = await this.creationsStore.exportCreation(this.agentId, this.creationId, format);
        if (!result) return;
        const safeTitle = String(this.creation?.title || 'creation').replace(/[^\w\u4e00-\u9fff-]+/g, '_');
        const filename = result.filename || `${safeTitle}.${format === 'json' ? 'json' : 'md'}`;

        if (result.downloadUrl) {
          const a = document.createElement('a');
          a.href = result.downloadUrl;
          a.download = filename;
          a.rel = 'noopener noreferrer';
          document.body.appendChild(a);
          a.click();
          a.remove();
          return;
        }

        if (result.content !== undefined || result.blob) {
          const blob = result.blob instanceof Blob
            ? result.blob
            : new Blob(
                [typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2)],
                { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' }
              );
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 0);
        }
      } finally {
        this.exporting = false;
      }
    },
    async toggleBatchPause() {
      const run = this.activeBatchRun;
      if (!run) return;
      if (run.type === 'batch') {
        const action = run.status === 'running' ? 'pause' : 'resume';
        await this.creationsStore.controlRun(this.agentId, this.creationId, run.id, action);
      } else {
        await this.creationsStore.controlRun(this.agentId, this.creationId, run.id, 'cancel');
      }
    },
    openRootOutlineBoard() {
      this.showRootOutlineBoard = true;
      this.creationsStore.selectNode(null);
      this.mobileTab = 'canvas';
    },
    selectNode(nodeId) {
      this.showRootOutlineBoard = false;
      this.creationsStore.selectNode(nodeId);
      this.mobileTab = 'canvas';
    },
    selectCanon(canonId) {
      this.showRootOutlineBoard = false;
      this.creationsStore.selectCanon(canonId);
      this.mobileTab = 'canvas';
    },
    selectSource(sourceId) {
      this.showRootOutlineBoard = false;
      this.creationsStore.selectSource(sourceId);
      this.mobileTab = 'canvas';
    },
    async handleCreateNode(payload) {
      const res = await this.creationsStore.createNode(this.agentId, this.creationId, {
        ...payload,
        nodeType: payload.kind === 'folder' ? 'folder' : 'unit',
        isFolder: payload.kind === 'folder',
      });
      const node = res?.node || (res?.id ? res : null);
      if (node?.id) this.selectNode(node.id);
    },
    async handleDeleteNode(nodeId) {
      await this.creationsStore.deleteNode(this.agentId, this.creationId, nodeId);
    },
    async handleCreateCanon(payload) {
      const created = await this.creationsStore.upsertCanon(this.agentId, this.creationId, payload);
      if (created?.id) this.selectCanon(created.id);
    },
    async handleUploadSources(files) {
      await this.creationsStore.uploadSources(this.agentId, this.creationId, files, []);
    },
    async handleAddTextSource({ name, text }) {
      await this.creationsStore.uploadSources(this.agentId, this.creationId, [], [{ name, title: name, content: text, text }]);
    },
    async handleDeleteSource(sourceId) {
      await this.creationsStore.deleteSource(this.agentId, this.creationId, sourceId);
    },
    async handleSaveContent(payload = {}) {
      const { nodeId, content } = payload;
      const baseRevId = Object.hasOwn(payload, 'baseRevId')
        ? payload.baseRevId
        : (this.activeNode?.currentRevId ?? null);
      this.saving = true;
      try {
        return await this.creationsStore.updateNode(this.agentId, this.creationId, nodeId, {
          content,
          baseRevId,
        });
      } finally {
        this.saving = false;
      }
    },
    async handleFinalizeNode({ nodeId }) {
      this.saving = true;
      try {
        await this.creationsStore.updateNode(this.agentId, this.creationId, nodeId, { status: 'final' });
      } finally {
        this.saving = false;
      }
    },
    handleRequestAiEdit({ anchor }) {
      if (this.mode === 'read') {
        this.activeAnchor = anchor;
        this.anchorDrawerOpen = true;
      } else {
        this.studioRightOpen = true;
        this.mobileTab = 'director';
        const quoteLine = anchor?.quote ? `\n> ${anchor.quote}\n` : '';
        this.directorPrefill = `[${anchor?.label || ''}]${quoteLine}`;
      }
    },
    async handleCaptureCanon({ quote, nodeTitle }) {
      if (!quote) return;
      const title = quote.length > 20 ? `${quote.slice(0, 20)}…` : quote;
      await this.creationsStore.upsertCanon(this.agentId, this.creationId, {
        type: 'world',
        title,
        body: nodeTitle ? `${quote}\n\n— ${nodeTitle}` : quote,
        pinned: false,
        locked: false,
      });
    },
    handleTuneProposal(proposal) {
      this.studioRightOpen = true;
      this.mobileTab = 'director';
      this.directorPrefill = `${this.$t('creation.proposal.continueTune')}: ${proposal?.summary || proposal?.title || ''}`;
    },
    onWelcomeUpload(e) {
      const files = Array.from(e.target?.files || []);
      if (e.target) e.target.value = '';
      if (files.length) this.handleUploadSources(files);
    },
    formatRevTime(ts) {
      if (!ts) return '';
      try {
        return new Date(ts).toLocaleString();
      } catch {
        return String(ts);
      }
    },
  },
  template: `
    <div v-if="activeRef && creation" class="creation-interior-overlay" role="dialog" aria-modal="true" :aria-label="creation.title">
      <!-- 48px Unified Topbar -->
      <header class="creation-topbar">
        <div class="creation-topbar-left">
          <button type="button" class="creation-glass-btn" @click="ascendToGalaxy">
            ← {{ $t('creation.interior.ascend') }}
          </button>

          <span class="creation-kind-badge">
            {{ $t('creation.celestial.' + (creation.kind || 'book')) }}
          </span>

          <input
            v-if="renamingTitle"
            ref="titleInput"
            v-model="titleDraft"
            class="creation-title-input"
            @blur="commitRenameTitle"
            @keydown.enter.prevent="commitRenameTitle"
            @keydown.esc.stop="renamingTitle = false"
          />
          <button
            v-else
            type="button"
            class="creation-topbar-title"
            @click="startRenameTitle"
          >
            {{ creation.title }}
          </button>
        </div>

        <!-- Center Segmented Mode Toggle -->
        <div class="creation-topbar-center">
          <div class="creation-mode-switch" role="tablist">
            <button
              type="button"
              role="tab"
              class="creation-mode-btn"
              :class="{ 'is-active': mode === 'read' }"
              :aria-selected="mode === 'read'"
              @click="setMode('read')"
            >
              📖 {{ $t('creation.interior.readMode') }}
            </button>
            <button
              type="button"
              role="tab"
              class="creation-mode-btn"
              :class="{ 'is-active': mode === 'studio' }"
              :aria-selected="mode === 'studio'"
              @click="setMode('studio')"
            >
              ✦ {{ $t('creation.interior.studioMode') }}
            </button>
          </div>
        </div>

        <!-- Right Controls -->
        <div class="creation-topbar-right">
          <!-- Live Active Run Pill -->
          <div v-if="activeBatchRun" class="creation-status-pill is-generating">
            <span v-if="isBatchRun">{{ batchDoneCount }}/{{ batchTotalCount }}</span>
            <span v-else>{{ $t('creation.status.running') }}</span>
            <button type="button" class="creation-icon-mini" @click="toggleBatchPause">
              <template v-if="isBatchRun">
                {{ activeBatchRun.status === 'running' ? $t('creation.studio.pause') : $t('creation.studio.resume') }}
              </template>
              <template v-else>
                {{ $t('creation.studio.stop') }}
              </template>
            </button>
          </div>

          <!-- Revision History Button -->
          <button
            type="button"
            class="creation-glass-btn"
            :class="{ 'is-active': revisionsOpen }"
            @click="toggleRevisions"
          >
            {{ $t('creation.interior.revisions') }}
          </button>

          <!-- Export Dropdown -->
          <div class="creation-popover-wrap">
            <button
              type="button"
              class="creation-glass-btn"
              :disabled="exporting"
              @click="exportMenuOpen = !exportMenuOpen"
            >
              {{ $t('creation.interior.exportMd').split(' ')[0] }} ▾
            </button>
            <div v-if="exportMenuOpen" class="creation-export-menu" @click.stop>
              <button type="button" class="creation-export-item" @click="handleExport('markdown')">
                {{ $t('creation.interior.exportMd') }}
              </button>
              <button type="button" class="creation-export-item" @click="handleExport('json')">
                {{ $t('creation.interior.exportJson') }}
              </button>
            </div>
          </div>

          <!-- Agent Ownership Badge -->
          <span v-if="creation.agentName || agentId" class="creation-agent-pill is-active" :title="agentId">
            {{ creation.agentName || agentId }}
          </span>
        </div>
      </header>

      <!-- BODY -->
      <div class="creation-interior-body">
        <!-- READ MODE -->
        <div v-if="mode === 'read'" class="creation-read-layout">
          <!-- Collapsible Left TOC / Unit Switcher Rail -->
          <aside class="creation-book-toc" :class="{ 'is-collapsed': !readTocOpen }">
            <div class="creation-read-toc-head">
              <span v-if="readTocOpen" class="creation-read-toc-title">{{ $t('creation.book.toc') }}</span>
              <button type="button" class="creation-icon-mini" @click="readTocOpen = !readTocOpen">
                {{ readTocOpen ? '‹' : '›' }}
              </button>
            </div>

            <ul v-if="readTocOpen" class="creation-read-toc-list">
              <li
                v-for="u in unitNodes"
                :key="u.id"
                class="creation-read-toc-item"
                :class="{ 'is-active': effectiveReadUnit && effectiveReadUnit.id === u.id }"
                @click="selectNode(u.id)"
              >
                <span class="creation-read-toc-name">{{ u.title }}</span>
                <span v-if="u.wordCount" class="creation-read-toc-wc">{{ u.wordCount }}</span>
              </li>
            </ul>
          </aside>

          <!-- Main Modality Reader Stage -->
          <main class="creation-read-stage">
            <component
              v-if="effectiveReadUnit"
              :is="readerComponentFor(effectiveReadUnit)"
              :node="effectiveReadUnit"
              :content="activeNodeContent"
              :nodes="nodes"
              :sources="sources"
              mode="read"
              :agent-id="agentId"
              :creation-id="creationId"
              :revisions="revisions"
              :saving="saving"
              :on-save-content="handleSaveContent"
              @save-content="handleSaveContent"
              @select-node="selectNode"
              @request-ai-edit="handleRequestAiEdit"
              @capture-canon="handleCaptureCanon"
              @finalize-node="handleFinalizeNode"
            />
            <div v-else class="creation-empty-stage">
              <p>{{ $t('creation.book.emptyChapter') }}</p>
              <button type="button" class="creation-glass-btn is-primary" @click="setMode('studio')">
                ✦ {{ $t('creation.inspector.enterStudio') }}
              </button>
            </div>
          </main>

          <!-- 380px Temporary Anchor AI Rewrite Drawer -->
          <div v-if="anchorDrawerOpen" class="creation-anchor-drawer">
            <DirectorChatPane
              :anchor-mode="true"
              :anchor="activeAnchor"
              :active-node="effectiveReadUnit"
              :agent-id="agentId"
              :creation-id="creationId"
              @close-anchor="anchorDrawerOpen = false; activeAnchor = null"
              @select-node="selectNode"
            />
          </div>
        </div>

        <!-- STUDIO MODE -->
        <div v-else class="creation-studio-layout" :data-mobile-tab="mobileTab">
          <!-- Left Rail: StudioTreeRail -->
          <div class="creation-studio-left" :class="{ 'is-collapsed': !studioLeftOpen }">
            <StudioTreeRail
              v-if="studioLeftOpen"
              :nodes="nodes"
              :canon="canon"
              :sources="sources"
              :active-selection="activeSelection"
              @select-node="selectNode"
              @select-root-board="openRootOutlineBoard"
              @select-canon="selectCanon"
              @select-source="selectSource"
              @create-node="handleCreateNode"
              @delete-node="handleDeleteNode"
              @create-canon="handleCreateCanon"
              @upload-sources="handleUploadSources"
              @add-text-source="handleAddTextSource"
              @delete-source="handleDeleteSource"
            />
          </div>

          <!-- Center Studio Canvas -->
          <main class="creation-studio-center">
            <!-- Folder or Root Outline Board Selected -> OutlineBoard -->
            <OutlineBoard
              v-if="(activeNode && isFolderNode(activeNode)) || showRootOutlineBoard"
              :folder="showRootOutlineBoard ? null : activeNode"
              :nodes="nodes"
              :agent-id="agentId"
              :creation-id="creationId"
              @select-node="selectNode"
              @create-unit="handleCreateNode({ ...$event, kind: 'unit' })"
            />

            <!-- Unit Selected -> ProposalDiffBar + Modality Editor -->
            <div v-else-if="activeNode && !isFolderNode(activeNode)" class="creation-studio-unit-wrap">
              <ProposalDiffBar
                v-if="pendingUnitProposals.length > 0"
                :node="activeNode"
                :current-content="activeNodeContent"
                :proposals="pendingUnitProposals"
                :agent-id="agentId"
                :creation-id="creationId"
                @tune-proposal="handleTuneProposal"
              />
              <component
                :is="readerComponentFor(activeNode)"
                :node="activeNode"
                :content="activeNodeContent"
                :nodes="nodes"
                :sources="sources"
                mode="studio"
                :agent-id="agentId"
                :creation-id="creationId"
                :revisions="revisions"
                :saving="saving"
                :on-save-content="handleSaveContent"
                @save-content="handleSaveContent"
                @select-node="selectNode"
                @request-ai-edit="handleRequestAiEdit"
                @capture-canon="handleCaptureCanon"
                @finalize-node="handleFinalizeNode"
              />
            </div>

            <!-- Canon Item Selected -> CanonEditor -->
            <CanonEditor
              v-else-if="activeCanon"
              :item="activeCanon"
              :agent-id="agentId"
              :creation-id="creationId"
              @deleted="selectCanon(null)"
            />

            <!-- Source Item Selected -> Source Viewer -->
            <section v-else-if="activeSource" class="creation-source-viewer">
              <header class="creation-source-viewer-head">
                <div>
                  <h2 class="creation-source-viewer-title">{{ activeSource.name || activeSource.filename || activeSource.id }}</h2>
                  <div class="creation-source-viewer-meta">
                    <span v-if="activeSource.mimeType">{{ activeSource.mimeType }}</span>
                    <span v-if="activeSourceBytes != null">{{ Math.max(1, Math.round(activeSourceBytes / 1024)) }} KB</span>
                    <span class="creation-status-pill">{{ activeSource.parseStatus || activeSource.status || $t('creation.sources.parsedReady') }}</span>
                  </div>
                </div>
                <div class="creation-source-viewer-actions">
                  <a
                    v-if="activeSourceUrl"
                    :href="activeSourceUrl"
                    :download="activeSource.name || activeSource.filename || activeSource.id"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="creation-glass-btn"
                  >
                    {{ $t('creation.sources.preview') }} ↗
                  </a>
                </div>
              </header>

              <div class="creation-source-viewer-body">
                <img
                  v-if="isSourceImage && activeSourceUrl"
                  :src="activeSourceUrl"
                  :alt="activeSource.name"
                  class="creation-source-img-preview"
                />
                <div v-if="activeSource.summary" class="creation-source-section">
                  <p>{{ activeSource.summary }}</p>
                </div>
                <div v-if="activeSourceText" class="creation-source-section">
                  <pre class="creation-source-text">{{ activeSourceText }}</pre>
                </div>
              </div>
            </section>

            <!-- Nothing Selected -> Clean Studio Welcome Canvas -->
            <section v-else class="creation-studio-welcome">
              <h2 class="creation-welcome-title">{{ creation.title }}</h2>
              <p class="creation-welcome-sub">{{ $t('creation.director.emptyChat') }}</p>
              <div class="creation-welcome-actions">
                <button
                  type="button"
                  class="creation-glass-btn"
                  @click="handleCreateNode({ kind: 'unit', title: $t('creation.studio.addChapter'), modality: 'markdown_doc' })"
                >
                  + {{ $t('creation.studio.newUnit') }}
                </button>
                <label class="creation-glass-btn creation-upload-label">
                  <input type="file" multiple hidden @change="onWelcomeUpload" />
                  <span>📎 {{ $t('creation.sources.upload') }}</span>
                </label>
                <button
                  type="button"
                  class="creation-glass-btn is-primary"
                  @click="studioRightOpen = true; mobileTab = 'director'; directorPrefill = $t('creation.director.slashOutline') + ' '"
                >
                  ✦ {{ $t('creation.director.slashOutline') }}
                </button>
              </div>
            </section>

            <!-- Floating Canon Sync Banner -->
            <CanonSyncBanner
              v-if="pendingCanonProposals.length > 0"
              :proposals="pendingCanonProposals"
              :agent-id="agentId"
              :creation-id="creationId"
            />
          </main>

          <!-- Right Rail: DirectorChatPane -->
          <div class="creation-studio-right" :class="{ 'is-collapsed': !studioRightOpen }">
            <DirectorChatPane
              v-if="studioRightOpen"
              :anchor-mode="false"
              :active-node="activeNode"
              :agent-id="agentId"
              :creation-id="creationId"
              :prefill-text="directorPrefill"
              @select-node="selectNode"
            />
          </div>

          <!-- Mobile < 768px Bottom 3-Tab Bar -->
          <nav class="creation-studio-mobile-tabs" role="tablist">
            <button
              type="button"
              class="creation-studio-mobile-tab"
              :class="{ 'is-active': mobileTab === 'tree' }"
              @click="mobileTab = 'tree'"
            >
              {{ $t('creation.studio.tabArtifacts') }} · {{ $t('creation.studio.tabCanon') }}
            </button>
            <button
              type="button"
              class="creation-studio-mobile-tab"
              :class="{ 'is-active': mobileTab === 'canvas' }"
              @click="mobileTab = 'canvas'"
            >
              {{ $t('creation.studio.editorView') }}
            </button>
            <button
              type="button"
              class="creation-studio-mobile-tab"
              :class="{ 'is-active': mobileTab === 'director' }"
              @click="mobileTab = 'director'"
            >
              {{ $t('creation.director.title') }}
            </button>
          </nav>
        </div>
      </div>

      <!-- Revision History Slide-Over Drawer -->
      <aside v-if="revisionsOpen" class="creation-revisions-drawer">
        <header class="creation-revisions-head">
          <h3>{{ $t('creation.interior.revisions') }}</h3>
          <button type="button" class="creation-icon-mini" @click="revisionsOpen = false">✕</button>
        </header>
        <div class="creation-revisions-body">
          <p v-if="revisions.length === 0" class="creation-revisions-empty">
            {{ $t('creation.proposal.noProposals') }}
          </p>
          <ul v-else class="creation-revisions-list">
            <li v-for="rev in revisions" :key="rev.revId || rev.id" class="creation-revision-item">
              <div class="creation-revision-meta">
                <span class="creation-revision-time">{{ formatRevTime(rev.createdAt) }}</span>
                <span v-if="rev.author" class="creation-revision-author">{{ rev.author }}</span>
              </div>
              <p v-if="rev.summary" class="creation-revision-summary">{{ rev.summary }}</p>
              <button
                type="button"
                class="creation-glass-btn"
                @click="restoreRevision(rev.revId || rev.id)"
              >
                ↺ {{ $t('creation.studio.resume') }}
              </button>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  `,
};
