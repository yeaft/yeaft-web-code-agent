/**
 * Crew — 动态角色管理
 * addRoleToSession, removeRoleFromSession
 */
import { initRoleDir, updateSharedClaudeMd } from './shared-dir.js';
import { saveRoleSessionId } from './role-query.js';
import { sendCrewMessage, sendCrewOutput, sendStatusUpdate } from './ui-messages.js';
import { saveSessionMeta, upsertCrewIndex } from './persistence.js';

/** Format role label */
function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

/**
 * 向现有 session 动态添加角色
 */
export async function addRoleToSession(msg) {
  // Lazy import to avoid circular dependency
  const { crewSessions, expandRoles, resumeCrewSession } = await import('./session.js');

  const { sessionId, role } = msg;
  let session = crewSessions.get(sessionId);
  if (!session) {
    // Auto-resume: try to restore from disk before giving up
    console.log(`[Crew] Session ${sessionId} not in memory, attempting auto-resume...`);
    try {
      await resumeCrewSession({ sessionId });
      session = crewSessions.get(sessionId);
    } catch (e) {
      console.warn(`[Crew] Auto-resume failed for ${sessionId}:`, e.message);
    }
    if (!session) {
      console.warn(`[Crew] Session not found: ${sessionId} (even after auto-resume)`);
      return;
    }
  }

  const rolesToAdd = expandRoles([role]);
  const addedRoles = [];

  for (const r of rolesToAdd) {
    if (session.roles.has(r.name)) {
      console.warn(`[Crew] Role already exists: ${r.name}`);
      continue;
    }

    session.roles.set(r.name, r);
    addedRoles.push(r);

    if (r.isDecisionMaker) {
      session.decisionMaker = r.name;
    }
    if (!session.decisionMaker) {
      session.decisionMaker = r.name;
    }

    await initRoleDir(session.sharedDir, r, session.language || 'zh-CN', Array.from(session.roles.values()));

    console.log(`[Crew] Role added: ${r.name} (${r.displayName}) to session ${sessionId}`);

    sendCrewMessage({
      type: 'crew_role_added',
      sessionId,
      role: {
        name: r.name,
        displayName: r.displayName,
        icon: r.icon,
        description: r.description,
        isDecisionMaker: r.isDecisionMaker || false,
        model: r.model,
        roleType: r.roleType,
        groupIndex: r.groupIndex
      },
      decisionMaker: session.decisionMaker
    });

    sendCrewOutput(session, 'system', 'system', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `${roleLabel(r)} 加入了群聊` }] }
    });
  }

  await updateSharedClaudeMd(session);

  // Notify the decision maker about the new role(s) so it can ROUTE to them.
  // We inject a system message into the DM's next turn via dispatchToRole
  // (only if the DM is idle — otherwise the DM will see the updated team list
  // through its CLAUDE.md or recent-routes context on next turn).
  if (session.decisionMaker && addedRoles.length > 0) {
    const dmState = session.roleStates.get(session.decisionMaker);
    const dmIdle = !dmState || !dmState.turnActive;

    if (dmIdle) {
      const isZh = (session.language || 'zh-CN').startsWith('zh');
      const addedNames = addedRoles.map(r => `${roleLabel(r)}(${r.name})`).join(', ');
      const notice = isZh
        ? `[系统通知] 新角色已加入团队: ${addedNames}。请在后续任务分配中考虑这些新成员。`
        : `[System Notice] New role(s) joined the team: ${addedNames}. Consider them in future task assignments.`;

      // Lazy import to avoid circular dependency
      const { dispatchToRole } = await import('./routing.js');
      await dispatchToRole(session, session.decisionMaker, notice, 'system');
    }
  }

  sendStatusUpdate(session);
  // Roles changed — persist
  saveSessionMeta(session).catch(e => console.warn('[Crew] Failed to save after addRole:', e.message));
  upsertCrewIndex(session).catch(e => console.warn('[Crew] Failed to update index after addRole:', e.message));
}

/**
 * 从 session 移除角色
 */
export async function removeRoleFromSession(msg) {
  const { crewSessions, resumeCrewSession } = await import('./session.js');

  const { sessionId, roleName } = msg;
  let session = crewSessions.get(sessionId);
  if (!session) {
    // Auto-resume: try to restore from disk before giving up
    console.log(`[Crew] Session ${sessionId} not in memory, attempting auto-resume...`);
    try {
      await resumeCrewSession({ sessionId });
      session = crewSessions.get(sessionId);
    } catch (e) {
      console.warn(`[Crew] Auto-resume failed for ${sessionId}:`, e.message);
    }
    if (!session) {
      console.warn(`[Crew] Session not found: ${sessionId} (even after auto-resume)`);
      return;
    }
  }

  const role = session.roles.get(roleName);
  if (!role) {
    console.warn(`[Crew] Role not found: ${roleName}`);
    return;
  }

  // 停止角色的 query
  const roleState = session.roleStates.get(roleName);
  if (roleState) {
    if (roleState.claudeSessionId) {
      await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId);
    }
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    session.roleStates.delete(roleName);
  }

  session.roles.delete(roleName);

  if (session.decisionMaker === roleName) {
    const remaining = Array.from(session.roles.values());
    const newDM = remaining.find(r => r.isDecisionMaker) || remaining[0];
    session.decisionMaker = newDM?.name || null;
  }

  await updateSharedClaudeMd(session);

  console.log(`[Crew] Role removed: ${roleName} from session ${sessionId}`);

  sendCrewMessage({
    type: 'crew_role_removed',
    sessionId,
    roleName,
    decisionMaker: session.decisionMaker
  });

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${roleLabel(role)} 离开了群聊` }] }
  });

  sendStatusUpdate(session);
  // Roles changed — persist
  saveSessionMeta(session).catch(e => console.warn('[Crew] Failed to save after removeRole:', e.message));
  upsertCrewIndex(session).catch(e => console.warn('[Crew] Failed to update index after removeRole:', e.message));
}
