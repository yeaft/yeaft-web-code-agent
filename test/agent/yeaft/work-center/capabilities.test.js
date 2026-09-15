import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workItemCapabilityContext } from '../../../../agent/yeaft/work-center/capabilities.js';
import { createWorkItemToolRegistry, workItemToolPolicySnapshot } from '../../../../agent/yeaft/work-center/runner.js';

const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Work Center executable capability inventory', () => {
  it('matches the executor policy and never advertises unowned async capabilities', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'work-center-capabilities-'));
    directories.push(workDir);
    for (const hasAttachments of [false, true]) {
      const ref = 'work-item-attachment://a/source.txt';
      const registry = createWorkItemToolRegistry({
        workDir, isRunActive: () => true,
        attachmentFiles: hasAttachments ? [{ root: workDir, path: join(workDir, 'source.txt'), ref }] : [],
      });
      const capabilities = workItemCapabilityContext([], { hasAttachments });
      expect(capabilities.tools.sort()).toEqual(registry.getAllTools().map(tool => tool.name).sort());
      expect(capabilities.tools.sort()).toEqual(workItemToolPolicySnapshot(workDir, hasAttachments ? [ref] : []).allowedToolNames.sort());
      expect(capabilities.tools).not.toContain('GitRead');
      expect(capabilities.tools).not.toEqual(expect.arrayContaining(['SpawnAgent', 'CreateWorkItem', 'HistorySearch']));
      expect(capabilities.tools.includes('Bash')).toBe(!hasAttachments);
    }
  });

  it('offers bounded role metadata without souls, credentials or truncated VP identities', () => {
    const vps = Array.from({ length: 70 }, (_, index) => ({
      id: `vp-${index}`, name: '分析'.repeat(200), role: '工程'.repeat(300),
      traits: ['质量'.repeat(100)], persona: 'PRIVATE_SOUL', apiKey: 'PRIVATE_SECRET',
    }));
    const context = workItemCapabilityContext(vps);
    expect(Buffer.byteLength(JSON.stringify(context.vps), 'utf8')).toBeLessThanOrEqual(8192);
    expect(context.omittedVpCount + context.vps.length).toBe(70);
    expect(JSON.stringify(context)).not.toContain('PRIVATE_');
    expect(workItemCapabilityContext([{ id: 'x'.repeat(200) }]).vps).toEqual([]);
  });

});
