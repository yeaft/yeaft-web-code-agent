import { describe, expect, it } from 'vitest';
import { GEMINI_BASE_URL } from '../../../agent/llm-model-discovery.js';
import { createProviderContext } from '../../../agent/yeaft/llm/provider-state.js';

const HOST = 'https://generativelanguage.googleapis.com';
const BETA = `${HOST}/v1beta`;
const CUSTOM = 'https://gateway.invalid/prefix/v1beta/models/previous:streamGenerateContent?route=google';
const MODEL = 'gemini-2.5-pro';

describe('Gemini stable endpoint defaults', () => {
  it('uses one native continuation identity for omitted, host-only and stable paths but fences beta and custom URLs', () => {
    const context = baseUrl => createProviderContext({ protocol: 'gemini', baseUrl, model: MODEL, staticApiKey: 'fixture-key' });
    const stable = context(GEMINI_BASE_URL);
    expect(context(undefined)).toEqual(stable);
    expect(context(`${HOST}/`)).toEqual(stable);
    expect(stable.diagnostics.capabilitySource).toBe('native-endpoint');
    expect(context(BETA).diagnostics.capabilitySource).toBe('native-endpoint');
    expect(context(BETA).origin.endpointFingerprint).not.toBe(stable.origin.endpointFingerprint);
    expect(context(CUSTOM).origin.endpointFingerprint).not.toBe(stable.origin.endpointFingerprint);
  });
});
