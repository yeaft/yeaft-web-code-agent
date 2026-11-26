/**
 * Yeaft Cosmos — Tiered Astronomical Texture Loader & WebGL1/2 POT-Safe Uploader
 *
 * Strategy:
 * 1. Instant 0.1ms thematic 1x1 WebGL placeholders ensure Frame 1 paints immediately with
 *    ZERO startup procedural shader compilation or offscreen FBO stalls.
 * 2. Real NASA/ESO/Hubble/JWST WebP maps stream in three progressive tiers:
 *    - Tier 0 (Solar core, 11 maps): immediate
 *    - Tier 1 (Earth clouds/night + deep-sky nebulae, 4 maps): staggered after first paint
 *    - Tier 2 (Galaxy M51/disc + Cosmic Web, 3 maps): loaded lazily on idle or scale zoom
 * 3. Uses `img.decode()` for off-main-thread image decoding while remaining synchronously
 *    testable with mock Image constructors.
 */

export const COSMOS_TEXTURE_BASE = './assets/cosmos/';

export const COSMOS_TEXTURE_MANIFEST = Object.freeze([
  // Tier 0 — Solar System core bodies & rings (immediate)
  { key: 'sun',          file: 'sun.webp',              group: 'solar',  tier: 0, wrapS: true,  wrapT: false, noMipmap: true,  placeholder: [248, 176, 68, 255] },
  { key: 'mercury',      file: 'mercury.webp',          group: 'solar',  tier: 0, wrapS: true,  wrapT: false, noMipmap: true,  placeholder: [134, 130, 126, 255] },
  { key: 'venus',        file: 'venus.webp',            group: 'solar',  tier: 0, wrapS: true,  wrapT: false, noMipmap: true,  placeholder: [212, 166, 98, 255] },
  { key: 'earth_day',    file: 'earth_day.webp',        group: 'solar',  tier: 0, wrapS: true,  wrapT: false, noMipmap: true,  placeholder: [34, 96, 166, 255] },
  { key: 'mars',         file: 'mars.webp',             group: 'solar',  tier: 0, wrapS: true,  wrapT: false, noMipmap: true,  placeholder: [176, 86, 52, 255] },
  { key: 'jupiter',      file: 'jupiter.webp',          group: 'solar',  tier: 0, wrapS: true,  wrapT: false, noMipmap: true,  placeholder: [198, 162, 122, 255] },
  { key: 'saturn',       file: 'saturn.webp',           group: 'solar',  tier: 0, wrapS: true,  wrapT: false, noMipmap: true,  placeholder: [212, 188, 140, 255] },
  { key: 'saturn_ring',  file: 'saturn_ring.webp',      group: 'solar',  tier: 0, wrapS: false, wrapT: false, noMipmap: false, placeholder: [0, 0, 0, 0] },
  { key: 'uranus',       file: 'uranus.webp',           group: 'solar',  tier: 0, wrapS: true,  wrapT: false, noMipmap: true,  placeholder: [122, 206, 222, 255] },
  { key: 'neptune',      file: 'neptune.webp',          group: 'solar',  tier: 0, wrapS: true,  wrapT: false, noMipmap: true,  placeholder: [58, 108, 212, 255] },
  { key: 'milky',        file: 'eso_milky_way.webp',    group: 'solar',  tier: 0, wrapS: true,  wrapT: false, noMipmap: true,  placeholder: [4, 8, 18, 255] },

  // Tier 1 — Atmospheric layers & deep-sky nebulae (staggered gently after initial paint)
  { key: 'earth_night',  file: 'earth_night.webp',      group: 'solar',  tier: 1, wrapS: true,  wrapT: false, noMipmap: true,  placeholder: [0, 0, 0, 255] },
  { key: 'earth_clouds', file: 'earth_clouds.webp',     group: 'solar',  tier: 1, wrapS: true,  wrapT: false, noMipmap: true,  placeholder: [0, 0, 0, 255] },
  { key: 'nebula',       file: 'veil_nebula.webp',      group: 'solar',  tier: 1, wrapS: false, wrapT: false, noMipmap: true,  placeholder: [0, 0, 0, 255] },
  { key: 'deep',         file: 'webb_deep_field.webp',  group: 'solar',  tier: 1, wrapS: false, wrapT: false, noMipmap: true,  placeholder: [0, 0, 0, 255] },

  // Tier 2 — Outer cosmic scales (lazy-loaded on idle or when zooming toward 10^21 / 10^24 m)
  { key: 'galaxy',       file: 'galaxy_m51.webp',       group: 'galaxy', tier: 2, wrapS: false, wrapT: false, noMipmap: true,  placeholder: [0, 0, 0, 255] },
  { key: 'galaxy_disc',  file: 'galaxy_disc.webp',      group: 'galaxy', tier: 2, wrapS: false, wrapT: false, noMipmap: true,  placeholder: [0, 0, 0, 255] },
  { key: 'web',          file: 'cosmic_web_field.webp', group: 'web',    tier: 2, wrapS: false, wrapT: false, noMipmap: true,  placeholder: [0, 0, 0, 255] },
]);

export const COSMOS_TEXTURE_BY_KEY = Object.freeze(
  Object.fromEntries(COSMOS_TEXTURE_MANIFEST.map((m) => [m.key, m])),
);

const imageCache = new Map();

export function isPowerOf2(v) {
  return v > 0 && (v & (v - 1)) === 0;
}

/**
 * Upload a decoded HTMLImageElement or ImageBitmap into an existing WebGL texture
 * while respecting WebGL 1 NPOT constraints.
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
 * Create a 1x1 thematic placeholder WebGL texture in <0.02ms (zero shader/FBO work).
 */
export function createSolidPlaceholderTexture(gl, rgba = [0, 0, 0, 255], opts = {}) {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.wrapS ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.wrapT ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * Create instant 1x1 thematic placeholder textures for all 18 manifest entries.
 */
export function createPlaceholderTextureSet(gl) {
  const textures = {};
  for (const spec of COSMOS_TEXTURE_MANIFEST) {
    const tex = createSolidPlaceholderTexture(gl, spec.placeholder || [0, 0, 0, 255], spec);
    if (!tex) {
      for (const existing of Object.values(textures)) {
        if (existing) gl.deleteTexture(existing);
      }
      return null;
    }
    textures[spec.key] = tex;
  }
  return textures;
}

function requestEntries(entries, onReady, opts = {}) {
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
      const finishLoad = () => {
        if (record.status !== 'loading') return;
        record.status = 'loaded';
        record.img = img;
        const cbs = Array.from(record.listeners);
        record.listeners.clear();
        for (const cb of cbs) {
          try { cb(spec.key, img, spec); } catch { /* ignore listener errors */ }
        }
      };
      img.onload = () => {
        if (typeof img.decode === 'function') {
          img.decode().then(finishLoad, finishLoad);
        } else {
          finishLoad();
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

/**
 * Subscribe to a texture group ('solar' | 'galaxy' | 'web').
 * Returns an unsubscribe function so destroyed engines never receive late callbacks.
 */
export function requestCosmosTextureGroup(group, onReady, opts = {}) {
  const entries = COSMOS_TEXTURE_MANIFEST.filter((m) => m.group === group);
  return requestEntries(entries, onReady, opts);
}

/**
 * Subscribe to a progressive loading tier (`0` Solar core, `1` detail/nebula, `2` outer scales).
 */
export function requestCosmosTextureTier(tier, onReady, opts = {}) {
  const entries = COSMOS_TEXTURE_MANIFEST.filter((m) => m.tier === tier);
  return requestEntries(entries, onReady, opts);
}

/**
 * Subscribe to explicit manifest keys (e.g. on-demand nebula fetch when an event starts).
 */
export function requestCosmosTextureKeys(keys, onReady, opts = {}) {
  const entries = (Array.isArray(keys) ? keys : [])
    .map((k) => COSMOS_TEXTURE_BY_KEY[k])
    .filter(Boolean);
  return requestEntries(entries, onReady, opts);
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
