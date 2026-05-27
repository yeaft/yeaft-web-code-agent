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
export function buildSpawnedPreamble({ parentName, parentVpId, agentName, mission, language = 'en' } = {}) {
  const m = (mission || '').trim();
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
      '- 完成时直接以 markdown 自由文本回复（end_turn）。建议结构："## 结果" / "## 关键发现" / "## 遗留问题"。',
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
    '- When done, reply in free markdown (end_turn). Suggested structure: "## Result" / "## Key findings" / "## Open questions".',
    '- If the mission is infeasible or you fail, say so plainly. The parent will read your final message.',
  ];
  return lines.join('\n');
}
