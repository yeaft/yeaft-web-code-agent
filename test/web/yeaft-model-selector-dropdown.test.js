import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { getDefaultModelEffort } from '../../web/utils/modelRefs.js';

const pageSource = () => readFileSync('web/components/YeaftPage.js', 'utf8');
const styleSource = () => readFileSync('web/styles/yeaft.css', 'utf8');

describe('Yeaft model selector dropdown', () => {
  it('does not render an Apply action', () => {
    const source = pageSource();

    expect(source).not.toContain('applyModelSelection');
    expect(source).not.toContain('pendingModelChanged');
    expect(source).not.toContain("$t('common.apply')");
    expect(source).not.toContain('yeaft-model-actions');
  });

  it('applies and closes immediately when selecting a model', () => {
    const source = pageSource();

    expect(source).toContain('@click="selectModel(modelOptionRef(m))"');
    expect(source).toContain('const selectModel = (modelId) => {');
    expect(source).toContain('store.switchYeaftModel(modelId, groupId, effortForModelRef(modelId));');
    expect(source).toContain('closeModelDropdown();');
  });

  it('keeps effort and settings in fixed controls outside the scrolling model list', () => {
    const source = pageSource();
    const bodyStart = source.indexOf('class="yeaft-model-selector-body"');
    const listStart = source.indexOf('class="yeaft-model-list"', bodyStart);
    const listEnd = source.indexOf('</div>', listStart);
    const controlsStart = source.indexOf('class="yeaft-model-fixed-controls"', bodyStart);
    const effortStart = source.indexOf('class="yeaft-model-effort-panel"', bodyStart);
    const settingsStart = source.indexOf('class="yeaft-model-config-option"', bodyStart);

    expect(bodyStart).toBeGreaterThan(-1);
    expect(listStart).toBeGreaterThan(bodyStart);
    expect(controlsStart).toBeGreaterThan(listEnd);
    expect(effortStart).toBeGreaterThan(controlsStart);
    expect(settingsStart).toBeGreaterThan(effortStart);
  });

  it('limits scrolling to about five model rows', () => {
    const css = styleSource();

    expect(css).toMatch(/\.yeaft-model-dropdown\s*\{[\s\S]*overflow:\s*hidden;/);
    expect(css).toMatch(/\.yeaft-model-list\s*\{[\s\S]*max-height:\s*220px;[\s\S]*overflow-y:\s*auto;/);
    expect(css).toMatch(/\.yeaft-model-fixed-controls\s*\{[\s\S]*flex-shrink:\s*0;/);
  });

  it('defaults effort to the second highest available option', () => {
    expect(getDefaultModelEffort(['minimal', 'low', 'medium', 'high'])).toBe('medium');
    expect(getDefaultModelEffort(['low', 'medium', 'high'])).toBe('medium');
    expect(getDefaultModelEffort(['low', 'high'])).toBe('low');
    expect(getDefaultModelEffort(['low', 'medium', 'high', 'xhigh'])).toBe('high');
    expect(getDefaultModelEffort(['low', 'medium', 'high', 'max'])).toBe('high');
  });

  it('uses tokenized styling for the fixed effort and settings area', () => {
    const css = styleSource();
    const controlsBlock = css.match(/\.yeaft-model-fixed-controls\s*\{[\s\S]*?\}/)?.[0] || '';
    const effortBlock = css.match(/\.yeaft-model-effort-panel\s*\{[\s\S]*?\}/)?.[0] || '';
    const settingsBlock = css.match(/\.yeaft-model-config-option\s*\{[\s\S]*?\}/)?.[0] || '';
    const combined = `${controlsBlock}\n${effortBlock}\n${settingsBlock}`;

    expect(combined).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(combined).not.toMatch(/rgba?\(/i);
    expect(effortBlock).toContain('background: transparent;');
    expect(settingsBlock).toContain('background: transparent;');
  });
});
