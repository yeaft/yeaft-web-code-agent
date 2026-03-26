import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Tests for PR #338: Conductor UI i18n + ActivePanel dual-column layout.
 *
 * Covers:
 *  1. i18n keys exist in en.js and zh-CN.js (21 conductor.* keys each)
 *  2. Components use $t() calls instead of hardcoded English
 *  3. ActivePanel dual-column grouping (inProgress vs completed)
 *  4. Task card selected highlight (.is-selected)
 *  5. Indeterminate progress bar animation (.is-indeterminate)
 *  6. ConductorTaskPanel status labels via i18n
 *  7. Input placeholder uses i18n string
 */

// =====================================================================
// Source files loaded once
// =====================================================================

let enSource;
let zhCnSource;
let chatViewSource;
let activePanelSource;
let taskPanelSource;
let conductorCssSource;

// Parse i18n files to get actual translation objects
let enTranslations;
let zhCnTranslations;

beforeAll(() => {
  const base = resolve(__dirname, '../../web');
  enSource = readFileSync(resolve(base, 'i18n/en.js'), 'utf-8');
  zhCnSource = readFileSync(resolve(base, 'i18n/zh-CN.js'), 'utf-8');
  chatViewSource = readFileSync(resolve(base, 'components/conductor/ConductorChatView.js'), 'utf-8');
  activePanelSource = readFileSync(resolve(base, 'components/conductor/ConductorActivePanel.js'), 'utf-8');
  taskPanelSource = readFileSync(resolve(base, 'components/conductor/ConductorTaskPanel.js'), 'utf-8');
  conductorCssSource = readFileSync(resolve(base, 'styles/conductor.css'), 'utf-8');

  // Extract translation key-value pairs from source strings
  enTranslations = extractTranslations(enSource);
  zhCnTranslations = extractTranslations(zhCnSource);
});

/** Extract 'conductor.*' key-value pairs from an i18n source file */
function extractTranslations(source) {
  const result = {};
  const regex = /'(conductor\.[^']+)':\s*['"`]([^'"`]+)['"`]/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}

// =====================================================================
// Expected i18n keys — the 21 conductor.* keys from the PR
// =====================================================================

const EXPECTED_KEYS = [
  'conductor.ready',
  'conductor.emptyHint',
  'conductor.inputPlaceholder',
  'conductor.scrollLatest',
  'conductor.tasks',
  'conductor.actors',
  'conductor.panelTitle',
  'conductor.panelActive',
  'conductor.emptyNoTasks',
  'conductor.emptyNoTasksHint',
  'conductor.showCompleted',
  'conductor.statusInProgress',
  'conductor.plan',
  'conductor.activeInstances',
  'conductor.loadOlder',
  'conductor.taskInputPlaceholder',
  'conductor.statusExecuting',
  'conductor.statusPlanning',
  'conductor.statusWaiting',
  'conductor.statusCompleted',
  'conductor.statusError'
];

// =====================================================================
// 1. i18n key completeness — EN + ZH-CN
// =====================================================================

describe('i18n key completeness', () => {
  it('en.js should contain all 21 conductor.* keys', () => {
    for (const key of EXPECTED_KEYS) {
      expect(enTranslations).toHaveProperty(key);
    }
    // Count conductor keys
    const conductorKeys = Object.keys(enTranslations).filter(k => k.startsWith('conductor.'));
    expect(conductorKeys.length).toBeGreaterThanOrEqual(21);
  });

  it('zh-CN.js should contain all 21 conductor.* keys', () => {
    for (const key of EXPECTED_KEYS) {
      expect(zhCnTranslations).toHaveProperty(key);
    }
  });

  it('EN and ZH-CN should have the same set of conductor.* keys', () => {
    const enKeys = Object.keys(enTranslations).filter(k => k.startsWith('conductor.')).sort();
    const zhKeys = Object.keys(zhCnTranslations).filter(k => k.startsWith('conductor.')).sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it('ZH-CN values should differ from EN (actual translation, not copy-paste)', () => {
    // Spot-check a few keys that must differ
    expect(zhCnTranslations['conductor.ready']).not.toBe(enTranslations['conductor.ready']);
    expect(zhCnTranslations['conductor.emptyHint']).not.toBe(enTranslations['conductor.emptyHint']);
    expect(zhCnTranslations['conductor.inputPlaceholder']).not.toBe(enTranslations['conductor.inputPlaceholder']);
    expect(zhCnTranslations['conductor.emptyNoTasks']).not.toBe(enTranslations['conductor.emptyNoTasks']);
    expect(zhCnTranslations['conductor.statusExecuting']).not.toBe(enTranslations['conductor.statusExecuting']);
  });

  it('EN conductor.ready should be "Conductor is ready"', () => {
    expect(enTranslations['conductor.ready']).toBe('Conductor is ready');
  });

  it('ZH-CN conductor.ready should be "Conductor 已就绪"', () => {
    expect(zhCnTranslations['conductor.ready']).toBe('Conductor 已就绪');
  });

  it('i18n keys with {count} placeholder should exist in both languages', () => {
    const paramKeys = ['conductor.tasks', 'conductor.actors', 'conductor.panelActive', 'conductor.showCompleted'];
    for (const key of paramKeys) {
      expect(enSource).toContain(`'${key}'`);
      expect(zhCnSource).toContain(`'${key}'`);
    }
  });
});

// =====================================================================
// 2. ConductorChatView uses $t() calls
// =====================================================================

describe('ConductorChatView i18n integration', () => {
  it('empty state uses $t("conductor.ready") and $t("conductor.emptyHint")', () => {
    expect(chatViewSource).toContain("$t('conductor.ready')");
    expect(chatViewSource).toContain("$t('conductor.emptyHint')");
    // Should NOT contain hardcoded English
    expect(chatViewSource).not.toContain('>Conductor is ready<');
    expect(chatViewSource).not.toContain(">Describe what you need");
  });

  it('scroll-to-bottom uses $t("conductor.scrollLatest")', () => {
    expect(chatViewSource).toContain("$t('conductor.scrollLatest')");
    expect(chatViewSource).not.toMatch(/>\s*&#8595;\s*Latest\s*</);
  });

  it('input hints use $t("conductor.tasks") and $t("conductor.actors")', () => {
    expect(chatViewSource).toContain("$t('conductor.tasks'");
    expect(chatViewSource).toContain("$t('conductor.actors'");
  });

  it('input placeholder uses :placeholder="$t(\'conductor.inputPlaceholder\')"', () => {
    expect(chatViewSource).toContain("$t('conductor.inputPlaceholder')");
    expect(chatViewSource).not.toContain('placeholder="Talk to the Conductor..."');
  });
});

// =====================================================================
// 3. ConductorActivePanel dual-column grouping
// =====================================================================

describe('ConductorActivePanel dual-column layout', () => {
  // Simulate the grouping logic from the component
  function groupTasks(tasks) {
    const entries = Object.values(tasks || {});
    const sorted = [...entries].sort((a, b) => {
      const statusOrder = { active: 0, executing: 0, planning: 1, waiting: 2, completed: 3 };
      const aOrder = statusOrder[a.status] ?? 1;
      const bOrder = statusOrder[b.status] ?? 1;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    const inProgress = sorted.filter(t => t.status !== 'completed');
    const completed = sorted.filter(t => t.status === 'completed');
    return { inProgress, completed };
  }

  it('should separate tasks into inProgress and completed groups', () => {
    const tasks = {
      t1: { taskId: 't1', status: 'active', createdAt: 100 },
      t2: { taskId: 't2', status: 'completed', createdAt: 200 },
      t3: { taskId: 't3', status: 'executing', createdAt: 300 },
      t4: { taskId: 't4', status: 'completed', createdAt: 50 },
      t5: { taskId: 't5', status: 'planning', createdAt: 150 }
    };
    const { inProgress, completed } = groupTasks(tasks);
    expect(inProgress).toHaveLength(3);
    expect(completed).toHaveLength(2);
    expect(inProgress.every(t => t.status !== 'completed')).toBe(true);
    expect(completed.every(t => t.status === 'completed')).toBe(true);
  });

  it('should sort active/executing first, then planning, then waiting', () => {
    const tasks = {
      t1: { taskId: 't1', status: 'waiting', createdAt: 100 },
      t2: { taskId: 't2', status: 'active', createdAt: 200 },
      t3: { taskId: 't3', status: 'planning', createdAt: 300 }
    };
    const { inProgress } = groupTasks(tasks);
    expect(inProgress[0].status).toBe('active');
    expect(inProgress[1].status).toBe('planning');
    expect(inProgress[2].status).toBe('waiting');
  });

  it('should return empty groups when no tasks', () => {
    const { inProgress, completed } = groupTasks({});
    expect(inProgress).toHaveLength(0);
    expect(completed).toHaveLength(0);
  });

  it('should put all tasks in inProgress when none completed', () => {
    const tasks = {
      t1: { taskId: 't1', status: 'active', createdAt: 100 },
      t2: { taskId: 't2', status: 'planning', createdAt: 200 }
    };
    const { inProgress, completed } = groupTasks(tasks);
    expect(inProgress).toHaveLength(2);
    expect(completed).toHaveLength(0);
  });

  it('source: ActivePanel should use crew-kanban-group classes', () => {
    expect(activePanelSource).toContain('crew-kanban-group');
    expect(activePanelSource).toContain('crew-kanban-group-header');
    expect(activePanelSource).toContain('crew-feature-card');
  });

  it('source: ActivePanel should have inProgressTasks and completedTasks computeds', () => {
    expect(activePanelSource).toContain('inProgressTasks()');
    expect(activePanelSource).toContain('completedTasks()');
  });

  it('source: In Progress header shows $t("conductor.statusInProgress")', () => {
    expect(activePanelSource).toContain("$t('conductor.statusInProgress')");
  });

  it('source: Completed group shows $t("conductor.showCompleted")', () => {
    expect(activePanelSource).toContain("$t('conductor.showCompleted'");
  });
});

// =====================================================================
// 4. Completed tasks collapsed by default, click to expand
// =====================================================================

describe('completed tasks fold/unfold', () => {
  it('source: showCompletedTasks defaults to false', () => {
    expect(activePanelSource).toContain('showCompletedTasks: false');
  });

  it('source: clicking completed header toggles showCompletedTasks', () => {
    expect(activePanelSource).toContain('showCompletedTasks = !showCompletedTasks');
  });

  it('source: completed cards wrapped in v-if="showCompletedTasks"', () => {
    expect(activePanelSource).toContain('v-if="showCompletedTasks"');
  });

  it('source: chevron rotates based on showCompletedTasks', () => {
    expect(activePanelSource).toContain('is-expanded');
    expect(activePanelSource).toContain('showCompletedTasks');
  });
});

// =====================================================================
// 5. Task card selected highlight (.is-selected)
// =====================================================================

describe('task card selected highlight', () => {
  it('source: ActivePanel applies is-selected class based on selectedTaskId', () => {
    // Both in-progress and completed cards should support is-selected
    const selectedMatches = activePanelSource.match(/is-selected.*selectedTaskId/g);
    expect(selectedMatches).not.toBeNull();
    expect(selectedMatches.length).toBeGreaterThanOrEqual(2); // in-progress + completed
  });

  it('CSS: .is-selected should have blue border', () => {
    expect(conductorCssSource).toContain('.crew-feature-card.is-selected');
    expect(conductorCssSource).toContain('crew-color-primary');
  });
});

// =====================================================================
// 6. Indeterminate progress bar (progress: -1)
// =====================================================================

describe('indeterminate progress bar', () => {
  // Mirror the progressWidth method
  function progressWidth(task) {
    if (task.progress === -1) return '100%';
    if (task.progress >= 0) return Math.min(task.progress, 100) + '%';
    if (task.plan && task.plan.length > 0) {
      const done = task.plan.filter(s => s.status === 'done' || s.status === 'completed').length;
      return (done / task.plan.length * 100) + '%';
    }
    return '0%';
  }

  it('should return 100% width for indeterminate (progress: -1)', () => {
    expect(progressWidth({ progress: -1 })).toBe('100%');
  });

  it('should return percentage for normal progress', () => {
    expect(progressWidth({ progress: 50 })).toBe('50%');
    expect(progressWidth({ progress: 0 })).toBe('0%');
  });

  it('should cap at 100%', () => {
    expect(progressWidth({ progress: 150 })).toBe('100%');
  });

  it('should compute from plan steps when no progress value', () => {
    const task = {
      plan: [
        { status: 'done' },
        { status: 'completed' },
        { status: 'pending' },
        { status: 'pending' }
      ]
    };
    expect(progressWidth(task)).toBe('50%');
  });

  it('should return 0% when no progress and no plan', () => {
    expect(progressWidth({})).toBe('0%');
  });

  it('source: is-indeterminate class applied when progress === -1', () => {
    expect(activePanelSource).toContain('is-indeterminate');
    expect(activePanelSource).toContain('task.progress === -1');
  });

  it('CSS: .is-indeterminate has animation', () => {
    expect(conductorCssSource).toContain('.is-indeterminate');
    expect(conductorCssSource).toContain('conductor-indeterminate');
    expect(conductorCssSource).toContain('animation');
  });
});

// =====================================================================
// 7. ConductorTaskPanel status labels via i18n
// =====================================================================

describe('ConductorTaskPanel i18n status labels', () => {
  // Simulate taskStatusLabel logic
  function simulateStatusLabel(status, $t) {
    const KEYS = {
      active: 'conductor.statusExecuting',
      executing: 'conductor.statusExecuting',
      planning: 'conductor.statusPlanning',
      waiting: 'conductor.statusWaiting',
      completed: 'conductor.statusCompleted',
      error: 'conductor.statusError'
    };
    const key = KEYS[status];
    return key ? $t(key) : (status || 'Active');
  }

  // Simple t() that returns EN values
  function tEN(key) { return enTranslations[key] || key; }
  function tZH(key) { return zhCnTranslations[key] || key; }

  it('should return "Executing" for active status in EN', () => {
    expect(simulateStatusLabel('active', tEN)).toBe('Executing');
  });

  it('should return "执行中" for active status in ZH-CN', () => {
    expect(simulateStatusLabel('active', tZH)).toBe('执行中');
  });

  it('should return "Planning" for planning status in EN', () => {
    expect(simulateStatusLabel('planning', tEN)).toBe('Planning');
  });

  it('should return "规划中" for planning status in ZH-CN', () => {
    expect(simulateStatusLabel('planning', tZH)).toBe('规划中');
  });

  it('should return "Completed" for completed status in EN', () => {
    expect(simulateStatusLabel('completed', tEN)).toBe('Completed');
  });

  it('should return "已完成" for completed status in ZH-CN', () => {
    expect(simulateStatusLabel('completed', tZH)).toBe('已完成');
  });

  it('should return raw status for unknown values', () => {
    expect(simulateStatusLabel('custom-status', tEN)).toBe('custom-status');
  });

  it('should return "Active" for null/undefined status', () => {
    expect(simulateStatusLabel(undefined, tEN)).toBe('Active');
    expect(simulateStatusLabel(null, tEN)).toBe('Active');
  });

  it('source: TaskPanel uses conductor.status* i18n keys', () => {
    expect(taskPanelSource).toContain("'conductor.statusExecuting'");
    expect(taskPanelSource).toContain("'conductor.statusPlanning'");
    expect(taskPanelSource).toContain("'conductor.statusWaiting'");
    expect(taskPanelSource).toContain("'conductor.statusCompleted'");
    expect(taskPanelSource).toContain("'conductor.statusError'");
  });

  it('source: TaskPanel Plan title uses $t("conductor.plan")', () => {
    expect(taskPanelSource).toContain("$t('conductor.plan')");
  });

  it('source: TaskPanel Active Instances uses $t("conductor.activeInstances")', () => {
    expect(taskPanelSource).toContain("$t('conductor.activeInstances')");
  });

  it('source: TaskPanel Load older uses $t("conductor.loadOlder")', () => {
    expect(taskPanelSource).toContain("$t('conductor.loadOlder')");
  });

  it('source: TaskPanel input placeholder uses $t("conductor.taskInputPlaceholder")', () => {
    expect(taskPanelSource).toContain("$t('conductor.taskInputPlaceholder')");
    expect(taskPanelSource).not.toContain('placeholder="Send to Orchestrator..."');
  });
});

// =====================================================================
// 8. ActivePanel i18n integration
// =====================================================================

describe('ConductorActivePanel i18n integration', () => {
  it('panel title uses $t("conductor.panelTitle")', () => {
    expect(activePanelSource).toContain("$t('conductor.panelTitle')");
    // No hardcoded "Tasks"
    const titleLine = activePanelSource.split('\n').find(l => l.includes('conductor-active-title'));
    expect(titleLine).toContain('$t(');
  });

  it('active count uses $t("conductor.panelActive")', () => {
    expect(activePanelSource).toContain("$t('conductor.panelActive'");
  });

  it('empty state uses $t("conductor.emptyNoTasks") and $t("conductor.emptyNoTasksHint")', () => {
    expect(activePanelSource).toContain("$t('conductor.emptyNoTasks')");
    expect(activePanelSource).toContain("$t('conductor.emptyNoTasksHint')");
    // No hardcoded English
    expect(activePanelSource).not.toContain('>No active tasks<');
    expect(activePanelSource).not.toContain('>Send a request to the Conductor');
  });
});

// =====================================================================
// 9. Boundary conditions
// =====================================================================

describe('boundary conditions', () => {
  it('empty tasks object → empty state shown (sortedTasks.length === 0)', () => {
    expect(activePanelSource).toContain('sortedTasks.length === 0');
  });

  it('all tasks completed → inProgress empty, completed has all', () => {
    const tasks = {
      t1: { taskId: 't1', status: 'completed', createdAt: 100 },
      t2: { taskId: 't2', status: 'completed', createdAt: 200 }
    };
    const entries = Object.values(tasks);
    const inProgress = entries.filter(t => t.status !== 'completed');
    const completed = entries.filter(t => t.status === 'completed');
    expect(inProgress).toHaveLength(0);
    expect(completed).toHaveLength(2);
  });

  it('task with unknown status goes to inProgress group', () => {
    const tasks = {
      t1: { taskId: 't1', status: 'custom-status', createdAt: 100 }
    };
    const entries = Object.values(tasks);
    const inProgress = entries.filter(t => t.status !== 'completed');
    expect(inProgress).toHaveLength(1);
  });

  it('i18n {count} placeholder keys contain correct format', () => {
    // Verify the EN translations have {count} placeholder
    expect(enTranslations['conductor.tasks']).toContain('{count}');
    expect(enTranslations['conductor.actors']).toContain('{count}');
    expect(enTranslations['conductor.panelActive']).toContain('{count}');
    expect(enTranslations['conductor.showCompleted']).toContain('{count}');
  });

  it('completed task cards get .is-completed class', () => {
    // In the template: class="crew-feature-card is-completed"
    expect(activePanelSource).toContain('crew-feature-card is-completed');
  });
});
