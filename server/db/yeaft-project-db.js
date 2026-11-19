import { randomUUID } from 'crypto';
import { stmts, transaction } from './connection.js';
import { applySessionUiMetadataUpdates } from './session-ui-metadata-db.js';

export class YeaftProjectDbError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'YeaftProjectDbError';
    this.code = code;
  }
}

function requireUserId(value) {
  const userId = typeof value === 'string' ? value.trim() : '';
  if (!userId) throw new YeaftProjectDbError('missing_user', 'User identity is required');
  return userId;
}

function requireName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new YeaftProjectDbError('invalid_name', 'Project name is required');
  return name.slice(0, 120);
}

function normalizeInstruction(value) {
  if (typeof value !== 'string') {
    throw new YeaftProjectDbError('invalid_instruction', 'Project instruction must be a string');
  }
  const instruction = value.trim();
  if (instruction.length > 20_000) {
    throw new YeaftProjectDbError('instruction_too_long', 'Project instruction must not exceed 20000 characters');
  }
  return instruction;
}

function requireId(value, code, label) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new YeaftProjectDbError(code, `${label} is required`);
  return id;
}

/**
 * Deepest folder nesting the sidebar offers; a top-level folder is depth 1.
 * Bounds the indentation and the inherited instruction chain. The Web mirror
 * lives in web/stores/helpers/project-tree.js.
 */
export const MAX_PROJECT_DEPTH = 5;

function normalizeParentId(value) {
  if (value == null || value === '') return null;
  return requireId(value, 'invalid_parent_id', 'Parent folder id');
}

/**
 * Index one user's folders as a tree. Writes keep parents valid and acyclic;
 * a row that still points at a missing parent or closes a cycle (manual edits)
 * is read as top level so every folder stays reachable.
 *
 * @param {object[]} rows yeaft_projects rows in sort order
 */
function projectTree(rows) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const parentOf = new Map();
  for (const row of rows) {
    const parentId = typeof row.parent_id === 'string' ? row.parent_id : '';
    parentOf.set(row.id, parentId && parentId !== row.id && byId.has(parentId) ? parentId : null);
  }
  for (const row of rows) {
    const seen = new Set([row.id]);
    for (let current = row.id; parentOf.get(current);) {
      const parentId = parentOf.get(current);
      if (seen.has(parentId)) {
        parentOf.set(current, null);
        break;
      }
      seen.add(parentId);
      current = parentId;
    }
  }
  const children = new Map();
  for (const row of rows) {
    const parentId = parentOf.get(row.id);
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(row);
  }
  const childrenOf = parentId => children.get(parentId ?? null) || [];
  /** Root-first chain ending at the folder itself. */
  const pathOf = (id) => {
    const chain = [];
    for (let current = id; current; current = parentOf.get(current)) chain.unshift(byId.get(current));
    return chain;
  };
  /** The folder and every folder below it, parents before children. */
  const subtreeIds = (id) => {
    const out = [];
    const visit = (current) => {
      out.push(current);
      for (const child of childrenOf(current)) visit(child.id);
    };
    visit(id);
    return out;
  };
  /** Levels in the folder's subtree, counting the folder itself. */
  const heightOf = id => 1 + Math.max(0, ...childrenOf(id).map(child => heightOf(child.id)));
  return {
    byId,
    parentOf: id => parentOf.get(id) ?? null,
    childrenOf,
    pathOf,
    subtreeIds,
    heightOf,
    depthOf: id => pathOf(id).length,
  };
}

function mapProject(row, members = [], parentId = row?.parent_id || null) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    instruction: typeof row.instruction === 'string' ? row.instruction : '',
    parentId,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    members: members.map(member => ({
      agentId: member.agent_id,
      sessionId: member.session_id,
    })),
  };
}

function requireProject(userId, projectId) {
  const row = stmts.getYeaftProjectForUser.get(userId, projectId);
  if (!row) throw new YeaftProjectDbError('not_found', 'Project not found');
  return row;
}

export const yeaftProjectDb = {
  list(userId) {
    const ownerId = requireUserId(userId);
    const membersByProject = new Map();
    for (const member of stmts.getYeaftProjectMembersByUser.all(ownerId)) {
      if (!membersByProject.has(member.project_id)) membersByProject.set(member.project_id, []);
      membersByProject.get(member.project_id).push(member);
    }
    const rows = stmts.getYeaftProjectsByUser.all(ownerId);
    const tree = projectTree(rows);
    return rows.map(row => mapProject(row, membersByProject.get(row.id) || [], tree.parentOf(row.id)));
  },

  listForAgent(userId, agentId) {
    const targetAgentId = typeof agentId === 'string' ? agentId.trim() : '';
    return this.list(userId).map(project => ({
      ...project,
      sessionIds: targetAgentId
        ? project.members
            .filter(member => member.agentId === targetAgentId)
            .map(member => member.sessionId)
        : [],
    }));
  },

  /** Create a folder at the end of the top level, or of `parentId`'s subfolders. */
  create(userId, name, parentId = null) {
    const ownerId = requireUserId(userId);
    const nextName = requireName(name);
    const targetParentId = normalizeParentId(parentId);
    return transaction(() => {
      const tree = projectTree(stmts.getYeaftProjectsByUser.all(ownerId));
      if (targetParentId && !tree.byId.has(targetParentId)) {
        throw new YeaftProjectDbError('not_found', 'Parent folder not found');
      }
      if (targetParentId && tree.depthOf(targetParentId) >= MAX_PROJECT_DEPTH) {
        throw new YeaftProjectDbError('project_depth_exceeded', `Folders nest at most ${MAX_PROJECT_DEPTH} levels`);
      }
      const now = Date.now();
      const project = {
        id: `project-${randomUUID().slice(0, 8)}`,
        name: nextName,
        instruction: '',
        parentId: targetParentId,
        sortOrder: tree.childrenOf(targetParentId)
          .reduce((max, row) => Math.max(max, Number(row.sort_order) || 0), -1) + 1,
        createdAt: now,
        updatedAt: now,
        members: [],
      };
      stmts.insertYeaftProject.run(
        project.id,
        ownerId,
        project.name,
        project.instruction,
        project.parentId,
        project.sortOrder,
        now,
        now,
      );
      return project;
    })();
  },

  /**
   * Move a folder (with its subfolders and Sessions) under `parentId`, or to
   * the top level, placed before `beforeProjectId` or at the end. Rejects moves
   * into its own subtree and moves that would exceed MAX_PROJECT_DEPTH.
   */
  move(userId, projectId, { parentId = null, beforeProjectId = null } = {}) {
    const ownerId = requireUserId(userId);
    const id = requireId(projectId, 'invalid_project_id', 'Project id');
    const targetParentId = normalizeParentId(parentId);
    const beforeId = beforeProjectId == null || beforeProjectId === ''
      ? null
      : requireId(beforeProjectId, 'invalid_project_id', 'Project id');
    transaction(() => {
      const tree = projectTree(stmts.getYeaftProjectsByUser.all(ownerId));
      if (!tree.byId.has(id)) throw new YeaftProjectDbError('not_found', 'Project not found');
      if (targetParentId && !tree.byId.has(targetParentId)) {
        throw new YeaftProjectDbError('not_found', 'Parent folder not found');
      }
      if (targetParentId && tree.subtreeIds(id).includes(targetParentId)) {
        throw new YeaftProjectDbError('project_cycle', 'A folder cannot move into itself or its subfolders');
      }
      const parentDepth = targetParentId ? tree.depthOf(targetParentId) : 0;
      if (parentDepth + tree.heightOf(id) > MAX_PROJECT_DEPTH) {
        throw new YeaftProjectDbError('project_depth_exceeded', `Folders nest at most ${MAX_PROJECT_DEPTH} levels`);
      }
      const siblings = tree.childrenOf(targetParentId).filter(row => row.id !== id);
      const index = beforeId ? siblings.findIndex(row => row.id === beforeId) : siblings.length;
      if (index < 0) {
        throw new YeaftProjectDbError('invalid_project_order', 'The folder to place before is not in the destination');
      }
      siblings.splice(index, 0, tree.byId.get(id));
      const now = Date.now();
      stmts.updateYeaftProjectParent.run(targetParentId, now, ownerId, id);
      siblings.forEach((row, order) => {
        if (row.id === id || row.sort_order !== order) {
          stmts.updateYeaftProjectSortOrder.run(order, now, ownerId, row.id);
        }
      });
    })();
    return this.list(ownerId);
  },

  rename(userId, projectId, name) {
    const ownerId = requireUserId(userId);
    const id = requireId(projectId, 'invalid_project_id', 'Project id');
    requireProject(ownerId, id);
    const nextName = requireName(name);
    stmts.updateYeaftProjectName.run(nextName, Date.now(), ownerId, id);
    return mapProject(stmts.getYeaftProjectForUser.get(ownerId, id),
      stmts.getYeaftProjectMembersByUser.all(ownerId).filter(member => member.project_id === id));
  },

  updateInstruction(userId, projectId, instruction) {
    const ownerId = requireUserId(userId);
    const id = requireId(projectId, 'invalid_project_id', 'Project id');
    requireProject(ownerId, id);
    const nextInstruction = normalizeInstruction(instruction);
    stmts.updateYeaftProjectInstruction.run(nextInstruction, Date.now(), ownerId, id);
    return mapProject(stmts.getYeaftProjectForUser.get(ownerId, id),
      stmts.getYeaftProjectMembersByUser.all(ownerId).filter(member => member.project_id === id));
  },

  /**
   * Delete a folder and its subfolders. Sessions are never deleted: every
   * Session inside moves to the deleted folder's parent (the top level when
   * there is none).
   */
  delete(userId, projectId) {
    const ownerId = requireUserId(userId);
    const id = requireId(projectId, 'invalid_project_id', 'Project id');
    return transaction(() => {
      const tree = projectTree(stmts.getYeaftProjectsByUser.all(ownerId));
      if (!tree.byId.has(id)) throw new YeaftProjectDbError('not_found', 'Project not found');
      const parentId = tree.parentOf(id);
      const removedProjectIds = tree.subtreeIds(id);
      for (const removedId of removedProjectIds) {
        if (parentId) stmts.moveYeaftProjectMemberships.run(parentId, ownerId, removedId);
        else stmts.deleteYeaftProjectMemberships.run(ownerId, removedId);
        stmts.deleteYeaftProject.run(ownerId, removedId);
      }
      return { projectId: id, parentId, removedProjectIds };
    })();
  },

  reorder(userId, projectIds) {
    const ownerId = requireUserId(userId);
    const projects = this.list(ownerId);
    const ids = Array.isArray(projectIds)
      ? projectIds.map(value => typeof value === 'string' ? value.trim() : '')
      : [];
    const currentIds = new Set(projects.map(project => project.id));
    if (ids.length !== projects.length
        || ids.some(id => !id || !currentIds.has(id))
        || new Set(ids).size !== ids.length) {
      throw new YeaftProjectDbError('invalid_project_order', 'Complete Project order is required');
    }
    const now = Date.now();
    transaction(() => {
      ids.forEach((id, index) => {
        const result = stmts.updateYeaftProjectSortOrder.run(index, now, ownerId, id);
        if (result.changes !== 1) {
          throw new YeaftProjectDbError('project_order_changed', 'Project identity changed during reorder');
        }
      });
    })();
    return this.list(ownerId);
  },

  moveSession(userId, {
    agentId,
    sessionId,
    projectId = null,
    catalogUpdates = null,
  } = {}) {
    const ownerId = requireUserId(userId);
    const targetAgentId = requireId(agentId, 'invalid_agent_id', 'Agent id');
    const targetSessionId = requireId(sessionId, 'invalid_session_id', 'Session id');
    const targetProjectId = projectId == null || projectId === ''
      ? null
      : requireId(projectId, 'invalid_project_id', 'Project id');
    if (targetProjectId) requireProject(ownerId, targetProjectId);
    if (catalogUpdates !== null && (!Array.isArray(catalogUpdates) || catalogUpdates.length === 0)) {
      throw new YeaftProjectDbError('invalid_catalog_order', 'Complete catalog order is required');
    }

    return transaction(() => {
      const now = Date.now();
      stmts.deleteYeaftProjectSessionMembership.run(ownerId, targetAgentId, targetSessionId);
      if (targetProjectId) {
        stmts.insertYeaftProjectSessionMembership.run(
          ownerId,
          targetProjectId,
          targetAgentId,
          targetSessionId,
          now,
        );
      }
      if (catalogUpdates) applySessionUiMetadataUpdates(ownerId, catalogUpdates, now);
      return { agentId: targetAgentId, sessionId: targetSessionId, projectId: targetProjectId };
    })();
  },

  /**
   * Assign a newly registered fork to the source's Project. The caller owns the
   * Session-registration transaction and replay fence; this is one insert, not
   * moveSession's independent transaction or a user-requested Project move.
   */
  inheritSessionProject(userId, agentId, sourceSessionId, targetSessionId) {
    const ownerId = requireUserId(userId);
    const targetAgentId = requireId(agentId, 'invalid_agent_id', 'Agent id');
    const sourceId = requireId(sourceSessionId, 'invalid_session_id', 'Source Session id');
    const targetId = requireId(targetSessionId, 'invalid_session_id', 'Fork Session id');
    if (sourceId === targetId) throw new YeaftProjectDbError('invalid_session_id', 'Fork must have a new identity');
    const project = stmts.getYeaftProjectForSession.get(ownerId, targetAgentId, sourceId);
    if (!project) return null;
    stmts.insertYeaftProjectSessionMembership.run(ownerId, project.id, targetAgentId, targetId, Date.now());
    return project.id;
  },

  reconcileAgentSessions(userId, agentId, sessionIds) {
    const ownerId = requireUserId(userId);
    const targetAgentId = requireId(agentId, 'invalid_agent_id', 'Agent id');
    const currentIds = new Set((Array.isArray(sessionIds) ? sessionIds : [])
      .filter(id => typeof id === 'string' && id.trim())
      .map(id => id.trim()));
    let removed = 0;
    for (const project of this.list(ownerId)) {
      for (const member of project.members) {
        if (member.agentId !== targetAgentId || currentIds.has(member.sessionId)) continue;
        removed += stmts.deleteYeaftProjectMembershipsForSession.run(
          ownerId,
          targetAgentId,
          member.sessionId,
        ).changes;
      }
    }
    return removed;
  },

  removeSession(userId, agentId, sessionId) {
    const ownerId = requireUserId(userId);
    const targetAgentId = requireId(agentId, 'invalid_agent_id', 'Agent id');
    const targetSessionId = requireId(sessionId, 'invalid_session_id', 'Session id');
    return stmts.deleteYeaftProjectMembershipsForSession.run(
      ownerId,
      targetAgentId,
      targetSessionId,
    ).changes > 0;
  },

  importLegacyProjects(userId, agentId, projects, sessionExists = () => true) {
    const ownerId = requireUserId(userId);
    const targetAgentId = requireId(agentId, 'invalid_agent_id', 'Agent id');
    if (stmts.getYeaftProjectImport.get(ownerId, targetAgentId)) return false;
    if (!Array.isArray(projects)) return false;
    const rows = projects;
    transaction(() => {
      const existingProjects = this.list(ownerId);
      const usedNames = new Set(existingProjects.map(project => project.name));
      let sortOrder = existingProjects.length;
      for (const row of rows) {
        const baseName = typeof row?.name === 'string' ? row.name.trim() : '';
        if (!baseName) continue;
        let name = baseName;
        for (let suffix = 2; usedNames.has(name); suffix += 1) name = `${baseName} ${suffix}`;
        const projectId = `project-${randomUUID().slice(0, 8)}`;
        const now = Date.now();
        stmts.insertYeaftProject.run(projectId, ownerId, name.slice(0, 120), '', null, sortOrder, now, now);
        sortOrder += 1;
        usedNames.add(name);
        for (const rawSessionId of Array.isArray(row.sessionIds) ? row.sessionIds : []) {
          const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
          if (!sessionId || !sessionExists(sessionId)) continue;
          // Legacy discovery is not authority over an existing Server membership.
          if (stmts.getYeaftProjectForSession.get(ownerId, targetAgentId, sessionId)) continue;
          stmts.deleteYeaftProjectSessionMembership.run(ownerId, targetAgentId, sessionId);
          stmts.insertYeaftProjectSessionMembership.run(
            ownerId,
            projectId,
            targetAgentId,
            sessionId,
            now,
          );
        }
      }
      stmts.insertYeaftProjectImport.run(ownerId, targetAgentId, Date.now());
    })();
    return true;
  },

  /**
   * The Agent-facing Project context of one Session. Nested folders keep the
   * Agent contract a single Project:
   * - projectName is the folder path ("Outer / Inner");
   * - projectInstruction inherits every non-empty instruction on that path,
   *   outermost first; a single one is passed verbatim (the flat behavior);
   * - sessionIds are same-Agent Sessions anywhere under the top-level folder,
   *   so reorganizing into subfolders never narrows what a Session can recall.
   */
  contextForSession(userId, agentId, sessionId) {
    const ownerId = requireUserId(userId);
    const targetAgentId = requireId(agentId, 'invalid_agent_id', 'Agent id');
    const targetSessionId = requireId(sessionId, 'invalid_session_id', 'Session id');
    const project = stmts.getYeaftProjectForSession.get(ownerId, targetAgentId, targetSessionId);
    if (!project) return null;
    const tree = projectTree(stmts.getYeaftProjectsByUser.all(ownerId));
    const chain = tree.pathOf(project.id);
    const labels = chain.map((_, index) => chain.slice(0, index + 1).map(row => row.name).join(' / '));
    const instructions = chain
      .map((row, index) => ({
        label: labels[index],
        text: typeof row.instruction === 'string' ? row.instruction.trim() : '',
      }))
      .filter(item => item.text);
    const sessionIds = new Set();
    for (const folderId of tree.subtreeIds(chain[0].id)) {
      for (const row of stmts.getYeaftProjectMembersForAgent.all(ownerId, folderId, targetAgentId)) {
        if (row.session_id && row.session_id !== targetSessionId) sessionIds.add(row.session_id);
      }
    }
    return {
      projectId: project.id,
      projectName: labels.at(-1),
      projectInstruction: instructions.length === 1
        ? instructions[0].text
        : instructions.map(item => `[${item.label}]\n${item.text}`).join('\n\n'),
      sessionIds: [...sessionIds],
    };
  },
};
