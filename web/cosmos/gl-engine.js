/**
 * Yeaft Cosmos — WebGL2/WebGL Renderer Engine with Real NASA/ESO Hot-Swap,
 * Mobile Thermal Scaling, Context-Loss Recovery & High-Craft 2D No-GPU Fallback
 */
import { BG_VERT, BG_FRAG, PARTICLE_VERT, PARTICLE_FRAG } from './shaders-bg.js';
import { BODY_VERT, BODY_FRAG } from './shaders-bodies.js';
import { bakeProceduralWebGLTextures } from './gpu-texture-baker.js';
import {
  COSMOS_TEXTURE_MANIFEST,
  requestCosmosTextureGroup,
  getLoadedCosmosImage,
  uploadImageToWebGLTexture,
  createSolidPlaceholderTexture,
} from './texture-loader.js';
import { createFallback2DEngine } from './fallback-2d-engine.js';

function createShader(gl, type, src) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[Cosmos] Shader compile warning:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[Cosmos] Program link warning:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
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

/**
 * Probe whether browser WebGL is backed by a software CPU rasterizer using a
 * disposable 1x1 canvas so the real stage canvas remains free for Canvas 2D.
 */
function probeSoftwareWebGL() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const pgl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!pgl) return false;
    const isSoft = detectSoftwareRenderer(pgl);
    try { pgl.getExtension('WEBGL_lose_context')?.loseContext?.(); } catch { /* ignore */ }
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

  // In 'auto' mode, route software/CPU WebGL directly to our High-Craft 2D Cosmos Engine
  // (sharp native DPR, real NASA/ESO imagery, low CPU) instead of blurry 0.5x CPU shaders.
  if (renderQuality === 'auto' && probeSoftwareWebGL()) {
    return createFallback2DEngine(glCanvas, hudCanvas, { isMobile });
  }

  let gl = null;
  let isWebGL2 = false;
  try {
    const attrs = {
      alpha: false,
      antialias: !isMobile,
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

  const ctx2d = hudCanvas.getContext('2d');
  if (!gl || !ctx2d) {
    return createFallback2DEngine(glCanvas, hudCanvas, { isMobile });
  }

  const isSoftware = detectSoftwareRenderer(gl);
  if (renderQuality === 'auto' && isSoftware) {
    return createFallback2DEngine(glCanvas, hudCanvas, { isMobile });
  }

  let bgProg = null;
  let bodyProg = null;
  let ptProg = null;
  let quadBuf = null;
  let ptBuf = null;
  let textures = null;
  let bgLoc = null;
  let ptLoc = null;
  let bodyLoc = null;
  let contextLost = false;
  let destroyed = false;

  const requestedGroups = new Set();
  const textureUnsubs = [];
  const uploadedRealKeys = new Set();

  function applyRealImage(key, img, spec) {
    if (destroyed || contextLost || !textures || !textures[key] || gl.isContextLost?.()) return;
    if (uploadImageToWebGLTexture(gl, textures[key], img, spec)) {
      uploadedRealKeys.add(key);
    }
  }

  function requestTextureGroup(group) {
    if (destroyed || requestedGroups.has(group)) return;
    requestedGroups.add(group);
    const unsub = requestCosmosTextureGroup(group, (key, img, spec) => {
      applyRealImage(key, img, spec);
    });
    textureUnsubs.push(unsub);
  }

  function reuploadCachedRealTextures() {
    for (const spec of COSMOS_TEXTURE_MANIFEST) {
      const img = getLoadedCosmosImage(spec.key);
      if (img) applyRealImage(spec.key, img, spec);
    }
  }

  function ensureScaleTextures(scaleLog) {
    if (scaleLog > 16.0) requestTextureGroup('galaxy');
    if (scaleLog > 20.0) requestTextureGroup('web');
  }

  function initGpuResources() {
    const nextBgProg = createProgram(gl, BG_VERT, BG_FRAG);
    const nextBodyProg = createProgram(gl, BODY_VERT, BODY_FRAG);
    const nextPtProg = createProgram(gl, PARTICLE_VERT, PARTICLE_FRAG);
    if (!nextBgProg || !nextBodyProg || !nextPtProg) {
      if (nextBgProg) gl.deleteProgram(nextBgProg);
      if (nextBodyProg) gl.deleteProgram(nextBodyProg);
      if (nextPtProg) gl.deleteProgram(nextPtProg);
      return false;
    }

    const nextQuadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nextQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    const nextPtBuf = gl.createBuffer();

    // Instant 0ms GPU procedural placeholder bake (~20ms) so first frame is never blank.
    const bakeScale = isSoftware ? 0.5 : (isMobile ? 0.75 : 1.0);
    const nextTextures = bakeProceduralWebGLTextures(gl, nextQuadBuf, bakeScale);
    if (!nextTextures) {
      gl.deleteBuffer(nextQuadBuf);
      gl.deleteBuffer(nextPtBuf);
      gl.deleteProgram(nextBgProg);
      gl.deleteProgram(nextBodyProg);
      gl.deleteProgram(nextPtProg);
      return false;
    }

    // Create 1x1 black placeholder slots for additive deep-space & galaxy layers until WebPs land.
    nextTextures.nebula = createSolidPlaceholderTexture(gl, [0, 0, 0, 255]);
    nextTextures.deep = createSolidPlaceholderTexture(gl, [0, 0, 0, 255]);
    nextTextures.galaxy_disc = createSolidPlaceholderTexture(gl, [0, 0, 0, 255]);

    bgProg = nextBgProg;
    bodyProg = nextBodyProg;
    ptProg = nextPtProg;
    quadBuf = nextQuadBuf;
    ptBuf = nextPtBuf;
    textures = nextTextures;

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
      uSkyBright: gl.getUniformLocation(bgProg, 'uSkyBright'),
      uStarDensity: gl.getUniformLocation(bgProg, 'uStarDensity'),
      uQuality: gl.getUniformLocation(bgProg, 'uQuality'),
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
      uTime: gl.getUniformLocation(bodyProg, 'uTime'),
      uRealTime: gl.getUniformLocation(bodyProg, 'uRealTime'),
      uSpin: gl.getUniformLocation(bodyProg, 'uSpin'),
      uTilt: gl.getUniformLocation(bodyProg, 'uTilt'),
      uOblate: gl.getUniformLocation(bodyProg, 'uOblate'),
      uLightDir: gl.getUniformLocation(bodyProg, 'uLightDir'),
      uAtmoColor: gl.getUniformLocation(bodyProg, 'uAtmoColor'),
      uAlpha: gl.getUniformLocation(bodyProg, 'uAlpha'),
      uHighlight: gl.getUniformLocation(bodyProg, 'uHighlight'),
      uTexMain: gl.getUniformLocation(bodyProg, 'uTexMain'),
      uTexNight: gl.getUniformLocation(bodyProg, 'uTexNight'),
      uTexClouds: gl.getUniformLocation(bodyProg, 'uTexClouds'),
      uTexRing: gl.getUniformLocation(bodyProg, 'uTexRing'),
    };

    reuploadCachedRealTextures();
    return true;
  }

  if (!initGpuResources()) {
    return createFallback2DEngine(glCanvas, hudCanvas, { isMobile });
  }

  // Stream photorealistic Solar NASA/ESO/Hubble/JWST maps asynchronously and hot-swap seamlessly.
  requestTextureGroup('solar');

  let width = 1;
  let height = 1;
  let dpr = 1;
  let glDpr = 1;
  const qualityFactor = (isMobile && renderQuality !== 'high') ? 0.65 : 1.0;

  function onContextLost(e) {
    e?.preventDefault?.();
    contextLost = true;
  }

  function onContextRestored() {
    if (destroyed) return;
    if (initGpuResources()) {
      contextLost = false;
      resize();
    }
  }

  function resize() {
    if (destroyed) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Keep 2D HUD crisp at full DPR; scale mobile WebGL pixel fill cleanly to save battery.
    if (isSoftware) {
      glDpr = renderQuality === 'high' ? Math.min(dpr, 1.0) : 0.6;
    } else if (isMobile && renderQuality !== 'high') {
      glDpr = Math.min(dpr, 1.35);
    } else {
      glDpr = dpr;
    }
    width = Math.max(glCanvas.clientWidth || window.innerWidth || 1, 1);
    height = Math.max(glCanvas.clientHeight || window.innerHeight || 1, 1);
    glCanvas.width = Math.max(1, Math.round(width * glDpr));
    glCanvas.height = Math.max(1, Math.round(height * glDpr));
    hudCanvas.width = Math.max(1, Math.round(width * dpr));
    hudCanvas.height = Math.max(1, Math.round(height * dpr));
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
    gl.disableVertexAttribArray(ptLoc.aSize);
    gl.disableVertexAttribArray(ptLoc.aColor);
  }

  function renderFrame(frameState) {
    if (destroyed) return;
    if (contextLost || gl.isContextLost?.() || !textures) {
      ctx2d.clearRect(0, 0, width, height);
      if (frameState?.hudDraw) frameState.hudDraw(ctx2d, width, height);
      return;
    }
    const {
      time, realTime, scaleLog, parallax, camRot, warp, fovZoom, shockWave,
      skyBright, starDensity, bhParams, galParams, webParams,
      particleData, particleCount, solarBodies, solarAlpha, hudDraw,
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
    gl.uniform1f(bgLoc.uSkyBright, skyBright);
    gl.uniform1f(bgLoc.uStarDensity, starDensity);
    gl.uniform1f(bgLoc.uQuality, qualityFactor);

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
        const pad = b.bodyType === 0 ? 3.85 : (b.bodyType === 6 ? 2.65 : (b.bodyType === 7 ? 2.02 : 1.36));
        gl.uniform2f(bodyLoc.uCenterPx, b.screenX * glDpr, b.screenY * glDpr);
        gl.uniform1f(bodyLoc.uQuadRadiusPx, b.radiusPx * glDpr * pad);
        gl.uniform1i(bodyLoc.uBodyType, b.bodyType);
        gl.uniform1f(bodyLoc.uRadiusRatio, 1.0 / pad);
        gl.uniform1f(bodyLoc.uSpin, b.spin);
        gl.uniform1f(bodyLoc.uTilt, b.tilt);
        gl.uniform1f(bodyLoc.uOblate, b.oblate);
        gl.uniform3f(bodyLoc.uLightDir, b.lightDir[0], b.lightDir[1], b.lightDir[2]);
        gl.uniform3f(bodyLoc.uAtmoColor, b.atmo[0], b.atmo[1], b.atmo[2]);
        gl.uniform1f(bodyLoc.uAlpha, solarAlpha);
        gl.uniform1f(bodyLoc.uHighlight, b.highlight || 0.0);

        bindTexUnit(0, textures[b.texKey] || textures.earth_day);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    ctx2d.clearRect(0, 0, width, height);
    if (hudDraw) hudDraw(ctx2d, width, height);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const off of textureUnsubs) off();
    textureUnsubs.length = 0;
    window.removeEventListener('resize', resize);
    glCanvas.removeEventListener('webglcontextlost', onContextLost, false);
    glCanvas.removeEventListener('webglcontextrestored', onContextRestored, false);
    if (contextLost || gl.isContextLost?.()) return;
    try {
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
    getSize: () => ({ width, height, dpr: glDpr }),
    areTexturesReady: () => true,
    areRealTexturesReady: () => uploadedRealKeys.has('earth_day') && uploadedRealKeys.has('milky'),
    destroy,
  };
}
