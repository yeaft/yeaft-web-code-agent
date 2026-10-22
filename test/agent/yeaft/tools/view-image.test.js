import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import viewImage from '../../../../agent/yeaft/tools/view-image.js';
import { hydratePersistedUserAttachmentContent, persistedAttachmentPreviewPayload } from '../../../../agent/yeaft/attachments.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=', 'base64');
const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-view-image-')); directories.push(root);
  const ctx = { cwd: join(root, 'project'), yeaftDir: join(root, 'instance'), sessionId: 'current-session' };
  mkdirSync(ctx.cwd);
  const image = (sessionId = ctx.sessionId, name = 'pixel.png') => {
    const path = join(ctx.yeaftDir, 'sessions', sessionId, 'attachments', name);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, png); return path;
  };
  const read = async (path, extra = {}) => JSON.parse(await viewImage.execute({ file_path: path }, { ...ctx, ...extra }));
  return { ctx, image, read, root };
}

describe('ViewImage owned Session attachments', () => {
  it('reads current Session images outside workDir and preserves provider history and preview payloads', async () => {
    const { ctx, image, read } = fixture();
    const path = image(), data = png.toString('base64');
    expect(await read(path)).toMatchObject({ path, width: 1, height: 1, media_type: 'image/png', size: png.length, image: `data:image/png;base64,${data}` });
    const attachment = { path, name: 'pixel.png', mimeType: 'image/png', isImage: true };
    expect(persistedAttachmentPreviewPayload(attachment, ctx)).toMatchObject({ data, mimeType: 'image/png', filename: 'pixel.png' });
    const row = { role: 'user', sessionId: ctx.sessionId, content: 'see image', attachments: [attachment] };
    expect(hydratePersistedUserAttachmentContent(row, ctx)).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
    expect(row.content).toBe('see image');
    writeFileSync(join(ctx.cwd, 'project.png'), png);
    expect(await read('project.png')).toMatchObject({ size: png.length, width: 1 });
    const allowed = join(dirname(ctx.cwd), 'allowed'); mkdirSync(allowed); writeFileSync(join(allowed, 'allowed.png'), png);
    expect(await read(join(allowed, 'allowed.png'), { imageAllowlist: [allowed] })).toHaveProperty('image');
  });

  it('rejects other Sessions, missing ownership, traversal and symlinked attachments without widening the instance allowlist', async () => {
    const { ctx, image, read } = fixture();
    const own = image(), other = image('other-session');
    expect(await read(other)).toMatchObject({ code: 'image_path_denied', errorEffect: 'none' });
    expect(await read(own, { sessionId: 'other-session' })).toHaveProperty('error');
    expect(await read(own, { sessionId: undefined })).toHaveProperty('error');
    expect(await read(own, { yeaftDir: undefined })).toHaveProperty('error');
    expect(await read(own.replace('/attachments/', '/attachments/../attachments/'))).toHaveProperty('error');
    const link = join(dirname(own), 'link.png'); symlinkSync(other, link);
    expect(await read(link)).toHaveProperty('error');
    symlinkSync(dirname(other), join(dirname(own), 'linked'));
    expect(await read(join(dirname(own), 'linked', 'pixel.png'))).toHaveProperty('error');
    expect(persistedAttachmentPreviewPayload({ path: other, isImage: true }, ctx)).toBeNull();
  });

  it('bounds attachment reads, rejects unsupported images and still handles missing project files', async () => {
    const { image, read } = fixture();
    const own = image();
    expect(await read(own, { maxImageBytes: png.length - 1 })).toMatchObject({ error: expect.stringMatching(/size limit/), code: 'image_attachment_unavailable' });
    expect(await read(own, { maxImageBytes: png.length })).toHaveProperty('image');
    expect(await read(image(undefined, 'pixel.txt'))).toMatchObject({ error: expect.stringMatching(/Unsupported image format/) });
    expect(await read('missing.png')).toMatchObject({ code: 'image_not_found', errorEffect: 'none' });
  });
});
