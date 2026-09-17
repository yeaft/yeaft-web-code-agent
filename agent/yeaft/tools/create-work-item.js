import { defineTool } from './types.js';

function cleanCriteria(value) {
  return Array.isArray(value)
    ? value.map(item => String(item).trim()).filter(Boolean)
    : [];
}

export default defineTool({
  name: 'CreateWorkItem',
  description: {
    en: `Create a persistent Agent-level Work Center item from the current Session.

Use this when work must continue beyond the current turn, needs role handoffs, review, waiting, retry, or durable tracking. This creates only the goal contract; the Work Center Coordinator dynamically chooses the next Actions and executors until the acceptance criteria are verified. The current Session is always stamped as the origin and cannot be overridden by model input.`,
    zh: `从当前 Session 创建一个持久化的 Agent 级工作项。

当工作需要跨 turn 继续、需要角色接力、评审、等待、重试或长期跟踪时使用。该工具只创建目标契约；Work Center Coordinator 会动态选择下一批 Action 和执行者，直到验收条件得到验证。来源 Session 由运行时强制写入，模型输入不能覆盖。`,
  },
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: { en: 'Optional explicit title; otherwise the Coordinator generates one', zh: '可选的显式标题；省略时由 Coordinator 生成' },
      },
      goal: {
        type: 'string',
        description: { en: 'Stable outcome the work item must achieve', zh: '工作项必须达到的稳定目标' },
      },
      acceptanceCriteria: {
        type: 'array',
        items: { type: 'string' },
        description: { en: 'Verifiable completion criteria', zh: '可验证的完成条件' },
      },
      workItemType: {
        type: 'string',
        description: { en: 'Optional explicit Work Item type; omit or use auto for LLM inference', zh: '可选的工作项类型；省略或填写 auto 时由 LLM 推断' },
      },
      workDir: {
        type: 'string',
        description: { en: 'Existing project directory for execution', zh: '执行时使用的已存在项目目录' },
      },
      start: {
        type: 'boolean',
        description: { en: 'Start Coordinator execution immediately (default true)', zh: '是否立即启动 Coordinator 执行（默认 true）' },
      },
    },
    required: ['goal'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  // The persistent Coordinator can create a writable Action after creation
  // returns. A paused item has no Coordinator- or watcher-owned execution.
  mayMutateWorkspaceAfterReturn: input => input?.start !== false,
  async execute(input, ctx = {}) {
    const sessionId = typeof ctx.sessionId === 'string' ? ctx.sessionId.trim() : '';
    if (!sessionId) throw new Error('CreateWorkItem requires an active Session');
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    const goal = typeof input?.goal === 'string' ? input.goal.trim() : '';
    if (!goal) throw new Error('goal is required');

    // Dynamic import avoids tools/index -> create-work-item -> bridge -> runner
    // -> tools/index becoming a static initialization cycle.
    const { createWorkItemFromProducer, snapshotCurrentSessionContext } = await import('../work-center/bridge.js');
    const sessionContext = await snapshotCurrentSessionContext(sessionId);
    const detail = await createWorkItemFromProducer({
      ...(title ? { title } : {}),
      goal,
      acceptanceCriteria: cleanCriteria(input.acceptanceCriteria),
      workItemType: typeof input.workItemType === 'string' ? input.workItemType.trim() : 'auto',
      workDir: typeof input.workDir === 'string' ? input.workDir.trim() : (ctx.cwd || ''),
      // Agent-local Work Center settings freeze the Action-template and model
      // policy snapshot. Tool callers create the contract; they cannot smuggle
      // a different dispatch policy into it.
      origin: {
        sessionId,
        messageId: ctx.inboundEnvelope?.msg?.id || null,
        createdBy: ctx.currentVpId || 'assistant',
      },
      linkedSessionIds: [sessionId],
      sessionContext,
      start: input.start !== false,
    });
    return JSON.stringify({
      workItemId: detail.id,
      status: detail.status,
      title: detail.title,
      message: `Created Work Center item ${detail.id}`,
    });
  },
});
