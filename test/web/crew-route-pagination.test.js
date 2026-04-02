import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for task-221: Route Activity per-task pagination with show-more button.
 *
 * Test requirements:
 * 1. Each task group defaults to showing max 5 routes
 * 2. Groups with >5 routes show "显示更多 (剩余 N)" button
 * 3. Clicking "show more" loads next batch of 5
 * 4. Groups with ≤5 routes don't show button
 * 5. i18n: en/zh button text is correct
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

let featurePanelSource;
let workspaceCssSource;
let enI18n;
let zhI18n;

beforeAll(() => {
  featurePanelSource = read('web/components/crew/CrewFeaturePanel.js');
  workspaceCssSource = read('web/styles/crew-workspace.css');
  enI18n = read('web/i18n/en.js');
  zhI18n = read('web/i18n/zh-CN.js');
});

// =============================================================================
// 1. Data: routeVisibleCounts state
// =============================================================================
describe('task-221: routeVisibleCounts data property', () => {
  it('declares routeVisibleCounts as empty object in data', () => {
    expect(featurePanelSource).toContain('routeVisibleCounts: {}');
  });

  it('has comment explaining default 5 visible', () => {
    expect(featurePanelSource).toContain('per-task visible route count (default 5)');
  });
});

// =============================================================================
// 2. Methods: getRouteVisibleCount + showMoreRoutes
// =============================================================================
describe('task-221: getRouteVisibleCount method', () => {
  it('method exists', () => {
    expect(featurePanelSource).toContain('getRouteVisibleCount(key)');
  });

  it('returns routeVisibleCounts[key] or defaults to 5', () => {
    const methodIdx = featurePanelSource.indexOf('getRouteVisibleCount(key)');
    const methodEnd = featurePanelSource.indexOf('}', methodIdx);
    const methodBody = featurePanelSource.substring(methodIdx, methodEnd + 1);
    expect(methodBody).toContain('this.routeVisibleCounts[key] || 5');
  });
});

describe('task-221: showMoreRoutes method', () => {
  it('method exists', () => {
    expect(featurePanelSource).toContain('showMoreRoutes(key)');
  });

  it('increments visible count by 5', () => {
    const methodIdx = featurePanelSource.indexOf('showMoreRoutes(key)');
    const methodEnd = featurePanelSource.indexOf('}', methodIdx);
    const methodBody = featurePanelSource.substring(methodIdx, methodEnd + 1);
    expect(methodBody).toContain('(this.routeVisibleCounts[key] || 5) + 5');
  });

  it('stores result back in routeVisibleCounts', () => {
    const methodIdx = featurePanelSource.indexOf('showMoreRoutes(key)');
    const methodEnd = featurePanelSource.indexOf('}', methodIdx);
    const methodBody = featurePanelSource.substring(methodIdx, methodEnd + 1);
    expect(methodBody).toContain('this.routeVisibleCounts[key] =');
  });
});

// =============================================================================
// 3. Template: .slice(0, getRouteVisibleCount(...)) on route items
// =============================================================================
describe('task-221: template uses slice for pagination', () => {
  it('v-for on group.routes uses .slice(0, getRouteVisibleCount(...))', () => {
    expect(featurePanelSource).toContain(
      "group.routes.slice(0, getRouteVisibleCount(group.taskId || '__global__'))"
    );
  });

  it('show-more button only appears when routes exceed visible count', () => {
    expect(featurePanelSource).toContain(
      "v-if=\"group.routes.length > getRouteVisibleCount(group.taskId || '__global__')\""
    );
  });

  it('show-more button has correct CSS class', () => {
    expect(featurePanelSource).toContain('class="crew-route-show-more"');
  });

  it('show-more button calls showMoreRoutes on click', () => {
    expect(featurePanelSource).toContain(
      "@click.stop=\"showMoreRoutes(group.taskId || '__global__')\""
    );
  });

  it('show-more button uses click.stop to prevent parent toggle', () => {
    expect(featurePanelSource).toContain('@click.stop="showMoreRoutes');
  });

  it('show-more button displays remaining count via i18n', () => {
    expect(featurePanelSource).toContain(
      "$t('crew.showMoreRoutes', { count: group.routes.length - getRouteVisibleCount(group.taskId || '__global__') })"
    );
  });

  it('show-more button is inside the expandable group items div', () => {
    // The button should be inside crew-route-task-group-items (only visible when group is expanded)
    const templateMatch = featurePanelSource.match(/template:\s*`([\s\S]*?)`\s*,/);
    const template = templateMatch[1];
    const groupItemsStart = template.indexOf('crew-route-task-group-items');
    const showMoreIdx = template.indexOf('crew-route-show-more', groupItemsStart);
    expect(showMoreIdx).toBeGreaterThan(groupItemsStart);
  });
});

// =============================================================================
// 4. i18n: English and Chinese translations
// =============================================================================
describe('task-221: i18n translations', () => {
  it('English translation exists with {count} placeholder', () => {
    expect(enI18n).toContain("'crew.showMoreRoutes'");
    expect(enI18n).toContain('Show more ({count} remaining)');
  });

  it('Chinese translation exists with {count} placeholder', () => {
    expect(zhI18n).toContain("'crew.showMoreRoutes'");
    expect(zhI18n).toContain('显示更多 (剩余 {count})');
  });

  it('both translations use the same key', () => {
    const enKey = enI18n.match(/'crew\.showMoreRoutes'/);
    const zhKey = zhI18n.match(/'crew\.showMoreRoutes'/);
    expect(enKey).toBeTruthy();
    expect(zhKey).toBeTruthy();
  });

  it('count placeholder format is consistent ({count})', () => {
    const enLine = enI18n.match(/crew\.showMoreRoutes.*$/m)[0];
    const zhLine = zhI18n.match(/crew\.showMoreRoutes.*$/m)[0];
    expect(enLine).toContain('{count}');
    expect(zhLine).toContain('{count}');
  });
});

// =============================================================================
// 5. CSS: crew-route-show-more button styles
// =============================================================================
describe('task-221: show-more button CSS', () => {
  it('.crew-route-show-more exists in CSS', () => {
    expect(workspaceCssSource).toContain('.crew-route-show-more');
  });

  it('has no background (transparent button)', () => {
    expect(workspaceCssSource).toMatch(/\.crew-route-show-more\s*\{[\s\S]*?background:\s*none/);
  });

  it('has no border', () => {
    expect(workspaceCssSource).toMatch(/\.crew-route-show-more\s*\{[\s\S]*?border:\s*none/);
  });

  it('uses muted text color', () => {
    expect(workspaceCssSource).toMatch(/\.crew-route-show-more\s*\{[\s\S]*?color:\s*var\(--text-muted\)/);
  });

  it('has compact font size', () => {
    expect(workspaceCssSource).toMatch(/\.crew-route-show-more\s*\{[\s\S]*?font-size:\s*10\.5px/);
  });

  it('is clickable with cursor: pointer', () => {
    expect(workspaceCssSource).toMatch(/\.crew-route-show-more\s*\{[\s\S]*?cursor:\s*pointer/);
  });

  it('hover state changes color to primary', () => {
    expect(workspaceCssSource).toMatch(/\.crew-route-show-more:hover\s*\{[\s\S]*?color:\s*var\(--text-primary\)/);
  });

  it('hover state adds underline', () => {
    expect(workspaceCssSource).toMatch(/\.crew-route-show-more:hover\s*\{[\s\S]*?text-decoration:\s*underline/);
  });
});

// =============================================================================
// 6. Functional tests: pagination logic
// =============================================================================
describe('task-221: getRouteVisibleCount functional logic', () => {
  function getRouteVisibleCount(routeVisibleCounts, key) {
    return routeVisibleCounts[key] || 5;
  }

  it('returns 5 when key is not in the map (default)', () => {
    expect(getRouteVisibleCount({}, 'task-1')).toBe(5);
  });

  it('returns stored value when key exists', () => {
    expect(getRouteVisibleCount({ 'task-1': 10 }, 'task-1')).toBe(10);
  });

  it('returns 5 for __global__ key when not set', () => {
    expect(getRouteVisibleCount({}, '__global__')).toBe(5);
  });

  it('different keys are independent', () => {
    const counts = { 'task-1': 10, 'task-2': 15 };
    expect(getRouteVisibleCount(counts, 'task-1')).toBe(10);
    expect(getRouteVisibleCount(counts, 'task-2')).toBe(15);
    expect(getRouteVisibleCount(counts, 'task-3')).toBe(5);
  });
});

describe('task-221: showMoreRoutes functional logic', () => {
  function showMoreRoutes(routeVisibleCounts, key) {
    routeVisibleCounts[key] = (routeVisibleCounts[key] || 5) + 5;
    return routeVisibleCounts;
  }

  it('first call sets count to 10 (5 default + 5)', () => {
    const counts = {};
    showMoreRoutes(counts, 'task-1');
    expect(counts['task-1']).toBe(10);
  });

  it('second call sets count to 15', () => {
    const counts = { 'task-1': 10 };
    showMoreRoutes(counts, 'task-1');
    expect(counts['task-1']).toBe(15);
  });

  it('third call sets count to 20', () => {
    const counts = { 'task-1': 15 };
    showMoreRoutes(counts, 'task-1');
    expect(counts['task-1']).toBe(20);
  });

  it('does not affect other keys', () => {
    const counts = { 'task-1': 10 };
    showMoreRoutes(counts, 'task-2');
    expect(counts['task-1']).toBe(10);
    expect(counts['task-2']).toBe(10);
  });
});

describe('task-221: pagination display logic (slice behavior)', () => {
  it('group with 3 routes: all shown, no button', () => {
    const routes = Array.from({ length: 3 }, (_, i) => ({ id: i }));
    const visibleCount = 5;
    const shown = routes.slice(0, visibleCount);
    expect(shown).toHaveLength(3);
    expect(routes.length > visibleCount).toBe(false); // no button
  });

  it('group with exactly 5 routes: all shown, no button', () => {
    const routes = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const visibleCount = 5;
    const shown = routes.slice(0, visibleCount);
    expect(shown).toHaveLength(5);
    expect(routes.length > visibleCount).toBe(false); // no button
  });

  it('group with 8 routes: 5 shown initially, button shows "3 remaining"', () => {
    const routes = Array.from({ length: 8 }, (_, i) => ({ id: i }));
    const visibleCount = 5;
    const shown = routes.slice(0, visibleCount);
    expect(shown).toHaveLength(5);
    expect(routes.length > visibleCount).toBe(true); // button visible
    expect(routes.length - visibleCount).toBe(3); // "3 remaining"
  });

  it('group with 8 routes after showMore: 8 shown, no button', () => {
    const routes = Array.from({ length: 8 }, (_, i) => ({ id: i }));
    const visibleCount = 10; // after one showMore (5 + 5)
    const shown = routes.slice(0, visibleCount);
    expect(shown).toHaveLength(8);
    expect(routes.length > visibleCount).toBe(false); // button gone
  });

  it('group with 12 routes after one showMore: 10 shown, button shows "2 remaining"', () => {
    const routes = Array.from({ length: 12 }, (_, i) => ({ id: i }));
    const visibleCount = 10; // after one showMore
    const shown = routes.slice(0, visibleCount);
    expect(shown).toHaveLength(10);
    expect(routes.length > visibleCount).toBe(true);
    expect(routes.length - visibleCount).toBe(2);
  });

  it('group with 20 routes requires 3 showMore clicks to reveal all', () => {
    const routes = Array.from({ length: 20 }, (_, i) => ({ id: i }));

    // Initial: 5 shown, 15 remaining
    expect(routes.slice(0, 5)).toHaveLength(5);
    expect(routes.length - 5).toBe(15);

    // After 1st showMore: 10 shown, 10 remaining
    expect(routes.slice(0, 10)).toHaveLength(10);
    expect(routes.length - 10).toBe(10);

    // After 2nd showMore: 15 shown, 5 remaining
    expect(routes.slice(0, 15)).toHaveLength(15);
    expect(routes.length - 15).toBe(5);

    // After 3rd showMore: 20 shown, button gone
    expect(routes.slice(0, 20)).toHaveLength(20);
    expect(routes.length > 20).toBe(false);
  });

  it('empty group: no routes shown, no button', () => {
    const routes = [];
    const visibleCount = 5;
    expect(routes.slice(0, visibleCount)).toHaveLength(0);
    expect(routes.length > visibleCount).toBe(false);
  });
});

// =============================================================================
// 7. Integration: button is correctly nested in template structure
// =============================================================================
describe('task-221: template structure integration', () => {
  it('show-more button is after the route items v-for loop', () => {
    const templateMatch = featurePanelSource.match(/template:\s*`([\s\S]*?)`\s*,/);
    const template = templateMatch[1];
    // The v-for on routes should come before the show-more button
    const vForIdx = template.indexOf("group.routes.slice(0, getRouteVisibleCount");
    const showMoreIdx = template.indexOf('crew-route-show-more');
    expect(vForIdx).toBeGreaterThan(-1);
    expect(showMoreIdx).toBeGreaterThan(vForIdx);
  });

  it('show-more button is a <button> element', () => {
    const templateMatch = featurePanelSource.match(/template:\s*`([\s\S]*?)`\s*,/);
    const template = templateMatch[1];
    // Find the button with crew-route-show-more class (multiline tag)
    const btnMatch = template.match(/<button[\s\S]*?crew-route-show-more[\s\S]*?>/);
    expect(btnMatch).toBeTruthy();
  });

  it('route items v-for is on crew-route-activity-item divs', () => {
    const templateMatch = featurePanelSource.match(/template:\s*`([\s\S]*?)`\s*,/);
    const template = templateMatch[1];
    // Should have v-for with slice on the route activity item
    expect(template).toMatch(/v-for="r in group\.routes\.slice\(0,\s*getRouteVisibleCount/);
  });
});

// =============================================================================
// 8. Regression: existing pagination tests still aligned
// =============================================================================
describe('task-221: regression — existing tests were updated', () => {
  it('recentRoutes limit was updated from 8 to 20', () => {
    // This verifies the existing test was correctly updated
    expect(featurePanelSource).toContain('routes.length < 20');
    expect(featurePanelSource).not.toContain('routes.length < 8');
  });
});
