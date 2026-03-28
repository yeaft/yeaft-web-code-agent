import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for Chat header compact/clear buttons.
 *
 * Verifies business logic:
 * 1) compactContext sends /compact, guards with isCompacting
 * 2) clearMessages uses confirm dialog, sends /clear
 * 3) isCompacting computed checks compactStatus
 * 4) Buttons excluded from Crew mode
 */

let headerSource;

beforeAll(() => {
  const base = resolve(__dirname, '../../web');
  headerSource = readFileSync(resolve(base, 'components/ChatHeader.js'), 'utf-8');
});

// =====================================================================
// 1. Compact button — logic
// =====================================================================
describe('compact button', () => {
  it('compactContext function sends /compact via sendMessage', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnSection = setupSection.split('compactContext')[1]?.split('};')[0] || '';
    expect(fnSection).toContain("sendMessage('/compact')");
  });

  it('compactContext checks isCompacting before sending', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnSection = setupSection.split('compactContext')[1]?.split('};')[0] || '';
    expect(fnSection).toContain('isCompacting');
  });

  it('compact button disabled binding uses isCompacting', () => {
    expect(headerSource).toContain(':disabled="isCompacting"');
  });
});

// =====================================================================
// 2. Clear button — logic
// =====================================================================
describe('clear button', () => {
  it('clearMessages uses confirm dialog before sending', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnSection = setupSection.split('clearMessages')[1]?.split('};')[0] || '';
    expect(fnSection).toContain('confirm(');
  });

  it('clearMessages sends /clear via sendMessage', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const clearStart = setupSection.indexOf('clearMessages');
    const clearBody = setupSection.substring(clearStart, clearStart + 500);
    expect(clearBody).toContain("sendMessage('/clear')");
  });
});

// =====================================================================
// 3. isCompacting computed
// =====================================================================
describe('isCompacting computed', () => {
  it('isCompacting checks compactStatus status === compacting', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    expect(setupSection).toContain("compactStatus?.status === 'compacting'");
  });

  it('isCompacting checks conversationId matches effectiveConvId', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const isCompactingSection = setupSection.split('isCompacting')[1]?.split('});')[0] || '';
    expect(isCompactingSection).toContain('conversationId');
    expect(isCompactingSection).toContain('effectiveConvId');
  });
});

// =====================================================================
// 4. Buttons excluded from Crew mode
// =====================================================================
describe('buttons visibility — Chat mode only', () => {
  it('header-right div excludes Crew conversations', () => {
    // ChatHeader now uses local isCrew computed (instead of store.currentConversationIsCrew)
    expect(headerSource).toContain('!isCrew');
  });
});
