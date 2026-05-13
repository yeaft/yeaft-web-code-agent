/**
 * start-plan.js — start_plan tool.
 *
 * Lightweight planning entry point inspired by Claude Code's plan mode.
 * Unlike Claude Code, we do NOT swap tools or change conversation state —
 * `start_plan` is a regular tool. Its only job is to push a planning
 * instruction back into the model's tool-result stream so the very next
 * turn produces a structured plan plus a `TodoWrite` call.
 *
 * Design (locked 2026-05-13):
 *   - Anyone can call it; the tool description tells the LLM when to.
 *   - The instruction text comes from one of two places, in order:
 *       1. The active VP's `planInstruction` frontmatter override
 *          (threaded through ctx.vpPersona.planInstruction by the
 *          engine; see engine.js #buildToolContext).
 *       2. The default template `templates/plan-instruction.md`
 *          loaded at module init by prompts.js.
 *   - The caller may pass guiding fields (stuck_at, user_problem,
 *     expected_scale, additional_context) to help the model think — these
 *     are echoed back in the tool result so the planning turn can read
 *     them without re-asking the user.
 *   - Output is plain text (the instruction + the echo). No side effects,
 *     no persistence — the LLM's next turn does the actual planning and
 *     calls TodoWrite to land structured steps.
 *
 * The expected integration is TodoWrite: after the planning turn the LLM
 * issues a `TodoWrite` call enumerating the 1..N steps. The frontend
 * already renders TodoWrite as a checkbox-style list, so the user sees
 * the plan materialize without any new UI.
 */

import { defineTool } from './types.js';
import { getDefaultPlanInstruction } from '../prompts.js';

export default defineTool({
  name: 'start_plan',
  description: `Enter planning mode for a non-trivial task. Use BEFORE you start working when the request needs multiple steps, has unclear scope, or the user said "make a plan" / "think through this first".

This tool does NOT execute the work. It returns a planning instruction; on the next turn you should:
1. Produce a short prose plan (problem, approach, risks).
2. Call \`TodoWrite\` with the ordered steps. Mark the first concrete step "in_progress", the rest "pending".

WHEN TO USE:
- Multi-step implementation (3+ steps), refactor, or open-ended investigation.
- User explicitly asks for a plan, a TODO list, or to "think through" the work.
- You're about to start a large change and want a checkpoint before diving in.

WHEN NOT TO USE:
- Single trivial change, single command run, lookup-style question.
- Mid-execution — once you're past the first step, use TodoWrite directly.

The tool takes the topic plus optional guiding fields (stuck_at, user_problem, expected_scale, additional_context) that help you think; they're echoed back verbatim, so don't repeat the full user request in \`topic\`.`,
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'One-sentence statement of what is being planned (e.g. "Add dark-mode toggle to UnifyPage settings").',
      },
      user_problem: {
        type: 'string',
        description: 'Optional. The underlying problem the user is trying to solve (often broader than the immediate ask).',
      },
      stuck_at: {
        type: 'string',
        description: 'Optional. If you are blocked or unsure, the specific decision or unknown that needs resolving first.',
      },
      expected_scale: {
        type: 'string',
        description: 'Optional. Rough scope estimate — number of files touched, lines of code, time horizon, etc.',
      },
      additional_context: {
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
      return JSON.stringify({ error: 'topic is required (one-sentence statement of what is being planned)' });
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
    for (const key of ['user_problem', 'stuck_at', 'expected_scale', 'additional_context']) {
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
    lines.push('Next: produce the plan as described above, then call `TodoWrite` to land the ordered steps. Do NOT start executing the steps in this turn.');

    return lines.join('\n');
  },
});
