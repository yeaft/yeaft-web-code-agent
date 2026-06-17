import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleListModels } from '../../agent/cli.js';

// `yeaft-agent llm list-models` handler: covers offline config view, live
// Copilot discovery (success + credential-missing), live OpenAI-compatible
// discovery, and unknown-provider guard. We inject the discovery functions
// instead of mocking fetch so the tests stay focused on the CLI surface.

describe('handleListModels', () => {
  let logs, errors, originalExitCode;

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
    originalExitCode = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  it('lists configured providers offline with primary/fast annotations', async () => {
    await handleListModels({
      providers: [{
        name: 'my-proxy',
        baseUrl: 'http://localhost:6628/v1',
        models: ['claude-sonnet-4-20250514', 'gpt-5', 'deepseek-reasoner'],
      }],
      primaryModel: 'my-proxy/claude-sonnet-4-20250514',
      fastModel: 'my-proxy/gpt-5',
    });

    const out = logs.join('\n');
    expect(out).toContain('Configured models:');
    expect(out).toContain('[my-proxy] http://localhost:6628/v1');
    expect(out).toContain('my-proxy/claude-sonnet-4-20250514 ← primary');
    expect(out).toContain('my-proxy/gpt-5 ← fast');
    expect(out).toContain('my-proxy/deepseek-reasoner');
    expect(process.exitCode).toBe(0);
  });

  it('points the user at setup/discovery when no providers exist', async () => {
    await handleListModels({ providers: [] });
    const out = logs.join('\n');
    expect(out).toContain('No providers configured');
    expect(out).toContain('list-models github-copilot');
    expect(process.exitCode).toBe(0);
  });

  it('live-discovers GitHub Copilot models and prints them', async () => {
    await handleListModels(
      { providers: [] },
      {
        providerName: 'github-copilot',
        deps: {
          discoverCopilot: async () => ({
            source: 'live',
            models: ['claude-sonnet-4.5', 'gpt-5'],
            warning: null,
          }),
        },
      }
    );

    const out = logs.join('\n');
    expect(out).toContain('Available models from GitHub Copilot (source: live)');
    expect(out).toContain('  claude-sonnet-4.5');
    expect(out).toContain('  gpt-5');
    expect(process.exitCode).toBe(0);
  });

  it('exits non-zero with a gh-auth hint when Copilot credentials are missing', async () => {
    const err = new Error('GitHub Copilot credential not found. Run `gh auth login` ...');
    err.code = 'COPILOT_CREDENTIAL_MISSING';
    await handleListModels(
      { providers: [] },
      {
        providerName: 'github-copilot',
        deps: { discoverCopilot: async () => { throw err; } },
      }
    );

    const errOut = errors.join('\n');
    expect(errOut).toContain('GitHub Copilot model discovery failed');
    expect(errOut).toContain('gh auth login');
    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero with the same hint when Copilot credentials are invalid', async () => {
    const err = new Error('GitHub Copilot credential is invalid ...');
    err.code = 'COPILOT_AUTH_INVALID';
    await handleListModels(
      { providers: [] },
      {
        providerName: 'github-copilot',
        deps: { discoverCopilot: async () => { throw err; } },
      }
    );

    expect(errors.join('\n')).toContain('gh auth login');
    expect(process.exitCode).toBe(1);
  });

  it('rejects an unknown provider and lists configured names', async () => {
    await handleListModels(
      {
        providers: [
          { name: 'my-proxy', baseUrl: 'http://x/v1', models: ['gpt-5'] },
          { name: 'other', baseUrl: 'http://y/v1', models: ['claude-3-5-haiku'] },
        ],
      },
      { providerName: 'bogus' }
    );

    const errOut = errors.join('\n');
    expect(errOut).toContain('Provider "bogus" not found');
    expect(errOut).toContain('my-proxy');
    expect(errOut).toContain('other');
    expect(process.exitCode).toBe(1);
  });

  it('live-discovers OpenAI-compatible models for a configured provider', async () => {
    await handleListModels(
      {
        providers: [{ name: 'my-proxy', baseUrl: 'http://proxy/v1', apiKey: 'k', models: ['gpt-5'] }],
      },
      {
        providerName: 'my-proxy',
        deps: {
          discoverOpenAI: async ({ baseUrl, apiKey }) => {
            expect(baseUrl).toBe('http://proxy/v1');
            expect(apiKey).toBe('k');
            return { source: 'live', models: ['gpt-5', 'gpt-4o', 'deepseek-reasoner'] };
          },
        },
      }
    );

    const out = logs.join('\n');
    expect(out).toContain('Available models from "my-proxy" (http://proxy/v1, source: live)');
    expect(out).toContain('  my-proxy/gpt-5');
    expect(out).toContain('  my-proxy/deepseek-reasoner');
    expect(process.exitCode).toBe(0);
  });
});
