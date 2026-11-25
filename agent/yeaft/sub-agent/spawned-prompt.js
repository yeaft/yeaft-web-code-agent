/**
 * spawned-prompt.js — Build the spawned-sub-agent preamble.
 *
 * Sub-agents report to a parent model, not directly to a human reader.
 * This preamble sets the child's execution contract:
 *   - delegated identity (parent reference + child name)
 *   - mission, optional role persona, tool authority, expected_output, and budget
 *   - strict machine-oriented, high-density structured delivery protocol
 *     (no human greetings, conversational filler, or mission restatement)
 *   - explicit orchestration boundaries (no recursive spawning / AskUser / RouteForward)
 */

/**
 * @param {object} args
 * @param {string} args.parentName      — display name of spawning VP / Engine
 * @param {string} args.parentVpId      — vpId if available (for traceability)
 * @param {string} args.agentName       — sub-agent's own name (from SpawnAgent)
 * @param {string} args.mission         — concrete objective statement
 * @param {object|null} [args.expectedOutput]
 * @param {string} [args.presetPrompt]
 * @param {string|null} [args.sceneId]
 * @param {object|null} [args.budget]
 * @param {string[]} [args.allowTools]
 * @param {'en'|'zh'} [args.language='en']
 * @returns {string} preamble block (ready to embed)
 */
export function buildSpawnedPreamble({
  parentName,
  parentVpId,
  agentName,
  mission,
  expectedOutput,
  presetPrompt,
  sceneId = null,
  budget,
  allowTools = [],
  language = 'en',
} = {}) {
  // Resolve template markers before embedding: the outer VP renderer treats
  // markers as sections of the whole soul and would drop the parent + contract.
  const locale = language === 'zh' || language === 'zh-CN' ? 'zh' : 'en';
  const sections = [...(presetPrompt || '').matchAll(/<!-- lang:(\w+) -->([\s\S]*?)(?=<!-- lang:|$)/g)];
  const rolePrompt = sections.length
    ? (sections.find(section => section[1] === locale) || sections.find(section => section[1] === 'en'))?.[2]?.trim()
    : presetPrompt;
  const contract = [
    rolePrompt || '',
    `## Tool authority\nDefault persona tools plus explicit parent grants: ${JSON.stringify(allowTools)}. Parent grants override a default read-only role only within the mission's scope. Bash permits arbitrary shell/writes; it is not a sandbox. You cannot grant yourself tools or budget; report blockers to the parent. UpdateAgent is parent-only.`,
    expectedOutput ? `## expected_output\nReturn ONLY the requested structure matching this schema with no conversational wrapper; mark unverified facts and blockers honestly.\n${JSON.stringify(expectedOutput)}` : '',
    budget ? `## Execution budget\n${JSON.stringify(budget)}\nLimits are ceilings, not targets. Complete the assigned result, then stop; do not stop with a plan or promise to continue. If a tool or prerequisite is unavailable, return the evidence and blocker instead of searching for unavailable capabilities. Near the tool limit, prioritize a supported conclusion. At the limit, one tool-free report may be requested within the remaining time/token budget; do not automatically restart the work.` : '',
  ].filter(Boolean).join('\n\n');
  const m = [(mission || '').trim(), contract].filter(Boolean).join('\n\n');

  if (locale === 'zh') {
    const outputProtocol = expectedOutput
      ? '- 严格按 `expected_output` schema 返回结构化结果；禁止在前后添加问候语、过渡句、任务复述或解释性废话。'
      : [
          '- 面向父 Agent 消费：使用紧凑、高信息密度的固定结构直接交付，禁止寒暄、客套、复述 mission 或过程流水账：',
          '  - `status`: `done | partial | blocked`',
          '  - `conclusion`: 1–3 句直接结论/决策',
          '  - `evidence`: 关键事实列表，一律使用指针引用（`path:line`、commit SHA、命令退出码、URL），不粘贴大段原文',
          '  - `changes`: 改动文件或产出路径（无则写 `none`）',
          '  - `verification`: 实际执行过的验证命令与结果（明确区分自测与上游提供的报告）',
          '  - `gaps`: 未覆盖范围、假设或阻塞点（无则写 `none`）',
        ].join('\n');
    const lines = [
      '## Sub-agent 执行契约',
      `- 派出方：${parentName || 'parent'}${parentVpId ? ` (${parentVpId})` : ''}`,
      `- 标识：${agentName || 'sub-agent'}${sceneId ? ` | scene=${sceneId}` : ''}`,
      '- 你的唯一接收方是父 Agent（机器消费，不直接面对人类用户）。只完成下方任务并返回可核验的结构化结果。',
      '',
      '## 你的子任务',
      m || '(无具体任务说明)',
      '',
      '## 行为约束与交付协议',
      '- 禁止再 spawn sub-agent（无 SpawnAgent / PromptAgent / WaitAgent / CloseAgent 工具）。',
      '- 禁止 route_forward 给其他 VP，禁止 ask_user。',
      '- 每次工具调用必须解决一个未决问题；先检查最小定向结果再决定是否扩展。不要重复成功读取的范围、同义搜索或无依据轮询。',
      '- 不要把子任务扩大为全项目审计；证据足以回答任务时立即收敛。工具活动不等于任务进展。',
      outputProtocol,
      '- 不确定或未验证的事实直接标 `unknown` 并说明原因，禁止猜测或编造；失败/不可行时明确报告 `status: blocked` 及阻塞证据。',
    ];
    return lines.join('\n');
  }

  const outputProtocol = expectedOutput
    ? '- Return ONLY a structured response matching `expected_output`. Do NOT add greetings, preamble, mission restatement, or conversational filler.'
    : [
        '- Parent-agent consumption protocol: return a compact, high-density structured handoff with NO greetings, filler, mission restatement, or play-by-play narration:',
        '  - `status`: `done | partial | blocked`',
        '  - `conclusion`: direct answer or decision (1–3 sentences)',
        '  - `evidence`: key facts cited via pointers (`path:line`, commit SHA, exit code, URL) rather than raw dumps',
        '  - `changes`: modified files or artifact paths (`none` if read-only)',
        '  - `verification`: commands actually executed and observed outcomes (distinguish self-run checks from supplied reports)',
        '  - `gaps`: uncovered scope, assumptions, or blockers (`none` if clear)',
      ].join('\n');

  const lines = [
    '## Sub-agent Execution Contract',
    `- Spawned by: ${parentName || 'parent'}${parentVpId ? ` (${parentVpId})` : ''}`,
    `- Identity: ${agentName || 'sub-agent'}${sceneId ? ` | scene=${sceneId}` : ''}`,
    '- Your sole consumer is the parent agent (agent-to-agent handoff, not human conversation). Complete only the sub-task below and return verifiable structured output.',
    '',
    '## Your sub-task',
    m || '(no mission body provided)',
    '',
    '## Constraints & Delivery Protocol',
    '- Do NOT spawn further sub-agents (SpawnAgent / PromptAgent / WaitAgent / CloseAgent are not in your toolset).',
    '- Do NOT use route_forward to other VPs. Do NOT ask_user.',
    '- Each tool call must resolve a remaining unknown. Inspect the smallest targeted result before expanding; do not repeat successful read ranges, equivalent searches, or poll tools without a concrete need.',
    '- Do not expand the mission into a whole-project audit. Stop once sufficient evidence answers the mission. Tool activity is not evidence of progress.',
    outputProtocol,
    '- Mark unverified facts as `unknown` with the reason; never fabricate. If infeasible or failed, report `status: blocked` with concrete diagnostics.',
  ];
  return lines.join('\n');
}
