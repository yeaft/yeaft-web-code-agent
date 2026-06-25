import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSubAgentTaskDetailLines, createSubAgentTaskStreamText } from '../../web/components/VpTimelinePane.js';

const toolLineSource = readFileSync(new URL('../../web/components/ToolLine.js', import.meta.url), 'utf8');
const assistantTurnSource = readFileSync(new URL('../../web/components/AssistantTurn.js', import.meta.url), 'utf8');
const messageItemSource = readFileSync(new URL('../../web/components/MessageItem.js', import.meta.url), 'utf8');
const vpTimelinePaneSource = readFileSync(new URL('../../web/components/VpTimelinePane.js', import.meta.url), 'utf8');
const terminalOutputSource = readFileSync(new URL('../../web/components/TerminalOutput.js', import.meta.url), 'utf8');
const yeaftCssSource = readFileSync(new URL('../../web/styles/yeaft.css', import.meta.url), 'utf8');
const variablesCssSource = readFileSync(new URL('../../web/styles/variables.css', import.meta.url), 'utf8');

describe('terminal output normalization render wiring', () => {
  it('renders Bash output through ANSI-aware terminal tokens and normalizes synthetic text output', () => {
    expect(toolLineSource).toContain("import TerminalOutput from './TerminalOutput.js';");
    expect(toolLineSource).toContain('components: { TerminalOutput }');
    expect(toolLineSource).toContain('<TerminalOutput class="bash-output-content" :content="bashOutput" />');
    expect(toolLineSource).toContain('return extractTextResult(props.toolResult);');
    expect(toolLineSource).toContain('{{ syntheticResultOutput }}');
    expect(toolLineSource).toContain('{{ compactSummaryOutput }}');
    expect(toolLineSource).not.toContain('{{ toolInput?.result || toolInput?.summary || formatInput(toolInput) }}');
  });

  it('normalizes assistant markdown and plain message text before rendering', () => {
    expect(assistantTurnSource).toContain('content = normalizeTerminalOutput(content);');
    expect(messageItemSource).toContain('const displayContent = Vue.computed(() => normalizeTerminalOutput(props.message.content || \'\'));');
    expect(messageItemSource).toContain('{{ displayContent }}');
  });

  it('renders background task logs through the terminal output component', () => {
    expect(vpTimelinePaneSource).toContain("import TerminalOutput from './TerminalOutput.js';");
    expect(vpTimelinePaneSource).toContain('components: { TerminalOutput }');
    expect(vpTimelinePaneSource).toContain('<TerminalOutput');
    expect(vpTimelinePaneSource).toContain(':content="task.log.preview"');
    expect(vpTimelinePaneSource).not.toContain('>{{ task.log.preview }}</pre>');
  });

  it('keeps terminal rendering token based instead of html based', () => {
    expect(terminalOutputSource).toContain('tokenizeTerminalOutput(props.content)');
    expect(terminalOutputSource).toContain('v-for="(token, index) in tokens"');
    expect(terminalOutputSource).not.toContain('v-html');
  });

  it('styles background task logs inside a subtle detail region', () => {
    const taskDetailBlock = yeaftCssSource.match(/\.yeaft-vp-task-detail \{[\s\S]*?\n\}/)?.[0] || '';
    const taskLogBlock = yeaftCssSource.match(/\.yeaft-vp-task-log,\n\.yeaft-vp-task-log-empty \{[\s\S]*?\n\}/)?.[0] || '';

    expect(taskDetailBlock).toContain('background: var(--bg-user-msg-subtle);');
    expect(taskDetailBlock).toContain('border-radius: 8px;');
    expect(taskLogBlock).toContain('background: transparent;');
    expect(taskLogBlock).not.toContain('border:');
    expect(yeaftCssSource).toContain('@keyframes yeaft-task-running-pulse');
    expect(yeaftCssSource).toContain('max-height: min(52vh, 520px);');
    expect(yeaftCssSource).toContain('overscroll-behavior: contain;');
    expect(yeaftCssSource).not.toContain('.yeaft-vp-task-prompt-form');
    expect(variablesCssSource).toContain('.terminal-fg-green { color: var(--terminal-fg-green); }');
    expect(variablesCssSource).toContain('.terminal-bg-cyan { background-color: var(--terminal-bg-cyan); }');
    expect(variablesCssSource).toContain('.terminal-output');
  });

  it('formats sub-agent task JSONL into human readable detail lines', () => {
    const messages = {
      'yeaft.sessionStatus.task.subAgentResult': '{name} result: {text}',
      'yeaft.sessionStatus.task.subAgentStatus': '{name} is {status}',
      'yeaft.sessionStatus.task.subAgentEvent': '{name}: {text}',
      'yeaft.sessionStatus.task.subAgentUserPrompt': 'You: {text}',
      'yeaft.sessionStatus.task.subAgentToolSummary': '{count} tool calls completed',
    };
    const t = (key, params = {}) => Object.entries(params).reduce(
      (text, [name, value]) => text.replace(new RegExp(`\\{${name}\\}`, 'g'), value),
      messages[key] || key,
    );
    const preview = [
      JSON.stringify({ type: 'sub_agent_status', agentName: 'worker', status: 'running' }),
      JSON.stringify({ type: 'tool_call', id: 'tool-1', agentName: 'worker', name: 'FileRead' }),
      JSON.stringify({ type: 'tool_start', id: 'tool-1', agentName: 'worker', name: 'FileRead' }),
      JSON.stringify({ type: 'tool_end', id: 'tool-1', agentName: 'worker', name: 'FileRead' }),
      JSON.stringify({ type: 'text_delta', agentName: 'worker', text: 'partial ' }),
      JSON.stringify({ type: 'text_delta', agentName: 'worker', text: 'answer' }),
      JSON.stringify({ type: 'tool_call', agentName: 'worker', name: 'Bash' }),
      JSON.stringify({ type: 'sub_agent_turn_end', agentName: 'worker', content: 'final answer' }),
    ].join('\n');

    expect(createSubAgentTaskStreamText({ kind: 'sub_agent', log: { preview } }, t)).toBe([
      'worker result: final answer',
      '2 tool calls completed',
    ].join('\n'));
    expect(createSubAgentTaskDetailLines({ kind: 'sub_agent', log: { preview } }, t)).toEqual([
      'worker result: final answer',
      '2 tool calls completed',
    ]);
    expect(createSubAgentTaskDetailLines({
      kind: 'sub_agent',
      agentName: 'worker',
      result: { summary: 'final answer from task snapshot' },
      log: { preview: JSON.stringify({ type: 'sub_agent_status', agentName: 'worker', status: 'running' }) },
    }, t)).toEqual([
      'worker result: final answer from task snapshot',
    ]);
    expect(createSubAgentTaskDetailLines({ kind: 'shell', log: { preview } }, t)).toEqual([]);

    const lifecyclePreview = [
      JSON.stringify({ type: 'tool_call', id: 'tool-1', agentName: 'worker', name: 'FileRead' }),
      JSON.stringify({ type: 'tool_start', id: 'tool-1', agentName: 'worker', name: 'FileRead' }),
      JSON.stringify({ type: 'tool_end', id: 'tool-1', agentName: 'worker', name: 'FileRead' }),
    ].join('\n');
    expect(createSubAgentTaskStreamText({ kind: 'sub_agent', log: { preview: lifecyclePreview } }, t))
      .toBe('1 tool calls completed');

    const longDelta = 'x'.repeat(900);
    expect(createSubAgentTaskStreamText({
      kind: 'sub_agent',
      log: { preview: JSON.stringify({ type: 'text_delta', agentName: 'worker', text: longDelta }) },
    }, t)).toBe(`worker: ${longDelta}`);

    expect(vpTimelinePaneSource).toContain('export function createSubAgentTaskDetailLines');
    expect(vpTimelinePaneSource).toContain('const resultSummary = compactText(task.result?.summary);');
    expect(vpTimelinePaneSource).toContain('v-if="task.kind === \'sub_agent\'"');
    expect(vpTimelinePaneSource).toContain('const compactText = (value, maxLength = 360) => {');
    expect(vpTimelinePaneSource).toContain("$t('yeaft.sessionStatus.task.subAgentNoReadableEvents')");
    expect(vpTimelinePaneSource).toContain('{{ taskKindLabel(task) }}');
    expect(vpTimelinePaneSource).toContain("task.status !== 'running'");
    expect(vpTimelinePaneSource).toContain("event.type === 'text_delta'");
    expect(vpTimelinePaneSource).toContain('createSubAgentTaskStreamText');
    expect(vpTimelinePaneSource).toContain('const readableText = (value) => {');
    expect(vpTimelinePaneSource).toContain('toolSummaryLine(toolCallCount, $t)');
    expect(vpTimelinePaneSource).not.toContain("case 'sub_agent_status':");
    expect(vpTimelinePaneSource).not.toContain("case 'tool_call':");
    expect(vpTimelinePaneSource).not.toContain("emit('prompt-sub-agent'");
    expect(vpTimelinePaneSource).not.toContain('yeaft-vp-task-prompt-form');
    expect(vpTimelinePaneSource).not.toContain('subAgentPromptError(task)');
    expect(vpTimelinePaneSource).not.toContain('isSubAgentPromptPending(task)');
    expect(vpTimelinePaneSource).not.toContain('subAgentSaid');
    expect(vpTimelinePaneSource).not.toContain('{{ task.log.preview }}');
  });
});
