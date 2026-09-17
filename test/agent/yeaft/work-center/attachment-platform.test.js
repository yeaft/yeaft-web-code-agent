import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendWorkItemAttachments,
  buildWorkItemAttachmentContext,
  cloneWorkItemAttachments,
  persistWorkItemAttachments,
  readWorkItemAttachment,
  removeWorkItemAttachments,
  removeWorkItemAttachmentFiles,
} from '../../../../agent/yeaft/work-center/attachments.js';
import {
  assertWorkItemAttachmentPlatform,
  supportsWorkItemAttachments,
} from '../../../../agent/yeaft/work-center/attachment-platform.js';

const directories = [];
const actualPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: actualPlatform });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function usePortablePlatform(platform = 'darwin') {
  Object.defineProperty(process, 'platform', { value: platform });
}

function file(name, mimeType, contents) {
  return { name, mimeType, data: Buffer.from(contents).toString('base64') };
}

describe('WorkItem attachment platforms', () => {
  it('advertises every platform backed by an attachment storage implementation', () => {
    expect(supportsWorkItemAttachments('linux')).toBe(true);
    expect(supportsWorkItemAttachments('darwin')).toBe(true);
    expect(supportsWorkItemAttachments('win32')).toBe(true);
    expect(supportsWorkItemAttachments('freebsd')).toBe(false);
    expect(() => assertWorkItemAttachmentPlatform('freebsd')).toThrow(/unavailable on freebsd/);
  });

  // Linux also exercises the portable branches locally. Native CI must use its
  // real mode/delete semantics, not pretend Windows has POSIX permissions.
  it.each(actualPlatform === 'linux' ? ['linux', 'darwin', 'win32'] : [actualPlatform])('persists, appends, reads, clones, projects and removes on %s', platform => {
    usePortablePlatform(platform);
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'work-item-portable-')));
    directories.push(base);
    const root = join(base, 'attachments');

    const attachments = persistWorkItemAttachments([
      file('notes.txt', 'text/plain', 'portable attachment'),
    ], { root, workItemId: 'source' });
    const appended = appendWorkItemAttachments(attachments, [
      file('more.txt', 'text/plain', 'second attachment'),
    ], { root, workItemId: 'source' });
    const all = [...attachments, ...appended];

    expect(readWorkItemAttachment({ id: 'source', attachments: all }, attachments[0].id, { root }))
      .toMatchObject({ name: 'notes.txt', size: 19 });
    expect(buildWorkItemAttachmentContext({ id: 'source', attachments: all }, {
      root,
      inlineTextBytes: 4096,
    })).toMatchObject({
      promptBlock: expect.stringContaining('portable attachment'),
      files: [expect.objectContaining({ root: expect.stringContaining('source') }), expect.any(Object)],
      readRoots: [expect.stringContaining('source')],
    });

    const cloned = cloneWorkItemAttachments({ id: 'source', attachments: all }, 'clone', { root });
    expect(cloned).toHaveLength(2);
    expect(readWorkItemAttachment({ id: 'clone', attachments: cloned }, cloned[1].id, { root }).data)
      .toBe(Buffer.from('second attachment').toString('base64'));

    // The service uses single-file removal to roll back uncommitted appends.
    // Exercise it separately from recursive rm (which handles Windows read-only
    // attributes differently), and keep the committed sibling intact.
    removeWorkItemAttachmentFiles(root, 'source', appended);
    expect(existsSync(join(root, 'source', appended[0].storageName))).toBe(false);
    expect(readWorkItemAttachment({ id: 'source', attachments }, attachments[0].id, { root }).data)
      .toBe(Buffer.from('portable attachment').toString('base64'));
    removeWorkItemAttachmentFiles(root, 'source', appended);
    removeWorkItemAttachments(root, 'source');
    expect(existsSync(join(root, 'source'))).toBe(false);
    expect(readdirSync(root).some(name => name.startsWith('.remove-'))).toBe(false);
  });

  it('rejects a symlink attachment root without writing outside storage', () => {
    usePortablePlatform('win32');
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'work-item-portable-link-')));
    directories.push(base);
    const outside = join(base, 'outside');
    const root = join(base, 'attachments');
    mkdirSync(outside);
    symlinkSync(outside, root, actualPlatform === 'win32' ? 'junction' : 'dir');

    expect(() => persistWorkItemAttachments([
      file('notes.txt', 'text/plain', 'must not escape'),
    ], { root, workItemId: 'owner' })).toThrow(/real directory/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('does not follow a replacement symlink while opening an attachment', () => {
    usePortablePlatform();
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'work-item-portable-owner-link-')));
    directories.push(base);
    const root = join(base, 'attachments');
    const attachment = persistWorkItemAttachments([
      file('notes.txt', 'text/plain', 'original'),
    ], { root, workItemId: 'owner' })[0];
    const owner = join(root, 'owner');
    const outside = join(base, 'outside');
    mkdirSync(outside);
    rmSync(owner, { recursive: true });
    symlinkSync(outside, owner, actualPlatform === 'win32' ? 'junction' : 'dir');

    expect(() => readWorkItemAttachment({ id: 'owner', attachments: [attachment] }, attachment.id, { root }))
      .toThrow(/real directory/);
    expect(readdirSync(outside)).toEqual([]);
  });
});
