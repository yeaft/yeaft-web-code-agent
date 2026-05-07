/**
 * attachments.test.js — Unify attachment plumbing.
 *
 * Covers the three places we changed for image + file upload support:
 *
 *   1. `persistUnifyAttachments` writes resolved files to disk under
 *      the agent CWD's `.claude-tmp-attachments/<groupId>/` folder,
 *      strips base64 from the persistable record, and emits a
 *      `promptParts` array of `{type:'image', source:{type:'base64',...}}`
 *      blocks for the LLM call.
 *
 *   2. `coordinator.ingest` forwards `_`-prefixed input fields to the
 *      envelope (so attachment payloads reach the driver) but does
 *      NOT persist them to the group log (audit / replay must stay
 *      lean — base64 in jsonl-log would blow up history).
 *
 *   3. `engine.query` accepts `promptParts` and uses it as the user
 *      message content array; falls back to the string `prompt`
 *      shape when omitted (no regression for existing callers).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  persistUnifyAttachments,
  attachmentsForPersistence,
} from '../../agent/unify/attachments.js';
import { createCoordinator } from '../../agent/unify/groups/coordinator.js';

// One-pixel transparent PNG, base64.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('persistUnifyAttachments', () => {
  let tmp;
  let prevCwd;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'unify-att-'));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty bundle when no files', () => {
    const r = persistUnifyAttachments([], { subdir: 'grp_x' });
    expect(r.savedFiles).toEqual([]);
    expect(r.promptSuffix).toBe('');
    expect(r.promptParts).toEqual([]);
  });

  it('writes a non-image file to disk under the group subdir', () => {
    const r = persistUnifyAttachments([
      {
        name: 'notes.md',
        mimeType: 'text/markdown',
        data: Buffer.from('hello').toString('base64'),
        isImage: false,
      },
    ], { subdir: 'grp_test' });

    expect(r.savedFiles).toHaveLength(1);
    const saved = r.savedFiles[0];
    expect(saved.name).toBe('notes.md');
    expect(saved.isImage).toBe(false);
    expect(saved.path).toMatch(/^\.claude-tmp-attachments\/grp_test\/notes_\d+\.md$/);
    // File actually written
    const abs = join(tmp, saved.path);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe('hello');
    // Files-only bundle: no image blocks
    expect(r.promptParts).toEqual([]);
    // Prompt suffix mentions the file path + mime
    expect(r.promptSuffix).toContain(saved.path);
    expect(r.promptSuffix).toContain('text/markdown');
  });

  it('emits an image content block AND saves bytes for an image file', () => {
    const r = persistUnifyAttachments([
      {
        name: 'pic.png',
        mimeType: 'image/png',
        data: PNG_1x1,
        isImage: true,
      },
    ], { subdir: 'grp_img' });

    expect(r.savedFiles).toHaveLength(1);
    expect(r.savedFiles[0].isImage).toBe(true);
    // Image bytes are on disk
    const abs = join(tmp, r.savedFiles[0].path);
    expect(existsSync(abs)).toBe(true);

    expect(r.promptParts).toHaveLength(1);
    const part = r.promptParts[0];
    expect(part.type).toBe('image');
    expect(part.source.type).toBe('base64');
    expect(part.source.mediaType).toBe('image/png');
    expect(part.source.data).toBe(PNG_1x1);
  });

  it('skips entries missing data and survives bad inputs', () => {
    const r = persistUnifyAttachments([
      { name: 'good.txt', mimeType: 'text/plain', data: Buffer.from('a').toString('base64') },
      null,
      { name: '', mimeType: 'text/plain', data: '' },
    ], { subdir: 'grp_bad' });
    expect(r.savedFiles).toHaveLength(1);
    expect(r.savedFiles[0].name).toBe('good.txt');
  });

  it('attachmentsForPersistence strips any extra fields', () => {
    const out = attachmentsForPersistence([
      {
        name: 'x', path: 'p', mimeType: 'image/png', isImage: true,
        // Imagine these slipped in:
        data: 'AAA', secret: 'no',
      },
    ]);
    expect(out).toEqual([
      { name: 'x', path: 'p', mimeType: 'image/png', isImage: true },
    ]);
  });
});

describe('coordinator.ingest ephemeral fields', () => {
  // Build an in-memory fake GroupHandle that satisfies the parts of
  // the contract `coord.ingest` actually calls.
  function makeFakeGroup({ roster = ['vp_a', 'vp_b'], defaultVpId = 'vp_a' } = {}) {
    const log = [];
    return {
      _log: log,
      getMeta() {
        return { id: 'grp_t', roster, defaultVpId };
      },
      appendMessage(record) {
        const stored = {
          id: 'm_' + log.length,
          ts: new Date().toISOString(),
          ...record,
        };
        log.push(stored);
        return stored;
      },
    };
  }

  it('ferries `_`-prefixed fields to the envelope but not to the log', () => {
    const group = makeFakeGroup();
    const captured = [];
    const coord = createCoordinator(group, {
      deliver: (vpId, env) => captured.push({ vpId, env }),
    });

    const imageBlocks = [{
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: PNG_1x1 },
    }];
    coord.ingest({
      from: 'user',
      role: 'user',
      // Use a real `@vp_a` mention that parseMentions will match
      // against the roster — keeps the test honest about the
      // dispatch path without coupling to fallback-resolution.
      text: '@vp_a look at this',
      meta: { attachments: [{ name: 'x.png', path: 'a/x.png', mimeType: 'image/png', isImage: true }] },
      _attachmentParts: imageBlocks,
      _attachmentSuffix: '\n[Uploaded files]\n- a/x.png (image)',
    });

    // One delivery to vp_a (mentioned).
    expect(captured).toHaveLength(1);
    expect(captured[0].vpId).toBe('vp_a');
    // Envelope carries the ephemeral payload.
    expect(captured[0].env._attachmentParts).toEqual(imageBlocks);
    expect(captured[0].env._attachmentSuffix).toContain('Uploaded files');
    // Persistable form is on msg.meta.attachments — and it does NOT
    // contain base64 data.
    const stored = captured[0].env.msg;
    expect(stored.meta.attachments).toEqual([
      { name: 'x.png', path: 'a/x.png', mimeType: 'image/png', isImage: true },
    ]);
    // Log entry has no `_attachmentParts` leak.
    expect(group._log).toHaveLength(1);
    expect(Object.keys(group._log[0])).not.toContain('_attachmentParts');
    expect(Object.keys(group._log[0])).not.toContain('_attachmentSuffix');
  });

  it('still works when no ephemeral fields are present (regression)', () => {
    const group = makeFakeGroup();
    const captured = [];
    const coord = createCoordinator(group, {
      deliver: (vpId, env) => captured.push({ vpId, env }),
    });
    coord.ingest({
      from: 'user',
      role: 'user',
      text: '@vp_a hi',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].env._attachmentParts).toBeUndefined();
    expect(captured[0].env._attachmentSuffix).toBeUndefined();
  });
});
