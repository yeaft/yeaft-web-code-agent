import { describe, expect, it, vi } from 'vitest';
import { previewFiles } from '../../server/context.js';
import { fallbackUploadName, registerUploadRoutes } from '../../server/routes/upload-routes.js';

describe('upload routes', () => {
  it('generates usable names for pasted clipboard images with empty multipart filenames', () => {
    const name = fallbackUploadName({ originalname: '', mimetype: 'image/png' }, 1);
    expect(name).toMatch(/^pasted-image-\d+-2\.png$/);
  });

  it('serves token previews with MIME sniffing disabled', () => {
    const routes = new Map();
    const app = {
      post: vi.fn(),
      get: vi.fn((path, handler) => routes.set(path, handler)),
    };
    registerUploadRoutes(app, { requireAuth: vi.fn() });
    previewFiles.set('preview-1', {
      buffer: Buffer.from('<script>alert(1)</script>'),
      mimeType: 'text/plain; charset=utf-8',
      filename: 'page.html',
      token: 'secret',
      createdAt: Date.now(),
    });
    const headers = {};
    const res = {
      setHeader: vi.fn((name, value) => { headers[name] = value; }),
      send: vi.fn(),
      status: vi.fn(() => res),
    };

    routes.get('/api/preview/:fileId')({ params: { fileId: 'preview-1' }, query: { token: 'secret' } }, res);

    expect(headers).toMatchObject({
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    expect(headers['Content-Disposition']).toBe('inline; filename="page.html"');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('<script>alert(1)</script>'));

    routes.get('/api/preview/:fileId')({
      params: { fileId: 'preview-1' },
      query: { token: 'secret', download: '1' },
    }, res);
    expect(headers['Content-Disposition']).toBe('attachment; filename="page.html"');
    previewFiles.delete('preview-1');
  });
});
