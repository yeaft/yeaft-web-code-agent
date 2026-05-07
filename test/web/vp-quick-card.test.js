// @vitest-environment happy-dom
// test/web/vp-quick-card.test.js
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

// VpQuickCard imports VpAvatar -> vp.js store, and the store does
// `const { defineStore } = Pinia;` against a global. Stub it to a
// no-op factory so module load doesn't crash; the VpAvatar mount
// itself is stubbed below so the store is never actually used.
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = globalThis.Pinia.defineStore || (() => () => ({}));

const { default: VpQuickCard } = await import('../../web/components/VpQuickCard.js');

function makeTurn(overrides = {}) {
  return {
    type: 'assistant-turn',
    id: 'turn_1',
    speakerVpId: 'jobs',
    turnId: 't1',
    isStreaming: false,
    toolMsgs: [],
    speakerTimestamp: 0,
    intent: 'feature',
    ...overrides,
  };
}

const stubT = (key, params) => {
  if (!params) return key;
  // Real $t looks up the translated value and interpolates {placeholders}.
  // The stub skips the lookup, so we append the param values to the key
  // so tests can assert on the substituted content (the param values
  // are what callers actually want to verify reached the template).
  return key + ' ' + Object.values(params).join(' ');
};

const mountOpts = {
  global: {
    mocks: { $t: stubT },
    stubs: { VpAvatar: true },
  },
};

describe('VpQuickCard', () => {
  it('renders the Track-A preview when present', () => {
    const wrapper = mount(VpQuickCard, {
      ...mountOpts,
      props: {
        turn: makeTurn(),
        preview: { intent: 'feature', preview: 'Refactoring auth module' },
      },
    });
    expect(wrapper.text()).toContain('Refactoring auth module');
  });

  it('shows "thinking" status while streaming with no tools', () => {
    const wrapper = mount(VpQuickCard, {
      ...mountOpts,
      props: {
        turn: makeTurn({ isStreaming: true }),
        preview: { intent: 'feature', preview: 'p' },
      },
    });
    expect(wrapper.find('.vp-card-status').classes()).toContain('status-thinking');
  });

  it('shows "tool" status with tool name when last toolMsg has no result', () => {
    const wrapper = mount(VpQuickCard, {
      ...mountOpts,
      props: {
        turn: makeTurn({
          isStreaming: true,
          toolMsgs: [{ toolName: 'web_search', hasResult: false }],
        }),
        preview: { intent: 'feature', preview: 'p' },
      },
    });
    expect(wrapper.find('.vp-card-status').classes()).toContain('status-tool');
    expect(wrapper.text()).toContain('web_search');
  });

  it('shows "done" status with tool count when not streaming', () => {
    const wrapper = mount(VpQuickCard, {
      ...mountOpts,
      props: {
        turn: makeTurn({
          toolMsgs: [
            { toolName: 'web_search', hasResult: true },
            { toolName: 'bash', hasResult: true },
          ],
        }),
        preview: { intent: 'feature', preview: 'p' },
      },
    });
    expect(wrapper.find('.vp-card-status').classes()).toContain('status-done');
    expect(wrapper.text()).toContain('2');
  });

  it('shows "aborted" when turn carries speakerStateCause === "vp_typing_aborted"', () => {
    const wrapper = mount(VpQuickCard, {
      ...mountOpts,
      props: {
        turn: makeTurn({ speakerStateCause: 'vp_typing_aborted' }),
        preview: { intent: 'feature', preview: 'p' },
      },
    });
    expect(wrapper.find('.vp-card-status').classes()).toContain('status-aborted');
  });

  it('emits open-detail with vpId+turnId when clicked', async () => {
    const wrapper = mount(VpQuickCard, {
      ...mountOpts,
      props: {
        turn: makeTurn(),
        preview: { intent: 'feature', preview: 'p' },
      },
    });
    await wrapper.find('.vp-quick-card').trigger('click');
    const events = wrapper.emitted('open-detail');
    expect(events).toBeTruthy();
    expect(events[0][0]).toEqual({ vpId: 'jobs', turnId: 't1' });
  });
});
