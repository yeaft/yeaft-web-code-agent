import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../web/components/AssistantTurn.js', import.meta.url), 'utf8');

describe('AssistantTurn tool expansion bindings', () => {
  it('returns the template helpers used by ToolLine expansion props', () => {
    expect(source).toContain(':expanded="toolExpandedValue(tool, i, \'history\')"');
    expect(source).toContain('@update:expanded="value => updateToolExpanded(tool, i, \'history\', value)"');
    expect(source).toContain(':expanded="toolExpandedValue(latestTool, latestToolIndex, \'latest\')"');
    expect(source).toContain('@update:expanded="value => updateToolExpanded(latestTool, latestToolIndex, \'latest\', value)"');
    expect(source).toMatch(/return\s*\{[\s\S]*toolExpandedValue,[\s\S]*updateToolExpanded[\s\S]*\};/);
  });
});
