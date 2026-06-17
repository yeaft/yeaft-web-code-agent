import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { getLlmConfig, updateLlmConfig } from '../../../agent/yeaft/config-api.js';
import { buildSystemPrompt } from '../../../agent/yeaft/prompts.js';
import { resolveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';
import {
  __testResetVpState,
  __testSetSession,
  broadcastLanguageChange,
} from '../../../agent/yeaft/web-bridge.js';

let tempDir = null;

function makeDir() {
  tempDir = mkdtempSync(join(tmpdir(), 'yeaft-system-prompt-language-'));
  return tempDir;
}

afterEach(async () => {
  __testSetSession(null);
  await __testResetVpState();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('Yeaft system prompt language propagation', () => {
  it('round-trips zh-CN through config API and loadConfig', () => {
    const root = makeDir();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [],
      language: 'en',
    }));

    const updated = updateLlmConfig({ language: 'zh-CN' }, root);
    expect(updated.error).toBeUndefined();
    expect(updated.language).toBe('zh-CN');

    expect(getLlmConfig(root).language).toBe('zh-CN');
    expect(loadConfig({ dir: root }).language).toBe('zh-CN');
  });

  it('renders Chinese prompt sections for zh-CN config values', () => {
    const prompt = buildSystemPrompt({ language: 'zh-CN', toolNames: [] });

    expect(prompt).toContain('## 核心原则');
    expect(prompt).toContain('真实性优先');
    expect(prompt).not.toContain('## Core Principles');
  });

  it('keeps global language when applying session-scoped model config', () => {
    const userConfig = {
      language: 'zh-CN',
      model: 'proxy/gpt-5',
      primaryModel: 'proxy/gpt-5',
      providers: [{ name: 'proxy', models: ['gpt-5', 'claude-opus-4.8'] }],
    };

    const effective = resolveSessionConfig(userConfig, {
      model: 'proxy/claude-opus-4.8',
      modelEffort: 'high',
    });

    expect(effective.language).toBe('zh-CN');
    expect(effective.model).toBe('proxy/claude-opus-4.8');
    expect(effective.modelEffort).toBe('high');
  });

  it('updates live session language so routed or rebuilt VP engines inherit zh-CN', () => {
    const sessionLike = {
      config: {
        language: 'en',
        model: 'proxy/gpt-5',
      },
      engine: {
        language: 'en',
        setLanguage(language) {
          this.language = language;
        },
      },
    };

    __testSetSession(sessionLike);
    broadcastLanguageChange('zh-CN');

    expect(sessionLike.config.language).toBe('zh-CN');
    expect(sessionLike.engine.language).toBe('zh-CN');

    const rebuiltPrompt = buildSystemPrompt({ language: sessionLike.config.language, toolNames: [] });
    expect(rebuiltPrompt).toContain('## 核心原则');
    expect(rebuiltPrompt).not.toContain('## Core Principles');
  });
});
