import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateLlmConfig } from '../../../agent/yeaft/config-api.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'yeaft-config-api-managed-'));
}

describe('LLM config API managed providers', () => {
  it('persists GitHub Copilot as minimal managed config', () => {
    const dir = tempDir();
    try {
      const result = updateLlmConfig({
        providers: [{
          name: 'github-copilot',
          baseUrl: 'https://api.githubcopilot.com',
          credentialProvider: 'github-copilot',
          protocol: 'openai-responses',
          models: [{ id: 'claude-opus-4.8', protocol: 'anthropic' }, { id: 'gpt-5', protocol: 'openai-responses' }],
        }],
        primaryModel: 'github-copilot/claude-opus-4.8',
      }, dir);

      expect(result.error).toBeUndefined();
      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
      expect(saved.providers).toEqual([{
        name: 'github-copilot',
        credentialProvider: 'github-copilot',
        managed: 'github-copilot',
      }]);
      expect(saved.primaryModel).toBe('github-copilot/claude-opus-4.8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still requires baseUrl and models for custom providers', () => {
    const dir = tempDir();
    try {
      expect(updateLlmConfig({ providers: [{ name: 'custom' }] }, dir).error)
        .toBe('Provider "custom" must have a baseUrl');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
