/**
 * Yeaft Cosmos Creations — StudioTreeRail
 *
 * Left Studio sidebar with 3 tabs: Artifacts, Canon, Sources.
 * Uses exact i18n keys from web/i18n/creations.js and flexible folder detection.
 */
import { useCreationsStore } from '../../../../stores/creations.js';

const STATUS_ICONS = {
  outline: '○',
  drafting: '◌',
  draft: '●',
  final: '✓',
  failed: '!',
};

const MODALITY_ICONS = {
  markdown_doc: '📄',
  slide_deck: '🎞',
  image_gallery: '🖼',
  video_episode: '🎬',
};

const CANON_GROUPS = ['world', 'entity', 'ledger', 'rule'];

function isFolderNode(n) {
  if (!n) return false;
  return n.kind === 'folder' || n.nodeType === 'folder' || n.type === 'folder' || n.isFolder === true;
}

export default {
  name: 'StudioTreeRail',
  setup() {
    const creationsStore = useCreationsStore();
    return { creationsStore };
  },
  props: {
    nodes: { type: Array, default: () => [] },
    canon: { type: Array, default: () => [] },
    sources: { type: Array, default: () => [] },
    activeSelection: { type: Object, default: () => ({ type: null, id: null }) },
  },
  emits: [
    'select-node',
    'select-root-board',
    'select-canon',
    'select-source',
    'create-node',
    'delete-node',
    'create-canon',
    'upload-sources',
    'add-text-source',
    'delete-source',
  ],
  data() {
    return {
      activeTab: 'artifacts',
      collapsedFolders: {},
      creatingKind: null,
      creatingParentId: null,
      newNodeTitle: '',
      newNodeModality: 'markdown_doc',
      creatingCanon: false,
      newCanonType: 'world',
      newCanonTitle: '',
      pasteFormOpen: false,
      pasteName: '',
      pasteText: '',
    };
  },
  computed: {
    sortedNodes() {
      return [...(this.nodes || [])].sort((a, b) => (a.sortOrder ?? a.order ?? 0) - (b.sortOrder ?? b.order ?? 0));
    },
    rootNodes() {
      const idSet = new Set(this.sortedNodes.map((n) => n.id));
      return this.sortedNodes.filter((n) => !n.parentId || !idSet.has(n.parentId));
    },
    childrenByParent() {
      const map = new Map();
      for (const n of this.sortedNodes) {
        if (!n.parentId) continue;
        if (!map.has(n.parentId)) map.set(n.parentId, []);
        map.get(n.parentId).push(n);
      }
      return map;
    },
    flatTreeItems() {
      const result = [];
      const visited = new Set();
      const visit = (list, depth) => {
        for (const node of list) {
          if (!node || !node.id || visited.has(node.id)) continue;
          visited.add(node.id);
          const folder = isFolderNode(node);
          const children = folder ? (this.childrenByParent.get(node.id) || []) : [];
          const isExpanded = folder && !this.collapsedFolders[node.id];
          result.push({
            node,
            depth,
            isFolder: folder,
            hasChildren: children.length > 0,
            isExpanded,
          });
          if (isExpanded && children.length > 0) {
            visit(children, depth + 1);
          }
        }
      };
      visit(this.rootNodes, 0);
      return result;
    },
    canonGroups() {
      return CANON_GROUPS.map((type) => ({
        type,
        items: (this.canon || []).filter((c) => (c.type || 'world') === type),
      }));
    },
  },
  methods: {
    isFolderNode,
    statusIcon(status) {
      return STATUS_ICONS[status] || '○';
    },
    modalityIcon(modality) {
      return MODALITY_ICONS[modality] || '📄';
    },
    childrenOf(folderId) {
      return this.childrenByParent.get(folderId) || [];
    },
    isFolderCollapsed(folderId) {
      return Boolean(this.collapsedFolders[folderId]);
    },
    toggleFolder(folderId) {
      this.collapsedFolders = {
        ...this.collapsedFolders,
        [folderId]: !this.collapsedFolders[folderId],
      };
    },
    isSelected(type, id) {
      return this.activeSelection?.type === type && this.activeSelection?.id === id;
    },
    openCreateNode(kind, parentId = null) {
      this.creatingKind = kind;
      this.creatingParentId = parentId;
      this.newNodeTitle = '';
      this.newNodeModality = 'markdown_doc';
      if (parentId && this.collapsedFolders[parentId]) {
        this.toggleFolder(parentId);
      }
    },
    cancelCreateNode() {
      this.creatingKind = null;
      this.creatingParentId = null;
      this.newNodeTitle = '';
    },
    submitCreateNode() {
      const title = this.newNodeTitle.trim();
      if (!title) return;
      this.$emit('create-node', {
        kind: this.creatingKind,
        parentId: this.creatingParentId,
        title,
        modality: this.creatingKind === 'unit' ? this.newNodeModality : undefined,
      });
      this.cancelCreateNode();
    },
    submitCreateCanon() {
      const title = this.newCanonTitle.trim();
      if (!title) return;
      this.$emit('create-canon', {
        type: this.newCanonType,
        title,
      });
      this.newCanonTitle = '';
      this.creatingCanon = false;
    },
    onFilePick(e) {
      const files = Array.from(e.target?.files || []);
      if (e.target) e.target.value = '';
      if (!files.length) return;
      this.$emit('upload-sources', files);
    },
    submitPasteSource() {
      const text = this.pasteText.trim();
      if (!text) return;
      const name = this.pasteName.trim() || this.$t('creation.sources.pasteNote');
      this.$emit('add-text-source', { name, text });
      this.pasteName = '';
      this.pasteText = '';
      this.pasteFormOpen = false;
    },
  },
  template: `
    <aside class="creation-tree-rail">
      <!-- 3-Tab Switcher -->
      <nav class="creation-tree-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          class="creation-tree-tab"
          :class="{ 'is-active': activeTab === 'artifacts' }"
          :aria-selected="activeTab === 'artifacts'"
          @click="activeTab = 'artifacts'"
        >
          {{ $t('creation.studio.tabArtifacts') }}
          <span class="creation-tree-count">{{ nodes.length }}</span>
        </button>
        <button
          type="button"
          role="tab"
          class="creation-tree-tab"
          :class="{ 'is-active': activeTab === 'canon' }"
          :aria-selected="activeTab === 'canon'"
          @click="activeTab = 'canon'"
        >
          {{ $t('creation.studio.tabCanon') }}
          <span class="creation-tree-count">{{ canon.length }}</span>
        </button>
        <button
          type="button"
          role="tab"
          class="creation-tree-tab"
          :class="{ 'is-active': activeTab === 'sources' }"
          :aria-selected="activeTab === 'sources'"
          @click="activeTab = 'sources'"
        >
          {{ $t('creation.studio.tabSources') }}
          <span class="creation-tree-count">{{ sources.length }}</span>
        </button>
      </nav>

      <!-- TAB 1: Artifacts Tree -->
      <div v-if="activeTab === 'artifacts'" class="creation-tree-panel">
        <div class="creation-tree-actions">
          <button
            type="button"
            class="creation-glass-btn"
            :class="{ 'is-active': activeSelection?.type === 'root-board' }"
            @click="$emit('select-root-board')"
          >
            ⊞ {{ $t('creation.studio.outlineBoard') }}
          </button>
          <button type="button" class="creation-glass-btn" @click="openCreateNode('folder', null)">
            + {{ $t('creation.studio.newFolder') }}
          </button>
          <button type="button" class="creation-glass-btn" @click="openCreateNode('unit', null)">
            + {{ $t('creation.studio.newUnit') }}
          </button>
        </div>

        <form v-if="creatingKind" class="creation-tree-inline-form" @submit.prevent="submitCreateNode">
          <input
            v-model="newNodeTitle"
            class="creation-inline-input"
            :placeholder="creatingKind === 'folder' ? $t('creation.studio.folderPlaceholder') : $t('creation.studio.unitPlaceholder')"
            autofocus
          />
          <select v-if="creatingKind === 'unit'" v-model="newNodeModality" class="creation-compact-select">
            <option value="markdown_doc">{{ $t('creation.kind.book') }}</option>
            <option value="slide_deck">{{ $t('creation.kind.deck') }}</option>
            <option value="image_gallery">{{ $t('creation.kind.gallery') }}</option>
            <option value="video_episode">{{ $t('creation.kind.video') }}</option>
          </select>
          <div class="creation-tree-form-btns">
            <button type="submit" class="creation-glass-btn is-primary">{{ $t('creation.interior.save') }}</button>
            <button type="button" class="creation-glass-btn" @click="cancelCreateNode">{{ $t('creation.canon.dismiss') }}</button>
          </div>
        </form>

        <div v-if="flatTreeItems.length === 0" class="creation-tree-empty">
          {{ $t('creation.studio.noFolders') }}
        </div>

        <ul v-else class="creation-tree-list">
          <li v-for="entry in flatTreeItems" :key="entry.node.id" class="creation-tree-item-wrap">
            <div
              v-if="entry.isFolder"
              class="creation-tree-row is-folder"
              :class="{ 'is-selected': isSelected('node', entry.node.id) }"
              :style="{ paddingLeft: (8 + entry.depth * 14) + 'px' }"
              @click="$emit('select-node', entry.node.id)"
            >
              <button type="button" class="creation-tree-caret" @click.stop="toggleFolder(entry.node.id)">
                {{ entry.isExpanded ? '▾' : '▸' }}
              </button>
              <span class="creation-tree-title">{{ entry.node.title }}</span>
              <span class="creation-tree-row-actions" @click.stop>
                <button type="button" class="creation-icon-mini" :title="$t('creation.studio.newUnit')" @click="openCreateNode('unit', entry.node.id)">+</button>
                <button type="button" class="creation-icon-mini is-danger" :title="$t('creation.inspector.delete')" @click="$emit('delete-node', entry.node.id)">×</button>
              </span>
            </div>

            <div
              v-else
              class="creation-tree-row is-unit"
              :class="{ 'is-selected': isSelected('node', entry.node.id) }"
              :style="{ paddingLeft: (12 + entry.depth * 14) + 'px' }"
              @click="$emit('select-node', entry.node.id)"
            >
              <span class="creation-node-status" :class="'is-' + (entry.node.status || 'outline')">
                {{ statusIcon(entry.node.status) }}
              </span>
              <span class="creation-node-mod" aria-hidden="true">{{ modalityIcon(entry.node.modality) }}</span>
              <span class="creation-tree-title">{{ entry.node.title }}</span>
              <span v-if="entry.node.wordCount" class="creation-tree-wc">{{ entry.node.wordCount }}</span>
              <button
                type="button"
                class="creation-icon-mini is-danger creation-tree-del"
                :title="$t('creation.inspector.delete')"
                @click.stop="$emit('delete-node', entry.node.id)"
              >×</button>
            </div>
          </li>
        </ul>
      </div>

      <!-- TAB 2: Canon -->
      <div v-else-if="activeTab === 'canon'" class="creation-tree-panel">
        <div class="creation-tree-actions">
          <button type="button" class="creation-glass-btn" @click="creatingCanon = !creatingCanon">
            + {{ $t('creation.canon.newItem') }}
          </button>
        </div>

        <form v-if="creatingCanon" class="creation-tree-inline-form" @submit.prevent="submitCreateCanon">
          <select v-model="newCanonType" class="creation-compact-select">
            <option value="world">{{ $t('creation.canon.world') }}</option>
            <option value="entity">{{ $t('creation.canon.entity') }}</option>
            <option value="ledger">{{ $t('creation.canon.ledger') }}</option>
            <option value="rule">{{ $t('creation.canon.rule') }}</option>
          </select>
          <input
            v-model="newCanonTitle"
            class="creation-inline-input"
            :placeholder="$t('creation.canon.titlePlaceholder')"
            autofocus
          />
          <div class="creation-tree-form-btns">
            <button type="submit" class="creation-glass-btn is-primary">{{ $t('creation.interior.save') }}</button>
            <button type="button" class="creation-glass-btn" @click="creatingCanon = false">{{ $t('creation.canon.dismiss') }}</button>
          </div>
        </form>

        <div v-if="canon.length === 0" class="creation-tree-empty">
          {{ $t('creation.canon.empty') }}
        </div>

        <div v-else class="creation-canon-groups">
          <section v-for="grp in canonGroups" :key="grp.type" class="creation-canon-group">
            <h4 class="creation-canon-group-title">
              {{ $t('creation.canon.' + grp.type) }}
              <span class="creation-tree-count">{{ grp.items.length }}</span>
            </h4>
            <ul v-if="grp.items.length" class="creation-tree-list">
              <li
                v-for="item in grp.items"
                :key="item.id"
                class="creation-tree-row is-canon"
                :class="{ 'is-selected': isSelected('canon', item.id) }"
                @click="$emit('select-canon', item.id)"
              >
                <span class="creation-tree-title">{{ item.title }}</span>
                <span class="creation-canon-badges">
                  <span v-if="item.pinned" :title="$t('creation.canon.pinned')">📌</span>
                  <span v-if="item.locked" :title="$t('creation.canon.locked')">🔒</span>
                </span>
              </li>
            </ul>
          </section>
        </div>
      </div>

      <!-- TAB 3: Sources -->
      <div v-else class="creation-tree-panel">
        <div class="creation-tree-actions">
          <label class="creation-glass-btn creation-upload-label">
            <input type="file" multiple hidden @change="onFilePick" />
            <span>+ {{ $t('creation.sources.upload') }}</span>
          </label>
          <button type="button" class="creation-glass-btn" @click="pasteFormOpen = !pasteFormOpen">
            + {{ $t('creation.sources.pasteNote') }}
          </button>
        </div>

        <form v-if="pasteFormOpen" class="creation-tree-inline-form" @submit.prevent="submitPasteSource">
          <input
            v-model="pasteName"
            class="creation-inline-input"
            :placeholder="$t('creation.sources.noteTitlePlaceholder')"
          />
          <textarea
            v-model="pasteText"
            class="creation-inline-textarea"
            rows="4"
            :placeholder="$t('creation.sources.noteContentPlaceholder')"
          ></textarea>
          <div class="creation-tree-form-btns">
            <button type="submit" class="creation-glass-btn is-primary">{{ $t('creation.sources.addNote') }}</button>
            <button type="button" class="creation-glass-btn" @click="pasteFormOpen = false">{{ $t('creation.canon.dismiss') }}</button>
          </div>
        </form>

        <div v-if="sources.length === 0" class="creation-tree-empty">
          {{ $t('creation.sources.empty') }}
        </div>

        <ul v-else class="creation-tree-list">
          <li
            v-for="src in sources"
            :key="src.id"
            class="creation-tree-row is-source"
            :class="{ 'is-selected': isSelected('source', src.id) }"
            @click="$emit('select-source', src.id)"
          >
            <span class="creation-tree-title">{{ src.name || src.filename || src.id }}</span>
            <span class="creation-status-pill">
              {{ src.parseStatus || src.status || $t('creation.sources.parsedReady') }}
            </span>
            <button
              type="button"
              class="creation-icon-mini is-danger creation-tree-del"
              :title="$t('creation.sources.delete')"
              @click.stop="$emit('delete-source', src.id)"
            >×</button>
          </li>
        </ul>
      </div>
    </aside>
  `,
};
