import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

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

  it('styles background task logs as a plain terminal region', () => {
    const taskLogBlock = yeaftCssSource.match(/\.yeaft-vp-task-log,\n\.yeaft-vp-task-log-empty \{[\s\S]*?\n\}/)?.[0] || '';

    expect(taskLogBlock).toContain('background: transparent;');
    expect(taskLogBlock).not.toContain('border:');
    expect(taskLogBlock).not.toContain('border-radius:');
    expect(variablesCssSource).toContain('.terminal-fg-green { color: var(--terminal-fg-green); }');
    expect(variablesCssSource).toContain('.terminal-bg-cyan { background-color: var(--terminal-bg-cyan); }');
    expect(variablesCssSource).toContain('.terminal-output');
  });
});
