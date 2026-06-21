import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shouldShowYeaftOnboardingGuide } from '../../web/utils/yeaftOnboarding.js';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('Yeaft conversation layout', () => {
  it('keeps the transcript in a flex body above the input', () => {
    const source = read('web/components/YeaftPage.js');

    expect(source).toContain('<div class="yeaft-conversation-body">');
    expect(source.indexOf('<div class="yeaft-conversation-body">')).toBeLessThan(source.indexOf('<MessageList'));
    expect(source.indexOf('</div>\n\n        <div v-if="showLlmConfig"')).toBeGreaterThan(source.indexOf('<SettingsPanel'));
    expect(source.indexOf('<ChatInput')).toBeGreaterThan(source.indexOf('</div>\n\n        <div v-if="showLlmConfig"'));
  });

  it('lets the message container consume remaining height instead of pushing the input upward', () => {
    const css = read('web/styles/yeaft.css');

    expect(css).toContain('.yeaft-main-center {\n  flex: 1;\n  min-width: 0;\n  min-height: 0;');
    expect(css).toContain('.yeaft-conversation-body {\n  flex: 1 1 auto;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  overflow: hidden;\n}');
    expect(css).toContain('.yeaft-conversation-body > .chat-container {\n  flex: 1 1 auto;\n}');
  });

  it('shows an onboarding guide instead of chat input when no Yeaft session exists', () => {
    const source = read('web/components/YeaftPage.js');
    const css = read('web/styles/yeaft.css');
    const en = read('web/i18n/en.js');
    const zh = read('web/i18n/zh-CN.js');

    expect(source).toContain('class="yeaft-onboarding"');
    expect(source).toContain("v-if=\"!showSettings && !store.yeaftActiveVpDetailId && showOnboardingGuide\"");
    expect(source).toContain('<ChatInput\n          v-if="!showSettings && !showOnboardingGuide"');
    expect(source).toContain('const showOnboardingGuide = Vue.computed(() => {');
    expect(source).toContain('shouldShowYeaftOnboardingGuide({');
    expect(source).toContain('sessionsReady: !!(gs && gs.hasLoadedSnapshot)');
    expect(source).toContain('openSessionCreate');
    expect(source).toContain('openLlmConfig');
    expect(source).toContain('npm install -g @yeaft/webchat-agent');
    expect(source).toContain("fetch('/api/user/agent-secret'");
    expect(source).toContain('yeaft-agent install --server ${serverUrl} --name yeaft-agent --secret ${secret}');
    expect(source).toContain('yeaft-agent llm use github-copilot --model gpt-5.5');
    expect(source).not.toContain('--model <model-id>');
    expect(source).not.toContain('OPENAI_KEY=sk-...');

    expect(css).toContain('.yeaft-onboarding {');
    expect(css).toContain('.yeaft-onboarding-terminal {');
    expect(css).toContain('.yeaft-onboarding-command code {');
    expect(css).not.toMatch(/\.yeaft-onboarding[\s\S]*?#[0-9a-f]{3,6}/i);
    expect(css).not.toMatch(/\.yeaft-onboarding[\s\S]*?rgba\(/i);

    expect(en).toContain("'yeaft.onboarding.title': 'Connect an Agent before chatting'");
    expect(zh).toContain("'yeaft.onboarding.title': '先连接 Agent，再开始会话'");
  });

  it('does not treat an unloaded Session snapshot as an empty Session list', () => {
    expect(shouldShowYeaftOnboardingGuide({
      hasYeaftAgent: true,
      sessionsReady: false,
      sessionsEmpty: true,
      activeSessionId: null,
      topbarSession: null,
    })).toBe(false);

    expect(shouldShowYeaftOnboardingGuide({
      hasYeaftAgent: true,
      sessionsReady: true,
      sessionsEmpty: true,
      activeSessionId: null,
      topbarSession: null,
    })).toBe(true);

    expect(shouldShowYeaftOnboardingGuide({
      hasYeaftAgent: true,
      sessionsReady: true,
      sessionsEmpty: false,
      activeSessionId: 'session-1',
      topbarSession: { id: 'session-1' },
    })).toBe(false);

    expect(shouldShowYeaftOnboardingGuide({
      hasYeaftAgent: false,
      sessionsReady: false,
      sessionsEmpty: false,
      activeSessionId: null,
      topbarSession: null,
    })).toBe(true);
  });
});
