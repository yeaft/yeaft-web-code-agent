/**
 * Yeaft Cosmos — Non-Blocking WebGL2/WebGL Engine with Lazy Per-Event Shaders,
 * Parallel Shader Compilation, Tiered Off-Main-Thread Texture Streaming,
 * Pixel-Budgeted Adaptive Scaling, Context-Loss Recovery & 2D Fallback
 */
import { BG_VERT, BG_FRAG, PARTICLE_VERT, PARTICLE_FRAG } from './shaders-bg.js';
import { BODY_VERT, BODY_FRAG } from './shaders-bodies.js';
import { EVENT_VERT, getEventFrag } from './shaders-events.js';
import {
  COSMOS_TEXTURE_MANIFEST,
  requestCosmosTextureGroup,
  requestCosmosTextureTier,
  requestCosmosTextureKeys,
  getLoadedCosmosImage,
  uploadImageToWebGLTexture,
  createPlaceholderTextureSet,
} from './texture-loader.js';
import { createFallback2DEngine } from './fallback-2d-engine.js';

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return sh;
}

function startProgram(gl, vsSrc, fsSrc, primaryAttr = null) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const prog = gl.createProgram();
  if (!prog) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  if (primaryAttr && typeof gl.bindAttribLocation === 'function') {
    gl.bindAttribLocation(prog, 0, primaryAttr);
  }
  gl.linkProgram(prog);
  return { prog, vs, fs };
}

function finishProgram(gl, handle, label = 'Program') {
  if (!handle) return null;
  const { prog, vs, fs } = handle;
  const linked = gl.getProgramParameter(prog, gl.LINK_STATUS);
  if (!linked) {
    console.warn(`[Cosmos] ${label} link warning:`, gl.getProgramInfoLog?.(prog), gl.getShaderInfoLog?.(vs), gl.getShaderInfoLog?.(fs));
    gl.deleteProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

export function detectSoftwareRenderer(gl) {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
    return /swiftshader|llvmpipe|softpipe|software|mesa offscreen|basic render|google swiftshader/i.test(name);
  } catch {
    return false;
  }
}

export function detectMobileDevice() {
  if (typeof window === 'undefined') return false;
  const coarse = Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);
  const touch = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
  const minDim = Math.min(window.innerWidth || 1024, window.innerHeight || 1024);
  return coarse || (touch && minDim <= 900) || minDim < 600;
}

let cachedSoftwareProbe = null;

/** Reset cached software-GL probe (for isolated unit tests). */
export function __resetSoftwareProbeForTests() {
  cachedSoftwareProbe = null;
}

/**
 * Probe once per session whether browser WebGL is backed by a software CPU rasterizer
 * using a disposable 1x1 canvas so the real stage canvas remains free for Canvas 2D.
 */
function probeSoftwareWebGL() {
  if (cachedSoftwareProbe !== null) return cachedSoftwareProbe;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const pgl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!pgl) return false;
    const isSoft = detectSoftwareRenderer(pgl);
    try { pgl.getExtension('WEBGL_lose_context')?.loseContext?.(); } catch { /* ignore */ }
    cachedSoftwareProbe = isSoft;
    return isSoft;
  } catch {
    return false;
  }
}

export function createCosmosEngine(glCanvas, hudCanvas, opts = {}) {
  if (!glCanvas || !hudCanvas) return null;

  const renderQuality = opts.renderQuality === 'high' || opts.renderQuality === 'lite'
    ? opts.renderQuality
    : 'auto';
  const isMobile = typeof opts.isMobile === 'boolean' ? opts.isMobile : detectMobileDevice();

  // Explicit 2D Eco mode: skip WebGL completely so glCanvas stays available for Canvas 2D.
  if (renderQuality === 'lite') {
    return createFallback2DEngine(glCanvas, hudCanvas, { isMobile });
  }

  // In 'auto' mode, route software/CPU WebGL directly to our High-Craft 2D Cosmos Engine.
  if (renderQuality === 'auto' && probeSoftwareWebGL()) {
    return createFallback2DEngine(glCanvas, hudCanvas, { isMobile });
  }

  let gl = null;
  let isWebGL2 = false;
  try {
    const attrs = {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      powerPreference: isMobile ? 'default' : 'high-performance',
    };
    gl = glCanvas.getContext('webgl2', attrs);
    if (gl) {
      isWebGL2 = true;
    } else {
      gl = glCanvas.getContext('webgl', attrs);
    }
  } catch {
    gl = null;
  }

  const releaseUnusedGl = () => {
    if (!gl) return;
    try { gl.getExtension('WEBGL_lose_context')?.loseContext?.(); } catch { /* ignore */ }
  };

  const ctx2d = hudCanvas.getContext('2d');
  if (!gl || !ctx2d) {
    releaseUnusedGl();
    return createFallback2DEngine(glCanvas, hudCanvas, { isMobile });
  }

  const isSoftware = detectSoftwareRenderer(gl);
  if (renderQuality === 'auto' && isSoftware) {
    releaseUnusedGl();
    return createFallback2DEngine(glCanvas, hudCanvas, { isMobile });
  }

  let parallelExt = null;
  let pendingCore = null;
  let coreReady = false;
  let coreFailed = false;
  let fatalNotified = false;
  let contextGen = 0;
  let bgProg = null;
  let bodyProg = null;
  let ptProg = null;
  let sharedEventVert = null;
  let eventCache = Object.create(null); // eventType -> { prog, fs, loc, ready, failed }
  let quadBuf = null;
  let ptBuf = null;
  let textures = null;
  let bgLoc = null;
  let ptLoc = null;
  let bodyLoc = null;
  let contextLost = false;
  let destroyed = false;

  const requestedGroups = new Set();
  const requestedTiers = new Set();
  const requestedKeys = new Set();
  const textureUnsubs = [];
  const uploadedRealKeys = new Set();
  const queuedUploadKeys = new Set();
  const uploadQueue = []; // { key, source, spec, ownsBitmap, gen }
  const stageTimers = [];
  let idleHandle = 0;

  function notifyFatalError(reason) {
    if (fatalNotified || destroyed) return;
    fatalNotified = true;
    try { opts.onFatalError?.(reason); } catch { /* ignore callback errors */ }
  }

  function clearPendingUploadQueue() {
    while (uploadQueue.length) {
      const item = uploadQueue.shift();
      if (item?.ownsBitmap && typeof item.source?.close === 'function') {
        try { item.source.close(); } catch { /* ignore */ }
      }
    }
    queuedUploadKeys.clear();
  }

  function applyRealSourceImmediate(key, source, spec, ownsBitmap = false) {
    try {
      if (destroyed || contextLost || !textures || !textures[key] || gl.isContextLost?.()) {
        return false;
      }
      const ok = uploadImageToWebGLTexture(gl, textures[key], source, spec);
      if (ok) uploadedRealKeys.add(key);
      return ok;
    } catch (err) {
      console.warn('[Cosmos] Texture upload warning:', key, err?.message || err);
      return false;
    } finally {
      if (ownsBitmap && typeof source?.close === 'function') {
        try { source.close(); } catch { /* ignore */ }
      }
    }
  }

  function enqueueRealImage(key, img, spec) {
    if (destroyed || contextLost || !textures || !textures[key]) return;
    if (uploadedRealKeys.has(key) || queuedUploadKeys.has(key)) return;
    const gen = contextGen;
    queuedUploadKeys.add(key);
    const isDomImage = typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement;
    if (isDomImage && typeof createImageBitmap === 'function') {
      createImageBitmap(img).then((bmp) => {
        if (destroyed || contextLost || gen !== contextGen || uploadedRealKeys.has(key)) {
          if (gen === contextGen) queuedUploadKeys.delete(key);
          try { bmp.close(); } catch { /* ignore */ }
          return;
        }
        uploadQueue.push({ key, source: bmp, spec, ownsBitmap: true, gen });
      }, () => {
        if (destroyed || contextLost || gen !== contextGen || uploadedRealKeys.has(key)) {
          if (gen === contextGen) queuedUploadKeys.delete(key);
          return;
        }
        uploadQueue.push({ key, source: img, spec, ownsBitmap: false, gen });
      });
    } else {
      // Unit tests or environments without createImageBitmap
      uploadQueue.push({ key, source: img, spec, ownsBitmap: false, gen });
    }
  }

  function flushUploadQueue() {
    if (!uploadQueue.length || destroyed || contextLost || !textures || gl.isContextLost?.()) return;
    const budgetMs = 4.0;
    const maxPerFrame = 2;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    let done = 0;
    while (uploadQueue.length && done < maxPerFrame) {
      const item = uploadQueue.shift();
      queuedUploadKeys.delete(item.key);
      if (item.gen !== contextGen || uploadedRealKeys.has(item.key)) {
        if (item.ownsBitmap && typeof item.source?.close === 'function') {
          try { item.source.close(); } catch { /* ignore */ }
        }
        continue;
      }
      applyRealSourceImmediate(item.key, item.source, item.spec, item.ownsBitmap);
      done += 1;
      if (t0 && (performance.now() - t0) >= budgetMs) break;
    }
  }

  function requestTextureGroup(group) {
    if (destroyed || requestedGroups.has(group)) return;
    requestedGroups.add(group);
    const unsub = requestCosmosTextureGroup(group, (key, img, spec) => {
      enqueueRealImage(key, img, spec);
    });
    textureUnsubs.push(unsub);
  }

  function requestTextureTier(tier) {
    if (destroyed || requestedTiers.has(tier)) return;
    requestedTiers.add(tier);
    const unsub = requestCosmosTextureTier(tier, (key, img, spec) => {
      enqueueRealImage(key, img, spec);
    });
    textureUnsubs.push(unsub);
  }

  function ensureEventTextures() {
    if (destroyed || uploadedRealKeys.has('nebula') || requestedKeys.has('nebula')) return;
    requestedKeys.add('nebula');
    const unsub = requestCosmosTextureKeys(['nebula'], (key, img, spec) => {
      enqueueRealImage(key, img, spec);
    });
    textureUnsubs.push(unsub);
  }

  function reuploadCachedRealTextures() {
    for (const spec of COSMOS_TEXTURE_MANIFEST) {
      const img = getLoadedCosmosImage(spec.key);
      if (img) applyRealSourceImmediate(spec.key, img, spec, false);
    }
  }

  function ensureScaleTextures(scaleLog) {
    if (scaleLog > 16.0) requestTextureGroup('galaxy');
    if (scaleLog > 20.0) requestTextureGroup('web');
  }

  function queryCoreLocations() {
    bgLoc = {
      aPos: gl.getAttribLocation(bgProg, 'aPos'),
      uRes: gl.getUniformLocation(bgProg, 'uRes'),
      uTime: gl.getUniformLocation(bgProg, 'uTime'),
      uRealTime: gl.getUniformLocation(bgProg, 'uRealTime'),
      uScaleLog: gl.getUniformLocation(bgProg, 'uScaleLog'),
      uParallax: gl.getUniformLocation(bgProg, 'uParallax'),
      uCamRot: gl.getUniformLocation(bgProg, 'uCamRot'),
      uWarp: gl.getUniformLocation(bgProg, 'uWarp'),
      uFovZoom: gl.getUniformLocation(bgProg, 'uFovZoom'),
      uShockWave: gl.getUniformLocation(bgProg, 'uShockWave'),
      uEventLens: gl.getUniformLocation(bgProg, 'uEventLens'),
      uEventAmbient: gl.getUniformLocation(bgProg, 'uEventAmbient'),
      uSkyBright: gl.getUniformLocation(bgProg, 'uSkyBright'),
      uStarDensity: gl.getUniformLocation(bgProg, 'uStarDensity'),
      uQuality: gl.getUniformLocation(bgProg, 'uQuality'),
      uSkyTint: gl.getUniformLocation(bgProg, 'uSkyTint'),
      uSoarVec: gl.getUniformLocation(bgProg, 'uSoarVec'),
      uBhPos: gl.getUniformLocation(bgProg, 'uBhPos'),
      uBhRadius: gl.getUniformLocation(bgProg, 'uBhRadius'),
      uBhStrength: gl.getUniformLocation(bgProg, 'uBhStrength'),
      uGalPos: gl.getUniformLocation(bgProg, 'uGalPos'),
      uGalRadius: gl.getUniformLocation(bgProg, 'uGalRadius'),
      uGalAlpha: gl.getUniformLocation(bgProg, 'uGalAlpha'),
      uGalTilt: gl.getUniformLocation(bgProg, 'uGalTilt'),
      uWebPos: gl.getUniformLocation(bgProg, 'uWebPos'),
      uWebRadius: gl.getUniformLocation(bgProg, 'uWebRadius'),
      uWebAlpha: gl.getUniformLocation(bgProg, 'uWebAlpha'),
      uTexMilky: gl.getUniformLocation(bgProg, 'uTexMilky'),
      uTexNebula: gl.getUniformLocation(bgProg, 'uTexNebula'),
      uTexDeep: gl.getUniformLocation(bgProg, 'uTexDeep'),
      uTexGalaxy: gl.getUniformLocation(bgProg, 'uTexGalaxy'),
      uTexGalaxyDisc: gl.getUniformLocation(bgProg, 'uTexGalaxyDisc'),
      uTexWeb: gl.getUniformLocation(bgProg, 'uTexWeb'),
    };

    ptLoc = {
      aPosPx: gl.getAttribLocation(ptProg, 'aPosPx'),
      aSize: gl.getAttribLocation(ptProg, 'aSize'),
      aColor: gl.getAttribLocation(ptProg, 'aColor'),
      uRes: gl.getUniformLocation(ptProg, 'uRes'),
    };

    bodyLoc = {
      aCorner: gl.getAttribLocation(bodyProg, 'aCorner'),
      uRes: gl.getUniformLocation(bodyProg, 'uRes'),
      uCenterPx: gl.getUniformLocation(bodyProg, 'uCenterPx'),
      uQuadRadiusPx: gl.getUniformLocation(bodyProg, 'uQuadRadiusPx'),
      uBodyType: gl.getUniformLocation(bodyProg, 'uBodyType'),
      uRadiusRatio: gl.getUniformLocation(bodyProg, 'uRadiusRatio'),
      uRadiusPx: gl.getUniformLocation(bodyProg, 'uRadiusPx'),
      uCloseup: gl.getUniformLocation(bodyProg, 'uCloseup'),
      uPitch: gl.getUniformLocation(bodyProg, 'uPitch'),
      uTime: gl.getUniformLocation(bodyProg, 'uTime'),
      uRealTime: gl.getUniformLocation(bodyProg, 'uRealTime'),
      uSpin: gl.getUniformLocation(bodyProg, 'uSpin'),
      uTilt: gl.getUniformLocation(bodyProg, 'uTilt'),
      uOblate: gl.getUniformLocation(bodyProg, 'uOblate'),
      uLightDir: gl.getUniformLocation(bodyProg, 'uLightDir'),
      uAtmoColor: gl.getUniformLocation(bodyProg, 'uAtmoColor'),
      uAlpha: gl.getUniformLocation(bodyProg, 'uAlpha'),
      uHighlight: gl.getUniformLocation(bodyProg, 'uHighlight'),
      uMoonStyle: gl.getUniformLocation(bodyProg, 'uMoonStyle'),
      uTexMain: gl.getUniformLocation(bodyProg, 'uTexMain'),
      uTexNight: gl.getUniformLocation(bodyProg, 'uTexNight'),
      uTexClouds: gl.getUniformLocation(bodyProg, 'uTexClouds'),
      uTexRing: gl.getUniformLocation(bodyProg, 'uTexRing'),
    };
  }

  function finalizeCorePrograms({ notify = true } = {}) {
    if (coreReady) return true;
    if (coreFailed || !pendingCore) return false;
    if (parallelExt) {
      const done = gl.getProgramParameter(pendingCore.bg.prog, parallelExt.COMPLETION_STATUS_KHR)
        && gl.getProgramParameter(pendingCore.body.prog, parallelExt.COMPLETION_STATUS_KHR)
        && gl.getProgramParameter(pendingCore.pt.prog, parallelExt.COMPLETION_STATUS_KHR);
      if (!done) return false;
    }
    const nextBg = finishProgram(gl, pendingCore.bg, 'Background');
    const nextBody = finishProgram(gl, pendingCore.body, 'Body');
    const nextPt = finishProgram(gl, pendingCore.pt, 'Particle');
    pendingCore = null;
    if (!nextBg || !nextBody || !nextPt) {
      if (nextBg) gl.deleteProgram(nextBg);
      if (nextBody) gl.deleteProgram(nextBody);
      if (nextPt) gl.deleteProgram(nextPt);
      coreFailed = true;
      if (notify) notifyFatalError('shader_link_failed');
      return false;
    }
    bgProg = nextBg;
    bodyProg = nextBody;
    ptProg = nextPt;
    queryCoreLocations();
    coreReady = true;
    return true;
  }

  function getEventLocations(prog) {
    return {
      aCorner: gl.getAttribLocation(prog, 'aCorner'),
      uRes: gl.getUniformLocation(prog, 'uRes'),
      uCenterPx: gl.getUniformLocation(prog, 'uCenterPx'),
      uQuadRadiusPx: gl.getUniformLocation(prog, 'uQuadRadiusPx'),
      uEventRadiusPx: gl.getUniformLocation(prog, 'uEventRadiusPx'),
      uProgress: gl.getUniformLocation(prog, 'uProgress'),
      uElapsed: gl.getUniformLocation(prog, 'uElapsed'),
      uRealTime: gl.getUniformLocation(prog, 'uRealTime'),
      uAlpha: gl.getUniformLocation(prog, 'uAlpha'),
      uObsBlend: gl.getUniformLocation(prog, 'uObsBlend'),
      uDistNorm: gl.getUniformLocation(prog, 'uDistNorm'),
      uAngle: gl.getUniformLocation(prog, 'uAngle'),
      uSeed: gl.getUniformLocation(prog, 'uSeed'),
      uSunRadiusPx: gl.getUniformLocation(prog, 'uSunRadiusPx'),
      uViewAngles: gl.getUniformLocation(prog, 'uViewAngles'),
      uTexNebula: gl.getUniformLocation(prog, 'uTexNebula'),
      uTexSun: gl.getUniformLocation(prog, 'uTexSun'),
      uTexRock: gl.getUniformLocation(prog, 'uTexRock'),
    };
  }

  function ensureEventProgram(eventType) {
    if (destroyed || contextLost) return null;
    let entry = eventCache[eventType];
    if (!entry) {
      if (!sharedEventVert) {
        sharedEventVert = compileShader(gl, gl.VERTEX_SHADER, EVENT_VERT);
        if (!sharedEventVert) return null;
      }
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, getEventFrag(eventType));
      if (!fs) {
        eventCache[eventType] = { prog: null, fs: null, loc: null, ready: false, failed: true };
        return null;
      }
      const prog = gl.createProgram();
      if (!prog) {
        gl.deleteShader(fs);
        eventCache[eventType] = { prog: null, fs: null, loc: null, ready: false, failed: true };
        return null;
      }
      gl.attachShader(prog, sharedEventVert);
      gl.attachShader(prog, fs);
      if (typeof gl.bindAttribLocation === 'function') {
        gl.bindAttribLocation(prog, 0, 'aCorner');
      }
      gl.linkProgram(prog);
      entry = { prog, fs, loc: null, ready: false, failed: false };
      eventCache[eventType] = entry;
    }
    if (!entry.ready && !entry.failed) {
      finalizeEventProgram(entry);
    }
    return entry.ready ? entry : null;
  }

  function finalizeEventProgram(entry) {
    if (entry.ready || entry.failed) return entry.ready;
    if (parallelExt && !gl.getProgramParameter(entry.prog, parallelExt.COMPLETION_STATUS_KHR)) {
      return false;
    }
    if (!gl.getProgramParameter(entry.prog, gl.LINK_STATUS)) {
      console.warn('[Cosmos] Event shader link warning:', gl.getProgramInfoLog?.(entry.prog), gl.getShaderInfoLog?.(entry.fs));
      gl.deleteProgram(entry.prog);
      if (entry.fs) gl.deleteShader(entry.fs);
      entry.prog = null;
      entry.fs = null;
      entry.failed = true;
      return false;
    }
    if (entry.fs) {
      gl.deleteShader(entry.fs);
      entry.fs = null;
    }
    entry.loc = getEventLocations(entry.prog);
    entry.ready = true;
    return true;
  }

  function disposeEventPrograms() {
    try {
      for (const entry of Object.values(eventCache)) {
        if (entry?.prog) gl.deleteProgram(entry.prog);
        if (entry?.fs) gl.deleteShader(entry.fs);
      }
      if (sharedEventVert) gl.deleteShader(sharedEventVert);
    } catch { /* ignore if context lost */ }
    eventCache = Object.create(null);
    sharedEventVert = null;
  }

  function initGpuResources({ notifyOnFail = false } = {}) {
    contextGen += 1;
    parallelExt = gl.getExtension?.('KHR_parallel_shader_compile') || null;
    coreReady = false;
    coreFailed = false;
    fatalNotified = false;
    bgProg = null;
    bodyProg = null;
    ptProg = null;
    bgLoc = null;
    ptLoc = null;
    bodyLoc = null;
    eventCache = Object.create(null);
    sharedEventVert = null;

    // Kick off all 3 core programs in parallel so drivers compile them across worker threads.
    // Zero cosmic event shaders and zero procedural texture baker shaders compile at boot!
    const bgH = startProgram(gl, BG_VERT, BG_FRAG, 'aPos');
    const bodyH = startProgram(gl, BODY_VERT, BODY_FRAG, 'aCorner');
    const ptH = startProgram(gl, PARTICLE_VERT, PARTICLE_FRAG, 'aPosPx');
    if (!bgH || !bodyH || !ptH) {
      for (const h of [bgH, bodyH, ptH]) {
        if (!h) continue;
        gl.deleteProgram(h.prog);
        gl.deleteShader(h.vs);
        gl.deleteShader(h.fs);
      }
      if (notifyOnFail) {
        coreFailed = true;
        notifyFatalError('shader_init_failed');
      }
      return false;
    }
    pendingCore = { bg: bgH, body: bodyH, pt: ptH };

    // When KHR_parallel_shader_compile is unavailable, verify links synchronously now
    // (still after kicking off all 3 in parallel so multi-threaded drivers overlap them).
    if (!parallelExt && !finalizeCorePrograms({ notify: notifyOnFail })) {
      return false;
    }

    const nextQuadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nextQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    const nextPtBuf = gl.createBuffer();

    // Instant <0.1ms thematic 1x1 placeholders (zero procedural FBO startup stall).
    const nextTextures = createPlaceholderTextureSet(gl);
    if (!nextTextures) {
      gl.deleteBuffer(nextQuadBuf);
      gl.deleteBuffer(nextPtBuf);
      if (bgProg) { gl.deleteProgram(bgProg); bgProg = null; }
      if (bodyProg) { gl.deleteProgram(bodyProg); bodyProg = null; }
      if (ptProg) { gl.deleteProgram(ptProg); ptProg = null; }
      if (pendingCore) {
        for (const h of Object.values(pendingCore)) {
          gl.deleteProgram(h.prog);
          gl.deleteShader(h.vs);
          gl.deleteShader(h.fs);
        }
        pendingCore = null;
      }
      coreReady = false;
      if (notifyOnFail) {
        coreFailed = true;
        notifyFatalError('texture_init_failed');
      }
      return false;
    }

    quadBuf = nextQuadBuf;
    ptBuf = nextPtBuf;
    textures = nextTextures;
    uploadedRealKeys.clear();
    clearPendingUploadQueue();
    return true;
  }

  if (!initGpuResources()) {
    releaseUnusedGl();
    return createFallback2DEngine(glCanvas, hudCanvas, { isMobile });
  }
  reuploadCachedRealTextures();

  // Tier 0 (Solar core) starts right away; Tier 1 (clouds/night/nebula) & Tier 2 (galaxy/web portals)
  // stage gently after initial frames so opening Yeaft feels instantaneous and never stalls.
  requestTextureTier(0);
  stageTimers.push(setTimeout(() => {
    if (!destroyed) requestTextureTier(1);
  }, 140));
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    idleHandle = window.requestIdleCallback(() => {
      idleHandle = 0;
      if (!destroyed) requestTextureTier(2);
    }, { timeout: 700 });
  } else {
    stageTimers.push(setTimeout(() => {
      if (!destroyed) requestTextureTier(2);
    }, 450));
  }

  let width = 1;
  let height = 1;
  let dpr = 1;
  let glDpr = 1;
  let adaptiveScale = 1.0;
  let avgRenderMs = 8.0;
  let adaptiveCooldown = 0;
  const qualityFactor = (isMobile && renderQuality !== 'high') ? 0.65 : 1.0;

  function onContextLost(e) {
    e?.preventDefault?.();
    contextGen += 1;
    contextLost = true;
    coreReady = false;
    pendingCore = null;
    eventCache = Object.create(null);
    sharedEventVert = null;
    uploadedRealKeys.clear();
    clearPendingUploadQueue();
  }

  function onContextRestored() {
    if (destroyed) return;
    if (initGpuResources({ notifyOnFail: true })) {
      contextLost = false;
      reuploadCachedRealTextures();
      resize();
    }
  }

  function resize() {
    if (destroyed) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(glCanvas.clientWidth || window.innerWidth || 1, 1);
    height = Math.max(glCanvas.clientHeight || window.innerHeight || 1, 1);

    if (isSoftware) {
      glDpr = renderQuality === 'high' ? Math.min(dpr, 1.0) : 0.6;
    } else if (renderQuality === 'high') {
      const capDpr = Math.sqrt(4200000 / Math.max(width * height, 1));
      glDpr = Math.max(0.85, Math.min(dpr, capDpr));
    } else if (isMobile) {
      const capDpr = Math.sqrt(1100000 / Math.max(width * height, 1));
      glDpr = Math.max(0.75, Math.min(Math.min(dpr, 1.25), capDpr)) * adaptiveScale;
    } else {
      const capDpr = Math.sqrt(2200000 / Math.max(width * height, 1));
      glDpr = Math.max(0.75, Math.min(Math.min(dpr, 1.5), capDpr)) * adaptiveScale;
    }

    const gw = Math.max(1, Math.round(width * glDpr));
    const gh = Math.max(1, Math.round(height * glDpr));
    if (glCanvas.width !== gw || glCanvas.height !== gh) {
      glCanvas.width = gw;
      glCanvas.height = gh;
    }

    const hw = Math.max(1, Math.round(width * dpr));
    const hh = Math.max(1, Math.round(height * dpr));
    if (hudCanvas.width !== hw || hudCanvas.height !== hh) {
      hudCanvas.width = hw;
      hudCanvas.height = hh;
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resize();
  window.addEventListener('resize', resize);
  glCanvas.addEventListener('webglcontextlost', onContextLost, false);
  glCanvas.addEventListener('webglcontextrestored', onContextRestored, false);

  function bindTexUnit(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  function drawParticles(particleData, count) {
    if (!particleData || count <= 0) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(ptProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf);
    gl.bufferData(gl.ARRAY_BUFFER, particleData.subarray(0, count * 7), gl.DYNAMIC_DRAW);
    gl.uniform2f(ptLoc.uRes, glCanvas.width, glCanvas.height);

    const stride = 7 * 4;
    gl.enableVertexAttribArray(ptLoc.aPosPx);
    gl.vertexAttribPointer(ptLoc.aPosPx, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(ptLoc.aSize);
    gl.vertexAttribPointer(ptLoc.aSize, 1, gl.FLOAT, false, stride, 2 * 4);
    gl.enableVertexAttribArray(ptLoc.aColor);
    gl.vertexAttribPointer(ptLoc.aColor, 4, gl.FLOAT, false, stride, 3 * 4);

    gl.drawArrays(gl.POINTS, 0, count);
    gl.disableVertexAttribArray(ptLoc.aPosPx);
    gl.disableVertexAttribArray(ptLoc.aSize);
    gl.disableVertexAttribArray(ptLoc.aColor);
  }

  function drawCosmicEvent(ev, realTime) {
    if (!ev || ev.alpha <= 0.002) return false;
    ensureEventTextures();
    const entry = ensureEventProgram(ev.eventType);
    if (!entry) return false;
    const loc = entry.loc;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(entry.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(loc.aCorner);
    gl.vertexAttribPointer(loc.aCorner, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(loc.uRes, glCanvas.width, glCanvas.height);
    gl.uniform2f(loc.uCenterPx, ev.x * glDpr, ev.y * glDpr);
    gl.uniform1f(loc.uQuadRadiusPx, ev.quadRadiusPx * glDpr);
    gl.uniform1f(loc.uEventRadiusPx, ev.eventRadiusPx * glDpr);
    gl.uniform1f(loc.uProgress, ev.progress);
    gl.uniform1f(loc.uElapsed, ev.elapsed);
    gl.uniform1f(loc.uRealTime, realTime);
    gl.uniform1f(loc.uAlpha, ev.alpha);
    gl.uniform1f(loc.uObsBlend, ev.obsBlend);
    gl.uniform1f(loc.uDistNorm, ev.distNorm);
    gl.uniform1f(loc.uAngle, ev.angle);
    gl.uniform1f(loc.uSeed, ev.seed);
    gl.uniform1f(loc.uSunRadiusPx, (ev.sunRadiusPx || ev.eventRadiusPx * 0.24) * glDpr);
    if (loc.uViewAngles) gl.uniform2f(loc.uViewAngles, ev.viewYaw || 0, ev.viewPitch || 0);

    bindTexUnit(0, textures.nebula);
    bindTexUnit(1, textures.sun);
    bindTexUnit(2, textures.mars);
    gl.uniform1i(loc.uTexNebula, 0);
    gl.uniform1i(loc.uTexSun, 1);
    gl.uniform1i(loc.uTexRock, 2);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return true;
  }

  function renderFrame(frameState) {
    if (destroyed) return;
    if (contextLost || gl.isContextLost?.() || !textures) {
      ctx2d.clearRect(0, 0, width, height);
      if (frameState?.hudDraw) frameState.hudDraw(ctx2d, width, height, { eventRenderedInGL: false });
      return;
    }

    // Frame-budgeted GPU texture upload (max 2 per frame, <4ms budget, zero stutter bursts).
    flushUploadQueue();

    // Non-blocking poll for async parallel core shader compilation.
    if (!coreReady && !finalizeCorePrograms({ notify: true })) {
      if (destroyed) return;
      gl.viewport(0, 0, glCanvas.width, glCanvas.height);
      if (typeof gl.clearColor === 'function' && typeof gl.clear === 'function') {
        gl.clearColor(0.012, 0.024, 0.059, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      ctx2d.clearRect(0, 0, width, height);
      if (frameState?.hudDraw) frameState.hudDraw(ctx2d, width, height, { eventRenderedInGL: false });
      return;
    }

    const renderStart = typeof performance !== 'undefined' ? performance.now() : 0;

    const {
      time, realTime, scaleLog, parallax, camRot, warp, fovZoom, shockWave,
      eventLens, eventAmbient, skyTint, soarVec,
      skyBright, starDensity, bhParams, galParams, webParams,
      particleData, particleCount,
      eventDraw, eventDraws, eventParticleData, eventParticleCount,
      solarBodies, solarAlpha, hudDraw,
    } = frameState;

    ensureScaleTextures(scaleLog);

    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    gl.disable(gl.BLEND);

    gl.useProgram(bgProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(bgLoc.aPos);
    gl.vertexAttribPointer(bgLoc.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(bgLoc.uRes, glCanvas.width, glCanvas.height);
    gl.uniform1f(bgLoc.uTime, time);
    gl.uniform1f(bgLoc.uRealTime, realTime);
    gl.uniform1f(bgLoc.uScaleLog, scaleLog);
    gl.uniform2f(bgLoc.uParallax, parallax.x, parallax.y);
    gl.uniform2f(bgLoc.uCamRot, camRot.x, camRot.y);
    gl.uniform1f(bgLoc.uWarp, warp || 0);
    gl.uniform1f(bgLoc.uFovZoom, fovZoom || 1.0);
    const sw = shockWave || [0, 0, 0, 0];
    gl.uniform4f(bgLoc.uShockWave, sw[0], sw[1], sw[2], sw[3]);
    const el = eventLens || [0, 0, 0, 0];
    gl.uniform4f(bgLoc.uEventLens, el[0], el[1], el[2], el[3]);
    const ea = eventAmbient || [0, 0, 0, 0];
    gl.uniform4f(bgLoc.uEventAmbient, ea[0], ea[1], ea[2], ea[3]);
    gl.uniform1f(bgLoc.uSkyBright, skyBright);
    gl.uniform1f(bgLoc.uStarDensity, starDensity);
    gl.uniform1f(bgLoc.uQuality, qualityFactor);
    const stCol = skyTint || [1.0, 1.0, 1.0];
    if (bgLoc.uSkyTint) gl.uniform3f(bgLoc.uSkyTint, stCol[0], stCol[1], stCol[2]);
    const sv = soarVec || [0.0, 0.0, 0.0];
    if (bgLoc.uSoarVec) gl.uniform3f(bgLoc.uSoarVec, sv[0], sv[1], sv[2]);

    gl.uniform2f(bgLoc.uBhPos, bhParams.x, bhParams.y);
    gl.uniform1f(bgLoc.uBhRadius, bhParams.radius);
    gl.uniform1f(bgLoc.uBhStrength, bhParams.strength);

    gl.uniform2f(bgLoc.uGalPos, galParams.x, galParams.y);
    gl.uniform1f(bgLoc.uGalRadius, galParams.radius);
    gl.uniform1f(bgLoc.uGalAlpha, galParams.alpha);
    gl.uniform1f(bgLoc.uGalTilt, galParams.tilt);

    gl.uniform2f(bgLoc.uWebPos, webParams.x, webParams.y);
    gl.uniform1f(bgLoc.uWebRadius, webParams.radius);
    gl.uniform1f(bgLoc.uWebAlpha, webParams.alpha);

    bindTexUnit(0, textures.milky);
    bindTexUnit(1, textures.nebula);
    bindTexUnit(2, textures.deep);
    bindTexUnit(3, textures.galaxy);
    bindTexUnit(4, textures.galaxy_disc);
    bindTexUnit(5, textures.web);
    gl.uniform1i(bgLoc.uTexMilky, 0);
    gl.uniform1i(bgLoc.uTexNebula, 1);
    gl.uniform1i(bgLoc.uTexDeep, 2);
    gl.uniform1i(bgLoc.uTexGalaxy, 3);
    gl.uniform1i(bgLoc.uTexGalaxyDisc, 4);
    gl.uniform1i(bgLoc.uTexWeb, 5);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Deep-space cosmic events render BEHIND Solar System planets for authentic 3D occlusion.
    const allEvents = Array.isArray(eventDraws) ? eventDraws : (eventDraw ? [eventDraw] : []);
    const deepEvents = [];
    const localEvents = [];
    for (let i = 0; i < allEvents.length; i++) {
      const ev = allEvents[i];
      if (!ev || ev.alpha <= 0.002) continue;
      if (ev.layer === 'local') localEvents.push(ev);
      else deepEvents.push(ev);
    }

    let eventRenderedInGL = false;
    const renderedEventUids = new Set();
    let renderedDeepCount = 0;
    for (let i = 0; i < deepEvents.length; i++) {
      if (drawCosmicEvent(deepEvents[i], realTime)) {
        eventRenderedInGL = true;
        renderedDeepCount += 1;
        renderedEventUids.add(deepEvents[i].uid || deepEvents[i].id);
      }
    }
    if (renderedDeepCount > 0 && localEvents.length === 0) {
      drawParticles(eventParticleData, eventParticleCount);
    }

    drawParticles(particleData, particleCount);

    if (solarAlpha > 0.004 && solarBodies.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(bodyProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(bodyLoc.aCorner);
      gl.vertexAttribPointer(bodyLoc.aCorner, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(bodyLoc.uRes, glCanvas.width, glCanvas.height);
      gl.uniform1f(bodyLoc.uTime, time);
      gl.uniform1f(bodyLoc.uRealTime, realTime);

      bindTexUnit(1, textures.earth_night);
      bindTexUnit(2, textures.earth_clouds);
      bindTexUnit(3, textures.saturn_ring);
      gl.uniform1i(bodyLoc.uTexMain, 0);
      gl.uniform1i(bodyLoc.uTexNight, 1);
      gl.uniform1i(bodyLoc.uTexClouds, 2);
      gl.uniform1i(bodyLoc.uTexRing, 3);

      const sorted = solarBodies.slice().sort((a, b) => a.camZ - b.camZ);
      for (let i = 0; i < sorted.length; i++) {
        const b = sorted[i];
        const pad = b.bodyType === 0 ? 3.85 : (b.bodyType === 6 ? 2.65 : (b.bodyType === 7 ? 2.02 : (b.bodyType === 9 ? 1.28 : 1.36)));
        const rPxGl = b.radiusPx * glDpr;
        gl.uniform2f(bodyLoc.uCenterPx, b.screenX * glDpr, b.screenY * glDpr);
        gl.uniform1f(bodyLoc.uQuadRadiusPx, rPxGl * pad);
        gl.uniform1i(bodyLoc.uBodyType, b.bodyType);
        gl.uniform1f(bodyLoc.uRadiusRatio, 1.0 / pad);
        if (bodyLoc.uRadiusPx) gl.uniform1f(bodyLoc.uRadiusPx, rPxGl);
        if (bodyLoc.uCloseup) gl.uniform1f(bodyLoc.uCloseup, b.closeup || 0.0);
        if (bodyLoc.uPitch) gl.uniform1f(bodyLoc.uPitch, b.pitch || 0.0);
        gl.uniform1f(bodyLoc.uSpin, b.spin);
        gl.uniform1f(bodyLoc.uTilt, b.tilt);
        gl.uniform1f(bodyLoc.uOblate, b.oblate);
        gl.uniform3f(bodyLoc.uLightDir, b.lightDir[0], b.lightDir[1], b.lightDir[2]);
        gl.uniform3f(bodyLoc.uAtmoColor, b.atmo[0], b.atmo[1], b.atmo[2]);
        gl.uniform1f(bodyLoc.uAlpha, solarAlpha * (b.alphaMul != null ? b.alphaMul : 1.0));
        gl.uniform1f(bodyLoc.uHighlight, b.highlight || 0.0);
        if (bodyLoc.uMoonStyle) gl.uniform1f(bodyLoc.uMoonStyle, b.moonStyle || 0.0);

        bindTexUnit(0, textures[b.texKey] || textures.earth_day);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    // Local / focused cosmic events render cleanly in front of Solar System bodies.
    let renderedLocalCount = 0;
    for (let i = 0; i < localEvents.length; i++) {
      if (drawCosmicEvent(localEvents[i], realTime)) {
        eventRenderedInGL = true;
        renderedLocalCount += 1;
        renderedEventUids.add(localEvents[i].uid || localEvents[i].id);
      }
    }
    if (renderedLocalCount > 0 || (renderedDeepCount > 0 && localEvents.length > 0)) {
      drawParticles(eventParticleData, eventParticleCount);
    }

    ctx2d.clearRect(0, 0, width, height);
    if (hudDraw) {
      hudDraw(
        ctx2d,
        width,
        height,
        Array.isArray(eventDraws) ? { eventRenderedInGL, renderedEventUids } : { eventRenderedInGL },
      );
    }

    // Measure actual render cost (not intentional sleep intervals on mobile) and apply any
    // adaptive resolution resize AFTER the frame completes so particle glDpr stays in sync.
    if (renderQuality === 'auto' && !isSoftware && renderStart > 0) {
      const renderMs = Math.min(120, performance.now() - renderStart);
      avgRenderMs = avgRenderMs * 0.90 + renderMs * 0.10;
      if (adaptiveCooldown > 0) {
        adaptiveCooldown -= 1;
      } else if (avgRenderMs > 28 && adaptiveScale > 0.74) {
        adaptiveScale = Math.max(0.72, adaptiveScale - 0.08);
        avgRenderMs = 14;
        adaptiveCooldown = 25;
        resize();
      } else if (avgRenderMs < 10 && adaptiveScale < 1.0) {
        adaptiveScale = Math.min(1.0, adaptiveScale + 0.05);
        avgRenderMs = 14;
        adaptiveCooldown = 35;
        resize();
      }
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const id of stageTimers) clearTimeout(id);
    stageTimers.length = 0;
    if (idleHandle && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleHandle);
      idleHandle = 0;
    }
    for (const off of textureUnsubs) off();
    textureUnsubs.length = 0;
    clearPendingUploadQueue();
    window.removeEventListener('resize', resize);
    glCanvas.removeEventListener('webglcontextlost', onContextLost, false);
    glCanvas.removeEventListener('webglcontextrestored', onContextRestored, false);
    if (contextLost || gl.isContextLost?.()) return;
    try {
      disposeEventPrograms();
      if (pendingCore) {
        for (const h of Object.values(pendingCore)) {
          gl.deleteProgram(h.prog);
          gl.deleteShader(h.vs);
          gl.deleteShader(h.fs);
        }
        pendingCore = null;
      }
      if (textures) {
        for (const tex of Object.values(textures)) {
          if (tex) gl.deleteTexture(tex);
        }
      }
      if (quadBuf) gl.deleteBuffer(quadBuf);
      if (ptBuf) gl.deleteBuffer(ptBuf);
      if (bgProg) gl.deleteProgram(bgProg);
      if (bodyProg) gl.deleteProgram(bodyProg);
      if (ptProg) gl.deleteProgram(ptProg);
    } catch { /* context already lost */ }
  }

  return {
    mode: isWebGL2 ? 'webgl2' : 'webgl',
    isWebGL: true,
    isSoftware,
    isMobile,
    renderFrame,
    resize,
    ensureScaleTextures,
    getSize: () => ({ width, height, dpr: glDpr, hudDpr: dpr }),
    areTexturesReady: () => true,
    areRealTexturesReady: () => uploadedRealKeys.has('earth_day') && uploadedRealKeys.has('milky'),
    isFailed: () => coreFailed,
    getCompiledEventShaderCount: () => Object.values(eventCache).filter((e) => e?.ready).length,
    destroy,
  };
}
