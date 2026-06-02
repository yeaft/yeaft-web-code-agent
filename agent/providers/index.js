import { PROVIDER_NAMES, DEFAULT_PROVIDER, isValidProvider } from './base.js';
import * as claudeCode from './claude-code.js';
import * as copilot from './copilot.js';

const REGISTRY = Object.freeze({
  'claude-code': claudeCode,
  'copilot': copilot,
});

export function getProvider(nameOrUndef) {
  const key = nameOrUndef || DEFAULT_PROVIDER;
  const driver = REGISTRY[key];
  if (!driver) {
    throw new Error(`Unknown chat provider: ${nameOrUndef} (known: ${PROVIDER_NAMES.join(', ')})`);
  }
  return driver;
}

export { PROVIDER_NAMES, DEFAULT_PROVIDER, isValidProvider };
