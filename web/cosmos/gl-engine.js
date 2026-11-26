/**
 * Yeaft Cosmos — WebGL2/WebGL Renderer Engine with Clean Lifecycle & 2D Fallback
 */
import { BG_VERT, BG_FRAG, PARTICLE_VERT, PARTICLE_FRAG } from './shaders-bg.js';
import { BODY_VERT, BODY_FRAG } from './shaders-bodies.js';
import { bakeProceduralWebGLTextures } from './gpu-texture-baker.js';

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

function detectSoftwareRenderer(gl) {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
    return /swiftshader|llvmpipe|softpipe|software|mesa offscreen|basic render/i.test(name);
  } catch {
    return false;
  }
}

/** Lightweight Canvas 2D fallback when WebGL is unavailable (e.g., restricted environments). */
function createFallback2DEngine(glCanvas, hudCanvas) {
  const bgCtx = glCanvas.getContext('2d');
  const ctx2d = hudCanvas.getContext('2d');
  let width = 1, height = 1, dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(glCanvas.clientWidth || window.innerWidth || 1, 1);
    height = Math.max(glCanvas.clientHeight || window.innerHeight || 1, 1);
    glCanvas.width = Math.round(width * dpr);
    glCanvas.height = Math.round(height * dpr);
    hudCanvas.width = Math.round(width * dpr);
    hudCanvas.height = Math.round(height * dpr);
    if (bgCtx) bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (ctx2d) ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resize();
  window.addEventListener('resize', resize);

  function renderFrame(frameState) {
    if (bgCtx) {
      const grad = bgCtx.createRadialGradient(width * 0.5, height * 0.5, 20, width * 0.5, height * 0.5, Math.max(width, height) * 0.72);
      grad.addColorStop(0, '#0a1428');
      grad.addColorStop(0.5, '#050a18');
      grad.addColorStop(1, '#02040a');
      bgCtx.fillStyle = grad;
      bgCtx.fillRect(0, 0, width, height);

      const { solarBodies = [], solarAlpha = 1 } = frameState;
      if (solarAlpha > 0.01) {
        bgCtx.save();
        bgCtx.globalAlpha = solarAlpha;
        const sorted = solarBodies.slice().sort((a, b) => a.camZ - b.camZ);
        for (const b of sorted) {
          const [ar, ag, ab] = b.atmo || [0.5, 0.7, 1.0];
          const g = bgCtx.createRadialGradient(b.screenX - b.radiusPx * 0.3, b.screenY - b.radiusPx * 0.3, b.radiusPx * 0.1, b.screenX, b.screenY, b.radiusPx);
          g.addColorStop(0, `rgb(${Math.round(ar * 255)}, ${Math.round(ag * 255)}, ${Math.round(ab * 255)})`);
          g.addColorStop(1, b.bodyType === 0 ? '#e67422' : '#0b1222');
          bgCtx.fillStyle = g;
          bgCtx.beginPath();
          bgCtx.arc(b.screenX, b.screenY, b.radiusPx, 0, Math.PI * 2);
          bgCtx.fill();
        }
        bgCtx.restore();
      }
    }
    if (ctx2d) {
      ctx2d.clearRect(0, 0, width, height);
      if (frameState.hudDraw) frameState.hudDraw(ctx2d, width, height);
    }
  }

  return {
    isWebGL: false,
    renderFrame,
    resize,
    getSize: () => ({ width, height, dpr }),
    areTexturesReady: () => true,
    destroy: () => {
      window.removeEventListener('resize', resize);
    },
  };
}

export function createCosmosEngine(glCanvas, hudCanvas) {
  if (!glCanvas || !hudCanvas) return null;
  let gl = null;
  try {
    gl = glCanvas.getContext('webgl2', { alpha: false, antialias: true, premultipliedAlpha: false, powerPreference: 'high-performance' })
      || glCanvas.getContext('webgl', { alpha: false, antialias: true, premultipliedAlpha: false });
  } catch {
    gl = null;
  }
  const ctx2d = hudCanvas.getContext('2d');
  if (!gl || !ctx2d) {
    return createFallback2DEngine(glCanvas, hudCanvas);
  }

  const bgProg = createProgram(gl, BG_VERT, BG_FRAG);
  const bodyProg = createProgram(gl, BODY_VERT, BODY_FRAG);
  const ptProg = createProgram(gl, PARTICLE_VERT, PARTICLE_FRAG);
  if (!bgProg || !bodyProg || !ptProg) {
    if (bgProg) gl.deleteProgram(bgProg);
    if (bodyProg) gl.deleteProgram(bodyProg);
    if (ptProg) gl.deleteProgram(ptProg);
    return createFallback2DEngine(glCanvas, hudCanvas);
  }

  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

  const ptBuf = gl.createBuffer();
  const isSoftware = detectSoftwareRenderer(gl);

  // Zero external downloads: bake all 15 procedural astronomical textures directly on GPU (~30ms)
  const textures = bakeProceduralWebGLTextures(gl, quadBuf, isSoftware ? 0.5 : 1.0);
  if (!textures) {
    gl.deleteBuffer(quadBuf);
    gl.deleteBuffer(ptBuf);
    gl.deleteProgram(bgProg);
    gl.deleteProgram(bodyProg);
    gl.deleteProgram(ptProg);
    return createFallback2DEngine(glCanvas, hudCanvas);
  }

  const bgLoc = {
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
    uTexGalaxy: gl.getUniformLocation(bgProg, 'uTexGalaxy'),
    uTexWeb: gl.getUniformLocation(bgProg, 'uTexWeb'),
  };

  const ptLoc = {
    aPosPx: gl.getAttribLocation(ptProg, 'aPosPx'),
    aSize: gl.getAttribLocation(ptProg, 'aSize'),
    aColor: gl.getAttribLocation(ptProg, 'aColor'),
    uRes: gl.getUniformLocation(ptProg, 'uRes'),
  };

  const bodyLoc = {
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

  let width = 1, height = 1, dpr = 1, glDpr = 1;
  let destroyed = false;

  function resize() {
    if (destroyed) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Keep 2D astronomical HUD razor-sharp at native DPR while scaling WebGL backing buffer
    // sensibly on software/CPU renderers so interaction stays responsive everywhere.
    glDpr = isSoftware ? 0.5 : dpr;
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
    if (destroyed || gl.isContextLost?.()) return;
    const {
      time, realTime, scaleLog, parallax, camRot, warp, fovZoom, shockWave,
      skyBright, starDensity, bhParams, galParams, webParams,
      particleData, particleCount, solarBodies, solarAlpha, hudDraw,
    } = frameState;

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
    bindTexUnit(1, textures.galaxy);
    bindTexUnit(2, textures.web);
    gl.uniform1i(bgLoc.uTexMilky, 0);
    gl.uniform1i(bgLoc.uTexGalaxy, 1);
    gl.uniform1i(bgLoc.uTexWeb, 2);

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
    window.removeEventListener('resize', resize);
    try {
      for (const tex of Object.values(textures)) gl.deleteTexture(tex);
      gl.deleteBuffer(quadBuf);
      gl.deleteBuffer(ptBuf);
      gl.deleteProgram(bgProg);
      gl.deleteProgram(bodyProg);
      gl.deleteProgram(ptProg);
    } catch { /* context already lost */ }
  }

  return {
    isWebGL: true,
    isSoftware,
    renderFrame,
    resize,
    getSize: () => ({ width, height, dpr: glDpr }),
    areTexturesReady: () => true,
    destroy,
  };
}
