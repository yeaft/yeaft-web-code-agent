import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { CORE_TEST_FILES, REVIEWED_TEST_FILES, SANDBOX_TEST_FILES, PERSON_MONGO_TEST_FILES, PERSON_CPU_TEST_FILES } from '../scripts/test-suite-manifest.mjs';
import {
  isMainModule,
  TEST_CASE_LIMIT,
  validateCoreTestFiles,
} from '../scripts/check-test-budget.mjs';

const firstCoreFile = 'test/agent/connection-plaintext.test.js';

describe('test budget gate', () => {
  it('enforces the manifest and platform-safe CLI entry point', () => {
    const missingResult = validateCoreTestFiles({ files: [] });
    expect(missingResult.missing).toContain(firstCoreFile);

    const unexpectedResult = validateCoreTestFiles({
      files: ['test/new-regression.test.js'],
    });
    expect(unexpectedResult.unexpected).toContain('test/new-regression.test.js');

    const windowsEntry = 'C:\\repo\\scripts\\check-test-budget.mjs';
    expect(isMainModule(pathToFileURL(windowsEntry).href, windowsEntry)).toBe(true);
    expect(isMainModule(import.meta.url, windowsEntry)).toBe(false);

    expect(SANDBOX_TEST_FILES).toEqual([
      'test/agent/container-manager.test.js',
      'test/agent/container-cli.test.js',
      'test/agent/container-init.test.js',
      'test/server/sandbox-routes.test.js',
      'test/web/sandbox-settings.test.js',
      'test/web/agent-settings.test.js',
    ]);
    expect(PERSON_MONGO_TEST_FILES).toEqual(['test/agent/yeaft/person/mongo.integration.test.js']);
    expect(PERSON_CPU_TEST_FILES).toEqual(['test/person-local-memory-cpu.test.js']);
    expect(REVIEWED_TEST_FILES).toEqual([...CORE_TEST_FILES, ...SANDBOX_TEST_FILES, ...PERSON_MONGO_TEST_FILES, ...PERSON_CPU_TEST_FILES]);
    expect(new Set(REVIEWED_TEST_FILES).size).toBe(REVIEWED_TEST_FILES.length);
    for (const file of [...SANDBOX_TEST_FILES, ...PERSON_MONGO_TEST_FILES, ...PERSON_CPU_TEST_FILES]) {
      expect(CORE_TEST_FILES).not.toContain(file);
    }
  });
});
