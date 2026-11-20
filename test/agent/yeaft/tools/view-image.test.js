import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import viewImage from '../../../../agent/yeaft/tools/view-image.js';
import { persistedAttachmentPreviewPayload } from '../../../../agent/yeaft/attachments.js';
import { imageDimensionsFromBase64 } from '../../../../agent/yeaft/image-dimensions.js';
import { estimateContentPartTokens } from '../../../../agent/yeaft/history-window.js';

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
  it('reads owned images at their exact size and rejects other Sessions, missing ownership, traversal and symlinked attachments without widening the instance allowlist', async () => {
    const { ctx, image, read } = fixture();
    const own = image(), other = image('other-session');
    expect(await read(own)).toMatchObject({ media_type: 'image/png', width: 1, height: 1 });
    // An EXIF thumbnail's frame header inside APP1 must not stand in for the photo's own.
    const photo = image(ctx.sessionId, 'photo.jpg');
    const jpeg = Buffer.from([
      0xFF, 0xD8,
      0xFF, 0xE1, 0x00, 0x0B, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10,
      0xFF, 0xC0, 0x00, 0x11, 0x08, 0x01, 0xE0, 0x02, 0x80, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
      0xFF, 0xD9,
    ]);
    writeFileSync(photo, jpeg);
    expect(await read(photo)).toMatchObject({ media_type: 'image/jpeg', width: 640, height: 480 });
    // The context budget reads the same headers straight from base64, at byte
    // offsets that are not 3-aligned (PNG 16, JPEG 17/20), never decoding it all.
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUInt32LE(10, 16); webp.writeUIntLE(1907, 24, 3); webp.writeUIntLE(857, 27, 3);
    expect([png, jpeg, webp].map(bytes => imageDimensionsFromBase64(bytes.toString('base64')))).toEqual([
      { width: 1, height: 1 }, { width: 640, height: 480 }, { width: 1908, height: 858 },
    ]);
    // Non-canonical base64 is refused up front, even where no header read would see it.
    const jpegBase64 = jpeg.toString('base64');
    expect(imageDimensionsFromBase64(`${jpegBase64.slice(0, 40)}\n\n\n\n${jpegBase64.slice(40)}`)).toBeNull();
    expect(imageDimensionsFromBase64(`${jpegBase64}A`)).toBeNull();
    // An inline data URL is image bytes, not text: a 1x1 image costs the per-image minimum.
    expect(estimateContentPartTokens({ type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` })).toBe(1024);
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

});
