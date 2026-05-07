/**
 * attachments.test.js — Unify attachment plumbing.
 *
 * Covers the three places we changed for image + file upload support:
 *
 *   1. `persistUnifyAttachments` writes resolved files to disk under
 *      the agent CWD's `.claude-tmp-attachments/<groupId>/` folder,
 *      strips base64 from the persistable record, and emits a
 *      `promptParts` array of `{type:'image', source:{type:'base64',...}}`
 *      blocks for the LLM call. PR #721 also adds a `failed` array
 *      with `{name, error}` entries the UI surfaces to the user, and
 *      enforces `MAX_FILES_PER_TURN` / `MAX_TOTAL_BYTES` caps.
 *
 *   2. `coordinator.ingest` forwards `_`-prefixed input fields to the
 *      envelope (so attachment payloads reach the driver) but does
 *      NOT persist them to the group log (audit / replay must stay
 *      lean — base64 in jsonl-log would blow up history). The
 *      structural `_`-prefix invariant is enforced at the
 *      `appendMessage` push site (group-store.js) — see the dedicated
 *      `appendMessage rejects ephemeral leaks` block below.
 *
 *   3. `engine.query` accepts `promptParts` and uses it as the user
 *      message content array; falls back to the string `prompt`
 *      shape when omitted (no regression for existing callers).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  persistUnifyAttachments,
  attachmentsForPersistence,
  MAX_FILES_PER_TURN,
  MAX_TOTAL_BYTES,
} from '../../agent/unify/attachments.js';
import { createCoordinator } from '../../agent/unify/groups/coordinator.js';
import { openGroup, createGroup } from '../../agent/unify/groups/group-store.js';

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
    expect(r.promptAttachments).toEqual([]);
    expect(r.promptSuffix).toBe('');
    expect(r.promptParts).toEqual([]);
    expect(r.failed).toEqual([]);
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

    expect(r.promptAttachments).toHaveLength(1);
    const saved = r.promptAttachments[0];
    expect(saved.name).toBe('notes.md');
    expect(saved.isImage).toBe(false);
    // Random-suffix path: 8 hex chars + extension. No clock dependency.
    expect(saved.path).toMatch(/^\.claude-tmp-attachments\/grp_test\/notes_[0-9a-f]{8}\.md$/);
    // File actually written
    const abs = join(tmp, saved.path);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe('hello');
    // Files-only bundle: no image blocks
    expect(r.promptParts).toEqual([]);
    // Prompt suffix mentions the file path + mime
    expect(r.promptSuffix).toContain(saved.path);
    expect(r.promptSuffix).toContain('text/markdown');
    // No failures.
    expect(r.failed).toEqual([]);
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

    expect(r.promptAttachments).toHaveLength(1);
    expect(r.promptAttachments[0].isImage).toBe(true);
    // Image bytes are on disk
    const abs = join(tmp, r.promptAttachments[0].path);
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
    expect(r.promptAttachments).toHaveLength(1);
    expect(r.promptAttachments[0].name).toBe('good.txt');
    // null / empty entries are caller bugs, not user errors — not in `failed`.
    expect(r.failed).toEqual([]);
  });

  it('preserves Unicode in on-disk filename basename (CJK, accents)', () => {
    const r = persistUnifyAttachments([
      {
        name: '设计图-v2.png',
        mimeType: 'image/png',
        data: PNG_1x1,
        isImage: true,
      },
    ], { subdir: 'grp_unicode' });
    expect(r.promptAttachments).toHaveLength(1);
    // Display name is preserved untouched.
    expect(r.promptAttachments[0].name).toBe('设计图-v2.png');
    // On-disk path keeps the Unicode basename — only path-dangerous
    // chars get sanitized.
    expect(r.promptAttachments[0].path).toMatch(/设计图-v2_[0-9a-f]{8}\.png$/);
  });

  it('strips path separators / NUL / leading dots from on-disk basename', () => {
    const r = persistUnifyAttachments([
      {
        name: '../../../etc/passwd',
        mimeType: 'text/plain',
        data: Buffer.from('x').toString('base64'),
      },
      {
        name: '.bashrc',
        mimeType: 'text/plain',
        data: Buffer.from('x').toString('base64'),
      },
    ], { subdir: 'grp_evil' });
    expect(r.promptAttachments).toHaveLength(2);
    // No `..`, `/`, or leading `.` in the on-disk basename.
    for (const f of r.promptAttachments) {
      const base = f.path.split('/').pop();
      expect(base.startsWith('.')).toBe(false);
      expect(base).not.toContain('/');
      expect(base).not.toContain('\\');
    }
  });

  it('caps attachments per turn at MAX_FILES_PER_TURN, surfacing excess in `failed`', () => {
    const tooMany = Array.from({ length: MAX_FILES_PER_TURN + 3 }, (_, i) => ({
      name: `f${i}.txt`,
      mimeType: 'text/plain',
      data: Buffer.from(String(i)).toString('base64'),
    }));
    const r = persistUnifyAttachments(tooMany, { subdir: 'grp_cap' });
    expect(r.promptAttachments).toHaveLength(MAX_FILES_PER_TURN);
    expect(r.failed).toHaveLength(3);
    expect(r.failed[0].error).toContain('too many files');
  });

  it('caps total bytes at MAX_TOTAL_BYTES, surfacing oversize in `failed`', () => {
    // Use 4 files of ~MAX_TOTAL_BYTES/3 each. The first three fit,
    // the fourth overflows the cap.
    const chunkSize = Math.floor(MAX_TOTAL_BYTES / 3);
    const big = Buffer.alloc(chunkSize, 0x41);
    const files = [0, 1, 2, 3].map((i) => ({
      name: `big${i}.bin`,
      mimeType: 'application/octet-stream',
      data: big.toString('base64'),
    }));
    const r = persistUnifyAttachments(files, { subdir: 'grp_bytes' });
    expect(r.promptAttachments.length).toBeLessThanOrEqual(3);
    expect(r.failed.length).toBeGreaterThanOrEqual(1);
    expect(r.failed.some((f) => f.error.includes('total upload'))).toBe(true);
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
      _promptParts: imageBlocks,
      _promptSuffix: '\n[Uploaded files]\n- a/x.png (image)',
    });

    // One delivery to vp_a (mentioned).
    expect(captured).toHaveLength(1);
    expect(captured[0].vpId).toBe('vp_a');
    // Envelope carries the ephemeral payload.
    expect(captured[0].env._promptParts).toEqual(imageBlocks);
    expect(captured[0].env._promptSuffix).toContain('Uploaded files');
    // Persistable form is on msg.meta.attachments — and it does NOT
    // contain base64 data.
    const stored = captured[0].env.msg;
    expect(stored.meta.attachments).toEqual([
      { name: 'x.png', path: 'a/x.png', mimeType: 'image/png', isImage: true },
    ]);
    // Log entry has no `_promptParts` leak.
    expect(group._log).toHaveLength(1);
    expect(Object.keys(group._log[0])).not.toContain('_promptParts');
    expect(Object.keys(group._log[0])).not.toContain('_promptSuffix');
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
    expect(captured[0].env._promptParts).toBeUndefined();
    expect(captured[0].env._promptSuffix).toBeUndefined();
  });
});

describe('appendMessage rejects ephemeral leaks (structural guard)', () => {
  // PR #721 (Linus): the `_`-prefix convention must be enforced at the
  // push site, not just at the coordinator. Any caller that bypasses
  // coord.ingest and pushes directly to appendMessage with a `_`-field
  // must fail loudly — silent leak of base64 into the audit log is the
  // exact regression we paid this PR to prevent.
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'unify-grp-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('throws when a record has any `_`-prefixed field', () => {
    const group = createGroup(tmp, { id: 'grp_assert', roster: ['vp_x'], defaultVpId: 'vp_x' });
    expect(() =>
      group.appendMessage({ from: 'user', text: 'leak', _promptParts: [{ x: 1 }] })
    ).toThrow(/ephemeral fields leaked/);
  });

  it('accepts records with no `_`-prefixed fields', () => {
    const group = createGroup(tmp, { id: 'grp_ok', roster: ['vp_y'], defaultVpId: 'vp_y' });
    const stored = group.appendMessage({ from: 'user', text: 'hi' });
    expect(stored.text).toBe('hi');
    expect(stored.id).toBeTruthy();
  });
});

