/**
 * task-260: @role mention routing in Crew human input
 *
 * Tests that @role mentions in crew messages correctly route to the targeted role
 * instead of falling through to the default PM/decision-maker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAtMention } from '../../agent/crew/human-interaction.js';

// ─── resolveAtMention unit tests ─────────────────────────────────

describe('resolveAtMention', () => {
  const mockSession = {
    roles: new Map([
      ['pm', { displayName: 'PM-乔布斯', icon: '📋' }],
      ['dev-1', { displayName: '开发者-托瓦兹-1', icon: '💻' }],
      ['dev-2', { displayName: '开发者-托瓦兹-2', icon: '💻' }],
      ['rev-1', { displayName: '审查-福勒-1', icon: '🔍' }],
      ['test-1', { displayName: '测试-贝克-1', icon: '🧪' }],
    ])
  };

  it('resolves @displayName to role name', () => {
    const result = resolveAtMention('@开发者-托瓦兹-1 请继续工作', mockSession);
    expect(result).not.toBeNull();
    expect(result.target).toBe('dev-1');
    expect(result.message).toBe('请继续工作');
  });

  it('resolves @roleName to role name', () => {
    const result = resolveAtMention('@dev-1 please continue', mockSession);
    expect(result).not.toBeNull();
    expect(result.target).toBe('dev-1');
    expect(result.message).toBe('please continue');
  });

  it('resolves @PM-乔布斯 to pm', () => {
    const result = resolveAtMention('@PM-乔布斯 这个需求怎么看', mockSession);
    expect(result).not.toBeNull();
    expect(result.target).toBe('pm');
    expect(result.message).toBe('这个需求怎么看');
  });

  it('resolves compound name-displayName pattern', () => {
    const result = resolveAtMention('@dev-1-开发者-托瓦兹-1 test', mockSession);
    expect(result).not.toBeNull();
    expect(result.target).toBe('dev-1');
    expect(result.message).toBe('test');
  });

  it('returns null for non-existent role', () => {
    const result = resolveAtMention('@nonexistent hello', mockSession);
    expect(result).toBeNull();
  });

  it('returns null for no @ prefix', () => {
    const result = resolveAtMention('hello world', mockSession);
    expect(result).toBeNull();
  });

  it('returns null for @ in middle of text', () => {
    const result = resolveAtMention('please ask @dev-1 about this', mockSession);
    expect(result).toBeNull();
  });

  it('handles @role with no message after it', () => {
    // Regex requires \s* after @target, so "@dev-1" alone (no space) won't match
    const result = resolveAtMention('@dev-1', mockSession);
    // The regex is /^@(\S+)\s*([\s\S]*)/ — it matches "@dev-1" with empty capture group 2
    expect(result).not.toBeNull();
    expect(result.target).toBe('dev-1');
    // With empty message, falls back to original content
    expect(result.message).toBe('@dev-1');
  });

  it('handles multiline message after @role', () => {
    const result = resolveAtMention('@dev-1 line1\nline2\nline3', mockSession);
    expect(result).not.toBeNull();
    expect(result.target).toBe('dev-1');
    expect(result.message).toBe('line1\nline2\nline3');
  });

  it('handles @role with skill command', () => {
    const result = resolveAtMention('@dev-1 /context', mockSession);
    expect(result).not.toBeNull();
    expect(result.target).toBe('dev-1');
    expect(result.message).toBe('/context');
  });

  it('case-insensitive match on role name', () => {
    const result = resolveAtMention('@DEV-1 hello', mockSession);
    expect(result).not.toBeNull();
    expect(result.target).toBe('dev-1');
  });

  it('case-sensitive match on displayName', () => {
    // displayName match is exact
    const result = resolveAtMention('@pm-乔布斯 hello', mockSession);
    // "pm-乔布斯" !== "PM-乔布斯" (case mismatch) but name "pm" matches via toLowerCase
    // "pm" === "pm-乔布斯".toLowerCase()? No. Let's check: atTarget is "pm-乔布斯"
    // name "pm" === "pm-乔布斯" → false
    // displayName "PM-乔布斯" === "pm-乔布斯" → false (case)
    // compound "pm-PM-乔布斯".toLowerCase() === "pm-乔布斯" → false
    expect(result).toBeNull();
  });
});

// ─── handleCrewHumanInput integration pattern tests ─────────────

describe('handleCrewHumanInput @mention routing', () => {
  it('resolveAtMention is called before waiting_human check (code structure)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      new URL('../../agent/crew/human-interaction.js', import.meta.url),
      'utf-8'
    );

    // Find the positions of key code sections
    const resolveAtMentionCall = src.indexOf('resolveAtMention(content, session)');
    const waitingHumanCheck = src.indexOf("session.status === 'waiting_human'");
    const effectiveTargetRoleInWaiting = src.indexOf('effectiveTargetRole || waitingContext');

    expect(resolveAtMentionCall).toBeGreaterThan(-1);
    expect(waitingHumanCheck).toBeGreaterThan(-1);
    expect(effectiveTargetRoleInWaiting).toBeGreaterThan(-1);

    // Critical: resolveAtMention must be called BEFORE the waiting_human check
    expect(resolveAtMentionCall).toBeLessThan(waitingHumanCheck);

    // The waiting_human branch must use effectiveTargetRole (which includes @mention)
    expect(effectiveTargetRoleInWaiting).toBeGreaterThan(waitingHumanCheck);
  });

  it('waiting_human branch uses effectiveTargetRole, not just targetRole', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      new URL('../../agent/crew/human-interaction.js', import.meta.url),
      'utf-8'
    );

    // The old buggy code had: targetRole || waitingContext?.fromRole
    // The fix should have: effectiveTargetRole || waitingContext?.fromRole
    const waitingBlock = src.substring(
      src.indexOf("session.status === 'waiting_human'"),
      src.indexOf("// @role 指令")
    );

    // Should NOT have bare "targetRole ||" in the target assignment (would miss @mentions)
    // The target line should use effectiveTargetRole
    expect(waitingBlock).toContain('effectiveTargetRole');
    expect(waitingBlock).not.toMatch(/const target = targetRole \|\|/);
  });

  it('default fallback uses effectiveTargetRole, not targetRole', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      new URL('../../agent/crew/human-interaction.js', import.meta.url),
      'utf-8'
    );

    const defaultBlock = src.substring(src.indexOf('// 默认发给决策者'));
    expect(defaultBlock).toContain('effectiveTargetRole || session.decisionMaker');
    expect(defaultBlock).not.toMatch(/targetRole \|\| session\.decisionMaker/);
  });
});

// ─── Frontend crewInput.js @mention parsing tests ───────────────

describe('Frontend crewInput.js @mention parsing', () => {
  it('parses @role from content and passes targetRole to sendCrewMessage', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      new URL('../../web/components/crew/crewInput.js', import.meta.url),
      'utf-8'
    );

    // Should have @role parsing logic in the sendMessage function
    const sendMessageFn = src.substring(src.indexOf('function sendMessage'));

    // Should parse @mention from text
    expect(sendMessageFn).toMatch(/text\.match\(.*@/);

    // Should pass targetRole to sendCrewMessage (not always null)
    expect(sendMessageFn).toContain('store.sendCrewMessage(text, targetRole');

    // Should NOT have the old pattern of always passing null
    expect(sendMessageFn).not.toContain('store.sendCrewMessage(text, null');
  });

  it('matches roles by name and displayName', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      new URL('../../web/components/crew/crewInput.js', import.meta.url),
      'utf-8'
    );

    const sendMessageFn = src.substring(src.indexOf('function sendMessage'));

    // Should check both role.name and role.displayName
    expect(sendMessageFn).toContain('role.name');
    expect(sendMessageFn).toContain('role.displayName');
  });
});
