import { describe, expect, it } from 'vitest';
import { historyDisplayToolResultContent } from '../../../agent/yeaft/web-bridge.js';

describe('Yeaft web bridge history display projection', () => {
  it('truncates tool output only for visible history display copies', () => {
    const fullContent = 'z'.repeat(1500);

    const visibleContent = historyDisplayToolResultContent(fullContent, {
      toolName: 'BigTool',
      language: 'en',
    });

    expect(visibleContent).not.toBe(fullContent);
    expect(visibleContent).toContain('[truncated: BigTool returned');
    expect(visibleContent).toContain('live requests, debug, and persistence keep the full content');
  });
});
