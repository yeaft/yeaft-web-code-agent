import { describe, expect, it } from 'vitest';
import {
  getAgentInstallCommand,
  getAgentLlmCommand,
  getAgentName,
  getAgentServiceCommand,
  getServerWsUrl,
} from '../../web/utils/agentSetup.js';

describe('agent setup helpers', () => {
  it('builds deterministic setup commands', () => {
    const profile = { username: 'alice@example.com' };
    const name = getAgentName(profile);

    expect(name).toMatch(/^alice-example-com-[0-9a-f]{6}$/);
    expect(getAgentInstallCommand()).toBe('npm install -g @yeaft/webchat-agent');
    expect(getAgentLlmCommand()).toBe('yeaft-agent llm use github-copilot --model gpt-5.5');
    expect(getAgentServiceCommand({
      profile,
      agentSecret: 'secret-123',
      serverWsUrl: 'wss://yeaft.example.com',
    })).toBe(`yeaft-agent install --instance ${name} --server wss://yeaft.example.com --secret secret-123 --name ${name}`);
  });

  it('does not build the service command before a secret exists', () => {
    expect(getAgentServiceCommand({ agentSecret: '' })).toBe('');
  });

  it('uses ws for http pages and wss for https pages', () => {
    expect(getServerWsUrl({ protocol: 'http:', host: 'localhost:3000' })).toBe('ws://localhost:3000');
    expect(getServerWsUrl({ protocol: 'https:', host: 'yeaft.example.com' })).toBe('wss://yeaft.example.com');
  });
});
