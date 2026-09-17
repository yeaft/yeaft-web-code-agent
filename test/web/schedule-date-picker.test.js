// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { readFileSync } from 'node:fs';
import ScheduleDatePicker from '../../web/components/ScheduleDatePicker.js';

const wrappers = [];
function mountPicker(props = {}, global = {}) {
  const wrapper = mount(ScheduleDatePicker, {
    props: { modelValue: '2024-01-31', ariaLabel: 'Start date', ...props },
    global: { config: { globalProperties: { $locale: ref('en'), $t: (key) => key } }, ...global },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}
const trigger = (wrapper) => wrapper.get('.schedule-date-picker__trigger');
const day = (wrapper, date) => wrapper.get(`[data-date="${date}"]`);
async function open(wrapper) { await trigger(wrapper).trigger('click'); await nextTick(); }
async function key(wrapper, date, value) { await day(wrapper, date).trigger('keydown', { key: value }); await nextTick(); }

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
  document.documentElement.removeAttribute('lang');
});

describe('ScheduleDatePicker', () => {
  it('discloses an inline calendar, selects a controlled ISO value and restores focus', async () => {
    const wrapper = mountPicker();
    expect(trigger(wrapper).text()).toContain('Jan 31, 2024');
    expect(trigger(wrapper).attributes('aria-label')).toBe('Start date: Jan 31, 2024');
    expect(wrapper.find('input, label, dialog').exists()).toBe(false);
    await open(wrapper);
    expect(trigger(wrapper).attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('.schedule-date-picker__panel').attributes('id')).toBe(trigger(wrapper).attributes('aria-controls'));
    expect(document.activeElement).toBe(day(wrapper, '2024-01-31').element);
    expect(day(wrapper, '2024-01-31').attributes('aria-pressed')).toBe('true');
    expect(wrapper.findAll('.schedule-date-picker__day[tabindex="0"]')).toHaveLength(1);
    expect(day(wrapper, '2024-01-30').attributes('type')).toBe('button');
    await day(wrapper, '2024-01-30').trigger('click');
    await nextTick();
    expect(wrapper.emitted('update:modelValue')).toEqual([['2024-01-30']]);
    expect(wrapper.find('.schedule-date-picker__panel').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger(wrapper).element);
    expect(trigger(wrapper).text()).toContain('Jan 31, 2024');
    await wrapper.setProps({ modelValue: '2024-01-30' });
    expect(trigger(wrapper).text()).toContain('Jan 30, 2024');
  });

  it('supports arrows across months, week boundaries and Escape without selecting', async () => {
    const wrapper = mountPicker();
    await open(wrapper);
    await key(wrapper, '2024-01-31', 'ArrowRight');
    expect(document.activeElement).toBe(day(wrapper, '2024-02-01').element);
    await key(wrapper, '2024-02-01', 'ArrowDown');
    expect(document.activeElement).toBe(day(wrapper, '2024-02-08').element);
    await key(wrapper, '2024-02-08', 'ArrowUp');
    await key(wrapper, '2024-02-01', 'Home');
    expect(document.activeElement).toBe(day(wrapper, '2024-01-28').element);
    await key(wrapper, '2024-01-28', 'End');
    expect(document.activeElement).toBe(day(wrapper, '2024-02-03').element);
    await key(wrapper, '2024-02-03', 'ArrowLeft');
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    day(wrapper, '2024-02-02').element.dispatchEvent(event);
    await nextTick();
    expect(event.defaultPrevented).toBe(true);
    expect(trigger(wrapper).attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger(wrapper).element);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it.each([['2024-01-31', '2024-02-29'], ['2023-01-31', '2023-02-28'], ['2024-12-31', '2025-01-31']])('clamps PageDown from %s to %s', async (from, to) => {
    const wrapper = mountPicker({ modelValue: from });
    await open(wrapper);
    await key(wrapper, from, 'PageDown');
    expect(document.activeElement).toBe(day(wrapper, to).element);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await key(wrapper, to, 'PageUp');
    expect(wrapper.vm.visibleMonth).toBe(from.slice(0, 7));
  });

  it('constrains day focus, month navigation and Today to min/max', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 15, 12));
    const wrapper = mountPicker({ min: '2024-01-30', max: '2024-02-02' });
    await open(wrapper);
    expect(wrapper.get('[aria-label="Previous month"]').element.disabled).toBe(true);
    expect(day(wrapper, '2024-01-29').element.disabled).toBe(true);
    expect(wrapper.get('.schedule-date-picker__today').element.disabled).toBe(true);
    await key(wrapper, '2024-01-31', 'ArrowUp');
    expect(document.activeElement).toBe(day(wrapper, '2024-01-30').element);
    await key(wrapper, '2024-01-30', 'PageDown');
    expect(document.activeElement).toBe(day(wrapper, '2024-02-02').element);
    expect(wrapper.get('[aria-label="Next month"]').element.disabled).toBe(true);
    expect(day(wrapper, '2024-02-03').element.disabled).toBe(true);
    await key(wrapper, '2024-02-02', 'ArrowDown');
    expect(document.activeElement).toBe(day(wrapper, '2024-02-02').element);
    wrapper.vm.select('2024-02-03');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('uses the caller time zone Today for highlighting and selection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 1, 28, 12));
    const wrapper = mountPicker({ modelValue: '2024-02-29', min: '2024-02-29', today: '2024-02-29' });
    await open(wrapper);
    expect(day(wrapper, '2024-02-29').attributes('aria-current')).toBe('date');
    expect(wrapper.get('.schedule-date-picker__today').element.disabled).toBe(false);
    await wrapper.get('.schedule-date-picker__today').trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['2024-02-29']]);
  });

  it('uses local Today and handles empty, invalid and externally updated dates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 1, 29, 12));
    const wrapper = mountPicker({ modelValue: '2023-02-29', min: 'nonsense' });
    expect(trigger(wrapper).text()).toContain('Choose date');
    await open(wrapper);
    expect(day(wrapper, '2024-02-29').attributes('aria-current')).toBe('date');
    await wrapper.setProps({ modelValue: '2025-04-05' });
    expect(wrapper.vm.visibleMonth).toBe('2025-04');
    await wrapper.get('.schedule-date-picker__today').trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['2024-02-29']]);
    await wrapper.setProps({ modelValue: '', min: '2025-01-01' });
    await open(wrapper);
    expect(document.activeElement).toBe(day(wrapper, '2025-01-01').element);
  });

  it('reacts to the actual app locale ref and translates controls with bilingual fallbacks', async () => {
    const locale = ref('en');
    const translate = vi.fn((key) => key === 'scheduleDatePicker.today' ? 'Translated today' : key);
    const wrapper = mountPicker({}, { config: { globalProperties: { $locale: locale, $t: translate } } });
    await open(wrapper);
    expect(wrapper.findAll('abbr')[0].text()).toBe('Sun');
    locale.value = 'zh-CN';
    await nextTick();
    expect(trigger(wrapper).text()).toContain('2024年1月31日');
    expect(wrapper.findAll('abbr')[0].text()).toBe('周一');
    expect(wrapper.get('[aria-label="上个月"]').exists()).toBe(true);
    expect(wrapper.get('.schedule-date-picker__today').text()).toBe('Translated today');
    await key(wrapper, '2024-01-31', 'Home');
    expect(document.activeElement).toBe(day(wrapper, '2024-01-29').element);
    expect(translate).toHaveBeenCalledWith('scheduleDatePicker.keyboardHelp');
  });

  it('supports an unconfigured host and the legacy locale alias', async () => {
    document.documentElement.lang = 'zh-CN';
    const plain = mountPicker({ modelValue: '' }, {});
    // Explicit locale takes precedence over the document language.
    expect(trigger(plain).text()).toContain('Choose date');
    const unconfigured = mountPicker({ modelValue: '' }, { config: { globalProperties: {} } });
    expect(trigger(unconfigured).text()).toContain('选择日期');
    const wrapper = mountPicker({ modelValue: '' }, { config: { globalProperties: { $i18nLocale: ref('zh-CN') } } });
    expect(trigger(wrapper).text()).toContain('选择日期');
    await open(wrapper);
    expect(wrapper.get('[aria-label="下个月"]').exists()).toBe(true);
  });

  it('does not open when disabled and closes when disabled externally', async () => {
    const wrapper = mountPicker({ disabled: true });
    await trigger(wrapper).trigger('click');
    expect(wrapper.find('.schedule-date-picker__panel').exists()).toBe(false);
    await wrapper.setProps({ disabled: false });
    await open(wrapper);
    await wrapper.setProps({ disabled: true });
    expect(wrapper.find('.schedule-date-picker__panel').exists()).toBe(false);
    wrapper.vm.select('2024-01-31');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('handles contradictory bounds and supported year boundaries without invalid dates', async () => {
    const wrapper = mountPicker({ min: '2024-03-01', max: '2024-02-01' });
    await open(wrapper);
    expect(wrapper.findAll('.schedule-date-picker__day').every((button) => button.element.disabled)).toBe(true);
    expect(wrapper.get('[aria-label="Previous month"]').element.disabled).toBe(true);
    expect(wrapper.get('[aria-label="Next month"]').element.disabled).toBe(true);
    await wrapper.setProps({ min: '', max: '', modelValue: '0001-01-01' });
    await key(wrapper, '0001-01-01', 'ArrowLeft');
    expect(document.activeElement).toBe(day(wrapper, '0001-01-01').element);
    await wrapper.setProps({ modelValue: '9999-12-31' });
    await key(wrapper, '9999-12-31', 'ArrowRight');
    expect(document.activeElement).toBe(day(wrapper, '9999-12-31').element);
  });

  it('keeps multiple instances independent and closes on tabbing outside without stealing focus', async () => {
    const first = mountPicker();
    const second = mountPicker();
    expect(trigger(first).attributes('aria-controls')).not.toBe(trigger(second).attributes('aria-controls'));
    await open(first);
    trigger(second).element.focus();
    await nextTick();
    expect(first.find('.schedule-date-picker__panel').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger(second).element);
  });

  it('uses theme tokens and a shrinkable inline seven-column layout (not native popup CSS)', () => {
    const css = readFileSync('web/styles/schedule-date-picker.css', 'utf8');
    expect(css).toContain('repeat(7, minmax(0, 1fr))');
    expect(css).toContain('var(--bg-input)');
    expect(css).toContain('var(--accent-fg)');
    expect(css).toContain(':focus-visible');
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|position:\s*fixed|z-index:/i);
    expect(css).toContain('max-width: 100%');
  });
});
