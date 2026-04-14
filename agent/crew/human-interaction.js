/**
 * Crew — 人工交互
 * handleCrewHumanInput, processHumanQueue
 */
import { dispatchToRole } from './routing.js';
import { sendStatusUpdate } from './ui-messages.js';
import { debouncedSaveSessionMeta } from './persistence.js';

/**
 * 处理人的输入
 */
export async function handleCrewHumanInput(msg) {
  // Lazy import to avoid circular dependency
  const { crewSessions, resumeCrewSession } = await import('./session.js');

  const { sessionId, content, targetRole, files } = msg;
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

  // Auto-resume: user sending a message = intent to continue → restore to running
  if (session.status === 'paused' || session.status === 'stopped' || session.status === 'completed') {
    console.log(`[Crew] Auto-resuming session from ${session.status} to running (user sent message)`);
    session.status = 'running';
    sendStatusUpdate(session);
    debouncedSaveSessionMeta(session);
  }

  // Build dispatch content (supports image attachments)
  function buildHumanContent(prefix, text) {
    if (files && files.length > 0) {
      const blocks = [];
      for (const file of files) {
        if (file.isImage || file.mimeType?.startsWith('image/')) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: file.mimeType, data: file.data }
          });
        }
      }
      blocks.push({ type: 'text', text: `${prefix}\n${text}` });
      return blocks;
    }
    return `${prefix}\n${text}`;
  }

  // 记录到 uiMessages 用于恢复时重放
  session.uiMessages.push({
    role: 'human', roleIcon: '', roleName: '你',
    type: 'text', content,
    timestamp: Date.now()
  });

  // 如果在等待人工介入
  if (session.status === 'waiting_human') {
    const waitingContext = session.waitingHumanContext;
    session.status = 'running';
    session.waitingHumanContext = null;
    sendStatusUpdate(session);
    // Status changed + new human message — persist (debounced, dispatch will follow)
    debouncedSaveSessionMeta(session);

    const target = targetRole || waitingContext?.fromRole || session.decisionMaker;
    await dispatchToRole(session, target, buildHumanContent('人工回复:', content), 'human');
    return;
  }

  // 解析 @role 指令
  const atMatch = content.match(/^@(\S+)\s*([\s\S]*)/);
  if (atMatch) {
    const atTarget = atMatch[1];
    const message = atMatch[2].trim() || content;

    let target = null;
    for (const [name, role] of session.roles) {
      if (name === atTarget.toLowerCase()) {
        target = name;
        break;
      }
      if (role.displayName === atTarget) {
        target = name;
        break;
      }
    }

    if (target) {
      // 检测纯 skill 命令（如 /context, /simplify），直接发送不加前缀
      if (/^\/[a-zA-Z0-9_-]+(?:\s+.*)?$/s.test(message)) {
        let roleState = session.roleStates.get(target);
        if (!roleState || !roleState.query || !roleState.inputStream) {
          const { createRoleQuery } = await import('./role-query.js');
          roleState = await createRoleQuery(session, target);
        }
        // P1-4: 守卫 stream.enqueue
        try {
          if (roleState.inputStream && !roleState.inputStream.isDone) {
            roleState.inputStream.enqueue({
              type: 'user',
              message: { role: 'user', content: message }
            });
          } else {
            console.warn(`[Crew] Skill dispatch: stream closed for ${target}, recreating`);
            const { createRoleQuery } = await import('./role-query.js');
            roleState = await createRoleQuery(session, target);
            roleState.inputStream.enqueue({
              type: 'user',
              message: { role: 'user', content: message }
            });
          }
        } catch (enqueueErr) {
          console.error(`[Crew] Skill dispatch enqueue failed for ${target}:`, enqueueErr.message);
          const { createRoleQuery } = await import('./role-query.js');
          roleState = await createRoleQuery(session, target);
          roleState.inputStream.enqueue({
            type: 'user',
            message: { role: 'user', content: message }
          });
        }
        sendStatusUpdate(session);
        console.log(`[Crew] Skill command dispatched to ${target}: ${message}`);
        return;
      }
      await dispatchToRole(session, target, buildHumanContent('人工消息:', message), 'human');
      return;
    }
  }

  // 默认发给决策者
  const target = targetRole || session.decisionMaker;
  await dispatchToRole(session, target, buildHumanContent('人工消息:', content), 'human');
}

/**
 * 处理排队的人的消息
 */
export async function processHumanQueue(session) {
  if (session.humanMessageQueue.length === 0) return;
  if (session._processingHumanQueue) return;
  session._processingHumanQueue = true;
  try {
    const msgs = session.humanMessageQueue.splice(0);
    if (msgs.length === 1) {
      const humanPrompt = `人工消息:\n${msgs[0].content}`;
      await dispatchToRole(session, msgs[0].target, humanPrompt, 'human');
    } else {
      const byTarget = new Map();
      for (const m of msgs) {
        if (!byTarget.has(m.target)) byTarget.set(m.target, []);
        byTarget.get(m.target).push(m.content);
      }
      for (const [target, contents] of byTarget) {
        const combined = contents.join('\n\n---\n\n');
        const humanPrompt = `人工消息:\n你有 ${contents.length} 条待处理消息，请一并分析并用多个 ROUTE 块并行分配：\n\n${combined}`;
        await dispatchToRole(session, target, humanPrompt, 'human');
      }
    }
  } finally {
    session._processingHumanQueue = false;
  }
}
