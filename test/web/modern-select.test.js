// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';
import ModernSelect from '../../web/components/ModernSelect.js';

let wrapper;
const options = [
  { value: 'one', label: 'One' },
  { value: 'disabled', label: 'Unavailable', disabled: true },
  { value: 'two', label: 'Two' },
];
function render(props = {}) {
  wrapper = mount(ModernSelect, {
    props: { options, modelValue: 'one', ariaLabel: 'Choice', ...props },
    global: { config: { globalProperties: { $t: key => key } } },
    attachTo: document.body,
  });
  return wrapper.get('.modern-select-trigger');
}
const search = () => document.querySelector('.modern-select-search input');
const list = () => document.querySelector('[role="listbox"]');
async function key(element, value, extras = {}) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extras }));
  await Vue.nextTick();
}
beforeEach(() => vi.stubGlobal('Vue', Vue));
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('ModernSelect keyboard and disabled regressions', () => {
  it('keeps non-searchable navigation, skips disabled choices, selects and returns focus', async () => {
    const trigger = render();
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    expect(list()).not.toBeNull();
    expect(list().id).toBe(trigger.attributes('aria-controls'));
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    expect(document.getElementById(trigger.attributes('aria-activedescendant')).textContent).toContain('Two');
    await trigger.trigger('keydown', { key: 'Enter' });
    await Vue.nextTick();
    expect(wrapper.emitted('update:modelValue')).toEqual([['two']]);
    expect(wrapper.emitted('change')).toEqual([['two']]);
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
  });

  it('labels a searchable combobox, supports empty filters and Escape without emitting', async () => {
    const trigger = render({ searchable: true });
    await trigger.trigger('click');
    expect(document.activeElement).toBe(search());
    expect(search().getAttribute('aria-label')).toBe('Choice');
    expect(search().getAttribute('aria-controls')).toBe(list().id);
    search().value = 'missing';
    search().dispatchEvent(new Event('input', { bubbles: true }));
    await Vue.nextTick();
    expect(search().hasAttribute('aria-activedescendant')).toBe(false);
    await key(search(), 'Enter');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await key(search(), 'Escape');
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
  });

  it('closes without selecting on Tab or disabled transition and cannot pick while disabled', async () => {
    const trigger = render({ searchable: true });
    await trigger.trigger('click');
    await key(search(), 'Tab', { shiftKey: true });
    expect(list()).toBeNull();
    // Native Tab advancement is covered by Playwright; before that, focus is back in the form.
    expect(document.activeElement).toBe(trigger.element);
    await trigger.trigger('click');
    await wrapper.setProps({ disabled: true });
    expect(list()).toBeNull();
    wrapper.vm.pick(options[2]);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await trigger.trigger('click');
    expect(list()).toBeNull();
  });
});
