import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for task-261: Unify Debug Panel — per-turn prompt/response/token/time.
 *
 * Data flow: Engine yields debug_turn → web-bridge forwards → store accumulates → UI renders.
 */

const rootDir = join(import.meta.dirname, '..', '..');
const unifyPageJs = readFileSync(join(rootDir, 'web/components/UnifyPage.js'), 'utf8');
const unifyCss = readFileSync(join(rootDir, 'web/styles/unify.css'), 'utf8');
const enI18n = readFileSync(join(rootDir, 'web/i18n/en.js'), 'utf8');
const zhI18n = readFileSync(join(rootDir, 'web/i18n/zh-CN.js'), 'utf8');
const chatStore = readFileSync(join(rootDir, 'web/stores/chat.js'), 'utf8');
const webBridge = readFileSync(join(rootDir, 'agent/unify/web-bridge.js'), 'utf8');
const engineJs = readFileSync(join(rootDir, 'agent/unify/engine.js'), 'utf8');

// =====================================================================
// 1. Engine — yields debug_turn event
// =====================================================================
describe('Engine yields debug_turn event', () => {
  it('yields debug_turn after endTurn on success path', () => {
    expect(engineJs).toContain("type: 'debug_turn'");
  });

  it('debug_turn includes turnNumber', () => {
    expect(engineJs).toMatch(/debug_turn[\s\S]*turnNumber/);
  });

  it('debug_turn includes model', () => {
    expect(engineJs).toMatch(/debug_turn[\s\S]*model:\s*currentModel/);
  });

  it('debug_turn includes systemPrompt', () => {
    expect(engineJs).toMatch(/debug_turn[\s\S]*systemPrompt/);
  });

  it('debug_turn includes messages', () => {
    expect(engineJs).toMatch(/debug_turn[\s\S]*messages:/);
  });

  it('debug_turn includes response', () => {
    expect(engineJs).toMatch(/debug_turn[\s\S]*response:\s*responseText/);
  });

  it('debug_turn includes toolCalls', () => {
    expect(engineJs).toMatch(/debug_turn[\s\S]*toolCalls:/);
  });

  it('debug_turn includes usage with inputTokens and outputTokens', () => {
    expect(engineJs).toMatch(/debug_turn[\s\S]*usage:\s*\{/);
  });

  it('debug_turn includes latencyMs', () => {
    expect(engineJs).toMatch(/debug_turn[\s\S]*latencyMs/);
  });

  it('debug_turn includes stopReason', () => {
    expect(engineJs).toMatch(/debug_turn[\s\S]*stopReason/);
  });

  it('yields debug_turn on error path too', () => {
    // There should be at least two occurrences of debug_turn yield
    const matches = engineJs.match(/type:\s*'debug_turn'/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

// =====================================================================
// 2. Web-bridge — forwards debug_turn
// =====================================================================
describe('Web-bridge forwards debug_turn', () => {
  it('has debug_turn case in event switch', () => {
    expect(webBridge).toContain("case 'debug_turn':");
  });

  it('sends debug_turn via sendUnifyEvent', () => {
    expect(webBridge).toMatch(/case 'debug_turn':[\s\S]*?sendUnifyEvent/);
  });

  it('forwards turnNumber', () => {
    expect(webBridge).toMatch(/debug_turn[\s\S]*turnNumber:\s*event\.turnNumber/);
  });

  it('forwards model', () => {
    expect(webBridge).toMatch(/debug_turn[\s\S]*model:\s*event\.model/);
  });

  it('forwards systemPrompt', () => {
    expect(webBridge).toMatch(/debug_turn[\s\S]*systemPrompt:\s*event\.systemPrompt/);
  });

  it('forwards messages', () => {
    expect(webBridge).toMatch(/debug_turn[\s\S]*messages:\s*event\.messages/);
  });

  it('forwards response', () => {
    expect(webBridge).toMatch(/debug_turn[\s\S]*response:\s*event\.response/);
  });

  it('forwards usage', () => {
    expect(webBridge).toMatch(/debug_turn[\s\S]*usage:\s*event\.usage/);
  });

  it('forwards latencyMs', () => {
    expect(webBridge).toMatch(/debug_turn[\s\S]*latencyMs:\s*event\.latencyMs/);
  });
});

// =====================================================================
// 3. Store — accumulates debug turns
// =====================================================================
describe('Store accumulates debug turns', () => {
  it('has unifyDebugTurns state', () => {
    expect(chatStore).toContain('unifyDebugTurns');
    expect(chatStore).toContain('unifyDebugTurns: []');
  });

  it('has debug_turn case in handleUnifyOutput', () => {
    expect(chatStore).toContain("case 'debug_turn':");
  });

  it('pushes to unifyDebugTurns on debug_turn event', () => {
    expect(chatStore).toMatch(/case 'debug_turn':[\s\S]*?unifyDebugTurns\.push/);
  });

  it('resets unifyDebugTurns on clearUnifyMessages', () => {
    expect(chatStore).toMatch(/clearUnifyMessages[\s\S]*?unifyDebugTurns\s*=\s*\[\]/);
  });
});

// =====================================================================
// 4. UI — debug button in topbar
// =====================================================================
describe('Debug button in topbar', () => {
  it('has debug button element', () => {
    expect(unifyPageJs).toContain('unify-debug-btn');
  });

  it('debug button has bug icon SVG', () => {
    // Bug icon has the distinctive antenna/legs path
    expect(unifyPageJs).toMatch(/unify-debug-btn[\s\S]*?<svg/);
  });

  it('debug button toggles debugMode', () => {
    expect(unifyPageJs).toContain('@click="toggleDebug"');
  });

  it('debug button has active class binding', () => {
    expect(unifyPageJs).toContain("{ active: debugMode }");
  });

  it('debug button has i18n title for show/hide', () => {
    expect(unifyPageJs).toContain("$t('unify.showDebug')");
    expect(unifyPageJs).toContain("$t('unify.hideDebug')");
  });
});

// =====================================================================
// 5. UI — debug panel in detail aside
// =====================================================================
describe('Debug panel in detail aside', () => {
  it('has debug panel container', () => {
    expect(unifyPageJs).toContain('unify-debug-panel');
  });

  it('debug panel is conditional on debugMode', () => {
    expect(unifyPageJs).toContain('v-if="debugMode"');
  });

  it('has debug header with title', () => {
    expect(unifyPageJs).toContain('unify-debug-header');
    expect(unifyPageJs).toContain('unify-debug-title');
  });

  it('has debug turn count badge', () => {
    expect(unifyPageJs).toContain('unify-debug-count');
    expect(unifyPageJs).toContain("$t('unify.debugTurns')");
  });

  it('iterates over debug turns', () => {
    expect(unifyPageJs).toContain('v-for="(turn, idx) in store.unifyDebugTurns"');
  });

  it('has collapsible turn headers', () => {
    expect(unifyPageJs).toContain('unify-debug-turn-header');
    expect(unifyPageJs).toContain('toggleTurnExpand');
  });

  it('turn header shows turn number, model, and stats', () => {
    expect(unifyPageJs).toContain('unify-debug-turn-num');
    expect(unifyPageJs).toContain('unify-debug-turn-model');
    expect(unifyPageJs).toContain('unify-debug-turn-stats');
  });

  it('turn number uses .replace for i18n interpolation (not string concat)', () => {
    // Must use $t('unify.turn').replace('{n}', ...) so zh-CN "第 {n} 轮" works
    expect(unifyPageJs).toContain("$t('unify.turn').replace('{n}', turn.turnNumber)");
  });

  it('turn body is conditional on expansion state', () => {
    expect(unifyPageJs).toContain('v-if="expandedTurns[idx]"');
  });

  it('shows system prompt section', () => {
    expect(unifyPageJs).toContain("$t('unify.systemPrompt')");
    expect(unifyPageJs).toContain('turn.systemPrompt');
  });

  it('shows messages section', () => {
    expect(unifyPageJs).toContain("$t('unify.messagesLabel')");
    expect(unifyPageJs).toContain('formatMessages(turn.messages)');
  });

  it('shows response section', () => {
    expect(unifyPageJs).toContain("$t('unify.response')");
    expect(unifyPageJs).toContain('turn.response');
  });

  it('shows tool calls section conditionally', () => {
    expect(unifyPageJs).toContain("$t('unify.toolCalls')");
    expect(unifyPageJs).toContain('formatToolCalls(turn.toolCalls)');
  });

  it('shows empty state when no debug data', () => {
    expect(unifyPageJs).toContain("$t('unify.noDebugData')");
    expect(unifyPageJs).toContain('unify-debug-empty');
  });

  it('placeholder is shown when not in debug mode', () => {
    // The v-else path shows the original placeholder
    expect(unifyPageJs).toContain('unify-detail-placeholder');
    expect(unifyPageJs).toContain("$t('unify.tasksMemory')");
  });

  it('has chevron icon for expand/collapse', () => {
    expect(unifyPageJs).toContain('unify-debug-turn-chevron');
  });
});

// =====================================================================
// 6. Setup logic
// =====================================================================
describe('Setup logic for debug', () => {
  it('has debugMode ref', () => {
    expect(unifyPageJs).toContain('debugMode');
    expect(unifyPageJs).toContain('Vue.ref(false)');
  });

  it('has expandedTurns reactive object', () => {
    expect(unifyPageJs).toContain('expandedTurns');
    expect(unifyPageJs).toContain('Vue.reactive({})');
  });

  it('has toggleDebug function', () => {
    expect(unifyPageJs).toContain('toggleDebug');
  });

  it('toggleDebug opens detail panel if collapsed', () => {
    expect(unifyPageJs).toMatch(/toggleDebug[\s\S]*debugMode\.value && detailCollapsed\.value/);
  });

  it('has toggleTurnExpand function', () => {
    expect(unifyPageJs).toContain('toggleTurnExpand');
  });

  it('has formatMessages function', () => {
    expect(unifyPageJs).toContain('formatMessages');
  });

  it('has formatToolCalls function', () => {
    expect(unifyPageJs).toContain('formatToolCalls');
  });

  it('returns all debug-related state and functions', () => {
    expect(unifyPageJs).toMatch(/return\s*\{[\s\S]*debugMode/);
    expect(unifyPageJs).toMatch(/return\s*\{[\s\S]*expandedTurns/);
    expect(unifyPageJs).toMatch(/return\s*\{[\s\S]*toggleDebug/);
    expect(unifyPageJs).toMatch(/return\s*\{[\s\S]*toggleTurnExpand/);
    expect(unifyPageJs).toMatch(/return\s*\{[\s\S]*formatMessages/);
    expect(unifyPageJs).toMatch(/return\s*\{[\s\S]*formatToolCalls/);
  });
});

// =====================================================================
// 7. CSS — debug styles exist
// =====================================================================
describe('CSS debug styles', () => {
  it('has .unify-debug-btn style', () => {
    expect(unifyCss).toContain('.unify-debug-btn');
  });

  it('has .unify-debug-btn.active style', () => {
    expect(unifyCss).toContain('.unify-debug-btn.active');
  });

  it('has .unify-debug-panel style', () => {
    expect(unifyCss).toContain('.unify-debug-panel');
  });

  it('has .unify-debug-header style', () => {
    expect(unifyCss).toContain('.unify-debug-header');
  });

  it('has .unify-debug-turn style', () => {
    expect(unifyCss).toContain('.unify-debug-turn');
  });

  it('has .unify-debug-turn-header style', () => {
    expect(unifyCss).toContain('.unify-debug-turn-header');
  });

  it('has .unify-debug-turn-body style', () => {
    expect(unifyCss).toContain('.unify-debug-turn-body');
  });

  it('has .unify-debug-pre style for code blocks', () => {
    expect(unifyCss).toContain('.unify-debug-pre');
  });

  it('has .unify-debug-section style', () => {
    expect(unifyCss).toContain('.unify-debug-section');
  });

  it('has .unify-debug-empty style', () => {
    expect(unifyCss).toContain('.unify-debug-empty');
  });

  it('debug pre has max-height for scrolling', () => {
    expect(unifyCss).toMatch(/\.unify-debug-pre\s*\{[^}]*max-height/);
  });

  it('debug pre uses monospace font', () => {
    expect(unifyCss).toMatch(/\.unify-debug-pre\s*\{[^}]*font-family.*monospace/);
  });
});

// =====================================================================
// 8. i18n — all debug keys exist
// =====================================================================
describe('i18n debug keys', () => {
  const requiredKeys = [
    'unify.debug',
    'unify.debugTurns',
    'unify.turn',
    'unify.systemPrompt',
    'unify.messagesLabel',
    'unify.response',
    'unify.toolCalls',
    'unify.inputTokens',
    'unify.outputTokens',
    'unify.duration',
    'unify.noDebugData',
    'unify.showDebug',
    'unify.hideDebug',
  ];

  it('en.js has all required debug i18n keys', () => {
    for (const key of requiredKeys) {
      expect(enI18n).toContain(`'${key}'`);
    }
  });

  it('zh-CN.js has all required debug i18n keys', () => {
    for (const key of requiredKeys) {
      expect(zhI18n).toContain(`'${key}'`);
    }
  });

  it('en.js unify.turn uses {n} placeholder for interpolation', () => {
    expect(enI18n).toMatch(/'unify\.turn':\s*'Turn \{n\}'/);
  });

  it('zh-CN.js unify.turn uses {n} placeholder for interpolation', () => {
    expect(zhI18n).toMatch(/'unify\.turn':\s*'第 \{n\} 轮'/);
  });
});
