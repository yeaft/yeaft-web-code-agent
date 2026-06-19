import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const toolLineSource = readFileSync(new URL('../../web/components/ToolLine.js', import.meta.url), 'utf8');
const assistantTurnSource = readFileSync(new URL('../../web/components/AssistantTurn.js', import.meta.url), 'utf8');
const messageItemSource = readFileSync(new URL('../../web/components/MessageItem.js', import.meta.url), 'utf8');

describe('terminal output normalization render wiring', () => {
  it('normalizes Bash and synthetic tool output before rendering', () => {
    expect(toolLineSource).toContain("import { normalizeTerminalOutput } from '../utils/terminal-output.js';");
    expect(toolLineSource).toContain('return normalizeTerminalOutput(extractTextResult(props.toolResult));');
    expect(toolLineSource).toContain('{{ syntheticResultOutput }}');
    expect(toolLineSource).toContain('{{ compactSummaryOutput }}');
    expect(toolLineSource).not.toContain('{{ toolInput?.result || toolInput?.summary || formatInput(toolInput) }}');
  });

  it('normalizes assistant markdown and plain message text before rendering', () => {
    expect(assistantTurnSource).toContain('content = normalizeTerminalOutput(content);');
    expect(messageItemSource).toContain('const displayContent = Vue.computed(() => normalizeTerminalOutput(props.message.content || \'\'));');
    expect(messageItemSource).toContain('{{ displayContent }}');
  });
});
