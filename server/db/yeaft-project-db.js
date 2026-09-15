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

function mapProject(row, members = []) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    instruction: typeof row.instruction === 'string' ? row.instruction : '',
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
    return stmts.getYeaftProjectsByUser.all(ownerId)
      .map(row => mapProject(row, membersByProject.get(row.id) || []));
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

  create(userId, name) {
    const ownerId = requireUserId(userId);
    const projects = this.list(ownerId);
    const now = Date.now();
    const project = {
      id: `project-${randomUUID().slice(0, 8)}`,
      name: requireName(name),
      instruction: '',
      sortOrder: projects.reduce((max, row) => Math.max(max, Number(row.sortOrder) || 0), -1) + 1,
      createdAt: now,
      updatedAt: now,
      members: [],
    };
    stmts.insertYeaftProject.run(
      project.id,
      ownerId,
      project.name,
      project.instruction,
      project.sortOrder,
      now,
      now,
    );
    return project;
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

  delete(userId, projectId) {
    const ownerId = requireUserId(userId);
    const id = requireId(projectId, 'invalid_project_id', 'Project id');
    requireProject(ownerId, id);
    stmts.deleteYeaftProject.run(ownerId, id);
    return { projectId: id };
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
        stmts.insertYeaftProject.run(projectId, ownerId, name.slice(0, 120), '', sortOrder, now, now);
        sortOrder += 1;
        usedNames.add(name);
        for (const rawSessionId of Array.isArray(row.sessionIds) ? row.sessionIds : []) {
          const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
          if (!sessionId || !sessionExists(sessionId)) continue;
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

  contextForSession(userId, agentId, sessionId) {
    const ownerId = requireUserId(userId);
    const targetAgentId = requireId(agentId, 'invalid_agent_id', 'Agent id');
    const targetSessionId = requireId(sessionId, 'invalid_session_id', 'Session id');
    const project = stmts.getYeaftProjectForSession.get(ownerId, targetAgentId, targetSessionId);
    if (!project) return null;
    const sameAgentMembers = stmts.getYeaftProjectMembersForAgent
      .all(ownerId, project.id, targetAgentId)
      .map(row => row.session_id)
      .filter(id => id && id !== targetSessionId);
    return {
      projectId: project.id,
      projectName: project.name,
      projectInstruction: typeof project.instruction === 'string' ? project.instruction : '',
      sessionIds: sameAgentMembers,
    };
  },
};
