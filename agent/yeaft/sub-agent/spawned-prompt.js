/**
 * spawned-prompt.js — Build the spawned-sub-agent preamble.
 *
 * A sub-agent inherits its parent VP's full worker system prompt
 * (so the persona/voice carries over) and gets ONE additional preamble
 * block appended that tells it:
 *   - it is a sub-agent of {parentName}
 *   - its concrete mission (free markdown from the caller)
 *   - it MUST NOT spawn further sub-agents, route to other VPs,
 *     or interrupt the user (those tools are unregistered already
 *     but the constraint is still spelled out for clarity)
 *   - how to report back: free markdown, end_turn when mission complete
 *
 * This module is deliberately tiny — the heavy lifting (persona,
 * Layer A summaries, etc.) is reused from `prompts.js` via the parent
 * Engine's existing system-prompt build path.
 */

/**
 * @param {object} args
 * @param {string} args.parentName    — display name of spawning VP / Engine
 * @param {string} args.parentVpId    — vpId if available (for traceability)
 * @param {string} args.agentName     — sub-agent's own name (from Agent tool)
 * @param {string} args.mission       — free markdown describing the task
 * @param {'en'|'zh'} [args.language='en']
 * @returns {string} preamble block (already ## headed, ready to concat)
 */
export function buildSpawnedPreamble({ parentName, parentVpId, agentName, mission, expectedOutput, presetPrompt, budget, allowTools = [], language = 'en' } = {}) {
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
    expectedOutput ? `## expected_output\nReturn the requested structure; mark unverified facts and blockers honestly.\n${JSON.stringify(expectedOutput)}` : '',
    budget ? `## Execution budget\n${JSON.stringify(budget)}\nLimits are ceilings, not targets. Complete the assigned result, then stop; do not stop with a plan or promise to continue. If a tool or prerequisite is unavailable, return the evidence and blocker instead of searching for unavailable capabilities. Near the tool limit, prioritize a supported conclusion. At the limit, one tool-free report may be requested within the remaining time/token budget; do not automatically restart the work.` : '',
  ].filter(Boolean).join('\n\n');
  const m = [(mission || '').trim(), contract].filter(Boolean).join('\n\n');
  if (language === 'zh') {
    const lines = [
      '## 你是 sub-agent',
      `- 派出方：${parentName || 'parent'}${parentVpId ? ` (${parentVpId})` : ''}`,
      `- 你的名字：${agentName || 'sub-agent'}`,
      '- 你继承了派出方的人格与风格，但你不是 ta。你只负责完成下面的子任务。',
      '',
      '## 你的子任务',
      m || '(无具体任务说明)',
      '',
      '## 行为约束',
      '- 不要再 spawn sub-agent（你已经没有 SpawnAgent / PromptAgent / WaitAgent / CloseAgent 工具）。',
      '- 不要 route_forward 给别的 VP，不要 ask_user。',
      '- 每次调用必须解决一个仍未解决的问题；先检查最小定向结果，再决定是否扩展。不要重复成功读取的范围、同义搜索或仅为轮询而调用工具。',
      '- 不要把子任务扩展成全项目审计；证据已足够回答时立即收敛。工具活动不等于任务进展。',
      '- 完成时遵守 expected_output；未指定则返回结果、关键证据、实际验证及遗留问题。不要用计划或过程评论冒充最终结果。',
      '- 失败/不可行也要明确说出来，不要假装完成。父 VP 会读你的最终消息。',
    ];
    return lines.join('\n');
  }
  const lines = [
    '## You are a sub-agent',
    `- Spawned by: ${parentName || 'parent'}${parentVpId ? ` (${parentVpId})` : ''}`,
    `- Your name: ${agentName || 'sub-agent'}`,
    "- You inherit the spawner's persona and voice, but you are not them. You exist only to finish the sub-task below.",
    '',
    '## Your sub-task',
    m || '(no mission body provided)',
    '',
    '## Constraints',
    '- Do NOT spawn further sub-agents (SpawnAgent / PromptAgent / WaitAgent / CloseAgent are not in your toolset).',
    '- Do NOT use route_forward to other VPs. Do NOT ask_user.',
    '- Each call must resolve a remaining unknown. Inspect the smallest targeted result before expanding; do not repeat successful read ranges, equivalent searches, or poll tools without a concrete need.',
    '- Do not expand the mission into a whole-project audit. Stop once sufficient evidence answers the mission. Tool activity is not evidence of progress.',
    '- When done, follow expected_output if supplied; otherwise return result, key evidence, actual verification, and open questions. Plans and progress commentary are not final deliverables.',
    '- If the mission is infeasible or you fail, say so plainly. The parent will read your final message.',
  ];
  return lines.join('\n');
}
