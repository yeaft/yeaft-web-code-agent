import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for task-220: Feature card time display optimization + remove actions.
 *
 * Validates:
 * 1. In-progress feature cards show time range (createdAt → lastActivityAt)
 * 2. Completed feature cards show time range (createdAt → lastActivityAt)
 * 3. Actions row (crew-feature-summary-actions) is removed from both sections
 * 4. CSS: time-range styles are right-aligned, compact, won't overflow
 * 5. Fallback: if no lastActivityAt, only show createdAt (no arrow)
 * 6. formatDuration no longer imported (replaced by formatTime)
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

let featurePanelSource;
let workspaceCssSource;

beforeAll(() => {
  featurePanelSource = read('web/components/crew/CrewFeaturePanel.js');
  workspaceCssSource = read('web/styles/crew-workspace.css');
});

// =============================================================================
// Time range display on feature cards
// =============================================================================
describe('Feature card time range display (task-220)', () => {
  it('uses crew-feature-card-time-range class instead of crew-feature-card-elapsed', () => {
    expect(featurePanelSource).toContain('crew-feature-card-time-range');
    expect(featurePanelSource).not.toContain('crew-feature-card-elapsed');
  });

  it('displays formatTime(feature.createdAt) for created time', () => {
    expect(featurePanelSource).toContain('formatTime(feature.createdAt)');
  });

  it('displays formatTime(feature.lastActivityAt) for last activity time', () => {
    expect(featurePanelSource).toContain('formatTime(feature.lastActivityAt)');
  });

  it('shows arrow (→) between created and last activity time', () => {
    expect(featurePanelSource).toContain('crew-feature-card-time-arrow');
    // The arrow is rendered as HTML entity &rarr;
    expect(featurePanelSource).toContain('&rarr;');
  });

  it('conditionally shows arrow only when lastActivityAt exists', () => {
    // Arrow span is conditional on feature.lastActivityAt
    expect(featurePanelSource).toContain('v-if="feature.lastActivityAt"');
  });

  it('conditionally shows time range only when createdAt exists', () => {
    expect(featurePanelSource).toContain('v-if="feature.createdAt"');
  });

  it('has time-range markup in both in-progress and completed card sections', () => {
    // Count occurrences of the time-range class — should appear in both sections
    const matches = featurePanelSource.match(/crew-feature-card-time-range/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('has formatTime(feature.createdAt) in both in-progress and completed sections', () => {
    const matches = featurePanelSource.match(/formatTime\(feature\.createdAt\)/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('has formatTime(feature.lastActivityAt) in both in-progress and completed sections', () => {
    const matches = featurePanelSource.match(/formatTime\(feature\.lastActivityAt\)/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// Actions row removal
// =============================================================================
describe('Actions row removal (task-220)', () => {
  it('does not contain crew-feature-summary-actions in template', () => {
    expect(featurePanelSource).not.toContain('crew-feature-summary-actions');
  });

  it('does not contain actions count display', () => {
    expect(featurePanelSource).not.toContain('crew-feature-summary-actions-count');
  });

  it('does not contain actions list display', () => {
    expect(featurePanelSource).not.toContain('crew-feature-summary-actions-list');
  });

  it('does not contain actions.length reference for display', () => {
    // The getSummary().actions array may still exist in data, but should not
    // be rendered in the template
    expect(featurePanelSource).not.toContain("getSummary(feature.taskId).actions.length");
    expect(featurePanelSource).not.toContain("getSummary(feature.taskId).actions.join");
  });
});

// =============================================================================
// CSS styles
// =============================================================================
describe('CSS: time-range styles (task-220)', () => {
  it('has .crew-feature-card-time-range class defined', () => {
    expect(workspaceCssSource).toContain('.crew-feature-card-time-range');
  });

  it('time-range uses flexbox layout', () => {
    // Extract the time-range rule block
    const idx = workspaceCssSource.indexOf('.crew-feature-card-time-range');
    const block = workspaceCssSource.slice(idx, workspaceCssSource.indexOf('}', idx) + 1);
    expect(block).toContain('display: flex');
    expect(block).toContain('align-items: center');
  });

  it('time-range is right-aligned with margin-left: auto', () => {
    const idx = workspaceCssSource.indexOf('.crew-feature-card-time-range');
    const block = workspaceCssSource.slice(idx, workspaceCssSource.indexOf('}', idx) + 1);
    expect(block).toContain('margin-left: auto');
  });

  it('time-range has flex-shrink: 0 to prevent overflow', () => {
    const idx = workspaceCssSource.indexOf('.crew-feature-card-time-range');
    const block = workspaceCssSource.slice(idx, workspaceCssSource.indexOf('}', idx) + 1);
    expect(block).toContain('flex-shrink: 0');
  });

  it('time-range uses tabular-nums for aligned digits', () => {
    const idx = workspaceCssSource.indexOf('.crew-feature-card-time-range');
    const block = workspaceCssSource.slice(idx, workspaceCssSource.indexOf('}', idx) + 1);
    expect(block).toContain('font-variant-numeric: tabular-nums');
  });

  it('has .crew-feature-card-time class with white-space: nowrap', () => {
    expect(workspaceCssSource).toContain('.crew-feature-card-time');
    const idx = workspaceCssSource.indexOf('.crew-feature-card-time {');
    const block = workspaceCssSource.slice(idx, workspaceCssSource.indexOf('}', idx) + 1);
    expect(block).toContain('white-space: nowrap');
  });

  it('has .crew-feature-card-time-arrow class defined', () => {
    expect(workspaceCssSource).toContain('.crew-feature-card-time-arrow');
  });

  it('does not contain .crew-feature-card-elapsed class', () => {
    expect(workspaceCssSource).not.toContain('.crew-feature-card-elapsed');
  });

  it('does not contain .crew-feature-summary-actions CSS rules', () => {
    expect(workspaceCssSource).not.toContain('.crew-feature-summary-actions');
  });

  it('does not contain .crew-feature-summary-actions-count CSS rules', () => {
    expect(workspaceCssSource).not.toContain('.crew-feature-summary-actions-count');
  });

  it('does not contain .crew-feature-summary-actions-list CSS rules', () => {
    expect(workspaceCssSource).not.toContain('.crew-feature-summary-actions-list');
  });
});

// =============================================================================
// Import cleanup
// =============================================================================
describe('Import cleanup (task-220)', () => {
  it('does not import formatDuration from crewHelpers', () => {
    expect(featurePanelSource).not.toContain('formatDuration');
  });

  it('still imports formatTime from crewHelpers', () => {
    expect(featurePanelSource).toContain('formatTime');
  });

  it('has formatTime in methods', () => {
    // Check that formatTime is registered as a method
    expect(featurePanelSource).toMatch(/methods:\s*\{[\s\S]*formatTime/);
  });
});
