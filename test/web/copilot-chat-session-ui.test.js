import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const chatPageSource = () => readFileSync('web/components/ChatPage.js', 'utf8');
const chatModalCss = () => readFileSync('web/styles/chat-modals.css', 'utf8');

describe('Copilot Chat Session creation UI', () => {
  it('does not render the old Copilot model selector', () => {
    const src = chatPageSource();
    expect(src).not.toContain('copilot-model-picker');
    expect(src).not.toContain('convModalCopilotModel');
    expect(src).not.toContain('listModelsForAgent(this.convModalAgent, \'copilot\')');
  });

  it('creates Copilot sessions without a model provider option', () => {
    const src = chatPageSource();
    const buildConvOpts = src.slice(src.indexOf('buildConvOpts() {'), src.indexOf('resumeSession(session)', src.indexOf('buildConvOpts() {')));

    expect(buildConvOpts).toContain("opts.providerOptions = { allowAllTools: true };");
    expect(buildConvOpts).not.toContain('providerOptions.model');
    expect(buildConvOpts).not.toContain('model =');
  });

  it('does not keep dead Copilot model picker CSS', () => {
    expect(chatModalCss()).not.toContain('copilot-model-picker');
  });
});
