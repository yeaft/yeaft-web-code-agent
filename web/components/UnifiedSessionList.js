import SidebarDigitalPerson from './SidebarDigitalPerson.js';
import { alertDialog, confirmDialog, promptDialog } from '../utils/dialog.js';
import { useUserPreferences } from '../utils/user-preferences.js';
import { buildProjectTree, MAX_PROJECT_DEPTH } from '../stores/helpers/project-tree.js';

function timestampValue(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasCompleteSortRanks(rows) {
  if (rows.length === 0) return false;
  const ranks = rows.map(row => row?.sortRank);
  return ranks.every(Number.isFinite) && new Set(ranks).size === rows.length;
}

function sortRows(rows, ranked = hasCompleteSortRanks(rows)) {
  return [...rows].sort((left, right) => {
    if (!!left.pinned !== !!right.pinned) return left.pinned ? -1 : 1;
    if (ranked) {
      const leftRank = Number.isFinite(left.sortRank) ? left.sortRank : Number.MAX_SAFE_INTEGER;
      const rightRank = Number.isFinite(right.sortRank) ? right.sortRank : Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    const metadataDelta = timestampValue(right.metadataUpdatedAt || right.createdAt)
      - timestampValue(left.metadataUpdatedAt || left.createdAt);
    if (metadataDelta !== 0) return metadataDelta;
    return String(left.catalogKey || '').localeCompare(String(right.catalogKey || ''));
  });
}

function projectIdentityKey(project) {
  return project?.id || '';
}

/** Drag-target key of the top level (outside every folder). */
const ROOT_DROP_KEY = '__root__';

/** Where on a folder header the pointer is: near the edges places, the middle nests. */
function folderHeaderZone(event) {
  const rect = event?.currentTarget?.getBoundingClientRect?.();
  if (!rect || !Number.isFinite(event?.clientY) || rect.height <= 0) return 'inside';
  const ratio = (event.clientY - rect.top) / rect.height;
  if (ratio < 0.3) return 'before';
  if (ratio > 0.7) return 'after';
  return 'inside';
}

function catalogOrderChanged(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return true;
  return left.some((row, index) => row?.catalogKey !== right[index]?.catalogKey);
}

/**
 * Move one catalog row before/after another row, or append it to the catalog.
 * The complete catalog is preserved so hidden/offline Sessions keep a stable
 * rank when a visible row is dragged.
 */
export function reorderSessionCatalogRows(rows, movedKey, targetKey = null, position = 'before') {
  const ordered = Array.isArray(rows) ? [...rows] : [];
  const fromIndex = ordered.findIndex(row => row?.catalogKey === movedKey);
  if (fromIndex < 0) return null;
  const [moved] = ordered.splice(fromIndex, 1);
  if (position === 'append') {
    ordered.push(moved);
    return ordered;
  }
  const targetIndex = ordered.findIndex(row => row?.catalogKey === targetKey);
  if (targetIndex < 0) return null;
  ordered.splice(targetIndex + (position === 'after' ? 1 : 0), 0, moved);
  return ordered;
}

export function calculateFloatingMenuPosition(triggerRect, menuSize, viewport = {}) {
  const gap = 4;
  const padding = 8;
  const viewportWidth = Math.max(0, Number(viewport.width) || 0);
  const viewportHeight = Math.max(0, Number(viewport.height) || 0);
  const width = Math.min(
    Math.max(160, Number(menuSize?.width) || 0),
    Math.max(0, viewportWidth - padding * 2),
  );
  const desiredHeight = Math.max(0, Number(menuSize?.height) || 0);
  const below = Math.max(0, viewportHeight - triggerRect.bottom - gap - padding);
  const above = Math.max(0, triggerRect.top - gap - padding);
  const placeAbove = below < desiredHeight && above > below;
  const maxHeight = Math.min(desiredHeight, placeAbove ? above : below);
  const left = Math.min(
    Math.max(padding, triggerRect.right - width),
    Math.max(padding, viewportWidth - padding - width),
  );
  const naturalTop = placeAbove
    ? triggerRect.top - gap - maxHeight
    : triggerRect.bottom + gap;
  const top = Math.min(
    Math.max(padding, naturalTop),
    Math.max(padding, viewportHeight - padding - maxHeight),
  );
  return { top, left, width, maxHeight, placement: placeAbove ? 'above' : 'below' };
}

export function calculateFloatingSubmenuPosition(parentRect, menuSize, viewport = {}) {
  const gap = 4;
  const padding = 8;
  const viewportWidth = Math.max(0, Number(viewport.width) || 0);
  const viewportHeight = Math.max(0, Number(viewport.height) || 0);
  const width = Math.min(
    Math.max(160, Number(menuSize?.width) || 0),
    Math.max(0, viewportWidth - padding * 2),
  );
  const desiredHeight = Math.max(0, Number(menuSize?.height) || 0);
  const maxHeight = Math.min(desiredHeight, Math.max(0, viewportHeight - padding * 2));
  const roomRight = Math.max(0, viewportWidth - parentRect.right - gap - padding);
  const roomLeft = Math.max(0, parentRect.left - gap - padding);
  const placeLeft = roomRight < width && roomLeft > roomRight;
  const naturalLeft = placeLeft
    ? parentRect.left - gap - width
    : parentRect.right + gap;
  const left = Math.min(
    Math.max(padding, naturalLeft),
    Math.max(padding, viewportWidth - padding - width),
  );
  const top = Math.min(
    Math.max(padding, parentRect.top),
    Math.max(padding, viewportHeight - padding - maxHeight),
  );
  return { top, left, width, maxHeight, placement: placeLeft ? 'left' : 'right' };
}



export default {
  name: 'UnifiedSessionList',
  components: { SidebarDigitalPerson },
  setup() {
    const userPreferences = useUserPreferences();
    Vue.onMounted(() => {
      window.addEventListener('focus', userPreferences.refresh);
      document.addEventListener('visibilitychange', refreshWhenVisible);
    });
    Vue.onBeforeUnmount(() => {
      window.removeEventListener('focus', userPreferences.refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    });
    function refreshWhenVisible() {
      if (document.visibilityState === 'visible') void userPreferences.refresh();
    }
    return {
      collapsedProjects: Vue.computed(() => userPreferences.preferences.value.sidebarCollapsedProjects),
      saveProjectCollapsed: userPreferences.saveSidebarProjectCollapsed,
      actionsCompact: Vue.computed(() => userPreferences.preferences.value.sidebarActionsCompact),
      saveActionsCompact: userPreferences.saveSidebarActionsCompact,
      preferencesReady: userPreferences.ready, preferencesError: userPreferences.error,
      refreshPreferences: userPreferences.refresh,
    };
  },
  emits: ['select', 'create', 'create-task', 'create-in-project', 'action', 'project-action', 'close-work-center'],
  props: {
    sessions: { type: Array, default: () => [] },
    // Keep the final navigation mounted while its owner-scoped inventory loads.
    loading: { type: Boolean, default: false },
    projectStore: { type: Object, default: null },
    projects: { type: Array, default: () => [] },
    activeRoute: { type: Object, default: null },
    isSessionUnread: { type: Function, default: null },
    processingConversations: { type: Object, default: () => ({}) },
    isYeaftSessionProcessing: { type: Function, default: null },
    agents: { type: Array, default: () => [] },
    workCenterOpen: { type: Boolean, default: false },
  },
  data() {
    return {
      actionGeneration: 0,
      actionsTogglePending: false,
      sessionListOverflows: false,
      openMenuKey: null,
      openProjectMenuKey: null,
      suppressedActionsKey: null,
      draggedRow: null,
      dragTargetProjectId: null,
      dragTargetRowKey: null,
      dragTargetPosition: null,
      draggedProjectId: null,
      dragTargetProjectRowId: null,
      dragTargetProjectPosition: null,
      dragOperationPending: false,
      projectCreateOpen: false,
      // The folder the inline "new folder" row is creating into; null = top level.
      projectCreateParentId: null,
      projectCreateName: '',
      projectCreateSubmitting: false,
      projectInstructionOpen: false,
      projectInstructionProject: null,
      projectInstructionDraft: '',
      projectInstructionSubmitting: false,
      floatingMenu: null,
      floatingMenuStyle: {},
      floatingMenuTrigger: null,
      projectSubmenuOpen: false,
      projectSubmenuStyle: {},
    };
  },
  mounted() {
    document.addEventListener('pointerdown', this.closeMenusFromDocument, true);
    document.addEventListener('keydown', this.closeMenusFromKeyboard);
    window.addEventListener('resize', this.positionFloatingMenu);
    window.addEventListener('scroll', this.positionFloatingMenu, true);
    this.actionsResizeObserver = new ResizeObserver(this.scheduleOverflowCheck);
    for (const element of [this.$el, this.$refs.sessionResults]) this.actionsResizeObserver.observe(element);
    this.scheduleOverflowCheck();
  },
  updated() {
    this.scheduleOverflowCheck();
  },
  beforeUnmount() {
    this.actionsResizeObserver?.disconnect();
    cancelAnimationFrame(this.overflowCheckFrame);
    document.removeEventListener('pointerdown', this.closeMenusFromDocument, true);
    document.removeEventListener('keydown', this.closeMenusFromKeyboard);
    window.removeEventListener('resize', this.positionFloatingMenu);
    window.removeEventListener('scroll', this.positionFloatingMenu, true);
  },
  watch: {
    actionsCompact(value) {
      // A server refresh or failed save may remove the overflow-only control.
      // Keep it mounted until focus has a stable destination in the new layout.
      if (!value && document.activeElement === this.$refs.actionsToggle) {
        this.actionsTogglePending = true;
      }
      this.scheduleOverflowCheck();
    },
    loading(value) {
      if (!value) return;
      this.actionGeneration += 1;
      this.closeMenus();
      this.finishAllDrag();
    },
  },
  computed: {
    resolvedProjectStore() {
      if (this.projectStore) return this.projectStore;
      try { return window.Pinia?.useChatStore?.() || null; } catch { return null; }
    },
    hasCompleteCatalogOrder() {
      return hasCompleteSortRanks(this.sessions);
    },
    projectRows() {
      const projects = this.projects.length > 0 ? this.projects : (this.resolvedProjectStore?.sessionProjects || []);
      return [...projects].sort((a, b) => (
        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
      ));
    },
    projectBySessionKey() {
      const out = new Map();
      for (const project of this.projectRows) {
        const members = Array.isArray(project.members)
          ? project.members
          : (project.agentId
              ? (project.sessionIds || []).map(sessionId => ({ agentId: project.agentId, sessionId }))
              : []);
        for (const member of members) {
          if (member?.agentId && member?.sessionId) {
            out.set(`${member.agentId}\u001f${member.sessionId}`, project);
          }
        }
      }
      return out;
    },
    projectSessionRows() {
      const out = new Map(this.projectRows.map(project => [projectIdentityKey(project), []]));
      for (const row of this.sessions) {
        if (row.runtimeProvider !== 'yeaft') continue;
        const project = this.projectBySessionKey.get(`${row.routeRef?.agentId}\u001f${row.routeRef?.sessionId}`);
        const key = projectIdentityKey(project);
        if (project && out.has(key)) out.get(key).push(row);
      }
      return out;
    },
    rowsByProject() {
      const out = new Map();
      for (const [id, rows] of this.projectSessionRows) {
        out.set(id, sortRows(rows.filter(row => this.isRowOnline(row)), this.hasCompleteCatalogOrder));
      }
      return out;
    },
    /** Sessions outside every folder, listed under the top-level folders. */
    rootRows() {
      return sortRows(this.sessions.filter(row => {
        if (!this.isRowOnline(row)) return false;
        if (row.runtimeProvider === 'yeaft') {
          const key = `${row.routeRef?.agentId}\u001f${row.routeRef?.sessionId}`;
          if (this.projectBySessionKey.has(key)) return false;
        }
        return true;
      }), this.hasCompleteCatalogOrder);
    },
    projectTree() {
      return buildProjectTree(this.projectRows);
    },
    maxProjectDepth() {
      return MAX_PROJECT_DEPTH;
    },
    /** Online Sessions anywhere inside each folder, subfolders included. */
    subtreeRowCounts() {
      const counts = new Map();
      const count = (id) => {
        let total = (this.rowsByProject.get(id) || []).length;
        for (const child of this.projectTree.childrenOf(id)) total += count(child.id);
        counts.set(id, total);
        return total;
      };
      for (const project of this.projectTree.childrenOf(null)) count(project.id);
      return counts;
    },
    /**
     * The sidebar as one file tree, flattened for rendering: each folder, then
     * its subfolders, an inline "new folder" row, and its Sessions; the
     * top-level Sessions come after the top-level folders.
     */
    treeItems() {
      const tree = this.projectTree;
      const items = [];
      const createRow = (parentId, depth) => {
        if (this.projectCreateOpen && this.projectCreateParentId === parentId) {
          items.push({ kind: 'create', key: `create:${parentId || ''}`, depth });
        }
      };
      const visit = (parentId, depth) => {
        for (const project of tree.childrenOf(parentId)) {
          const key = projectIdentityKey(project);
          // A folder receiving a new subfolder stays open while the name is typed.
          const creatingHere = this.projectCreateOpen && this.projectCreateParentId === project.id;
          const collapsed = this.isProjectCollapsed(project) && !creatingHere;
          items.push({ kind: 'folder', key: `folder:${key}`, project, depth, collapsed });
          if (collapsed) continue;
          visit(project.id, depth + 1);
          createRow(project.id, depth + 1);
          const rows = this.rowsByProject.get(key) || [];
          for (const row of rows) items.push({ kind: 'session', key: row.catalogKey, row, project, depth: depth + 1 });
          if (!this.loading && rows.length === 0 && !creatingHere && tree.childrenOf(project.id).length === 0) {
            items.push({ kind: 'empty', key: `empty:${key}`, project, depth: depth + 1 });
          }
        }
      };
      visit(null, 0);
      createRow(null, 0);
      // The folders and the top-level Sessions read as two groups without a heading.
      const afterFolders = items.length > 0;
      this.rootRows.forEach((row, index) => items.push({
        kind: 'session', key: row.catalogKey, row, project: null, depth: 0, groupStart: afterFolders && index === 0,
      }));
      return items;
    },
  },
  methods: {
    scheduleOverflowCheck() {
      if (this.overflowCheckFrame) return;
      this.overflowCheckFrame = requestAnimationFrame(() => {
        this.overflowCheckFrame = null;
        this.measureSessionOverflow();
      });
    },
    measureSessionOverflow() {
      const results = this.$refs.sessionResults;
      // A closed desktop rail / mobile drawer has no useful geometry. Keep
      // the last measurement until ResizeObserver sees it become visible.
      if (!results?.clientHeight || !results.clientWidth) return;
      this.sessionListOverflows = results.scrollHeight > results.clientHeight + 1;
      if (this.actionsTogglePending) {
        // Keep the focused toggle mounted while the new layout is measured.
        // If it genuinely disappears, move focus to a stable, visible action.
        if (!this.actionsCompact && !this.sessionListOverflows && document.activeElement === this.$refs.actionsToggle) {
          this.$el.querySelector('.sidebar-primary-action:not(:disabled)')?.focus({ preventScroll: true });
        }
        this.actionsTogglePending = false;
      }
    },
    toggleCompactActions() {
      this.actionsTogglePending = true;
      void this.saveActionsCompact(!this.actionsCompact);
    },
    closeMenus() {
      this.openMenuKey = null;
      this.openProjectMenuKey = null;
      this.floatingMenu = null;
      this.floatingMenuStyle = {};
      this.floatingMenuTrigger = null;
      this.projectSubmenuOpen = false;
      this.projectSubmenuStyle = {};
    },
    closeMenusFromDocument(event) {
      if (event?.target?.closest?.('.session-menu, .session-submenu, .session-dots-btn')) return;
      this.closeMenus();
    },
    closeMenusFromKeyboard(event) {
      if (event?.key !== 'Escape') return;
      this.closeMenus();
      this.cancelProjectCreate();
      if (this.projectInstructionOpen) this.closeProjectInstruction();
    },
    restoreRowActions(row) {
      if (this.suppressedActionsKey === row?.catalogKey) this.suppressedActionsKey = null;
    },
    toggleProjectMenu(project, event) {
      if (this.loading) return;
      const key = projectIdentityKey(project);
      if (this.openProjectMenuKey === key) {
        this.closeMenus();
        return;
      }
      this.openMenuKey = null;
      this.openProjectMenuKey = key;
      this.floatingMenu = { kind: 'project', project };
      this.floatingMenuTrigger = event?.currentTarget || null;
      this.$nextTick(this.positionFloatingMenu);
    },
    toggleSessionMenu(row, inProject, event) {
      if (this.loading) return;
      if (this.openMenuKey === row.catalogKey) {
        this.closeMenus();
        return;
      }
      this.openProjectMenuKey = null;
      this.openMenuKey = row.catalogKey;
      this.floatingMenu = {
        kind: 'session',
        row,
        inProject: inProject === true,
        currentProject: this.projectBySessionKey.get(`${row.routeRef?.agentId}\u001f${row.routeRef?.sessionId}`) || null,
      };
      this.floatingMenuTrigger = event?.currentTarget || null;
      this.$nextTick(this.positionFloatingMenu);
    },
    positionFloatingMenu() {
      const trigger = this.floatingMenuTrigger;
      const menu = this.$refs.floatingMenu;
      if (!this.floatingMenu || !trigger?.isConnected || !menu) {
        if (this.floatingMenu && trigger && !trigger.isConnected) this.closeMenus();
        return;
      }
      const position = calculateFloatingMenuPosition(trigger.getBoundingClientRect(), {
        width: menu.scrollWidth || menu.offsetWidth || 160,
        height: menu.scrollHeight || menu.offsetHeight || 0,
      }, {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: document.documentElement.clientHeight || window.innerHeight,
      });
      this.floatingMenuStyle = {
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: `${position.width}px`,
        maxHeight: `${position.maxHeight}px`,
      };
      if (this.projectSubmenuOpen) this.$nextTick(this.positionProjectSubmenu);
    },
    isActive(row) {
      if (this.resolvedProjectStore?.pluginCenterOpen || this.resolvedProjectStore?.digitalPersonOpen) return false;
      const route = row?.routeRef;
      const active = this.activeRoute;
      return !!route && !!active
        && route.runtimeProvider === active.runtimeProvider
        && route.agentId === active.agentId
        && route.sessionId === active.sessionId;
    },
    isProcessing(row) {
      if (row?.runtimeProvider === 'yeaft') {
        return typeof this.isYeaftSessionProcessing === 'function'
          ? !!this.isYeaftSessionProcessing(row.routeRef.sessionId, row.routeRef.agentId)
          : false;
      }
      return !!this.processingConversations?.[row?.routeRef?.sessionId];
    },
    forkUnavailableReason(row) {
      if (typeof this.resolvedProjectStore?.sessionForkUnavailableReason === 'function') {
        return this.resolvedProjectStore.sessionForkUnavailableReason(row);
      }
      if (!this.canEditRow(row)) return 'agent_offline';
      return this.isProcessing(row) ? 'session_running' : null;
    },
    mergeUnavailableReason(row) {
      return this.resolvedProjectStore?.sessionMergeUnavailableReason?.(row) ||
        (typeof this.resolvedProjectStore?.sessionMergeUnavailableReason !== 'function' ? 'session_merge_unsupported' : null);
    },
    isUnread(row) {
      return typeof this.isSessionUnread === 'function' ? !!this.isSessionUnread(row) : false;
    },
    /** Unread anywhere inside, so a collapsed parent still surfaces it. */
    isProjectUnread(project) {
      return this.projectTree.subtreeIds(projectIdentityKey(project))
        .some(id => (this.projectSessionRows.get(id) || []).some(row => this.isUnread(row)));
    },
    projectSessionCount(project) {
      return this.subtreeRowCounts.get(projectIdentityKey(project)) || 0;
    },
    /** "Outer / Inner" — names a nested folder unambiguously in menus. */
    projectPathLabel(project) {
      return this.projectTree.pathOf(projectIdentityKey(project)).map(item => item.name).join(' / ');
    },
    /** Folder nesting needs a Server-owned folder; Agent-local legacy ones stay flat. */
    canNestProject(project) {
      return this.canEditProject(project) && !project.legacyProjectId;
    },
    canCreateSubfolder(project) {
      return this.canNestProject(project)
        && this.projectTree.depthOf(projectIdentityKey(project)) < MAX_PROJECT_DEPTH;
    },
    projectKey(project) {
      return projectIdentityKey(project);
    },
    isAgentOnline(agentId) {
      return !!agentId && this.agents.some(agent => agent.id === agentId && agent.online);
    },
    isRowOnline(row) {
      if (row?.availability !== 'online') return false;
      return this.isAgentOnline(row?.routeRef?.agentId);
    },
    canEditProject(project) {
      if (this.loading) return false;
      if (!project?.id) return false;
      return !project.legacyAgentId || this.isAgentOnline(project.legacyAgentId);
    },
    canEditRow(row) {
      if (this.loading) return false;
      if (!row?.routeRef?.agentId || row.availability !== 'online') return false;
      return this.isAgentOnline(row.routeRef.agentId);
    },
    canRunAction(row, action) {
      return this.canEditRow(row)
        && this.resolvedProjectStore?.catalogSessionActionSupported?.(row, action) !== false;
    },
    canMoveRowToProject(row, project = null) {
      if (!this.canEditRow(row)) return false;
      if (!project) return true;
      if (!this.canEditProject(project)) return false;
      return !project.legacyAgentId || project.legacyAgentId === row.routeRef.agentId;
    },
    /** Folders a Session can move into, in tree order with their depth. */
    projectMoveTargets(row, currentProject = null) {
      const currentProjectId = projectIdentityKey(currentProject);
      return this.projectTree.flatten().filter(({ project }) => (
        projectIdentityKey(project) !== currentProjectId
        && this.canMoveRowToProject(row, project)
      ));
    },
    /** Where a folder can move: the top level, then every folder outside its own subtree. */
    folderMoveTargets(project) {
      if (!this.canNestProject(project)) return [];
      const tree = this.projectTree;
      const currentParentId = tree.parentOf(project.id);
      const targets = currentParentId && tree.canMove(project.id, null)
        ? [{ project: null, depth: 0 }]
        : [];
      for (const target of tree.flatten()) {
        if (target.project.id === currentParentId || !this.canNestProject(target.project)) continue;
        if (tree.canMove(project.id, target.project.id)) targets.push(target);
      }
      return targets;
    },
    openProjectMoveList() {
      if (!this.floatingMenu) return;
      this.projectSubmenuOpen = true;
      this.$nextTick(this.positionProjectSubmenu);
    },
    closeProjectMoveList() {
      this.projectSubmenuOpen = false;
      this.projectSubmenuStyle = {};
    },
    positionProjectSubmenu() {
      const parentMenu = this.$refs.floatingMenu;
      const submenu = this.$refs.projectSubmenu;
      if (!this.projectSubmenuOpen || !parentMenu || !submenu) return;
      const position = calculateFloatingSubmenuPosition(parentMenu.getBoundingClientRect(), {
        width: submenu.scrollWidth || submenu.offsetWidth || 160,
        height: submenu.scrollHeight || submenu.offsetHeight || 0,
      }, {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: document.documentElement.clientHeight || window.innerHeight,
      });
      this.projectSubmenuStyle = {
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: `${position.width}px`,
        maxHeight: `${position.maxHeight}px`,
      };
    },
    isProjectCollapsed(project) {
      return this.collapsedProjects[projectIdentityKey(project)] === true;
    },
    toggleProject(project) {
      if (!this.preferencesReady) return;
      const key = projectIdentityKey(project);
      void this.saveProjectCollapsed(key, !this.isProjectCollapsed(project));
      this.closeMenus();
    },
    providerLabel(row) {
      if (row.runtimeProvider === 'yeaft') return 'Yeaft';
      if (row.runtimeProvider === 'copilot') return 'Copilot';
      return 'Claude';
    },
    agentLabel(row) {
      const agent = this.agents.find(item => item.id === row?.routeRef?.agentId);
      return row?.agentName || agent?.name || row?.routeRef?.agentId || '';
    },
    openPlugins() {
      const store = this.resolvedProjectStore;
      if (typeof store?.openPluginCenter !== 'function') return;
      if (store.openPluginCenter() !== false) store.closeSessionSidebar?.();
    },
    createTask() {
      if (this.loading) return;
      this.resolvedProjectStore?.leaveDigitalPerson?.();
      this.resolvedProjectStore?.closePluginCenter?.();
      if (this.workCenterOpen) this.$emit('close-work-center');
      this.$emit('create-task');
    },
    createSession() {
      if (this.loading) return;
      this.resolvedProjectStore?.leaveDigitalPerson?.();
      this.resolvedProjectStore?.closePluginCenter?.();
      if (this.workCenterOpen) this.$emit('close-work-center');
      this.$emit('create');
    },
    createSessionInProject(project, { taskMode = false } = {}) {
      if (!this.canEditProject(project)) return;
      this.closeMenus();
      this.resolvedProjectStore?.leaveDigitalPerson?.();
      this.resolvedProjectStore?.closePluginCenter?.();
      if (this.workCenterOpen) this.$emit('close-work-center');
      this.$emit('create-in-project', { project, taskMode });
    },
    selectRow(row, event, options = {}) {
      if (this.loading) return;
      if (options.suppressActions === true) {
        this.suppressedActionsKey = row?.catalogKey || null;
        event?.currentTarget?.blur?.();
      }
      this.closeMenus();
      if (this.workCenterOpen) this.$emit('close-work-center');
      this.$emit('select', row);
    },
    selectRowFromKeyboard(row, event) {
      if (event?.target !== event?.currentTarget) return;
      event.preventDefault();
      this.selectRow(row, event);
    },
    async runAction(action, row) {
      // Merge removes its menu item; let the dialog return focus to a stable trigger.
      if (action === 'merge') this.floatingMenuTrigger?.focus();
      this.closeMenus();
      const normalizedAction = action === 'delete' ? 'remove' : action;
      if (!this.canRunAction(row, normalizedAction)) return;
      if (action === 'copy' && this.forkUnavailableReason(row)) return;
      if (action === 'merge' && this.mergeUnavailableReason(row)) return;
      if (action === 'rename') {
        const generation = this.actionGeneration;
        const title = await promptDialog(this.$t('yeaft.session.renamePrompt', { name: row.title }), row.title);
        const currentRow = this.sessions.find(item => item.catalogKey === row.catalogKey);
        if (!title?.trim() || title.trim() === row.title
            || generation !== this.actionGeneration || !this.canRunAction(currentRow, action)
            || currentRow.routeRef.runtimeProvider !== row.routeRef.runtimeProvider
            || currentRow.routeRef.agentId !== row.routeRef.agentId
            || currentRow.routeRef.sessionId !== row.routeRef.sessionId) return;
        this.$emit('action', { action, row: currentRow, title: title.trim() });
        return;
      }
      this.$emit('action', { action: normalizedAction, row });
    },
    dispatchSessionAction(payload) {
      if (this.loading) return false;
      if (payload?.action === 'reorder' && this.resolvedProjectStore?.reorderCatalogSessions) {
        return this.resolvedProjectStore.reorderCatalogSessions(payload.sessions);
      }
      this.$emit('action', payload);
      return true;
    },
    dispatchProjectAction(payload) {
      if (this.loading) return false;
      if (payload?.action === 'move-session'
          && !this.canMoveRowToProject(payload?.row, payload?.project || null)) return false;
      this.$emit('project-action', payload);
      const store = this.resolvedProjectStore;
      if (!store?.mutateProject) return true;
      const { action, project, row, name, catalogOrder, agentId: explicitAgentId } = payload;
      const agentId = explicitAgentId || row?.routeRef?.agentId || null;
      if (action === 'create') {
        return store.mutateProject('create', { name, ...(payload.parentId ? { parentId: payload.parentId } : {}) }, agentId);
      }
      const projectId = project?.legacyProjectId || project?.id;
      if (action === 'rename') return store.mutateProject('rename', { projectId, name }, project?.legacyAgentId || agentId);
      if (action === 'update-instruction') {
        return store.mutateProject('update_instruction', {
          projectId,
          instruction: payload.instruction || '',
        }, project?.legacyAgentId || agentId);
      }
      if (action === 'delete') return store.mutateProject('delete', { projectId }, project?.legacyAgentId || agentId);
      if (action === 'move-project') {
        return store.mutateProject('move_project', {
          projectId,
          parentId: payload.parentId || null,
          beforeProjectId: payload.beforeProjectId || null,
        });
      }
      if (action === 'move-session' && row?.routeRef?.sessionId) {
        return store.mutateProject('move_session', {
          sessionId: row.routeRef.sessionId,
          projectId: project?.legacyProjectId || project?.id || null,
          ...(Array.isArray(catalogOrder) ? {
            catalogOrder: catalogOrder.map(item => ({
              catalogKey: item.catalogKey,
              routeRef: item.routeRef,
            })),
          } : {}),
        }, agentId);
      }
      return false;
    },
    /** Run a folder change and say so when the Server refuses it. */
    async runFolderAction(payload) {
      const result = await this.dispatchProjectAction(payload);
      if (result && typeof result === 'object' && result.ok === false) {
        const message = result.error?.message || result.error?.code || 'unknown';
        await alertDialog(this.$t('sidebar.projects.actionFailed', { message }));
      }
      return result;
    },
    /** Open the inline name row at the top level, or inside `parent`. */
    createProject(parent = null) {
      if (this.loading || this.projectCreateSubmitting) return;
      if (parent && !this.canCreateSubfolder(parent)) return;
      this.closeMenus();
      this.projectCreateOpen = true;
      this.projectCreateParentId = parent ? parent.id : null;
      this.projectCreateName = '';
      if (parent && this.isProjectCollapsed(parent)) void this.saveProjectCollapsed(projectIdentityKey(parent), false);
      this.$nextTick(() => {
        const input = [].concat(this.$refs.projectCreateInput || [])[0];
        input?.focus?.({ preventScroll: true });
        input?.scrollIntoView?.({ block: 'nearest' });
      });
    },
    cancelProjectCreate() {
      if (this.projectCreateSubmitting) return;
      this.projectCreateOpen = false;
      this.projectCreateParentId = null;
      this.projectCreateName = '';
    },
    async submitProjectCreate() {
      if (this.loading) return;
      const name = this.projectCreateName.trim();
      if (!name || this.projectCreateSubmitting) return;
      this.projectCreateSubmitting = true;
      try {
        const result = await this.runFolderAction({ action: 'create', name, parentId: this.projectCreateParentId });
        if (result?.ok !== false) {
          this.projectCreateOpen = false;
          this.projectCreateParentId = null;
          this.projectCreateName = '';
        }
      } finally {
        this.projectCreateSubmitting = false;
      }
    },
    async renameProject(project) {
      if (!this.canEditProject(project)) return;
      const name = await promptDialog(this.$t('sidebar.projects.renamePrompt'), project.name);
      this.closeMenus();
      if (name?.trim() && name.trim() !== project.name) {
        void this.runFolderAction({ action: 'rename', project, name: name.trim() });
      }
    },
    async deleteProject(project) {
      if (!this.canEditProject(project)) return;
      this.closeMenus();
      const subfolders = Math.max(0, this.projectTree.subtreeIds(projectIdentityKey(project)).length - 1);
      const message = subfolders > 0
        ? this.$t('sidebar.projects.deleteConfirmNested', { name: project.name, count: subfolders })
        : this.$t('sidebar.projects.deleteConfirm', { name: project.name });
      if (await confirmDialog(message, { destructive: true })) {
        void this.runFolderAction({ action: 'delete', project });
      }
    },
    moveFolderTo(project, parent = null) {
      this.closeMenus();
      const parentId = parent ? parent.id : null;
      if (!this.canNestProject(project) || !this.projectTree.canMove(project.id, parentId)) return false;
      return this.runFolderAction({ action: 'move-project', project, parentId, beforeProjectId: null });
    },
    editProjectInstruction(project) {
      if (!this.canEditProject(project)) return;
      this.closeMenus();
      this.projectInstructionProject = project;
      this.projectInstructionDraft = typeof project.instruction === 'string' ? project.instruction : '';
      this.projectInstructionOpen = true;
      this.$nextTick(() => this.$refs.projectInstructionInput?.focus?.());
    },
    closeProjectInstruction() {
      if (this.projectInstructionSubmitting) return;
      this.projectInstructionOpen = false;
      this.projectInstructionProject = null;
      this.projectInstructionDraft = '';
    },
    async saveProjectInstruction() {
      const project = this.projectInstructionProject;
      if (!project || this.projectInstructionSubmitting) return;
      this.projectInstructionSubmitting = true;
      try {
        const result = await this.dispatchProjectAction({
          action: 'update-instruction',
          project,
          instruction: this.projectInstructionDraft,
        });
        if (result?.ok !== false) {
          this.projectInstructionOpen = false;
          this.projectInstructionProject = null;
          this.projectInstructionDraft = '';
        }
      } finally {
        this.projectInstructionSubmitting = false;
      }
    },
    moveRow(row, project = null, catalogOrder = null) {
      this.closeMenus();
      if (!this.canMoveRowToProject(row, project)) return false;
      return this.dispatchProjectAction({ action: 'move-session', row, project, catalogOrder });
    },
    projectForRow(row) {
      if (row?.runtimeProvider !== 'yeaft') return null;
      const key = `${row.routeRef?.agentId}\u001f${row.routeRef?.sessionId}`;
      return this.projectBySessionKey.get(key) || null;
    },
    canDragProject(project) {
      return !!project?.id
        && !project.legacyProjectId
        && this.projectRows.length > 1
        && this.projectRows.every(row => row?.id && !row.legacyProjectId)
        && !this.dragOperationPending;
    },
    startProjectDrag(project, event) {
      if (!this.canDragProject(project)) return;
      this.closeMenus();
      this.finishDrag();
      this.draggedProjectId = projectIdentityKey(project);
      if (event?.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', `project:${this.draggedProjectId}`);
      }
    },
    /**
     * Resolve a folder dropped on `target`'s header: the top and bottom edges
     * place it among target's siblings, the middle nests it inside target.
     * Below an open folder the next row is its first child, so its bottom
     * edge nests too. Null when the move would cycle or exceed the depth limit.
     */
    folderHeaderDrop(target, event) {
      const movedId = this.draggedProjectId;
      const tree = this.projectTree;
      if (!movedId || !target?.id || movedId === target.id || !this.canNestProject(target)) return null;
      const zone = folderHeaderZone(event);
      const open = !this.isProjectCollapsed(target)
        && (tree.childrenOf(target.id).length > 0 || (this.rowsByProject.get(target.id) || []).length > 0);
      const position = zone === 'after' && open ? 'inside' : zone;
      const parentId = position === 'inside' ? target.id : tree.parentOf(target.id);
      if (!tree.canMove(movedId, parentId)) return null;
      if (position === 'inside') return { position, parentId, beforeProjectId: null };
      const siblings = tree.childrenOf(parentId).filter(item => item.id !== movedId);
      const index = siblings.findIndex(item => item.id === target.id);
      const beforeProjectId = position === 'before' ? target.id : (siblings[index + 1]?.id || null);
      return { position, parentId, beforeProjectId };
    },
    /** Same parent and same slot: dropping there would change nothing. */
    isFolderMoveNoop(movedId, parentId, beforeProjectId) {
      const tree = this.projectTree;
      if (tree.parentOf(movedId) !== parentId) return false;
      const siblings = tree.childrenOf(parentId).map(item => item.id);
      const remaining = siblings.filter(id => id !== movedId);
      const index = beforeProjectId ? remaining.indexOf(beforeProjectId) : remaining.length;
      return index === siblings.indexOf(movedId);
    },
    dragOverProjectRow(project, event) {
      const drop = this.folderHeaderDrop(project, event);
      if (!drop || this.isFolderMoveNoop(this.draggedProjectId, drop.parentId, drop.beforeProjectId)) {
        if (this.dragTargetProjectRowId === projectIdentityKey(project)) {
          this.dragTargetProjectRowId = null;
          this.dragTargetProjectPosition = null;
        }
        return;
      }
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.dragTargetProjectId = null;
      this.dragTargetProjectRowId = projectIdentityKey(project);
      this.dragTargetProjectPosition = drop.position;
    },
    dragLeaveProjectRow(project, event) {
      if (this.dragTargetProjectRowId !== projectIdentityKey(project)) return;
      const next = event?.relatedTarget;
      if (next && event?.currentTarget?.contains?.(next)) return;
      this.dragTargetProjectRowId = null;
      this.dragTargetProjectPosition = null;
    },
    async dropProjectRow(project, event) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const movedId = this.draggedProjectId;
      const drop = this.folderHeaderDrop(project, event);
      this.finishProjectDrag();
      if (!drop || this.isFolderMoveNoop(movedId, drop.parentId, drop.beforeProjectId)) return false;
      return this.applyFolderMove(movedId, drop.parentId, drop.beforeProjectId);
    },
    /** A folder dropped on a folder's contents nests in it; on the top-level area it moves to the top level. */
    canDropFolderInto(parentId) {
      const movedId = this.draggedProjectId;
      if (!movedId || this.dragOperationPending) return false;
      if (parentId && !this.canNestProject(this.projectTree.byId.get(parentId))) return false;
      return this.projectTree.canMove(movedId, parentId) && !this.isFolderMoveNoop(movedId, parentId, null);
    },
    dragOverFolderInto(project, event) {
      const parentId = project?.id || null;
      if (!this.canDropFolderInto(parentId)) {
        this.clearDragTarget();
        return;
      }
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.dragTargetProjectRowId = null;
      this.dragTargetProjectPosition = null;
      this.dragTargetProjectId = parentId || ROOT_DROP_KEY;
    },
    async dropFolderInto(project, event) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const movedId = this.draggedProjectId;
      const parentId = project?.id || null;
      const allowed = this.canDropFolderInto(parentId);
      this.finishAllDrag();
      if (!allowed) return false;
      return this.applyFolderMove(movedId, parentId, null);
    },
    async applyFolderMove(movedId, parentId, beforeProjectId) {
      const project = this.projectTree.byId.get(movedId);
      if (!project) return false;
      this.dragOperationPending = true;
      try {
        const result = await this.runFolderAction({ action: 'move-project', project, parentId, beforeProjectId });
        return result !== false && result?.ok !== false;
      } finally {
        this.dragOperationPending = false;
      }
    },
    isFolderDropInto(project) {
      const key = projectIdentityKey(project);
      return this.dragTargetProjectId === key
        || (this.dragTargetProjectRowId === key && this.dragTargetProjectPosition === 'inside');
    },
    isRootDropTarget() {
      return this.dragTargetProjectId === ROOT_DROP_KEY;
    },
    finishProjectDrag() {
      this.draggedProjectId = null;
      this.dragTargetProjectRowId = null;
      this.dragTargetProjectPosition = null;
    },
    canDragRow(row, project = null) {
      if (this.dragOperationPending || !this.canRunAction(row, 'reorder')) return false;
      if (!project) return true;
      if (row?.runtimeProvider !== 'yeaft') return false;
      const sameProject = projectIdentityKey(this.projectForRow(row)) === projectIdentityKey(project);
      return sameProject || this.canMoveRowToProject(row, project);
    },
    canDropRow(row, project = null) {
      if (!row || this.dragOperationPending || !this.canRunAction(row, 'reorder')) return false;
      if (!project) return row.runtimeProvider === 'yeaft' || !this.projectForRow(row);
      if (row.runtimeProvider !== 'yeaft') return false;
      const sameProject = projectIdentityKey(this.projectForRow(row)) === projectIdentityKey(project);
      return sameProject ? this.canEditRow(row) : this.canMoveRowToProject(row, project);
    },
    startDrag(row, event) {
      if (!this.canDragRow(row, this.projectForRow(row))) return;
      this.closeMenus();
      this.finishProjectDrag();
      this.draggedRow = row;
      this.dragTargetProjectId = null;
      this.dragTargetRowKey = null;
      this.dragTargetPosition = null;
      if (event?.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', row.catalogKey);
      }
    },
    dragPositionForEvent(event) {
      const rect = event?.currentTarget?.getBoundingClientRect?.();
      if (!rect || !Number.isFinite(event?.clientY)) return 'before';
      return event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
    },
    dragOverRow(row, project, event) {
      if (this.draggedProjectId) {
        this.dragOverFolderInto(project, event);
        return;
      }
      const moved = this.draggedRow;
      if (!this.canDropRow(moved, project)
          || !this.canRunAction(row, 'reorder')
          || moved.catalogKey === row?.catalogKey
          || !!moved.pinned !== !!row?.pinned) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.dragTargetProjectId = null;
      this.dragTargetRowKey = row.catalogKey;
      this.dragTargetPosition = this.dragPositionForEvent(event);
    },
    dragLeaveRow(row, event, project = null) {
      if (this.draggedProjectId) {
        this.clearGroupDragTarget(projectIdentityKey(project) || ROOT_DROP_KEY, event);
        return;
      }
      if (this.dragTargetRowKey !== row?.catalogKey) return;
      const next = event?.relatedTarget;
      if (next && event?.currentTarget?.contains?.(next)) return;
      this.dragTargetRowKey = null;
      this.dragTargetPosition = null;
    },
    async dropOnRow(row, project, event) {
      if (this.draggedProjectId) return this.dropFolderInto(project, event);
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const moved = this.draggedRow;
      const position = this.dragTargetRowKey === row?.catalogKey
        ? this.dragTargetPosition
        : this.dragPositionForEvent(event);
      this.finishDrag();
      if (!this.canDropRow(moved, project) || !this.canRunAction(row, 'reorder') || !position) return false;
      return this.applySessionDrop(moved, project, row, position);
    },
    dragOverProjectHeader(project, event) {
      if (this.draggedProjectId) {
        this.dragOverProjectRow(project, event);
        return;
      }
      this.dragOverProject(project, event);
    },
    clearProjectHeaderDragTarget(project, event) {
      if (this.draggedProjectId) {
        this.dragLeaveProjectRow(project, event);
        return;
      }
      this.clearGroupDragTarget(projectIdentityKey(project), event);
    },
    dropOnProjectHeader(project, event) {
      if (this.draggedProjectId) return this.dropProjectRow(project, event);
      return this.dropOnProject(project, event);
    },
    dragOverProject(project, event) {
      if (!this.canDropRow(this.draggedRow, project)) {
        this.clearDragTarget();
        return;
      }
      event?.preventDefault?.();
      if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.dragTargetProjectId = projectIdentityKey(project);
      this.dragTargetRowKey = null;
      this.dragTargetPosition = null;
    },
    async dropOnProject(project, event) {
      event?.preventDefault?.();
      const moved = this.draggedRow;
      this.finishDrag();
      if (!this.canDropRow(moved, project)) return false;
      return this.applySessionDropAtEnd(moved, project);
    },
    /** The empty-folder hint takes the same drops as the folder itself. */
    dragOverFolderContents(project, event) {
      if (this.draggedProjectId) {
        this.dragOverFolderInto(project, event);
        return;
      }
      this.dragOverProject(project, event);
    },
    dropOnFolderContents(project, event) {
      if (this.draggedProjectId) return this.dropFolderInto(project, event);
      return this.dropOnProject(project, event);
    },
    /** The space below the last row: drops land at the end of the top level. */
    dragOverRoot(event) {
      if (this.draggedProjectId) {
        this.dragOverFolderInto(null, event);
        return;
      }
      if (!this.canDropRow(this.draggedRow, null)) {
        this.clearDragTarget();
        return;
      }
      event?.preventDefault?.();
      if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.dragTargetProjectId = ROOT_DROP_KEY;
      this.dragTargetRowKey = null;
      this.dragTargetPosition = null;
    },
    async dropOnRoot(event) {
      if (this.draggedProjectId) return this.dropFolderInto(null, event);
      event?.preventDefault?.();
      const moved = this.draggedRow;
      this.finishDrag();
      if (!this.canDropRow(moved, null)) return false;
      return this.applySessionDropAtEnd(moved, null);
    },
    clearGroupDragTarget(key, event) {
      if (this.dragTargetProjectId !== key) return;
      const next = event?.relatedTarget;
      if (next && event?.currentTarget?.contains?.(next)) return;
      this.dragTargetProjectId = null;
    },
    clearDragTarget() {
      this.dragTargetProjectId = null;
      this.dragTargetRowKey = null;
      this.dragTargetPosition = null;
    },
    finishDrag() {
      this.draggedRow = null;
      this.clearDragTarget();
    },
    finishAllDrag() {
      this.finishDrag();
      this.finishProjectDrag();
    },
    rowsForProject(project = null) {
      return project
        ? (this.rowsByProject.get(projectIdentityKey(project)) || [])
        : this.rootRows;
    },
    async applySessionDropAtEnd(moved, project = null) {
      const targetRows = this.rowsForProject(project)
        .filter(row => row.catalogKey !== moved?.catalogKey);
      const target = targetRows.at(-1) || null;
      return this.applySessionDrop(moved, project, target, target ? 'after' : 'append');
    },
    async applySessionDrop(moved, project, target, position) {
      if (!moved?.catalogKey || !this.canDropRow(moved, project)) return false;
      const currentOrder = sortRows(this.sessions);
      const nextOrder = reorderSessionCatalogRows(
        currentOrder,
        moved.catalogKey,
        target?.catalogKey || null,
        position,
      );
      if (!nextOrder) return false;

      const sourceProject = this.projectForRow(moved);
      const membershipChanged = projectIdentityKey(sourceProject) !== projectIdentityKey(project);
      const orderChanged = catalogOrderChanged(currentOrder, nextOrder);
      if (!membershipChanged && !orderChanged) return false;

      this.dragOperationPending = true;
      try {
        if (membershipChanged) {
          const result = await this.moveRow(moved, project, nextOrder);
          return result !== false && result?.ok !== false;
        }
        if (orderChanged) {
          const accepted = await this.dispatchSessionAction({
            action: 'reorder',
            row: moved,
            sessions: nextOrder,
          });
          return accepted !== false;
        }
        return true;
      } finally {
        this.dragOperationPending = false;
      }
    },
  },
  template: `
    <nav class="sidebar-navigation" :aria-busy="loading" :aria-label="$t('sidebar.surface.sessions')">
      <div class="sidebar-primary-actions" :class="{ 'is-compact': actionsCompact }">
        <button type="button" class="btn-ghost sidebar-primary-action sidebar-chat-create" :disabled="loading" @click="createSession" :title="$t('sidebar.sessions.newChat')" :aria-label="$t('sidebar.sessions.newChat')">
          <svg class="sidebar-primary-action-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path class="sidebar-primary-action-frame" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path class="sidebar-primary-action-pen" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852Z"/>
          </svg>
          <span v-if="!actionsCompact">{{ $t('sidebar.sessions.newChat') }}</span>
        </button>
        <button type="button" class="btn-ghost sidebar-primary-action sidebar-task-create" :disabled="loading" @click="createTask" :title="$t('scheduledTasks.new')" :aria-label="$t('scheduledTasks.new')">
          <svg class="sidebar-primary-action-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 6v6l4 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <span v-if="!actionsCompact">{{ $t('scheduledTasks.new') }}</span>
        </button>
        <button type="button" class="btn-ghost sidebar-primary-action sidebar-folder-create" :disabled="loading || projectCreateSubmitting" @click="createProject()" :title="$t('sidebar.projects.new')" :aria-label="$t('sidebar.projects.new')">
          <svg class="sidebar-primary-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 11v6M9 14h6"/></svg>
          <span v-if="!actionsCompact">{{ $t('sidebar.projects.new') }}</span>
        </button>
        <slot name="after-create">
          <button v-if="resolvedProjectStore?.openPluginCenter" type="button"
                  class="btn-ghost sidebar-primary-action sidebar-plugins-entry"
                  :class="{ active: resolvedProjectStore.pluginCenterOpen }"
                  :title="$t('yeaft.plugins.title')" :aria-label="$t('yeaft.plugins.title')"
                  :aria-current="resolvedProjectStore.pluginCenterOpen ? 'page' : undefined"
                  :disabled="!(resolvedProjectStore.pluginCenterAgents || agents).some(agent => agent?.online || resolvedProjectStore.pluginConfigByAgent?.[agent.id]?.loaded)" @click="openPlugins">
            <svg class="sidebar-primary-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M9 5V4a2.5 2.5 0 0 1 5 0v1h3a2 2 0 0 1 2 2v3h1a2.5 2.5 0 0 1 0 5h-1v4a2 2 0 0 1-2 2h-3v-1a2.5 2.5 0 0 0-5 0v1H5a2 2 0 0 1-2-2v-4h1a2.5 2.5 0 0 0 0-5H3V7a2 2 0 0 1 2-2Z"/></svg>
            <span v-if="!actionsCompact">{{ $t('yeaft.plugins.title') }}</span>
          </button>
        </slot>
        <SidebarDigitalPerson :compact="actionsCompact" />
        <button v-if="actionsCompact || sessionListOverflows || actionsTogglePending" ref="actionsToggle" type="button"
                class="btn-ghost sidebar-actions-toggle" :aria-expanded="!actionsCompact"
                :disabled="!preferencesReady"
                :aria-label="$t(actionsCompact ? 'sidebar.actions.expand' : 'sidebar.actions.collapse')"
                :title="$t(actionsCompact ? 'sidebar.actions.expand' : 'sidebar.actions.collapse')"
                @click="toggleCompactActions">
          <svg class="sidebar-section-chevron" :class="{ collapsed: actionsCompact }" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m8 10 4 4 4-4"/></svg>
        </button>
      </div>

      <!-- One file tree: folders (nested) first, each with its subfolders and
           Sessions; Sessions outside every folder follow at the top level. -->
      <div ref="sessionResults" class="sidebar-session-results sidebar-tree">
        <div v-if="loading" class="sidebar-section-empty sidebar-catalog-loading" role="status"><span class="spinner-mini" aria-hidden="true"></span>{{ $t('common.loading') }}</div>
        <template v-for="item in treeItems" :key="item.key">
          <div v-if="item.kind === 'folder'"
            class="sidebar-project-header"
            :class="{ 'menu-open': openProjectMenuKey === projectKey(item.project), 'drag-over': isFolderDropInto(item.project), dragging: draggedProjectId === projectKey(item.project), 'project-drag-before': dragTargetProjectRowId === projectKey(item.project) && dragTargetProjectPosition === 'before', 'project-drag-after': dragTargetProjectRowId === projectKey(item.project) && dragTargetProjectPosition === 'after' }"
            :style="{ '--tree-depth': item.depth }"
            :draggable="canDragProject(item.project)"
            @dragstart="startProjectDrag(item.project, $event)"
            @dragover="dragOverProjectHeader(item.project, $event)"
            @dragleave="clearProjectHeaderDragTarget(item.project, $event)"
            @drop="dropOnProjectHeader(item.project, $event)"
            @dragend="finishAllDrag"
          >
            <button type="button" class="sidebar-project-toggle" :disabled="!preferencesReady" @click="toggleProject(item.project)" :aria-expanded="String(!item.collapsed)">
              <svg v-if="item.collapsed" class="sidebar-project-icon sidebar-project-icon-closed" viewBox="0 0 20 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M2.5 7.5a2 2 0 0 1 2-2h4l1.8 2H15.5a2 2 0 0 1 2 2V18h-15z"/></svg>
              <svg v-else class="sidebar-project-icon sidebar-project-icon-open" viewBox="0 0 20 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M2.5 9V7a2 2 0 0 1 2-2h4l1.8 2h5.2a2 2 0 0 1 2 2v1M3.5 10h15l-2 8h-15z"/></svg>
              <span class="sidebar-project-name">{{ item.project.name }}</span>
              <span class="sidebar-project-count">{{ projectSessionCount(item.project) }}</span>
              <span v-if="isProjectUnread(item.project)" class="sidebar-session-unread sidebar-project-unread" :aria-label="$t('sidebar.sessions.unread')"></span>
            </button>
            <span v-if="canEditProject(item.project)" class="sidebar-folder-actions" :class="{ 'menu-open': openProjectMenuKey === projectKey(item.project) }">
            <button type="button" class="sidebar-project-session-create" @click.stop="createSessionInProject(item.project)" :title="$t('sidebar.projects.newSession', { name: item.project.name })" :aria-label="$t('sidebar.projects.newSession', { name: item.project.name })">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852Z"/>
              </svg>
            </button>
            <button type="button" class="sidebar-project-session-create sidebar-project-task-create" @click.stop="createSessionInProject(item.project, { taskMode: true })" :title="$t('sidebar.projects.newTask', { name: item.project.name })" :aria-label="$t('sidebar.projects.newTask', { name: item.project.name })">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 6v6l4 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            </button>
            <button type="button" class="session-dots-btn" :class="{ 'menu-open': openProjectMenuKey === projectKey(item.project) }" @click.stop="toggleProjectMenu(item.project, $event)" :aria-label="$t('sidebar.projects.menu')">
              <svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>
            </button>
            </span>
          </div>

          <form v-else-if="item.kind === 'create'" class="sidebar-project-create" :style="{ '--tree-depth': item.depth }" @submit.prevent="submitProjectCreate" @keydown.escape.stop.prevent="cancelProjectCreate">
            <svg class="sidebar-project-create-icon" viewBox="0 0 20 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M2.5 7.5a2 2 0 0 1 2-2h4l1.8 2H15.5a2 2 0 0 1 2 2V18h-15z"/></svg>
            <input
              ref="projectCreateInput"
              v-model="projectCreateName"
              type="text"
              maxlength="120"
              :placeholder="$t('sidebar.projects.namePrompt')"
              :aria-label="$t('sidebar.projects.namePrompt')"
              :disabled="projectCreateSubmitting"
            />
            <button type="submit" class="sidebar-project-create-confirm" :disabled="!projectCreateName.trim() || projectCreateSubmitting" :title="$t('common.confirm')" :aria-label="$t('common.confirm')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 12 4 4L19 6"/></svg>
            </button>
            <button type="button" class="sidebar-project-create-cancel" :disabled="projectCreateSubmitting" @click="cancelProjectCreate" :title="$t('common.cancel')" :aria-label="$t('common.cancel')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="m7 7 10 10M17 7 7 17"/></svg>
            </button>
          </form>

          <div v-else-if="item.kind === 'empty'" class="sidebar-section-empty sidebar-folder-empty" :style="{ '--tree-depth': item.depth }"
               @dragover="dragOverFolderContents(item.project, $event)"
               @dragleave="clearGroupDragTarget(projectKey(item.project), $event)"
               @drop="dropOnFolderContents(item.project, $event)">{{ $t('sidebar.projects.noSessions') }}</div>

          <div v-else
            class="session-item sidebar-session-row"
            :class="{ 'sidebar-tree-group-start': item.groupStart, active: isActive(item.row), processing: isProcessing(item.row), dragging: draggedRow?.catalogKey === item.row.catalogKey, 'drag-before': dragTargetRowKey === item.row.catalogKey && dragTargetPosition === 'before', 'drag-after': dragTargetRowKey === item.row.catalogKey && dragTargetPosition === 'after', 'actions-suppressed': suppressedActionsKey === item.row.catalogKey }"
            :style="{ '--tree-depth': item.depth }"
            :draggable="canDragRow(item.row, item.project)"
            role="button"
            :tabindex="loading ? -1 : 0"
            :aria-disabled="loading"
            @dragstart="startDrag(item.row, $event)"
            @dragover="dragOverRow(item.row, item.project, $event)"
            @dragleave="dragLeaveRow(item.row, $event, item.project)"
            @drop="dropOnRow(item.row, item.project, $event)"
            @dragend="finishDrag"
            @pointerleave="restoreRowActions(item.row)"
            @click="selectRow(item.row, $event, { suppressActions: true })"
            @keydown.enter="selectRowFromKeyboard(item.row, $event)"
            @keydown.space="selectRowFromKeyboard(item.row, $event)"
          >
            <span v-if="item.row.pinned" class="session-pin-icon" :aria-label="$t('sidebar.sessions.pinned')"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M8.5 3.5h7M10 3.5V10l-3 3v1.5h10V13l-3-3V3.5M12 14.5V21"/></svg></span>
            <span class="sidebar-session-copy">
              <span class="title" :title="item.row.title">
                <span v-if="isProcessing(item.row)" class="processing-dot" :aria-label="$t('sidebar.sessions.processing')"></span>
                <span class="sidebar-session-title-text">{{ item.row.title }}</span>
                <span v-if="item.row.task" class="sidebar-session-task" role="img" :aria-label="$t('scheduledTasks.itemLabel')" :title="$t('scheduledTasks.itemLabel')">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 6v6l4 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                </span>
                <span v-if="isUnread(item.row)" class="sidebar-session-unread" :aria-label="$t('sidebar.sessions.unread')"></span>
              </span>
            </span>
            <span v-if="canEditRow(item.row)" class="session-actions" :class="{ 'menu-open': openMenuKey === item.row.catalogKey }">
              <button type="button" class="session-quick-action" @click.stop="runAction('pin', item.row)" :title="item.row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin')" :aria-label="item.row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M8.5 3.5h7M10 3.5V10l-3 3v1.5h10V13l-3-3V3.5M12 14.5V21"/></svg>
              </button>
              <button type="button" class="session-quick-action" :disabled="!canRunAction(item.row, 'remove')" @click.stop="runAction('delete', item.row)" :title="canRunAction(item.row, 'remove') ? $t('sidebar.sessions.remove') : $t('sidebar.sessions.upgradeForAction')" :aria-label="$t('sidebar.sessions.remove')">
                <svg class="session-remove-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg>
              </button>
              <button type="button" class="session-dots-btn" :disabled="loading" :class="{ 'menu-open': openMenuKey === item.row.catalogKey }" @click.stop="toggleSessionMenu(item.row, !!item.project, $event)" :aria-label="$t('sidebar.sessions.menu')"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>
            </span>
          </div>
        </template>
        <div v-if="!loading && treeItems.length === 0" class="sidebar-section-empty">{{ $t('sidebar.sessions.empty') }}</div>
        <div class="sidebar-tree-end" :class="{ 'drag-over': isRootDropTarget() }" aria-hidden="true"
             @dragover="dragOverRoot" @dragleave="clearGroupDragTarget('__root__', $event)" @drop="dropOnRoot"></div>
      </div>

      <div v-if="preferencesError" class="sidebar-preferences-error" role="status">
        <span>{{ $t('sidebar.preferences.' + preferencesError + 'Error') }}</span>
        <button v-if="preferencesError === 'load'" type="button" class="btn-ghost" @click="refreshPreferences">{{ $t('common.retry') }}</button>
      </div>
      <Teleport to="body">
        <div v-if="floatingMenu" ref="floatingMenu" class="session-menu session-menu-floating" :style="floatingMenuStyle">
          <template v-if="floatingMenu.kind === 'project'">
            <button v-if="canNestProject(floatingMenu.project)" class="session-menu-item" :disabled="!canCreateSubfolder(floatingMenu.project)" :title="canCreateSubfolder(floatingMenu.project) ? '' : $t('sidebar.projects.depthLimit', { max: maxProjectDepth })" @click.stop="createProject(floatingMenu.project)">{{ $t('sidebar.projects.newSubfolder') }}</button>
            <button class="session-menu-item" @click.stop="editProjectInstruction(floatingMenu.project)">{{ $t('sidebar.projects.instructions') }}</button>
            <button class="session-menu-item" @click.stop="renameProject(floatingMenu.project)">{{ $t('sidebar.projects.rename') }}</button>
            <button v-if="canNestProject(floatingMenu.project)" class="session-menu-item session-menu-parent" :class="{ active: projectSubmenuOpen }" aria-haspopup="menu" :aria-expanded="projectSubmenuOpen ? 'true' : 'false'" @click.stop="projectSubmenuOpen ? closeProjectMoveList() : openProjectMoveList()">
              <span>{{ $t('sidebar.projects.moveFolder') }}</span>
              <span aria-hidden="true">&rsaquo;</span>
            </button>
            <button class="session-menu-item danger" @click.stop="deleteProject(floatingMenu.project)">{{ $t('sidebar.projects.delete') }}</button>
          </template>
          <template v-else>
            <button class="session-menu-item" @click.stop="runAction('rename', floatingMenu.row)">{{ $t('chat.sidebar.renameConv') }}</button>
            <template v-if="floatingMenu.row.runtimeProvider === 'yeaft'">
              <button type="button" class="session-menu-item" :disabled="!!forkUnavailableReason(floatingMenu.row)" :title="forkUnavailableReason(floatingMenu.row) ? $t('yeaft.session.error.' + forkUnavailableReason(floatingMenu.row)) : $t('yeaft.session.copy')" @click.stop="runAction('copy', floatingMenu.row)">{{ $t('yeaft.session.copy') }}</button>
              <button type="button" class="session-menu-item" :disabled="!!mergeUnavailableReason(floatingMenu.row)" :title="mergeUnavailableReason(floatingMenu.row) ? $t('yeaft.session.error.' + mergeUnavailableReason(floatingMenu.row)) : $t('yeaft.session.merge')" @click.stop="runAction('merge', floatingMenu.row)">{{ $t('yeaft.session.merge') }}</button>
              <button class="session-menu-item" @click.stop="runAction('settings', floatingMenu.row)">{{ $t('yeaft.session.openSettings') }}</button>
              <button v-if="floatingMenu.inProject" class="session-menu-item" @click.stop="moveRow(floatingMenu.row, null)">{{ $t('sidebar.projects.remove') }}</button>
              <button class="session-menu-item session-menu-parent" :class="{ active: projectSubmenuOpen }" aria-haspopup="menu" :aria-expanded="projectSubmenuOpen ? 'true' : 'false'" @click.stop="projectSubmenuOpen ? closeProjectMoveList() : openProjectMoveList()">
                <span>{{ $t('sidebar.projects.moveMenu') }}</span>
                <span aria-hidden="true">&rsaquo;</span>
              </button>
            </template>
            <div class="sidebar-session-menu-info">
              <strong :title="agentLabel(floatingMenu.row)">{{ agentLabel(floatingMenu.row) }}</strong>
              <strong>{{ providerLabel(floatingMenu.row) }}</strong>
            </div>
          </template>
        </div>
        <div v-if="projectSubmenuOpen && floatingMenu" ref="projectSubmenu" class="session-menu session-menu-floating session-submenu" :style="projectSubmenuStyle" role="menu">
          <template v-if="floatingMenu.kind === 'session'">
            <button v-for="target in projectMoveTargets(floatingMenu.row, floatingMenu.currentProject)" :key="target.project.id" class="session-menu-item sidebar-folder-menu-item" :style="{ '--tree-depth': target.depth }" :title="projectPathLabel(target.project)" @click.stop="moveRow(floatingMenu.row, target.project)">{{ target.project.name }}</button>
            <div v-if="projectMoveTargets(floatingMenu.row, floatingMenu.currentProject).length === 0" class="session-menu-empty">{{ $t('sidebar.projects.moveEmpty') }}</div>
          </template>
          <template v-else>
            <button v-for="target in folderMoveTargets(floatingMenu.project)" :key="target.project ? target.project.id : '__top__'" class="session-menu-item sidebar-folder-menu-item" :style="{ '--tree-depth': target.depth }" :title="target.project ? projectPathLabel(target.project) : $t('sidebar.projects.moveToTop')" @click.stop="moveFolderTo(floatingMenu.project, target.project)">{{ target.project ? target.project.name : $t('sidebar.projects.moveToTop') }}</button>
            <div v-if="folderMoveTargets(floatingMenu.project).length === 0" class="session-menu-empty">{{ $t('sidebar.projects.moveEmpty') }}</div>
          </template>
        </div>
      </Teleport>

      <Teleport to="body">
        <div v-if="projectInstructionOpen" class="modal-overlay" @click.self="closeProjectInstruction">
          <form class="modal modal-card project-instruction-modal" role="dialog" aria-modal="true" :aria-label="$t('sidebar.projects.instructionsTitle', { name: projectInstructionProject?.name || '' })" @submit.prevent="saveProjectInstruction">
            <div class="project-instruction-header">
              <div>
                <h3>{{ $t('sidebar.projects.instructionsTitle', { name: projectInstructionProject?.name || '' }) }}</h3>
                <p>{{ $t('sidebar.projects.instructionsHint') }}</p>
              </div>
              <button type="button" class="modal-close" :disabled="projectInstructionSubmitting" @click="closeProjectInstruction" :aria-label="$t('common.close')">&times;</button>
            </div>
            <div class="project-instruction-body">
              <textarea ref="projectInstructionInput" v-model="projectInstructionDraft" maxlength="20000" :disabled="projectInstructionSubmitting" :placeholder="$t('sidebar.projects.instructionsPlaceholder')"></textarea>
              <span class="project-instruction-count">{{ projectInstructionDraft.length }} / 20000</span>
            </div>
            <div class="project-instruction-actions">
              <button type="button" class="btn btn-secondary" :disabled="projectInstructionSubmitting" @click="closeProjectInstruction">{{ $t('common.cancel') }}</button>
              <button type="submit" class="btn btn-primary" :disabled="projectInstructionSubmitting">{{ $t('common.save') }}</button>
            </div>
          </form>
        </div>
      </Teleport>
    </nav>
  `,
};
