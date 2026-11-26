/**
 * Yeaft Cosmos — Cached Astronomical Texture Loader & WebGL1/2 POT-Safe Uploader
 *
 * Strategy:
 * 1. GPU procedural textures render instantaneously (0ms wait) on mount.
 * 2. Real NASA/ESO/Hubble/JWST WebP maps (~838 KB for Solar, cached 1 year) load
 *    asynchronously and seamlessly hot-swap into active WebGL textures AND the
 *    high-craft 2D no-GPU fallback renderer.
 * 3. Galaxy (M51 + disc) and Cosmic Web maps load lazily only when the user
 *    zooms toward those cosmic scales.
 */

export const COSMOS_TEXTURE_BASE = './assets/cosmos/';

export const COSMOS_TEXTURE_MANIFEST = Object.freeze([
  // Solar bodies & rings (eager on Solar System)
  { key: 'sun',          file: 'sun.webp',              group: 'solar',  wrapS: true,  wrapT: false, noMipmap: true },
  { key: 'mercury',      file: 'mercury.webp',          group: 'solar',  wrapS: true,  wrapT: false, noMipmap: true },
  { key: 'venus',        file: 'venus.webp',            group: 'solar',  wrapS: true,  wrapT: false, noMipmap: true },
  { key: 'earth_day',    file: 'earth_day.webp',        group: 'solar',  wrapS: true,  wrapT: false, noMipmap: true },
  { key: 'earth_night',  file: 'earth_night.webp',      group: 'solar',  wrapS: true,  wrapT: false, noMipmap: true },
  { key: 'earth_clouds', file: 'earth_clouds.webp',     group: 'solar',  wrapS: true,  wrapT: false, noMipmap: true },
  { key: 'mars',         file: 'mars.webp',             group: 'solar',  wrapS: true,  wrapT: false, noMipmap: true },
  { key: 'jupiter',      file: 'jupiter.webp',          group: 'solar',  wrapS: true,  wrapT: false, noMipmap: true },
  { key: 'saturn',       file: 'saturn.webp',           group: 'solar',  wrapS: true,  wrapT: false, noMipmap: true },
  { key: 'saturn_ring',  file: 'saturn_ring.webp',      group: 'solar',  wrapS: false, wrapT: false, noMipmap: false },
  { key: 'uranus',       file: 'uranus.webp',           group: 'solar',  wrapS: true,  wrapT: false, noMipmap: true },
  { key: 'neptune',      file: 'neptune.webp',          group: 'solar',  wrapS: true,  wrapT: false, noMipmap: true },

  // Solar deep-space skybox (eager on Solar System)
  { key: 'milky',        file: 'eso_milky_way.webp',    group: 'solar',  wrapS: true,  wrapT: false, noMipmap: true },
  { key: 'nebula',       file: 'veil_nebula.webp',      group: 'solar',  wrapS: false, wrapT: false, noMipmap: true },
  { key: 'deep',         file: 'webb_deep_field.webp',  group: 'solar',  wrapS: false, wrapT: false, noMipmap: false },

  // Galaxy scale (lazy-loaded when zooming near 10^21 m)
  { key: 'galaxy',       file: 'galaxy_m51.webp',       group: 'galaxy', wrapS: false, wrapT: false, noMipmap: true },
  { key: 'galaxy_disc',  file: 'galaxy_disc.webp',      group: 'galaxy', wrapS: false, wrapT: false, noMipmap: false },

  // Cosmic Web scale (lazy-loaded when zooming near 10^24 m)
  { key: 'web',          file: 'cosmic_web_field.webp', group: 'web',    wrapS: false, wrapT: false, noMipmap: false },
]);

export const COSMOS_TEXTURE_BY_KEY = Object.freeze(
  Object.fromEntries(COSMOS_TEXTURE_MANIFEST.map((m) => [m.key, m])),
);

const imageCache = new Map();

export function isPowerOf2(v) {
  return v > 0 && (v & (v - 1)) === 0;
}

/**
 * Upload a decoded HTMLImageElement into an existing WebGL texture while respecting
 * WebGL 1 NPOT constraints (never sets REPEAT or generateMipmap on NPOT WebGL 1 textures).
 */
export function uploadImageToWebGLTexture(gl, tex, img, opts = {}) {
  if (!gl || !tex || !img) return false;
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  if (w <= 0 || h <= 0) return false;

  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const pot = isPowerOf2(w) && isPowerOf2(h);
  const allowRepeat = isWebGL2 || pot;
  const canMip = !opts.noMipmap && (isWebGL2 || pot);

  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (typeof gl.pixelStorei === 'function' && gl.UNPACK_FLIP_Y_WEBGL !== undefined) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

  if (canMip && typeof gl.generateMipmap === 'function') {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, (opts.wrapS && allowRepeat) ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, (opts.wrapT && allowRepeat) ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  return true;
}

/**
 * Create a 1x1 dark placeholder WebGL texture (for optional additive backdrop layers
 * like Veil Nebula & JWST Deep Field before their real images finish decoding).
 */
export function createSolidPlaceholderTexture(gl, rgba = [0, 0, 0, 255]) {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * Subscribe to a texture group ('solar' | 'galaxy' | 'web').
 * Returns an unsubscribe function so destroyed engines never receive late callbacks.
 */
export function requestCosmosTextureGroup(group, onReady, opts = {}) {
  const entries = COSMOS_TEXTURE_MANIFEST.filter((m) => m.group === group);
  const baseUrl = opts.baseUrl ?? COSMOS_TEXTURE_BASE;
  const ImageCtor = opts.ImageCtor || (typeof Image !== 'undefined' ? Image : null);
  const unsubs = [];

  for (const spec of entries) {
    let record = imageCache.get(spec.key);
    if (record?.status === 'loaded' && record.img) {
      if (typeof onReady === 'function') onReady(spec.key, record.img, spec);
      continue;
    }
    if (record?.status === 'error') {
      continue;
    }
    if (!record) {
      if (!ImageCtor) continue;
      record = { status: 'loading', img: null, listeners: new Set() };
      imageCache.set(spec.key, record);

      const img = new ImageCtor();
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        record.status = 'loaded';
        record.img = img;
        const cbs = Array.from(record.listeners);
        record.listeners.clear();
        for (const cb of cbs) {
          try { cb(spec.key, img, spec); } catch { /* ignore listener errors */ }
        }
      };
      img.onerror = () => {
        record.status = 'error';
        record.img = null;
        record.listeners.clear();
      };
      img.src = `${baseUrl}${spec.file}`;
    }

    if (typeof onReady === 'function') {
      record.listeners.add(onReady);
      unsubs.push(() => record.listeners.delete(onReady));
    }
  }

  return () => {
    for (const off of unsubs) off();
  };
}

/** Synchronous access to already-decoded astronomical images (used by 2D engine & GL restore). */
export function getLoadedCosmosImage(key) {
  const record = imageCache.get(key);
  return (record?.status === 'loaded' && record.img) ? record.img : null;
}

export function isCosmosTextureGroupLoaded(group) {
  const entries = COSMOS_TEXTURE_MANIFEST.filter((m) => m.group === group);
  return entries.every((spec) => imageCache.get(spec.key)?.status === 'loaded');
}

/** Reset cache (for isolated unit tests). */
export function __resetCosmosTextureCacheForTests() {
  imageCache.clear();
}
