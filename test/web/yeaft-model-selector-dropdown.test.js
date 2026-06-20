import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { getDefaultModelEffort, getSelectableModelEfforts } from '../../web/utils/modelRefs.js';

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

  it('applies and closes immediately when selecting a combined model-effort row', () => {
    const source = pageSource();

    expect(source).toContain('v-for="row in topbarModelRows"');
    expect(source).toContain('@click="selectModel(row.modelRef, effort)"');
    expect(source).toContain('@click="selectModel(row.modelRef, row.defaultEffort)"');
    expect(source).toContain('const selectModel = (modelId, effort = null) => {');
    expect(source).toContain('store.switchYeaftModel(modelId, groupId, effort);');
    expect(source).toContain('closeModelDropdown();');
  });

  it('keeps settings in fixed controls outside the scrolling combined model list', () => {
    const source = pageSource();
    const bodyStart = source.indexOf('class="yeaft-model-selector-body"');
    const listStart = source.indexOf('class="yeaft-model-list"', bodyStart);
    const listEnd = source.indexOf('</div>', listStart);
    const controlsStart = source.indexOf('class="yeaft-model-fixed-controls"', bodyStart);
    const settingsStart = source.indexOf('class="yeaft-model-config-option"', bodyStart);

    expect(bodyStart).toBeGreaterThan(-1);
    expect(listStart).toBeGreaterThan(bodyStart);
    expect(controlsStart).toBeGreaterThan(listEnd);
    expect(settingsStart).toBeGreaterThan(controlsStart);
    expect(source).toContain('yeaft-model-effort-list');
    expect(source).toContain('yeaft-model-effort-chip');
    expect(source).not.toContain('topbarModelOptions');
    expect(source).not.toContain('yeaft-model-effort-panel');
  });

  it('limits scrolling to the combined model-effort list', () => {
    const css = styleSource();

    expect(css).toMatch(/\.yeaft-model-dropdown\s*\{[\s\S]*overflow:\s*hidden;/);
    expect(css).toMatch(/\.yeaft-model-list\s*\{[\s\S]*max-height:\s*320px;[\s\S]*overflow-y:\s*auto;/);
    expect(css).toMatch(/\.yeaft-model-fixed-controls\s*\{[\s\S]*flex-shrink:\s*0;/);
  });

  it('keeps mobile scrolling on the model list only', () => {
    const css = styleSource();
    const mobileBlock = css.match(/@media \(max-width: 640px\) \{[\s\S]*?\/\* ── Provider edit/)?.[0] || '';
    const bodyBlock = mobileBlock.match(/\.yeaft-model-selector-body\s*\{[\s\S]*?\}/)?.[0] || '';
    const listBlock = mobileBlock.match(/\.yeaft-model-list\s*\{[\s\S]*?\}/)?.[0] || '';

    expect(mobileBlock).toContain('.yeaft-topbar-model-dropdown');
    expect(mobileBlock).toContain('position: fixed;');
    expect(mobileBlock).toContain('top: calc(52px + env(safe-area-inset-top, 0px));');
    expect(mobileBlock).toContain('bottom: auto;');
    expect(mobileBlock).toContain('max-height: min(72dvh, calc(100dvh - 64px));');
    expect(mobileBlock).not.toContain('bottom: 12px;');
    expect(mobileBlock).toContain('.yeaft-model-selector-body');
    expect(bodyBlock).toContain('overflow: hidden;');
    expect(bodyBlock).not.toContain('overflow-y: auto;');
    expect(listBlock).toContain('flex: 1 1 auto;');
    expect(listBlock).toContain('min-height: 0;');
    expect(listBlock).toContain('overflow-y: auto;');
  });

  it('defaults effort to the second highest available option', () => {
    expect(getDefaultModelEffort(['minimal', 'low', 'medium', 'high'])).toBe('medium');
    expect(getDefaultModelEffort(['low', 'medium', 'high'])).toBe('medium');
    expect(getDefaultModelEffort(['low', 'high'])).toBe('low');
    expect(getDefaultModelEffort(['low', 'medium', 'high', 'xhigh'])).toBe('high');
    expect(getDefaultModelEffort(['low', 'medium', 'high', 'max'])).toBe('high');
  });

  it('hides minimal and low effort variants from the selectable model rows', () => {
    expect(getSelectableModelEfforts(['minimal', 'low', 'medium', 'high'])).toEqual(['medium', 'high']);
    expect(getSelectableModelEfforts(['low', 'medium', 'high', 'xhigh', 'max'])).toEqual(['medium', 'high', 'xhigh', 'max']);
  });

  it('uses tokenized styling for effort chips and the fixed settings area', () => {
    const css = styleSource();
    const controlsBlock = css.match(/\.yeaft-model-fixed-controls\s*\{[\s\S]*?\}/)?.[0] || '';
    const chipBlock = css.match(/\.yeaft-model-effort-chip\s*\{[\s\S]*?\}/)?.[0] || '';
    const settingsBlock = css.match(/\.yeaft-model-config-option\s*\{[\s\S]*?\}/)?.[0] || '';
    const combined = `${controlsBlock}\n${chipBlock}\n${settingsBlock}`;

    expect(combined).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(combined).not.toMatch(/rgba?\(/i);
    expect(chipBlock).toContain('background: var(--bg-input-wrapper);');
    expect(settingsBlock).toContain('background: transparent;');
  });
});
