/**
 * start-plan.js — StartPlan tool.
 *
 * Lightweight planning entry point inspired by Claude Code's plan mode.
 * Unlike Claude Code, we do NOT swap tools or change conversation state —
 * `StartPlan` is a regular tool. Its job is to push a planning instruction
 * back into the model's tool-result stream so the same turn produces a
 * short prose plan, a `TodoWrite` call to land the steps, and then keeps
 * going by starting the first step. The plan is the runway, not the
 * destination — the loop continues until the work is done (or until the
 * model legitimately needs the user, e.g. an unresolved unknown).
 *
 * Design:
 *   - Anyone can call it; the tool description tells the LLM when to.
 *   - The instruction text comes from one of two places, in order:
 *       1. The active VP's `planInstruction` frontmatter override
 *          (threaded through ctx.vpPersona.planInstruction by the
 *          engine; see engine.js #buildToolContext).
 *       2. The default template `templates/plan-instruction.md`
 *          loaded at module init by prompts.js.
 *   - The caller may pass guiding fields (stuckAt, userProblem,
 *     expectedScale, additionalContext) to help the model think — these
 *     are echoed back in the tool result so the planning turn can read
 *     them without re-asking the user.
 *   - Output is plain text (the instruction + the echo). No side effects,
 *     no persistence — the same turn that called StartPlan produces the
 *     plan, lands the steps via TodoWrite, and starts executing the first
 *     step (unless that first step is "ask the user", which is the one
 *     legitimate reason to stop here).
 *
 * The expected integration is TodoWrite: during the planning turn the LLM
 * issues a `TodoWrite` call enumerating the 1..N steps, then keeps going
 * and works the first step. The frontend already renders TodoWrite as a
 * checkbox-style list, so the user sees the plan materialize without any
 * new UI.
 */

import { defineTool } from './types.js';
import { getDefaultPlanInstruction } from '../prompts.js';

export default defineTool({
  name: 'StartPlan',
  description: {
    en: `Enter planning mode for a non-trivial task. Use BEFORE you start working when the request needs multiple steps, has unclear scope, or the user said "make a plan" / "think through this first".

This tool returns a planning instruction. Use it to land a structured plan, then keep working in the same turn. The expected flow is:
1. Produce a short prose plan (problem, approach, risks).
2. Call \`TodoWrite\` with the ordered steps. Mark the first concrete step "in_progress", the rest "pending".
3. Start executing that first step — call whatever tools the work needs. Do not end the turn just because the plan is written; the plan is the runway.

WHEN TO USE:
- Multi-step implementation (3+ steps), refactor, or open-ended investigation.
- User explicitly asks for a plan, a TODO list, or to "think through" the work.
- You're about to start a large change and want a checkpoint before diving in.

WHEN NOT TO USE:
- Single trivial change, single command run, lookup-style question.
- Mid-execution — once you're past the first step, use TodoWrite directly.

EXCEPTION — stop after the plan only if the first step is genuinely "ask the user" (an unresolved unknown that blocks every other step). Otherwise keep moving.

The tool takes the topic plus optional guiding fields (stuckAt, userProblem, expectedScale, additionalContext) that help you think; they're echoed back verbatim, so don't repeat the full user request in \`topic\`.`,
    zh: `进入规划模式，用于非平凡任务。在开始工作之前使用——当需求涉及多步骤、范围不明确，或用户说"先做个计划"/"先想清楚"时。

此工具返回规划指令。用它产出一份结构化计划，然后在同一个 turn 中继续工作。预期流程是：
1. 产出简短文字计划（问题、方法、风险）。
2. 调用 TodoWrite 写出有序步骤。将第一个具体步骤标记为 "in_progress"，其余标记为 "pending"。
3. 开始执行第一个步骤——调用工作所需的任何工具。不要因为计划写完了就结束 turn；计划是跑道。

何时使用：
- 多步骤实现（3+ 步）、重构或开放式调查。
- 用户明确要求计划、TODO 列表或"想清楚"再动手。
- 你即将开始一个大型改动，想在动手前有个检查点。

何时不使用：
- 单个琐碎改动、单个命令执行、查询式问题。
- 中途执行——一旦过了第一步，直接用 TodoWrite。

例外——只有当第一步确实是"询问用户"（一个未解决的未知因素，阻塞所有其他步骤）时才在计划后停止。否则继续前进。

此工具接收 topic 加上可选引导字段（stuckAt、userProblem、expectedScale、additionalContext）
帮助你思考；它们会被原样回显，所以不要在 topic 中重复完整的用户请求。`
  },
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'One-sentence statement of what is being planned (e.g. "Add dark-mode toggle to YeaftPage settings").',
      },
      userProblem: {
        type: 'string',
        description: 'Optional. The underlying problem the user is trying to solve (often broader than the immediate ask).',
      },
      stuckAt: {
        type: 'string',
        description: 'Optional. If you are blocked or unsure, the specific decision or unknown that needs resolving first.',
      },
      expectedScale: {
        type: 'string',
        description: 'Optional. Rough scope estimate — number of files touched, lines of code, time horizon, etc.',
      },
      additionalContext: {
        type: 'string',
        description: 'Optional. Any other facts that shape the plan (constraints, deadlines, related prior work).',
      },
    },
    required: ['topic'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const topic = typeof input?.topic === 'string' ? input.topic.trim() : '';
    if (!topic) {
      // Plain-text error — same shape as the success path so the LLM
      // doesn't need a JSON-vs-text branch to read this tool's output.
      return 'Error: topic is required (one-sentence statement of what is being planned).';
    }

    // Resolve the planning instruction: per-VP override first, then default.
    // `ctx.vpPersona.planInstruction` is wired by engine.js #buildToolContext;
    // it's the empty string when the VP has no override, or when the call is
    // not VP-scoped (test ctx, sub-agent ctx without persona). We tolerate
    // both shapes and fall through to the default template silently.
    const language = typeof ctx?.config?.language === 'string' ? ctx.config.language : 'en';
    const vpOverride = typeof ctx?.vpPersona?.planInstruction === 'string'
      ? ctx.vpPersona.planInstruction.trim()
      : '';
    const instruction = vpOverride || getDefaultPlanInstruction(language);

    // Echo the optional guiding fields back so the planning turn has them
    // without re-reading the user's original message. Skip empty strings.
    const echoed = {};
    for (const key of ['userProblem', 'stuckAt', 'expectedScale', 'additionalContext']) {
      const v = typeof input?.[key] === 'string' ? input[key].trim() : '';
      if (v) echoed[key] = v;
    }

    // Plain text is friendlier to the LLM than JSON for an instructional
    // result. The shape: a tagged instruction block, then a compact
    // YAML-ish echo of the guiding fields, then a one-line nudge to land
    // the plan via TodoWrite.
    const lines = [];
    lines.push('<plan-instruction>');
    lines.push(instruction);
    lines.push('</plan-instruction>');
    lines.push('');
    lines.push('<topic>');
    lines.push(topic);
    lines.push('</topic>');
    if (Object.keys(echoed).length > 0) {
      lines.push('');
      lines.push('<guiding-context>');
      for (const [k, v] of Object.entries(echoed)) {
        lines.push(`${k}: ${v}`);
      }
      lines.push('</guiding-context>');
    }
    lines.push('');
    lines.push('Next: produce the plan, call `TodoWrite` to land the ordered steps, then keep going — start executing the first step in this same turn. Only stop after the plan if the first step is "ask the user".');

    return lines.join('\n');
  },
});
