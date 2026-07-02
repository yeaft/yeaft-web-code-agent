import { describe, expect, it } from 'vitest';
import { fallbackUploadName } from '../../server/routes/upload-routes.js';

describe('upload routes', () => {
  it('keeps existing multipart filenames', () => {
    expect(fallbackUploadName({ originalname: 'screen.png', mimetype: 'image/png' }, 0)).toBe('screen.png');
  });

  it('generates usable names for pasted clipboard images with empty multipart filenames', () => {
    const name = fallbackUploadName({ originalname: '', mimetype: 'image/png' }, 1);
    expect(name).toMatch(/^pasted-image-\d+-2\.png$/);
  });
});
