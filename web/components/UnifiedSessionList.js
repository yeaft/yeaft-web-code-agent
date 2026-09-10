import { confirmDialog, promptDialog } from '../utils/dialog.js';

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

const SIDEBAR_SECTION_COLLAPSE_KEY = 'yeaft-sidebar-section-collapse';

function readCollapsedSections() {
  try {
    if (typeof localStorage === 'undefined') return { projects: false, recents: false };
    const parsed = JSON.parse(localStorage.getItem(SIDEBAR_SECTION_COLLAPSE_KEY) || '{}');
    return {
      projects: parsed?.projects === true,
      recents: parsed?.recents === true,
    };
  } catch {
    return { projects: false, recents: false };
  }
}

function writeCollapsedSections(value) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SIDEBAR_SECTION_COLLAPSE_KEY, JSON.stringify({
        projects: value?.projects === true,
        recents: value?.recents === true,
      }));
    }
  } catch { /* browser storage is best-effort UI state */ }
}

export function reorderProjectRows(rows, movedId, targetId, position = 'before') {
  const ordered = Array.isArray(rows) ? [...rows] : [];
  const fromIndex = ordered.findIndex(row => projectIdentityKey(row) === movedId);
  if (fromIndex < 0) return null;
  const [moved] = ordered.splice(fromIndex, 1);
  const targetIndex = ordered.findIndex(row => projectIdentityKey(row) === targetId);
  if (targetIndex < 0) return null;
  ordered.splice(targetIndex + (position === 'after' ? 1 : 0), 0, moved);
  return ordered;
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
  emits: ['select', 'create', 'create-in-project', 'action', 'project-action', 'close-work-center'],
  props: {
    sessions: { type: Array, default: () => [] },
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
      collapsedProjects: {},
      collapsedSections: readCollapsedSections(),
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
  },
  beforeUnmount() {
    document.removeEventListener('pointerdown', this.closeMenusFromDocument, true);
    document.removeEventListener('keydown', this.closeMenusFromKeyboard);
    window.removeEventListener('resize', this.positionFloatingMenu);
    window.removeEventListener('scroll', this.positionFloatingMenu, true);
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
    recentRows() {
      return sortRows(this.sessions.filter(row => {
        if (!this.isRowOnline(row)) return false;
        if (row.runtimeProvider === 'yeaft') {
          const key = `${row.routeRef?.agentId}\u001f${row.routeRef?.sessionId}`;
          if (this.projectBySessionKey.has(key)) return false;
        }
        return true;
      }), this.hasCompleteCatalogOrder);
    },
  },
  methods: {
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
    isUnread(row) {
      return typeof this.isSessionUnread === 'function' ? !!this.isSessionUnread(row) : false;
    },
    isProjectUnread(project) {
      const rows = this.projectSessionRows.get(projectIdentityKey(project)) || [];
      return rows.some(row => this.isUnread(row));
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
      if (!project?.id) return false;
      return !project.legacyAgentId || this.isAgentOnline(project.legacyAgentId);
    },
    canEditRow(row) {
      if (!row?.routeRef?.agentId || row.availability !== 'online') return false;
      return this.isAgentOnline(row.routeRef.agentId);
    },
    canMoveRowToProject(row, project = null) {
      if (!this.canEditRow(row)) return false;
      if (!project) return true;
      if (!this.canEditProject(project)) return false;
      return !project.legacyAgentId || project.legacyAgentId === row.routeRef.agentId;
    },
    projectMoveTargets(row, currentProject = null) {
      const currentProjectId = projectIdentityKey(currentProject);
      return this.projectRows.filter(project => (
        projectIdentityKey(project) !== currentProjectId
        && this.canMoveRowToProject(row, project)
      ));
    },
    openProjectMoveList() {
      if (!this.floatingMenu || this.floatingMenu.kind !== 'session') return;
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
    isSectionCollapsed(section) {
      return this.collapsedSections?.[section] === true;
    },
    toggleSection(section) {
      if (section !== 'projects' && section !== 'recents') return;
      this.collapsedSections = {
        ...this.collapsedSections,
        [section]: !this.isSectionCollapsed(section),
      };
      writeCollapsedSections(this.collapsedSections);
      this.closeMenus();
    },
    isProjectCollapsed(project) {
      return this.collapsedProjects[projectIdentityKey(project)] === true;
    },
    toggleProject(project) {
      const key = projectIdentityKey(project);
      this.collapsedProjects = {
        ...this.collapsedProjects,
        [key]: !this.collapsedProjects[key],
      };
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
    createSession() {
      if (this.workCenterOpen) this.$emit('close-work-center');
      this.$emit('create');
    },
    createSessionInProject(project) {
      if (!this.canEditProject(project)) return;
      this.closeMenus();
      if (this.workCenterOpen) this.$emit('close-work-center');
      this.$emit('create-in-project', { project });
    },
    selectRow(row, event, options = {}) {
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
      this.closeMenus();
      if (!this.canEditRow(row)) return;
      if (action === 'rename') {
        const title = await promptDialog(this.$t('yeaft.session.renamePrompt', { name: row.title }), row.title);
        if (!title?.trim() || title.trim() === row.title) return;
        this.$emit('action', { action, row, title: title.trim() });
        return;
      }
      const normalizedAction = action === 'delete' ? 'remove' : action;
      this.$emit('action', { action: normalizedAction, row });
    },
    dispatchSessionAction(payload) {
      if (payload?.action === 'reorder' && this.resolvedProjectStore?.reorderCatalogSessions) {
        return this.resolvedProjectStore.reorderCatalogSessions(payload.sessions);
      }
      this.$emit('action', payload);
      return true;
    },
    dispatchProjectAction(payload) {
      if (payload?.action === 'move-session'
          && !this.canMoveRowToProject(payload?.row, payload?.project || null)) return false;
      this.$emit('project-action', payload);
      const store = this.resolvedProjectStore;
      if (!store?.mutateProject) return true;
      const { action, project, row, name, catalogOrder, agentId: explicitAgentId } = payload;
      const agentId = explicitAgentId || row?.routeRef?.agentId || null;
      if (action === 'create') return store.mutateProject('create', { name }, agentId);
      const projectId = project?.legacyProjectId || project?.id;
      if (action === 'rename') return store.mutateProject('rename', { projectId, name }, project?.legacyAgentId || agentId);
      if (action === 'update-instruction') {
        return store.mutateProject('update_instruction', {
          projectId,
          instruction: payload.instruction || '',
        }, project?.legacyAgentId || agentId);
      }
      if (action === 'delete') return store.mutateProject('delete', { projectId }, project?.legacyAgentId || agentId);
      if (action === 'reorder-projects') {
        return store.mutateProject('reorder', {
          projectIds: (payload.projects || []).map(item => item.id),
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
    createProject() {
      if (this.projectCreateSubmitting) return;
      if (this.isSectionCollapsed('projects')) {
        this.collapsedSections = { ...this.collapsedSections, projects: false };
        writeCollapsedSections(this.collapsedSections);
      }
      this.projectCreateOpen = true;
      this.projectCreateName = '';
      this.$nextTick(() => this.$refs.projectCreateInput?.focus?.());
    },
    cancelProjectCreate() {
      if (this.projectCreateSubmitting) return;
      this.projectCreateOpen = false;
      this.projectCreateName = '';
    },
    async submitProjectCreate() {
      const name = this.projectCreateName.trim();
      if (!name || this.projectCreateSubmitting) return;
      this.projectCreateSubmitting = true;
      try {
        const result = await this.dispatchProjectAction({ action: 'create', name });
        if (result?.ok !== false) {
          this.projectCreateOpen = false;
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
        this.dispatchProjectAction({ action: 'rename', project, name: name.trim() });
      }
    },
    async deleteProject(project) {
      if (!this.canEditProject(project)) return;
      this.closeMenus();
      if (await confirmDialog(this.$t('sidebar.projects.deleteConfirm', { name: project.name }), { destructive: true })) {
        this.dispatchProjectAction({ action: 'delete', project });
      }
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
    dragOverProjectRow(project, event) {
      const targetId = projectIdentityKey(project);
      if (!this.draggedProjectId || targetId === this.draggedProjectId || !this.canDragProject(project)) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.dragTargetProjectRowId = targetId;
      this.dragTargetProjectPosition = this.dragPositionForEvent(event);
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
      const targetId = projectIdentityKey(project);
      const position = this.dragTargetProjectRowId === targetId
        ? this.dragTargetProjectPosition
        : this.dragPositionForEvent(event);
      this.finishProjectDrag();
      if (!movedId || !targetId || movedId === targetId || !position) return false;
      const nextProjects = reorderProjectRows(this.projectRows, movedId, targetId, position);
      if (!nextProjects) return false;
      this.dragOperationPending = true;
      try {
        const result = await this.dispatchProjectAction({
          action: 'reorder-projects',
          projects: nextProjects,
        });
        return result !== false && result?.ok !== false;
      } finally {
        this.dragOperationPending = false;
      }
    },
    finishProjectDrag() {
      this.draggedProjectId = null;
      this.dragTargetProjectRowId = null;
      this.dragTargetProjectPosition = null;
    },
    canDragRow(row, project = null) {
      if (this.dragOperationPending || !this.canEditRow(row)) return false;
      if (!project) return true;
      if (row?.runtimeProvider !== 'yeaft') return false;
      const sameProject = projectIdentityKey(this.projectForRow(row)) === projectIdentityKey(project);
      return sameProject || this.canMoveRowToProject(row, project);
    },
    canDropRow(row, project = null) {
      if (!row || this.dragOperationPending || !this.canEditRow(row)) return false;
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
      const moved = this.draggedRow;
      if (!this.canDropRow(moved, project)
          || moved.catalogKey === row?.catalogKey
          || !!moved.pinned !== !!row?.pinned) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.dragTargetProjectId = null;
      this.dragTargetRowKey = row.catalogKey;
      this.dragTargetPosition = this.dragPositionForEvent(event);
    },
    dragLeaveRow(row, event) {
      if (this.dragTargetRowKey !== row?.catalogKey) return;
      const next = event?.relatedTarget;
      if (next && event?.currentTarget?.contains?.(next)) return;
      this.dragTargetRowKey = null;
      this.dragTargetPosition = null;
    },
    async dropOnRow(row, project, event) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const moved = this.draggedRow;
      const position = this.dragTargetRowKey === row?.catalogKey
        ? this.dragTargetPosition
        : this.dragPositionForEvent(event);
      this.finishDrag();
      if (!this.canDropRow(moved, project) || !position) return false;
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
    dragOverRecents(event) {
      if (!this.canDropRow(this.draggedRow, null)) {
        this.clearDragTarget();
        return;
      }
      event?.preventDefault?.();
      if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.dragTargetProjectId = '__recents__';
      this.dragTargetRowKey = null;
      this.dragTargetPosition = null;
    },
    async dropOnRecents(event) {
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
        : this.recentRows;
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
    <nav class="sidebar-navigation" :aria-label="$t('sidebar.surface.sessions')">
      <div class="sidebar-primary-actions">
        <button type="button" class="sidebar-primary-action" @click="createSession" :title="$t('sidebar.sessions.newChat')" :aria-label="$t('sidebar.sessions.newChat')">
          <svg class="sidebar-primary-action-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path class="sidebar-primary-action-frame" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path class="sidebar-primary-action-pen" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852Z"/>
          </svg>
          <span>{{ $t('sidebar.sessions.newChat') }}</span>
        </button>
      </div>

      <div class="sidebar-session-results">
        <section class="sidebar-section projects-section" :class="{ 'is-collapsed': isSectionCollapsed('projects') }">
          <div class="sidebar-section-heading">
            <button type="button" class="sidebar-section-toggle" @click="toggleSection('projects')" :aria-expanded="String(!isSectionCollapsed('projects'))">
              <span>{{ $t('sidebar.projects.title') }}</span>
              <svg class="sidebar-section-chevron" :class="{ collapsed: isSectionCollapsed('projects') }" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m8 10 4 4 4-4"/></svg>
            </button>
            <button type="button" class="sidebar-tool-button sidebar-project-add-button" @click="createProject" :disabled="projectCreateOpen" :title="$t('sidebar.projects.new')" :aria-label="$t('sidebar.projects.new')">
              <svg class="sidebar-project-add-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path class="sidebar-project-add-mark" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 5v14M5 12h14"/>
              </svg>
            </button>
          </div>

          <form v-if="projectCreateOpen && !isSectionCollapsed('projects')" class="sidebar-project-create" @submit.prevent="submitProjectCreate" @keydown.escape.stop.prevent="cancelProjectCreate">
            <svg class="sidebar-project-create-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 6h7l2 2h9v10H3V6zm2 2v8h14v-6h-8l-2-2H5z"/></svg>
            <input
              ref="projectCreateInput"
              v-model="projectCreateName"
              type="text"
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

          <div v-if="!isSectionCollapsed('projects') && projectRows.length === 0 && !projectCreateOpen" class="sidebar-section-empty">{{ $t('sidebar.projects.empty') }}</div>
          <div v-for="project in (isSectionCollapsed('projects') ? [] : projectRows)" :key="projectKey(project)" class="sidebar-project">
            <div
              class="sidebar-project-header"
              :class="{ 'drag-over': !draggedProjectId && dragTargetProjectId === projectKey(project), dragging: draggedProjectId === projectKey(project), 'project-drag-before': dragTargetProjectRowId === projectKey(project) && dragTargetProjectPosition === 'before', 'project-drag-after': dragTargetProjectRowId === projectKey(project) && dragTargetProjectPosition === 'after' }"
              :draggable="canDragProject(project)"
              @dragstart="startProjectDrag(project, $event)"
              @dragover="dragOverProjectHeader(project, $event)"
              @dragleave="clearProjectHeaderDragTarget(project, $event)"
              @drop="dropOnProjectHeader(project, $event)"
              @dragend="finishAllDrag"
            >
              <button type="button" class="sidebar-project-toggle" @click="toggleProject(project)" :aria-expanded="String(!isProjectCollapsed(project))">
                <svg v-if="isProjectCollapsed(project)" class="sidebar-project-icon sidebar-project-icon-closed" viewBox="0 0 20 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M2.5 7.5a2 2 0 0 1 2-2h4l1.8 2H15.5a2 2 0 0 1 2 2V18h-15z"/></svg>
                <svg v-else class="sidebar-project-icon sidebar-project-icon-open" viewBox="0 0 20 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M2.5 9V7a2 2 0 0 1 2-2h4l1.8 2h5.2a2 2 0 0 1 2 2v1M3.5 10h15l-2 8h-15z"/></svg>
                <span class="sidebar-project-name">{{ project.name }}</span>
                <span class="sidebar-project-count">{{ (rowsByProject.get(projectKey(project)) || []).length }}</span>
                <span v-if="isProjectUnread(project)" class="sidebar-session-unread sidebar-project-unread" :aria-label="$t('sidebar.sessions.unread')"></span>
              </button>
              <button v-if="canEditProject(project)" type="button" class="sidebar-project-session-create" @click.stop="createSessionInProject(project)" :title="$t('sidebar.projects.newSession', { name: project.name })" :aria-label="$t('sidebar.projects.newSession', { name: project.name })">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>
              </button>
              <button v-if="canEditProject(project)" type="button" class="session-dots-btn" :class="{ 'menu-open': openProjectMenuKey === projectKey(project) }" @click.stop="toggleProjectMenu(project, $event)" :aria-label="$t('sidebar.projects.menu')">
                <svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>
              </button>
            </div>
            <div v-if="!isProjectCollapsed(project)" class="sidebar-project-sessions">
              <div
                v-for="row in rowsByProject.get(projectKey(project)) || []"
                :key="row.catalogKey"
                class="session-item sidebar-session-row"
                :class="{ active: isActive(row), processing: isProcessing(row), dragging: draggedRow?.catalogKey === row.catalogKey, 'drag-before': dragTargetRowKey === row.catalogKey && dragTargetPosition === 'before', 'drag-after': dragTargetRowKey === row.catalogKey && dragTargetPosition === 'after', 'actions-suppressed': suppressedActionsKey === row.catalogKey }"
                :draggable="canDragRow(row, project)"
                role="button"
                tabindex="0"
                @dragstart="startDrag(row, $event)"
                @dragover="dragOverRow(row, project, $event)"
                @dragleave="dragLeaveRow(row, $event)"
                @drop="dropOnRow(row, project, $event)"
                @dragend="finishDrag"
                @pointerleave="restoreRowActions(row)"
                @click="selectRow(row, $event, { suppressActions: true })"
                @keydown.enter="selectRowFromKeyboard(row, $event)"
                @keydown.space="selectRowFromKeyboard(row, $event)"
              >
                <span v-if="row.pinned" class="session-pin-icon" :aria-label="$t('sidebar.sessions.pinned')"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>
                <span class="sidebar-session-copy">
                  <span class="title" :title="row.title">
                    <span v-if="isProcessing(row)" class="processing-dot" :aria-label="$t('sidebar.sessions.processing')"></span>
                    <span class="sidebar-session-title-text">{{ row.title }}</span>
                    <span v-if="isUnread(row)" class="sidebar-session-unread" :aria-label="$t('sidebar.sessions.unread')"></span>
                  </span>
                </span>
                <span v-if="canEditRow(row)" class="session-actions" :class="{ 'menu-open': openMenuKey === row.catalogKey }">
                  <button type="button" class="session-quick-action" @click.stop="runAction('pin', row)" :title="row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin')" :aria-label="row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin')">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                  </button>
                  <button type="button" class="session-quick-action" @click.stop="runAction('delete', row)" :title="$t('sidebar.sessions.remove')" :aria-label="$t('sidebar.sessions.remove')">
                    <svg class="session-remove-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg>
                  </button>
                  <button type="button" class="session-dots-btn" :class="{ 'menu-open': openMenuKey === row.catalogKey }" @click.stop="toggleSessionMenu(row, true, $event)" :aria-label="$t('sidebar.sessions.menu')"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>
                </span>
              </div>
              <div v-if="(rowsByProject.get(projectKey(project)) || []).length === 0" class="sidebar-section-empty">{{ $t('sidebar.projects.noSessions') }}</div>
            </div>
          </div>
        </section>

        <section class="sidebar-section recents-section" :class="{ 'drag-over': dragTargetProjectId === '__recents__', 'is-collapsed': isSectionCollapsed('recents') }" @dragover="dragOverRecents" @dragleave="clearGroupDragTarget('__recents__', $event)" @drop="dropOnRecents">
          <div class="sidebar-section-heading">
            <button type="button" class="sidebar-section-toggle" @click="toggleSection('recents')" :aria-expanded="String(!isSectionCollapsed('recents'))">
              <span>{{ $t('sidebar.recents.title') }}</span>
              <svg class="sidebar-section-chevron" :class="{ collapsed: isSectionCollapsed('recents') }" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m8 10 4 4 4-4"/></svg>
            </button>
            <button type="button" class="sidebar-tool-button sidebar-recents-create" @click="createSession" :title="$t('sidebar.sessions.newChat')" :aria-label="$t('sidebar.sessions.newChat')">
              <svg class="sidebar-recents-create-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path class="sidebar-recents-create-frame" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path class="sidebar-recents-create-pen" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852Z"/>
              </svg>
            </button>
          </div>
          <div
            v-for="row in (isSectionCollapsed('recents') ? [] : recentRows)"
            :key="row.catalogKey"
            class="session-item sidebar-session-row"
            :class="{ active: isActive(row), processing: isProcessing(row), dragging: draggedRow?.catalogKey === row.catalogKey, 'drag-before': dragTargetRowKey === row.catalogKey && dragTargetPosition === 'before', 'drag-after': dragTargetRowKey === row.catalogKey && dragTargetPosition === 'after', 'actions-suppressed': suppressedActionsKey === row.catalogKey }"
            :draggable="canDragRow(row)"
            role="button"
            tabindex="0"
            @dragstart="startDrag(row, $event)"
            @dragover="dragOverRow(row, null, $event)"
            @dragleave="dragLeaveRow(row, $event)"
            @drop="dropOnRow(row, null, $event)"
            @dragend="finishDrag"
            @pointerleave="restoreRowActions(row)"
            @click="selectRow(row, $event, { suppressActions: true })"
            @keydown.enter="selectRowFromKeyboard(row, $event)"
            @keydown.space="selectRowFromKeyboard(row, $event)"
          >
            <span v-if="row.pinned" class="session-pin-icon" :aria-label="$t('sidebar.sessions.pinned')"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>
            <span class="sidebar-session-copy">
              <span class="title" :title="row.title">
                <span v-if="isProcessing(row)" class="processing-dot" :aria-label="$t('sidebar.sessions.processing')"></span>
                <span class="sidebar-session-title-text">{{ row.title }}</span>
                <span v-if="isUnread(row)" class="sidebar-session-unread" :aria-label="$t('sidebar.sessions.unread')"></span>
              </span>
            </span>
            <span v-if="canEditRow(row)" class="session-actions" :class="{ 'menu-open': openMenuKey === row.catalogKey }">
              <button type="button" class="session-quick-action" @click.stop="runAction('pin', row)" :title="row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin')" :aria-label="row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
              </button>
              <button type="button" class="session-quick-action" @click.stop="runAction('delete', row)" :title="$t('sidebar.sessions.remove')" :aria-label="$t('sidebar.sessions.remove')">
                <svg class="session-remove-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg>
              </button>
              <button type="button" class="session-dots-btn" :class="{ 'menu-open': openMenuKey === row.catalogKey }" @click.stop="toggleSessionMenu(row, false, $event)" :aria-label="$t('sidebar.sessions.menu')"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>
            </span>
          </div>
          <div v-if="!isSectionCollapsed('recents') && recentRows.length === 0" class="sidebar-section-empty">{{ $t('sidebar.recents.empty') }}</div>
        </section>
      </div>

      <Teleport to="body">
        <div v-if="floatingMenu" ref="floatingMenu" class="session-menu session-menu-floating" :style="floatingMenuStyle">
          <template v-if="floatingMenu.kind === 'project'">
            <button class="session-menu-item" @click.stop="editProjectInstruction(floatingMenu.project)">{{ $t('sidebar.projects.instructions') }}</button>
            <button class="session-menu-item" @click.stop="renameProject(floatingMenu.project)">{{ $t('sidebar.projects.rename') }}</button>
            <button class="session-menu-item danger" @click.stop="deleteProject(floatingMenu.project)">{{ $t('sidebar.projects.delete') }}</button>
          </template>
          <template v-else>
            <button class="session-menu-item" @click.stop="runAction('rename', floatingMenu.row)">{{ $t('chat.sidebar.renameConv') }}</button>
            <template v-if="floatingMenu.row.runtimeProvider === 'yeaft'">
              <button v-if="isActive(floatingMenu.row)" class="session-menu-item" @click.stop="runAction('copy', floatingMenu.row)">{{ $t('yeaft.session.copyCurrent') }}</button>
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
        <div v-if="projectSubmenuOpen && floatingMenu?.kind === 'session'" ref="projectSubmenu" class="session-menu session-menu-floating session-submenu" :style="projectSubmenuStyle" role="menu">
          <button v-for="project in projectMoveTargets(floatingMenu.row, floatingMenu.currentProject)" :key="project.id" class="session-menu-item" @click.stop="moveRow(floatingMenu.row, project)">{{ project.name }}</button>
          <div v-if="projectMoveTargets(floatingMenu.row, floatingMenu.currentProject).length === 0" class="session-menu-empty">{{ $t('sidebar.projects.moveEmpty') }}</div>
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
