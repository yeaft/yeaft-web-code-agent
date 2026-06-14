import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import ctx from '../../../agent/context.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { createSessionFromSpec } from '../../../agent/yeaft/sessions/session-crud.js';
import {
  __testGroupHistory,
  __testSetSession,
} from '../../../agent/yeaft/web-bridge.js';

const roots = [];
const originalConfig = ctx.CONFIG;

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-web-bridge-workdir-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  __testSetSession(null);
  ctx.CONFIG = originalConfig;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('web bridge workdir sessions', () => {
  it('hydrates registered workdir session history from the workdir root', () => {
    const defaultYeaftDir = tempRoot();
    const workDir = tempRoot();
    ctx.CONFIG = { ...(originalConfig || {}), yeaftDir: defaultYeaftDir };

    const meta = createSessionFromSpec(defaultYeaftDir, {
      name: 'Workdir History',
      roster: ['omni'],
      workDir,
    });
    const workYeaftDir = join(workDir, '.yeaft');
    const workStore = new ConversationStore(workYeaftDir);
    workStore.append({
      role: 'user',
      content: 'hello from workdir',
      sessionId: meta.id,
      threadId: 'main',
    });

    __testSetSession({
      yeaftDir: defaultYeaftDir,
      config: { _readOnly: true },
      conversationStore: new ConversationStore(defaultYeaftDir),
      memoryIndex: null,
      amsRegistry: null,
    });

    expect(__testGroupHistory(meta.id).map(entry => entry.content)).toEqual(['hello from workdir']);
  });
});
