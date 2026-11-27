/**
 * Yeaft Cosmos — Modular Per-Event WebGL Shaders (8 Phenomena, Lazy-Compiled)
 *
 * Each cosmic phenomenon compiles into a compact individual fragment program lazily
 * on first playback (supporting KHR_parallel_shader_compile), so initial Cosmos mount
 * compiles ZERO cosmic event shaders and avoids frame-1 GPU stalls.
 *
 * Output convention: premultiplied RGBA (`gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)`),
 * allowing opaque/dust occultation (`solid`, `solidA`) and ACES tone-mapped additive light
 * (`emit`) to coexist seamlessly within a single draw pass.
 */

export const EVENT_VERT = `
  attribute vec2 aCorner;
  uniform vec2 uRes;
  uniform vec2 uCenterPx;
  uniform float uQuadRadiusPx;
  varying vec2 vLocal;
  void main() {
    vLocal = vec2(aCorner.x, -aCorner.y);
    vec2 px = uCenterPx + aCorner * uQuadRadiusPx;
    vec2 clip = (px / uRes) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
  }
`;

const COMMON_HEAD = `
  precision highp float;
  varying vec2 vLocal;

  uniform float uQuadRadiusPx;
  uniform float uEventRadiusPx;
  uniform float uProgress;
  uniform float uElapsed;
  uniform float uRealTime;
  uniform float uAlpha;
  uniform float uObsBlend;
  uniform float uDistNorm;
  uniform float uAngle;
  uniform float uSeed;
  uniform float uSunRadiusPx;
  uniform vec2 uViewAngles;

  uniform sampler2D uTexNebula;
  uniform sampler2D uTexSun;
  uniform sampler2D uTexRock;

  const float PI = 3.14159265359;
  const float TAU = 6.28318530718;

  mat2 rot2(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, -s, s, c);
  }

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float fbm4(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 4; i++) {
      v += a * noise2(p);
      p = rot * p * 2.06 + vec2(13.7, 9.2);
      a *= 0.5;
    }
    return v;
  }

  float ridged4(vec2 p) {
    float v = 0.0;
    float a = 0.54;
    float weight = 1.0;
    mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 4; i++) {
      float n = 1.0 - abs(noise2(p) * 2.0 - 1.0);
      n = n * n * weight;
      weight = clamp(n * 1.8, 0.0, 1.0);
      v += n * a;
      p = rot * p * 2.12 + vec2(5.3, 11.1);
      a *= 0.5;
    }
    return v;
  }

  vec2 mirrorUv(vec2 uv) {
    return clamp(abs(fract(uv * 0.5) * 2.0 - 1.0), 0.004, 0.996);
  }

  /* Strictly ascending smoothstep falloff (GLSL ES 1.00 sec 8.3 safe when hi > lo) */
  float sstepDown(float hi, float lo, float x) {
    return 1.0 - smoothstep(lo, hi, x);
  }

  /* GLSL ES 1.00 sec 8.2 safe square (avoids UB of pow(x, 2.0) when x < 0) */
  float sq(float x) {
    return x * x;
  }

  vec2 sstepDown2(float hi, float lo, vec2 x) {
    return vec2(1.0) - smoothstep(lo, hi, x);
  }

  vec3 sampleNebulaSoft(vec2 uv) {
    vec2 m = mirrorUv(uv);
    vec2 border = smoothstep(0.0, 0.14, m) * sstepDown2(1.0, 0.86, m);
    float fade = 0.35 + 0.65 * border.x * border.y;
    return pow(max(texture2D(uTexNebula, m).rgb, vec3(0.0)), vec3(1.22)) * fade;
  }

  vec3 acesTone(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  vec3 blackbody(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c0 = vec3(0.38, 0.05, 0.02);
    vec3 c1 = vec3(0.95, 0.28, 0.05);
    vec3 c2 = vec3(1.00, 0.64, 0.22);
    vec3 c3 = vec3(1.00, 0.92, 0.78);
    vec3 c4 = vec3(0.82, 0.92, 1.00);
    vec3 c = mix(c0, c1, smoothstep(0.0, 0.30, t));
    c = mix(c, c2, smoothstep(0.28, 0.58, t));
    c = mix(c, c3, smoothstep(0.56, 0.84, t));
    c = mix(c, c4, smoothstep(0.82, 1.00, t));
    return c;
  }

  vec3 opticalSpikes(vec2 q, float strength, float span, float rotAng, vec3 tint) {
    if (strength <= 0.002) return vec3(0.0);
    vec2 qs = rot2(rotAng) * q / max(span, 0.05);
    float acc = 0.0;
    float disp = 0.0;
    for (int k = 0; k < 3; k++) {
      float a = float(k) * (PI / 3.0);
      vec2 rk = rot2(a) * qs;
      acc += exp(-abs(rk.y) * 62.0) * exp(-abs(rk.x) * 2.5)
           + exp(-abs(rk.y) * 20.0) * exp(-abs(rk.x) * 3.8) * 0.22;
      disp += exp(-abs(rk.y) * 36.0) * exp(-abs(rk.x) * 2.4) * sin(abs(rk.x) * 11.0);
    }
    float ana = exp(-abs(qs.y) * 30.0) * exp(-abs(qs.x) * 1.55) * 0.30;
    vec3 chroma = tint + vec3(0.14, -0.02, -0.14) * disp * 0.26;
    return chroma * (acc * 0.50 + ana) * strength;
  }
`;

const VORONOI_HELPER = `
  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }
  float voronoiEdge(vec2 x) {
    vec2 n = floor(x);
    vec2 f = fract(x);
    float md1 = 8.0, md2 = 8.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 r = g + hash22(n + g) - f;
        float d = dot(r, r);
        if (d < md1) { md2 = md1; md1 = d; }
        else if (d < md2) { md2 = d; }
      }
    }
    return sqrt(md2) - sqrt(md1);
  }
  float rockShardSdf(vec2 p, float r, float seed) {
    float d = -1e5;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float a = fi * (TAU / 5.0) + seed * 3.1 + sin(fi * 2.3 + seed * 5.0) * 0.36;
      float distPlane = r * (0.72 + 0.36 * hash21(vec2(fi + seed * 7.0, seed * 13.0)));
      d = max(d, dot(p, vec2(cos(a), sin(a))) - distPlane);
    }
    float crag = (noise2(p * (24.0 / max(r, 0.02)) + seed * 11.3) - 0.5) * r * 0.26;
    return d + crag;
  }
`;

const SEG_HELPER = `
  float segDist(vec2 p, vec2 a, vec2 b, out float h) {
    vec2 pa = p - a, ba = b - a;
    h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    return length(pa - ba * h);
  }
`;

const SPHERE_UV_HELPER = `
  vec2 sphereUv(vec3 n, float spin, float tilt) {
    float ct = cos(tilt), st = sin(tilt);
    vec3 nr = vec3(n.x * ct - n.y * st, n.x * st + n.y * ct, n.z);
    return vec2(
      fract((atan(nr.x, nr.z) + spin) / TAU + 0.5),
      clamp(0.5 - asin(clamp(nr.y, -1.0, 1.0)) / PI, 0.004, 0.996)
    );
  }
`;

const MAIN_OPEN = `
  void main() {
    float locR = length(vLocal);
    if (locR >= 1.0 || uAlpha <= 0.002) discard;
    float edgeMask = sstepDown(1.0, 0.78, locR);
    float p = clamp(uProgress, 0.0, 1.0);
    float t = uRealTime;
    float evT = uElapsed;
    float invS = uQuadRadiusPx / max(uEventRadiusPx, 1.0);
    vec2 q = vLocal * invS;
    vec3 emit = vec3(0.0);
    vec3 solid = vec3(0.0);
    float solidA = 0.0;
    float birthEnv = smoothstep(0.0, 0.14, p);
    float decayEnv = sstepDown(1.0, 0.76, p);
    float lifeEnv = birthEnv * decayEnv;
    float vYaw = uViewAngles.x;
    float vPitch = uViewAngles.y;
    float pitchSin = sin(vPitch);
    float pitchCos = cos(vPitch);
`;

const MAIN_CLOSE = `
    float masterA = clamp(uAlpha * edgeMask, 0.0, 1.0);
    vec3 finalEmit = acesTone(max(emit, vec3(0.0))) * masterA;
    float finalSolidA = clamp(solidA * masterA, 0.0, 1.0);
    vec3 finalRgb = solid * finalSolidA + finalEmit;
    gl_FragColor = vec4(clamp(finalRgb, 0.0, 1.0), finalSolidA);
  }
`;

const BODIES = {
  /* 0. SUPERNOVA — High-Contrast Veil/Cas-A Filamentary Remnant + Pulsar Wind Nebula */
  0: {
    extra: '',
    body: `
      vec2 qr = rot2(uAngle + vYaw * 0.65) * q;
      float r = length(qr);
      float ang = atan(qr.y, qr.x);
      float torTilt = clamp(0.44 + pitchSin * 0.42, 0.16, 0.92);
      float obsBoost = mix(0.76, 1.18, uObsBlend);

      float prePhase = smoothstep(0.0, 0.13, p) * (1.0 - smoothstep(0.20, 0.30, p));
      float collapsePinch = 1.0 - 0.62 * smoothstep(0.13, 0.21, p);
      if (prePhase > 0.002) {
        float pulse = 0.90 + 0.16 * sin(evT * 12.0) + 0.09 * sin(evT * 21.0);
        float starCore = exp(-r * r * (42.0 / max(collapsePinch * collapsePinch, 0.10))) * pulse;
        float starHalo = exp(-r * 6.2) * 0.44;
        float infall = exp(-r * 3.4) * pow(max(ridged4(vec2(ang * 5.0 + evT * 0.6, r * 6.0 + evT * 2.4)), 0.0), 1.6) * smoothstep(0.06, 0.20, p);
        vec2 rRing = vec2(qr.x, qr.y / torTilt);
        float eqRing = exp(-sq((length(rRing) - 0.46) / 0.036)) * (0.65 + 0.35 * noise2(vec2(ang * 7.0 + vYaw * 2.0, uSeed)));
        emit += vec3(0.68, 0.90, 1.00) * (starCore * 1.95 + starHalo + infall * 0.55) * prePhase;
        emit += vec3(0.96, 0.74, 0.48) * eqRing * 0.48 * prePhase;
      }

      float flash = exp(-sq((p - 0.23) / 0.056));
      float afterCore = exp(-max(p - 0.23, 0.0) * 3.8) * smoothstep(0.18, 0.23, p);
      float expP = clamp((p - 0.19) / 0.81, 0.0, 1.0);

      if (expP > 0.004) {
        float rShell = 0.14 + pow(expP, 0.60) * 1.44;
        float nebEnv = smoothstep(0.0, 0.13, expP) * sstepDown(1.0, 0.72, p);

        float asym = 1.0
          + 0.18 * (fbm4(vec2(cos(ang) * 1.8 + uSeed, sin(ang) * 1.8 + 2.3)) - 0.5)
          + 0.10 * sin(ang * 3.0 + uSeed * 6.28)
          + 0.06 * cos(ang * 5.0 - uSeed * 4.1)
          + 0.04 * sin(ang * 9.0 + uSeed * 9.1);
        float rw = r / max(asym, 0.62);

        vec2 flowDir = normalize(qr + vec2(1e-5));
        vec2 nebUv = (qr / max(rShell * 1.62, 0.18)) * 0.46 + 0.5 - flowDir * expP * 0.13 + vec2(uSeed * 0.17, uSeed * 0.23);
        vec3 veilTex = sampleNebulaSoft(nebUv);

        vec2 turbCoord = qr * (3.1 / max(rShell, 0.24)) - flowDir * expP * 1.55 + vec2(uSeed * 3.7, -uSeed * 2.1);
        float nWarp = fbm4(turbCoord * 0.92);
        float filA = ridged4(turbCoord * 1.55 + vec2(nWarp * 1.35, -nWarp * 1.08));
        float filB = fbm4(turbCoord * 2.4 - vec2(nWarp * 0.90, nWarp * 1.15));
        float sharpFil = pow(clamp(filA, 0.0, 1.0), 1.55);
        float rtFingers = pow(max(0.5 + 0.5 * sin(ang * 18.0 + nWarp * 4.8 + uSeed * 6.28), 0.0), 3.0);

        float outerBand = exp(-sq((rw - rShell * 0.96) / max(rShell * 0.135, 0.036)));
        float outerWisps = outerBand * (0.20 + (1.68 * sharpFil + 0.42 * rtFingers) * (0.44 + 0.96 * veilTex.r));

        float midBand = smoothstep(rShell * 0.20, rShell * 0.58, rw) * sstepDown(rShell * 1.16, rShell * 0.72, rw);
        float innerWeb = midBand * (0.12 + 1.28 * sharpFil) * (0.30 + 1.40 * max(veilTex.b, veilTex.g));

        float dustKnots = midBand * smoothstep(0.48, 0.80, filB) * (1.0 - sharpFil) * 0.34 * nebEnv * mix(0.45, 1.0, uObsBlend);
        solid = mix(solid, vec3(0.022, 0.015, 0.032), dustKnots);
        solidA = max(solidA, dustKnots);

        float cool = smoothstep(0.24, 0.92, expP);
        vec3 colShock = mix(vec3(1.00, 0.62, 0.28), vec3(0.98, 0.22, 0.18), cool);
        vec3 colO3 = mix(vec3(0.30, 0.86, 1.00), vec3(0.18, 0.62, 0.98), cool);
        vec3 colViolet = vec3(0.68, 0.34, 0.94);

        emit += colShock * outerWisps * (1.16 - cool * 0.28) * nebEnv * obsBoost;
        emit += colO3 * innerWeb * (0.86 - cool * 0.20) * nebEnv * obsBoost;
        emit += mix(colO3, colViolet, filB) * sstepDown(rShell * 1.06, rShell * 0.26, rw) * filB * (0.26 + 0.58 * veilTex.r) * 0.32 * nebEnv * obsBoost;

        float leadEdge = exp(-sq((rw - rShell * 1.035) / max(rShell * 0.028, 0.011))) * (0.26 + 1.18 * sharpFil);
        float secShock = exp(-sq((rw - rShell * 0.80) / max(rShell * 0.042, 0.016))) * sharpFil * 0.52;
        emit += mix(vec3(0.80, 0.94, 1.0), vec3(1.0, 0.56, 0.28), 0.38 + 0.36 * cool) * (leadEdge * 0.84 + secShock * 0.45) * nebEnv * obsBoost;

        float pwnEnv = smoothstep(0.20, 0.46, expP) * decayEnv;
        if (pwnEnv > 0.002 && r < 0.68) {
          vec2 pTor = vec2(qr.x, qr.y / torTilt);
          float pr = length(pTor);
          float wispWave = 0.62 + 0.38 * sin(pr * 36.0 - evT * 5.2);
          float torus = exp(-sq((pr - 0.14) / 0.036)) * (0.64 + 0.36 * sin(ang * 4.0 - evT * 3.4 + vYaw));
          float torus2 = exp(-sq((pr - 0.24) / 0.046)) * 0.42 * wispWave;
          vec2 jetP = rot2(-evT * 3.1) * qr;
          float pBeam = exp(-abs(jetP.y) * 40.0) * exp(-abs(jetP.x) * (3.2 / max(0.45, pitchCos))) * (0.70 + 0.30 * sin(evT * 15.0));
          emit += vec3(0.40, 0.92, 1.00) * (torus * 0.76 + torus2 * 0.42 + pBeam * 0.64) * pwnEnv * obsBoost;
          emit += vec3(0.96, 0.99, 1.00) * exp(-r * r * 175.0) * 1.40 * pwnEnv;
        }
      }

      float coreBright = flash * 2.35 + afterCore * 0.78;
      if (coreBright > 0.004) {
        float coreDisk = exp(-r * r * mix(22.0, 6.2, flash)) * coreBright;
        float coreHalo = exp(-r * mix(4.6, 2.2, flash)) * (0.48 * flash + 0.20 * afterCore);
        emit += mix(vec3(0.54, 0.86, 1.0), vec3(1.0, 0.98, 0.96), smoothstep(0.0, 0.54, coreDisk)) * coreDisk;
        emit += vec3(0.38, 0.74, 1.0) * coreHalo;
        emit += opticalSpikes(qr, (flash * 1.55 + afterCore * 0.42) * mix(0.75, 1.15, uObsBlend), 0.64 + flash * 0.95, 0.22, vec3(0.78, 0.93, 1.0));
      }
    `,
  },

  /* 1. PLANET SHATTER — 3D Ray-Traced Exoplanet + Voronoi Magma Fissures + Faceted Shards + Roche Ring */
  1: {
    extra: VORONOI_HELPER,
    body: `
      vec2 qr = rot2(uAngle + vYaw * 0.45) * q;
      float hitT = 0.24;
      float rPl = 0.36;
      vec3 L = normalize(vec3(-0.62 * cos(vYaw * 0.45) + 0.35 * sin(vYaw * 0.45), 0.42 + pitchSin * 0.35, 0.66));
      float bp = clamp((p - hitT) / (1.0 - hitT), 0.0, 1.0);
      float impactFlash = exp(-pow(bp / 0.12, 2.0)) * step(hitT - 0.02, p);
      vec2 hitPt = vec2(0.24, -0.14);

      if (p < hitT + 0.05) {
        float ap = clamp(p / hitT, 0.0, 1.0);
        float approachEnv = birthEnv * (1.0 - smoothstep(hitT - 0.015, hitT + 0.035, p));
        vec2 impPos = mix(vec2(1.25, -0.62), hitPt, pow(ap, 1.15));
        vec2 dImp = qr - impPos;
        float rImp = length(dImp);
        float impR = 0.115;

        vec2 wakeDir = normalize(vec2(1.25, -0.62) - hitPt);
        float alongW = dot(dImp, wakeDir);
        float perpW = length(dImp - wakeDir * alongW);
        if (alongW > -0.05 && alongW < 0.78) {
          float wWidth = 0.055 + alongW * 0.17;
          float wTurb = fbm4(vec2(alongW * 7.0 - evT * 4.2, perpW * 9.0 + uSeed * 4.0));
          float wake = exp(-pow(perpW / wWidth, 2.0)) * sstepDown(0.78, 0.02, alongW) * (0.38 + 0.82 * wTurb);
          emit += blackbody(0.26 + 0.50 * (1.0 - alongW / 0.78)) * wake * 0.92 * approachEnv;
        }

        if (rImp < impR * 1.15) {
          float ir = min(rImp / impR, 1.0);
          float iz = sqrt(max(1.0 - ir * ir, 0.0));
          vec3 inorm = vec3(dImp / impR, iz);
          vec2 iuv = vec2(fract(atan(inorm.x, inorm.z) / TAU + evT * 0.18), clamp(0.5 - asin(clamp(inorm.y, -1.0, 1.0)) / PI, 0.01, 0.99));
          float crackI = sstepDown(0.16, 0.02, voronoiEdge(iuv * 6.0));
          vec3 rockI = texture2D(uTexRock, iuv).rgb * (0.14 + 0.95 * max(dot(inorm, L), 0.0));
          float iaa = sstepDown(1.03, 0.93, rImp / impR) * approachEnv;
          solid = rockI;
          solidA = max(solidA, iaa);
          emit += blackbody(0.45 + 0.42 * crackI) * (crackI * 1.2 + pow(1.0 - iz, 2.8) * 0.55) * iaa;
        }
      }

      float planetRemain = 1.0 - smoothstep(0.48, 0.94, bp);
      float rCurrPl = rPl * (1.0 - bp * 0.30);
      float r0 = length(qr);
      if (planetRemain > 0.005 && r0 < rCurrPl * 1.24) {
        float pr = r0 / max(rCurrPl, 0.01);
        if (pr <= 1.03) {
          float rc = min(pr, 1.0);
          float pz = sqrt(max(1.0 - rc * rc, 0.0));
          vec3 pn = vec3(qr / max(rCurrPl, 0.01), pz);
          vec2 puv = vec2(fract(atan(pn.x, pn.z) / TAU + 0.32 + evT * 0.055 + vYaw * 0.26), clamp(0.5 - asin(clamp(pn.y * pitchCos - pn.z * pitchSin, -1.0, 1.0)) / PI, 0.005, 0.995));
          vec3 rTex = texture2D(uTexRock, puv).rgb;
          float ndl = max(dot(pn, L), 0.0);
          vec3 litP = rTex * (0.07 + pow(ndl, 0.85) * 1.16) + vec3(0.84, 0.44, 0.24) * pow(1.0 - pz, 3.6) * (0.06 + ndl * 0.34);

          float dHit = length(qr - hitPt * (rCurrPl / rPl));
          float shockR = bp * 1.46;
          float waveReach = sstepDown(shockR + 0.04, shockR - 0.14, dHit) * step(hitT - 0.01, p);
          float seismicRing = exp(-sq((dHit - shockR) / 0.036)) * smoothstep(0.0, 0.05, bp) * (1.0 - smoothstep(0.42, 0.82, bp));
          vec2 crackWarp = vec2(fbm4(puv * 6.4 + uSeed), fbm4(puv * 6.4 + vec2(4.7, 2.3))) - 0.5;
          float vEdge = voronoiEdge(puv * 8.4 + crackWarp * 0.76 + vec2(uSeed * 2.0, 0.4));
          float fissure = sstepDown(0.072 + bp * 0.115, 0.005, vEdge) * waveReach;
          float fissureCore = sstepDown(0.024 + bp * 0.032, 0.002, vEdge) * waveReach;
          float craterMelt = exp(-dHit * dHit * 18.0) * smoothstep(0.0, 0.08, bp);
          float lavaHeat = clamp(fissure * (0.95 + 0.48 * (1.0 - bp * 0.38)) + craterMelt * 1.25 + seismicRing * 0.90, 0.0, 1.50);

          float sectorBreak = smoothstep(0.36, 0.82, bp + fbm4(puv * 5.0) * 0.34 - dHit * 0.50);
          float paa = sstepDown(1.02, 0.95, pr) * birthEnv * planetRemain * (1.0 - sectorBreak * 0.58);

          solid = mix(solid, litP * (1.0 - min(lavaHeat, 1.0) * 0.48), paa);
          solidA = max(solidA, paa);
          emit += blackbody(0.26 + 0.62 * clamp(lavaHeat * 0.82 + fissureCore * 0.35, 0.0, 1.0)) * (lavaHeat * 1.22 + fissureCore * 0.58) * paa;
        }
      }

      if (bp > 0.002) {
        float postEnv = decayEnv;

        float ringEnv = smoothstep(0.14, 0.52, bp) * postEnv;
        if (ringEnv > 0.003) {
          vec2 rq = rot2(-0.22) * qr;
          vec2 eq = vec2(rq.x, rq.y / 0.26);
          float eqR = length(eq);
          float ringRad = 0.44 + bp * 0.86;
          float ringBand = smoothstep(ringRad * 0.48, ringRad * 0.78, eqR) * sstepDown(ringRad * 1.44, ringRad * 0.96, eqR);
          if (ringBand > 0.003) {
            vec2 rotEq = rot2(evT * (0.92 / max(eqR, 0.4)) + eqR * 4.2) * eq;
            float rn1 = fbm4(rotEq * 2.2 + uSeed * 3.0);
            float rn2 = pow(ridged4(rotEq * 3.8 + vec2(rn1 * 1.2, -rn1)), 1.45);
            float streaks = 0.22 + 0.95 * rn2 * (0.50 + 0.50 * sin(eqR * 22.0 + rn1 * 5.5));
            float ringHeat = clamp(0.56 - bp * 0.28 + rn2 * 0.26 - (eqR - ringRad * 0.6) * 0.32, 0.12, 0.78);
            float frontRing = sstepDown(0.08, -0.06, rq.y);
            float occ = mix(1.0 - solidA * 0.88, 1.0, frontRing);
            emit += blackbody(ringHeat) * ringBand * streaks * 0.54 * ringEnv * occ;
            float dustLane = ringBand * smoothstep(0.32, 0.75, rn1) * (1.0 - rn2) * 0.46 * ringEnv * frontRing;
            solid = mix(solid, vec3(0.055, 0.028, 0.020), dustLane);
            solidA = max(solidA, dustLane);
          }
        }

        vec2 plumeOff = qr - hitPt * (1.0 + bp * 0.52);
        float plumeR = length(plumeOff);
        float plumeMax = 0.24 + pow(bp, 0.68) * 1.18;
        if (plumeR < plumeMax * 1.32) {
          vec2 pDir = normalize(plumeOff + vec2(1e-5));
          float pN1 = fbm4(plumeOff * (2.8 / max(plumeMax, 0.2)) - pDir * bp * 1.8 + uSeed * 4.0);
          float pN2 = pow(ridged4(plumeOff * (4.2 / max(plumeMax, 0.2)) + vec2(pN1 * 1.3, -pN1)), 1.35);
          float pMask = sstepDown(plumeMax * 1.15, plumeMax * 0.16, plumeR) * (0.16 + 1.05 * pN1 * (0.38 + 0.82 * pN2));
          float shockArc = exp(-pow((plumeR - plumeMax * 0.94) / max(plumeMax * 0.10, 0.036), 2.0)) * (0.24 + 0.92 * pN2);
          float coolP = smoothstep(0.15, 0.92, bp);
          float smoke = sstepDown(plumeMax * 1.0, plumeMax * 0.25, plumeR) * smoothstep(0.45, 0.82, pN1) * (1.0 - pN2) * 0.34 * (1.0 - bp * 0.45) * postEnv;
          solid = mix(solid, vec3(0.07, 0.035, 0.025), smoke);
          solidA = max(solidA, smoke);
          emit += blackbody(clamp(0.70 - coolP * 0.38 + pN2 * 0.22, 0.14, 0.86)) * (pMask * 0.52 + shockArc * 0.68) * (1.0 - bp * 0.42) * postEnv;
        }

        if (bp < 0.84) {
          float chEnv = (1.0 - smoothstep(0.52, 0.84, bp)) * postEnv;
          for (int c = 0; c < 5; c++) {
            float fc = float(c);
            float ca = -0.92 + fc * 0.76 + uSeed * 1.8 + bp * 0.18;
            float cd = 0.22 + pow(bp, 0.74) * (0.54 + fract(fc * 0.41) * 0.48);
            vec2 cPos = hitPt * 0.45 + vec2(cos(ca), sin(ca) * 0.76) * cd;
            vec2 dCh = rot2(evT * (0.55 + fc * 0.16) + fc * 1.4) * (qr - cPos);
            float cr = (0.042 + fract(fc * 0.67) * 0.032) * (1.0 - bp * 0.32);
            float sd = rockShardSdf(dCh, cr, fc * 0.73 + uSeed);
            if (sd < 0.025) {
              float maskCh = sstepDown(0.008, -0.006, sd) * chEnv;
              vec2 blastDir = normalize(hitPt - cPos + vec2(1e-4));
              float blastSide = clamp(dot(normalize(dCh + vec2(1e-4)), blastDir), 0.0, 1.0);
              vec3 rockTex = texture2D(uTexRock, mirrorUv(dCh * 5.0 + vec2(fc * 0.23, 0.3))).rgb;
              vec3 litShard = rockTex * (0.14 + 0.58 * clamp(dot(normalize(vec3(dCh / max(cr, 0.01), 0.7)), L), 0.0, 1.0));
              float hotFace = smoothstep(-0.014, 0.004, sd) * sstepDown(0.014, -0.004, sd) * (0.28 + 0.72 * blastSide);
              solid = mix(solid, litShard, maskCh);
              solidA = max(solidA, maskCh);
              emit += blackbody(0.46 - bp * 0.20) * hotFace * 0.75 * chEnv;
            }
          }
        }

        if (impactFlash > 0.004) {
          float dF = length(qr - hitPt);
          float fCore = exp(-dF * dF * 18.0) * impactFlash;
          emit += blackbody(0.92) * fCore * 1.85;
          emit += opticalSpikes(qr - hitPt, impactFlash * 1.10, 0.60, 0.4, vec3(1.0, 0.82, 0.58));
        }
      }
    `,
  },

  /* 2. BLACK HOLE BIRTH — Hypergiant Implosion -> Mini-Gargantua + Relativistic Bipolar Jets */
  2: {
    extra: '',
    body: `
      vec2 qr = rot2(uAngle + vYaw * 0.55) * q;
      float r = length(qr);
      float ang = atan(qr.y, qr.x);
      float diskTilt = clamp(0.19 + pitchSin * 0.54, 0.10, 0.86);
      float collP = clamp(p / 0.28, 0.0, 1.0);
      float birthP = clamp((p - 0.23) / 0.77, 0.0, 1.0);

      if (p < 0.32) {
        float starEnv = birthEnv * (1.0 - smoothstep(0.23, 0.31, p));
        float rStar = mix(0.44, 0.07, pow(collP, 1.45));
        if (r < rStar * 2.6) {
          float sr = r / max(rStar, 0.01);
          if (sr <= 1.05) {
            float sz = sqrt(max(1.0 - min(sr, 1.0) * min(sr, 1.0), 0.0));
            vec2 suv = vec2(fract(ang / TAU + evT * 0.14), clamp(0.5 - (qr.y / max(rStar, 0.01)) * 0.45, 0.02, 0.98));
            vec3 gran = texture2D(uTexSun, mirrorUv(suv + vec2(fbm4(qr * 8.0 - evT) * 0.06))).rgb;
            vec3 hotStar = mix(gran * vec3(1.3, 0.95, 0.65), vec3(0.74, 0.90, 1.0), collP * 0.72) * (0.45 + 0.85 * pow(sz, 0.5));
            emit += hotStar * sstepDown(1.04, 0.86, sr) * 1.55 * starEnv;
          }
          float wind = exp(-max(sr - 0.85, 0.0) * 2.4) * (0.65 + 0.45 * fbm4(vec2(ang * 4.0 + evT * 1.6, sr * 2.4)));
          emit += mix(vec3(0.52, 0.82, 1.0), vec3(1.0, 0.86, 0.62), 0.35) * wind * 0.72 * starEnv;
        }
      }

      float snapFlash = exp(-pow((p - 0.26) / 0.045, 2.0));
      if (snapFlash > 0.004) {
        emit += vec3(0.84, 0.94, 1.0) * exp(-r * r * 14.0) * snapFlash * 1.95;
        emit += opticalSpikes(qr, snapFlash * 1.25, 0.70, 0.12, vec3(0.78, 0.90, 1.0));
      }

      if (birthP > 0.002) {
        float bhEnv = smoothstep(0.0, 0.14, birthP) * decayEnv;
        float rs = 0.25 * smoothstep(0.0, 0.18, birthP);
        vec2 bq = qr / max(rs, 0.015);
        float bqr = length(bq);

        float jetRise = smoothstep(0.04, 0.22, birthP) * (1.0 - smoothstep(0.58, 0.94, birthP)) * decayEnv;
        if (jetRise > 0.003) {
          float along = abs(qr.y);
          float perp = abs(qr.x);
          float jetReach = 0.28 + smoothstep(0.04, 0.42, birthP) * 1.68;
          if (along > rs * 0.98 && along < jetReach * 1.25) {
            float jWidth = 0.020 + pow(along, 0.82) * 0.088;
            float poleSign = sign(qr.y + 1e-4);
            float knots = ridged4(vec2(along * 4.8 - evT * 5.2 + poleSign * 3.7, qr.x * 16.0 + sin(along * 9.0) * 0.6));
            float spine = exp(-pow(perp / (jWidth * 0.36), 2.0)) * 1.25;
            float sheath = exp(-pow(perp / jWidth, 2.0)) * (0.34 + 0.92 * knots);
            float lenMask = smoothstep(rs * 0.98, rs * 1.75, along) * sstepDown(jetReach * 1.15, jetReach * 0.22, along);
            vec3 jetCol = mix(vec3(0.46, 0.74, 1.0), vec3(0.92, 0.96, 1.0), clamp(spine * 0.7, 0.0, 1.0));
            emit += (jetCol * spine + vec3(0.54, 0.64, 1.0) * sheath * 0.68) * lenMask * jetRise * 1.05;
          }
        }

        if (bqr < 6.8 && rs > 0.02) {
          float shadow = (1.0 - smoothstep(0.94, 1.02, bqr)) * bhEnv;
          solid = mix(solid, vec3(0.004, 0.006, 0.012), shadow);
          solidA = max(solidA, shadow);

          float photonRing = exp(-sq((bqr - 1.032) / 0.036)) * 2.15 * (0.94 + 0.06 * sin(t * 2.1));
          float secRing = exp(-sq((bqr - 1.11) / 0.095)) * 0.52;
          float einsteinRing = exp(-sq((bqr - 1.48) / 0.042)) * 0.24 * smoothstep(0.10, 0.45, birthP);
          float innerGlow = exp(-max(bqr - 1.0, 0.0) * 2.1) * smoothstep(0.95, 1.02, bqr) * 0.46;

          vec2 eq = vec2(bq.x, bq.y / diskTilt);
          float eqR = length(eq);
          float frontCross = sstepDown(0.06, -0.05, bq.y);
          float diskGrow = smoothstep(0.02, 0.36, birthP);
          float diskBand = smoothstep(1.12, 1.46, eqR) * sstepDown(2.35 + 3.95 * diskGrow, 1.92, eqR)
                         * mix(smoothstep(0.95, 1.04, bqr), 1.0, frontCross);
          float archMask = smoothstep(0.99, 1.13, bqr) * sstepDown(2.75, 1.14, bqr)
                         * smoothstep(0.04, 0.62, abs(bq.y) / max(bqr, 0.16)) * diskGrow;

          float doppler = clamp(1.0 - 0.52 * (bq.x / max(bqr, 0.28)), 0.32, 1.84);
          vec3 dCol = mix(vec3(0.74, 0.20, 0.04), vec3(1.00, 0.64, 0.26), smoothstep(0.32, 0.96, doppler));
          dCol = mix(dCol, vec3(1.00, 0.95, 0.84), smoothstep(0.92, 1.40, doppler));
          dCol = mix(dCol, vec3(0.82, 0.94, 1.00), smoothstep(1.38, 1.84, doppler) * 0.58);

          float bhFlow = evT * 1.18;
          float dInt = 0.0;
          if (diskBand > 0.003) {
            vec2 rotEq = rot2(bhFlow * (1.08 / pow(max(eqR, 0.85), 0.78)) + eqR * 2.95) * eq;
            float n1 = fbm4(rotEq * 1.55);
            float n2 = fbm4(rotEq * 3.3 + vec2(n1 * 1.8, -n1 * 1.4));
            float shear = pow(max(ridged4(rotEq * 2.8 + vec2(n2, -n1)), 0.0), 1.35);
            dInt = diskBand * (0.36 + 0.72 * n2 + 0.42 * shear) * (0.56 + 0.46 * sin(eqR * 13.0 + n1 * 5.8 - bhFlow * 0.75))
                 * mix(1.56, 0.42, smoothstep(1.28, 5.4, eqR)) * doppler;
          }
          float aInt = 0.0;
          if (archMask > 0.003) {
            vec2 rotArch = rot2(bhFlow * 0.74 + bqr * 3.6) * bq;
            float an1 = fbm4(rotArch * 2.3);
            float an2 = fbm4(rotArch * 4.7 + vec2(an1 * 1.5, -an1 * 1.1));
            aInt = archMask * (0.42 + 0.86 * an2) * (0.64 + 0.36 * sin(bqr * 15.0 + an1 * 5.0 - bhFlow * 0.6)) * doppler * 0.96;
          }

          vec3 frontEm = dCol * dInt * frontCross;
          vec3 extEm = dCol * (dInt * (1.0 - frontCross) + aInt)
                     + mix(vec3(1.0, 0.68, 0.28), vec3(1.0, 0.96, 0.88), smoothstep(0.45, 1.48, doppler)) * (photonRing + secRing) * doppler
                     + vec3(0.84, 0.92, 1.0) * einsteinRing * (0.5 + 0.5 * uObsBlend)
                     + vec3(0.98, 0.56, 0.22) * (innerGlow + exp(-max(bqr - 1.0, 0.0) * 0.86) * 0.18 * doppler);
          emit += (frontEm + extEm * smoothstep(0.94, 1.02, bqr)) * bhEnv * mix(0.84, 1.12, uObsBlend);
        }
      }
    `,
  },

  /* 3. KILONOVA — Binary Neutron Star Inspiral + Two-Component Turquoise/Gold Ejecta */
  3: {
    extra: '',
    body: `
      vec2 qr = rot2(uAngle + vYaw * 0.60) * q;
      float orbTilt = clamp(0.56 + pitchSin * 0.38, 0.18, 0.96);
      float mergeP = 0.42;

      if (p < mergeP + 0.04) {
        float ip = clamp(p / mergeP, 0.0, 1.0);
        float inEnv = birthEnv * (1.0 - smoothstep(mergeP - 0.02, mergeP + 0.035, p));
        float sep = 0.62 * pow(1.0 - ip, 0.52);
        float omega = ip * ip * 20.0 + evT * 2.4;

        vec2 eq = vec2(qr.x, qr.y / orbTilt);
        float eqR = length(eq);
        float eqA = atan(eq.y, eq.x);

        float gwWave = sin(2.0 * (eqA - omega * 0.72) + eqR * (8.0 + ip * 11.0));
        float gwMask = smoothstep(0.22, 0.50, eqR) * sstepDown(1.68, 0.42, eqR);
        emit += vec3(0.46, 0.72, 1.0) * pow(max(gwWave, 0.0), 3.2) * gwMask * (0.12 + 0.20 * ip) * inEnv;

        float sepSafe = max(sep, 0.025);
        float spiralArg = 2.0 * (eqA - omega) + (eqR - sepSafe) * (5.2 + ip * 4.5);
        float armRidge = exp(-sq(sin(spiralArg * 0.5)) * (10.5 + eqR * 6.0));
        float armTurb = fbm4(rot2(-omega * 0.35) * eq * 3.8 + uSeed * 3.0);
        float armEnv = smoothstep(sepSafe * 0.72, sepSafe * 1.06, eqR) * sstepDown(sepSafe + 0.82, sepSafe + 0.08, eqR);
        emit += mix(vec3(0.34, 0.88, 1.0), vec3(0.80, 0.54, 1.0), 0.5 + 0.5 * sin(eqA - omega))
              * armRidge * (0.44 + 1.02 * armTurb) * armEnv * (0.52 + 0.92 * ip) * inEnv;

        for (int k = 0; k < 2; k++) {
          float a = omega + float(k) * PI;
          vec2 nsPos = vec2(cos(a) * sep, sin(a) * sep * orbTilt);
          float nd = length(qr - nsPos);
          vec3 nsCol = (k == 0) ? vec3(0.40, 0.90, 1.0) : vec3(0.82, 0.56, 1.0);
          emit += (vec3(1.0) * exp(-nd * nd * 170.0) * 2.25 + nsCol * exp(-nd * 8.0) * 0.76) * inEnv;
        }
      }

      if (p >= mergeP - 0.03) {
        float kp = clamp((p - mergeP) / (1.0 - mergeP), 0.0, 1.0);
        float mFlash = exp(-pow((p - mergeP - 0.015) / 0.052, 2.0));
        float kEnv = smoothstep(mergeP - 0.03, mergeP + 0.05, p) * decayEnv;

        float sGrb = exp(-pow((kp - 0.08) / 0.14, 2.0)) * kEnv;
        if (sGrb > 0.004) {
          float along = abs(qr.y), perp = abs(qr.x);
          float beam = exp(-pow(perp / (0.018 + along * 0.064), 2.0)) * exp(-along * 1.15);
          emit += vec3(0.58, 0.90, 1.0) * beam * sGrb * 1.25;
        }

        float rExp = 0.18 + pow(kp, 0.60) * 1.26;
        vec2 flow = normalize(qr + vec2(1e-5));
        float r = length(qr);
        float polarFactor = pow(abs(flow.y), 1.65);

        float rScaled = r / max(rExp * mix(1.08, 0.86, polarFactor), 0.05);
        vec2 nUv = (qr / max(rExp * 1.65, 0.18)) * 0.46 + 0.5 - flow * kp * 0.12 + vec2(uSeed * 0.25, 0.15);
        vec3 nebSample = sampleNebulaSoft(nUv);
        float f1 = fbm4(qr * (2.8 / max(rExp, 0.2)) - flow * kp * 1.5 + uSeed * 5.0);
        float f2 = pow(ridged4(qr * (4.0 / max(rExp, 0.2)) + vec2(f1 * 1.25, -f1)), 1.55);

        float cloudMask = sstepDown(1.22, 0.20, rScaled) * (0.14 + 1.15 * f1 * (0.34 + 0.92 * f2));
        float shellRim = exp(-pow((rScaled - 0.92) / 0.14, 2.0)) * (0.24 + 1.05 * f2);
        float darkVeins = sstepDown(1.05, 0.22, rScaled) * smoothstep(0.48, 0.84, f1) * (1.0 - f2) * 0.34 * kEnv;
        solid = mix(solid, vec3(0.04, 0.025, 0.045), darkVeins);
        solidA = max(solidA, darkVeins);

        vec3 colPolar = mix(vec3(0.24, 0.90, 0.92), vec3(0.48, 0.72, 1.0), f1);
        vec3 colGold = mix(vec3(1.00, 0.68, 0.20), vec3(0.92, 0.34, 0.18), smoothstep(0.22, 0.85, kp));
        colGold = mix(colGold, vec3(0.72, 0.30, 0.82), f2 * 0.32);

        vec3 kiloCol = mix(colGold, colPolar, polarFactor * 0.84);
        emit += kiloCol * (cloudMask * (0.48 + 0.58 * nebSample.r) + shellRim * 0.72) * (1.0 - kp * 0.32) * kEnv;

        float core = exp(-r * r * mix(28.0, 7.5, mFlash)) * (mFlash * 1.85 + (1.0 - kp) * 0.42);
        emit += mix(vec3(0.70, 0.96, 1.0), vec3(1.0, 0.88, 0.64), kp) * core * kEnv;
        emit += opticalSpikes(qr, mFlash * 1.30, 0.68, 0.52, vec3(0.78, 0.95, 1.0));
      }
    `,
  },

  /* 4. STELLAR SUPERFLARE — Seamless Boiling 3D Star + Sunspot Two-Ribbon Flare + 5-Arcade SDO Loops + Twisted CME */
  4: {
    extra: SPHERE_UV_HELPER,
    body: `
      vec2 qs = (vLocal * uQuadRadiusPx) / max(uSunRadiusPx, 1.0);
      vec2 qr = rot2(-uAngle - vYaw * 0.72) * qs;
      qr.y /= max(0.68, 1.0 - abs(pitchSin) * 0.28);
      float rSun = length(qr);
      float aOff = atan(qr.y, qr.x);

      float eruptEnv = birthEnv * decayEnv;
      float flarePeak = exp(-sq((p - 0.30) / 0.125));
      float cmeP = clamp((p - 0.14) / 0.86, 0.0, 1.0);
      float obsDetail = smoothstep(0.06, 0.65, uObsBlend);

      /* Seamless volumetric corona + chromospheric glow (no hard ring gap around photosphere) */
      float ang = atan(qs.y, qs.x);
      float streamer = 0.76 + 0.26 * noise2(vec2(ang * 5.0 + t * 0.12, rSun * 1.35 - t * 0.20))
                     + 0.16 * noise2(vec2(ang * 11.0 - t * 0.09, rSun * 2.2 - t * 0.26));
      float radialCorona = exp(-max(rSun - 0.90, 0.0) * 3.1) * 0.72
                         + exp(-max(rSun - 0.85, 0.0) * 1.45) * 0.34 * streamer
                         + pow(1.0 / max(rSun, 0.92), 2.9) * 0.16;
      float coronaMask = smoothstep(0.84, 1.04, rSun) * sstepDown(4.2, 1.05, rSun);
      float chromoRim = exp(-sq((rSun - 0.995) / 0.055)) * (0.48 + 0.52 * noise2(vec2(ang * 9.0 + t * 0.14, t * 0.22)));
      vec3 coronaCol = mix(vec3(0.96, 0.36, 0.09), vec3(1.00, 0.88, 0.66), exp(-max(rSun - 0.92, 0.0) * 2.6));
      emit += (coronaCol * radialCorona * coronaMask + vec3(1.00, 0.30, 0.06) * chromoRim * 0.55) * eruptEnv;

      /* Far ambient mode: blend into a jewel-like distant flaring star with delicate spikes instead of a flat yellow disc */
      if (obsDetail < 0.98) {
        float ambStar = (exp(-rSun * rSun * 2.4) * 1.15 + exp(-rSun * 1.65) * 0.36) * (1.0 - obsDetail);
        emit += mix(vec3(1.00, 0.66, 0.28), vec3(1.00, 0.95, 0.84), smoothstep(0.0, 0.8, ambStar)) * ambStar * eruptEnv;
      }

      /* Boiling 3D stellar photosphere + active sunspot umbra + Moreton surface shock ripple */
      if (rSun <= 1.04) {
        float z = sqrt(max(1.0 - min(rSun, 1.0) * min(rSun, 1.0), 0.0));
        vec3 n = vec3(qs.x, qs.y, z);
        vec2 uv1 = sphereUv(n, evT * 0.05 + uSeed * 6.28, 0.11);
        vec2 uv2 = sphereUv(n, -evT * 0.035 + 0.37, -0.07);
        vec2 warp = vec2(
          noise2(uv1 * 18.0 + vec2(t * 0.11, -t * 0.08)) - 0.5,
          noise2(uv1 * 18.0 + vec2(-t * 0.09, t * 0.10)) - 0.5
        ) * 0.014;
        vec3 gran = mix(
          texture2D(uTexSun, fract(uv1 + warp)).rgb,
          texture2D(uTexSun, fract(uv2 * 1.65 + vec2(t * 0.008, 0.0))).rgb,
          0.38
        );
        float limb = pow(z, 0.52);
        vec3 photo = pow(max(gran, vec3(0.02)), vec3(0.92)) * mix(vec3(0.95, 0.26, 0.04), vec3(1.26, 0.92, 0.52), limb) * (0.34 + 0.82 * limb)
                   + vec3(0.42, 0.30, 0.14) * pow(z, 2.4);

        /* Active sunspot group near magnetic reconnection footpoint */
        float dSpot1 = length(qr - vec2(0.80, 0.09));
        float dSpot2 = length(qr - vec2(0.84, -0.10));
        float spotMask = (exp(-dSpot1 * dSpot1 * 56.0) + exp(-dSpot2 * dSpot2 * 72.0)) * 0.72 * obsDetail;
        photo *= (1.0 - spotMask);

        /* Chromospheric Moreton shockwave sweeping across the stellar disc */
        float moretonR = smoothstep(0.18, 0.62, p) * 1.85;
        float dFoot = length(qr - vec2(0.88, 0.0));
        float moreton = exp(-sq((dFoot - moretonR) / 0.075)) * smoothstep(0.18, 0.28, p) * (1.0 - smoothstep(0.50, 0.74, p)) * obsDetail;

        float aa = sstepDown(1.02, 0.90, rSun) * eruptEnv * mix(0.45, 1.0, obsDetail);
        solid = mix(solid, clamp(acesTone(photo), 0.0, 1.0), aa);
        solidA = max(solidA, aa);
        emit += vec3(1.00, 0.68, 0.34) * moreton * 0.95 * aa;
      }

      /* Two-Ribbon Magnetic Reconnection Flare + EUV White-Hot X-Point Cusp */
      float dRibbonA = length(vec2((qr.x - 0.94) * 3.0, (qr.y - 0.11) * 1.7));
      float dRibbonB = length(vec2((qr.x - 0.94) * 3.0, (qr.y + 0.11) * 1.7));
      float ribNoise = 0.54 + 0.46 * fbm4(qr * 9.0 - vec2(evT * 1.1, 0.0));
      float plage = (exp(-dRibbonA * dRibbonA * 10.0) + exp(-dRibbonB * dRibbonB * 10.0)) * ribNoise;
      emit += mix(vec3(1.0, 0.42, 0.08), vec3(1.0, 0.96, 0.86), flarePeak) * plage * (0.58 + flarePeak * 1.45) * eruptEnv;

      float dCusp = length(qr - vec2(1.16 + flarePeak * 0.22, 0.0));
      emit += vec3(1.0, 0.92, 0.82) * exp(-dCusp * dCusp * 18.0) * flarePeak * 1.35 * eruptEnv;
      emit += vec3(1.0, 0.32, 0.56) * exp(-dCusp * 4.6) * flarePeak * 0.78 * eruptEnv;
      emit += opticalSpikes(qr - vec2(1.06, 0.0), (0.18 + flarePeak * 1.05) * eruptEnv, 0.88 + flarePeak * 0.42, 0.18, vec3(1.0, 0.86, 0.58));

      /* 5-Strand SDO 304A / 171A Interlaced Coronal Magnetic Loop Arcade */
      if (qr.x > 0.70 && rSun < 3.6) {
        float loopRise = smoothstep(0.0, 0.20, p) * (1.0 - smoothstep(0.72, 0.98, p)) * eruptEnv;
        for (int k = 0; k < 5; k++) {
          float fk = float(k);
          float archH = (0.30 + fk * 0.22) * (0.48 + 0.66 * sin(min(1.0, p * 1.38) * PI) + flarePeak * 0.26);
          vec2 cLoop = vec2(0.88 + archH * 0.24, (fk - 2.0) * 0.068);
          vec2 dl = vec2((qr.x - cLoop.x) / max(archH * 1.24, 0.1), (qr.y - cLoop.y) / max(archH * 0.74, 0.1));
          float lr = length(dl);
          float strand = exp(-sq((lr - 1.0) / (0.062 + fk * 0.006))) * smoothstep(0.80, 1.00, qr.x);
          float plasmaFlow = pow(max(ridged4(vec2(atan(dl.y, dl.x) * 5.2 + evT * (1.9 - fk * 0.22), lr * 6.0 + fk * 2.3)), 0.0), 1.30);
          vec3 hotInner = (k < 2) ? vec3(0.86, 0.94, 1.00) : vec3(1.00, 0.82, 0.38);
          vec3 loopCol = mix(vec3(1.00, 0.26, 0.06), hotInner, clamp(plasmaFlow * 0.86 + flarePeak * 0.42, 0.0, 1.0));
          emit += loopCol * strand * (0.34 + 1.32 * plasmaFlow) * (0.90 - fk * 0.11) * loopRise;
        }
      }

      /* Billowing 3-Part Coronal Mass Ejection (Twisted Flux Rope + Bright Shock Front + Prominence Filaments) */
      if (cmeP > 0.01 && qr.x > 0.82) {
        float cmeEnv = smoothstep(0.0, 0.15, cmeP) * decayEnv;
        float coneAng = 0.72 + cmeP * 0.24;
        float angMask = sstepDown(coneAng, coneAng * 0.18, abs(aOff));
        float frontR = 1.22 + pow(cmeP, 0.68) * 2.95;
        float radialU = (rSun - 0.96) / max(frontR - 0.96, 0.15);

        if (radialU > 0.0 && radialU < 1.36 && angMask > 0.002) {
          float twist = sin(radialU * 7.5 - evT * 2.4 + aOff * 3.0) * 0.16;
          vec2 cmeFlow = vec2(radialU * 3.0 - evT * 0.85, (aOff + twist) * 4.4);
          float n1 = fbm4(cmeFlow * 1.45 + uSeed * 3.0);
          float n2 = pow(ridged4(cmeFlow * 2.7 + vec2(n1 * 1.25, -n1 * 0.95)), 1.35);
          vec3 sunTex = texture2D(uTexSun, mirrorUv(vec2(radialU * 0.72 - cmeP * 0.44, aOff * 0.5 + 0.5))).rgb;

          float rFrontWarped = radialU - (n1 - 0.5) * 0.14;
          float leadShock = exp(-sq((rFrontWarped - 0.95) / 0.078)) * (0.38 + 1.25 * n2);
          float fluxRope = exp(-sq((rFrontWarped - 0.58) / 0.19)) * (0.24 + 1.42 * n2 * (0.45 + 0.75 * sunTex.r));
          float streamers = sstepDown(1.18, 0.06, radialU) * pow(max(0.5 + 0.5 * sin(aOff * 22.0 + n1 * 5.2), 0.0), 2.4) * 0.42;

          float heat = clamp(0.80 - radialU * 0.42 - cmeP * 0.18 + n2 * 0.28, 0.16, 0.92);
          vec3 cmeCol = mix(blackbody(heat), vec3(0.95, 0.96, 1.0), clamp(leadShock * 0.32 * flarePeak, 0.0, 0.45));
          emit += cmeCol * (leadShock * 0.98 + fluxRope * 0.86 + streamers) * angMask * (1.0 - cmeP * 0.24) * cmeEnv * mix(0.75, 1.15, obsDetail);
        }
      }
    `,
  },

  /* 5. GAMMA-RAY BURST — Relativistic Collimated Jet & Hourglass Nebula Cocoon */
  5: {
    extra: '',
    body: `
      vec2 qr = rot2(uAngle + vYaw * 0.72) * q;
      float r = length(qr);
      float along = abs(qr.x) / max(0.42, pitchCos);
      float perp = abs(qr.y);

      float preEnv = birthEnv * (1.0 - smoothstep(0.18, 0.30, p));
      if (preEnv > 0.002) {
        emit += vec3(0.82, 0.68, 1.0) * exp(-r * r * 30.0) * (0.85 + 0.15 * sin(evT * 13.0)) * 1.25 * preEnv;
      }

      float jetP = clamp((p - 0.12) / 0.88, 0.0, 1.0);
      float beamEnv = smoothstep(0.10, 0.24, p) * decayEnv;
      if (beamEnv > 0.002) {
        float jetLen = 0.15 + smoothstep(0.0, 0.28, jetP) * (invS * 0.92);
        float lenMask = sstepDown(jetLen, jetLen * 0.16, along);

        float coreW = 0.013 + along * 0.015;
        float sheathW = 0.042 + pow(along, 0.84) * 0.135;
        float dirSign = sign(qr.x + 1e-5);
        float nJet = fbm4(vec2(along * 2.8 - evT * 6.5 + dirSign * 3.7, qr.y * 8.0 + uSeed * 4.0));
        float knots = ridged4(vec2(along * 4.4 - evT * 8.2 + dirSign * 5.1, qr.y * 13.0 + nJet * 1.4));

        float needle = exp(-sq(perp / coreW)) * (1.55 + 0.62 * knots);
        float sheath = exp(-sq(perp / sheathW)) * (0.28 + 1.08 * knots);
        float aura = exp(-sq(perp / (sheathW * 2.4))) * (0.16 + 0.46 * nJet);
        float internalShock = exp(-sq(perp / (coreW * 2.4))) * pow(max(0.0, sin(along * 7.0 - evT * 10.5)), 5.0) * 0.95;

        float bowR = 0.24 + pow(jetP, 0.60) * 1.28;
        vec2 cocUv = (qr / max(bowR * 1.65, 0.2)) * 0.44 + 0.5 + vec2(uSeed * 0.2, 0.1);
        vec3 nebTex = sampleNebulaSoft(cocUv);
        float hourglass = abs(perp - (0.08 + pow(along, 0.72) * 0.45));
        float cocoonShell = exp(-sq(hourglass / 0.105)) * sstepDown(bowR * 1.28, bowR * 0.14, along)
                          * (0.34 + 1.22 * knots * (0.40 + 0.84 * nebTex.b));
        float bowCap = exp(-sq((along - bowR * 0.96) / 0.085)) * exp(-sq(perp / (0.14 + bowR * 0.26))) * (0.45 + 0.85 * knots);

        vec2 eqT = vec2(qr.x / 0.20, qr.y);
        float eqGlow = exp(-length(eqT) * 4.4) * (0.58 + 0.42 * nJet);

        vec3 colNeedle = vec3(0.97, 0.95, 1.00);
        vec3 colSheath = mix(vec3(0.68, 0.36, 1.00), vec3(0.28, 0.84, 1.00), clamp(knots * 0.85, 0.0, 1.0));
        vec3 colCocoon = mix(vec3(0.26, 0.78, 1.00), vec3(0.88, 0.40, 1.00), nJet);

        emit += colNeedle * (needle + internalShock) * lenMask * beamEnv * 1.38;
        emit += colSheath * (sheath * 0.92 + aura * 0.36 + bowCap * 0.95) * lenMask * beamEnv;
        emit += colCocoon * cocoonShell * 0.92 * beamEnv;
        emit += vec3(1.0, 0.74, 0.44) * eqGlow * 0.62 * beamEnv;

        float flash = exp(-pow((p - 0.26) / 0.11, 2.0));
        emit += vec3(0.95, 0.92, 1.0) * exp(-r * r * 28.0) * (0.85 + flash * 1.45) * beamEnv;
        emit += opticalSpikes(qr, (0.38 + flash * 1.10) * beamEnv, 0.68, 0.26, vec3(0.82, 0.72, 1.0));
      }
    `,
  },

  /* 6. TIDAL DISRUPTION — Flaming Stellar River & Gargantua Eccentric Accretion Flare */
  6: {
    extra: SEG_HELPER,
    body: `
      vec2 qr = rot2(uAngle + vYaw * 0.55) * q;
      float accTilt = clamp(0.22 + pitchSin * 0.50, 0.11, 0.84);
      float rBh = 0.21;
      float bqr = length(qr) / rBh;
      float tdeEnv = lifeEnv;

      float shadow = (1.0 - smoothstep(0.94, 1.03, bqr)) * tdeEnv;
      solid = mix(solid, vec3(0.004, 0.006, 0.012), shadow);
      solidA = max(solidA, shadow);

      if (p < 0.42) {
        float ap = clamp(p / 0.36, 0.0, 1.0);
        float sEnv = birthEnv * (1.0 - smoothstep(0.28, 0.42, p));
        float sAng = -2.35 + ap * 1.95;
        float sRad = mix(1.28, 0.36, pow(ap, 0.88));
        vec2 sPos = vec2(cos(sAng) * sRad, sin(sAng) * sRad * 0.62);
        vec2 tang = normalize(vec2(-sin(sAng), cos(sAng) * 0.62));
        vec2 dSt = qr - sPos;
        float stretch = 1.0 + pow(ap, 1.6) * 2.8;
        vec2 stLoc = vec2(dot(dSt, tang) / stretch, dot(dSt, vec2(-tang.y, tang.x)) * (1.0 + ap * 0.6));
        float sr = length(stLoc) / 0.13;
        if (sr < 2.2) {
          float sCore = exp(-sr * sr * 2.6);
          vec3 sTex = texture2D(uTexSun, mirrorUv(stLoc * 2.2 + 0.5)).rgb;
          emit += blackbody(0.46 + 0.42 * sCore) * (sCore * (0.80 + 0.50 * sTex.r) + exp(-sr * 2.4) * 0.38) * 1.35 * sEnv;
        }
      }

      float streamEnv = smoothstep(0.10, 0.24, p) * decayEnv;
      if (streamEnv > 0.002) {
        float minD = 9.0, bestU = 0.0;
        float headT = clamp(p * 1.38, 0.0, 1.25);
        float tailT = max(0.0, headT - 0.88);
        vec2 prevPt = vec2(0.0);
        for (int i = 0; i <= 18; i++) {
          float u = float(i) / 18.0;
          float tc = mix(tailT, headT, u);
          float angC = -2.35 + tc * 6.4;
          float radC = 0.22 + 1.08 * exp(-tc * 1.62);
          vec2 pt = vec2(cos(angC) * radC, sin(angC) * radC * 0.58);
          if (i > 0) {
            float hSeg;
            float dSeg = segDist(qr, prevPt, pt, hSeg);
            if (dSeg < minD) { minD = dSeg; bestU = mix((float(i) - 1.0) / 18.0, u, hSeg); }
          }
          prevPt = pt;
        }

        float escEnv = smoothstep(0.32, 0.55, p) * decayEnv;
        float escD = 9.0, escU = 0.0;
        if (escEnv > 0.002) {
          vec2 ePrev = vec2(0.0);
          for (int j = 0; j <= 8; j++) {
            float eu = float(j) / 8.0;
            float et = eu * clamp((p - 0.28) * 1.6, 0.0, 1.0);
            float ea = -0.35 + et * 1.25;
            float er = 0.36 + et * 1.32;
            vec2 ept = vec2(cos(ea) * er, sin(ea) * er * 0.58);
            if (j > 0) {
              float eh;
              float ed = segDist(qr, ePrev, ept, eh);
              if (ed < escD) { escD = ed; escU = mix((float(j) - 1.0) / 8.0, eu, eh); }
            }
            ePrev = ept;
          }
        }

        float ribWidth = mix(0.032, 0.078, bestU) * (0.76 + 0.34 * sin(bestU * PI));
        float sTurb = fbm4(qr * 5.2 - vec2(evT * 1.4, -evT * 0.9) + uSeed * 3.0);
        float sRidge = ridged4(qr * 7.6 + vec2(sTurb * 1.3, -sTurb));
        float streamSpine = exp(-pow(minD / (ribWidth * 0.34), 2.0)) * (0.82 + 0.68 * sRidge);
        float streamPlume = exp(-pow(minD / (ribWidth * 1.62), 2.0)) * (0.28 + 0.90 * sTurb);
        float taper = smoothstep(0.0, 0.14, bestU) * sstepDown(1.0, 0.88, bestU);
        float streamHeat = clamp(0.26 + bestU * 0.56 + sRidge * 0.20, 0.16, 0.90);
        float occStream = smoothstep(0.92, 1.05, bqr);
        emit += blackbody(streamHeat) * (streamSpine * 1.08 + streamPlume * 0.54) * taper * streamEnv * occStream;

        if (escEnv > 0.002) {
          float eWidth = 0.042 + escU * 0.10;
          float eGlow = exp(-pow(escD / eWidth, 2.0)) * (0.30 + 0.80 * sTurb) * (1.0 - escU * 0.72);
          emit += blackbody(0.36 - escU * 0.20) * eGlow * 0.64 * escEnv * occStream;
        }
      }

      float accP = smoothstep(0.34, 0.62, p) * decayEnv;
      if (accP > 0.002 && bqr < 6.2) {
        vec2 bq = qr / rBh;
        vec2 eq = vec2(bq.x - 0.18, bq.y / accTilt);
        float eqR = length(eq);
        float frontCross = sstepDown(0.06, -0.05, bq.y);
        float diskBand = smoothstep(1.16, 1.54, eqR) * sstepDown(4.6, 1.90, eqR) * mix(smoothstep(0.96, 1.05, bqr), 1.0, frontCross);
        float archMask = smoothstep(0.99, 1.15, bqr) * sstepDown(2.40, 1.14, bqr) * smoothstep(0.06, 0.62, abs(bq.y) / max(bqr, 0.16));
        float doppler = clamp(1.0 - 0.44 * (bq.x / max(bqr, 0.32)), 0.38, 1.62);
        float flow = evT * 1.25;
        vec2 rotEq = rot2(flow * (0.95 / pow(max(eqR, 0.85), 0.75)) + eqR * 2.4) * eq;
        float n1 = fbm4(rotEq * 1.5);
        float n2 = fbm4(rotEq * 3.1 + vec2(n1 * 1.6, -n1 * 1.2));

        float dInt = diskBand * (0.34 + 0.82 * n2) * mix(1.18, 0.34, smoothstep(1.3, 4.4, eqR)) * doppler;
        float aInt = archMask * (0.34 + 0.72 * n2) * doppler * 0.74;
        float pRing = exp(-pow((bqr - 1.04) / 0.042, 2.0)) * 1.48 * doppler;
        float shockPt = exp(-length(bq - vec2(1.42, 0.18)) * 2.5) * exp(-pow((p - 0.56) / 0.18, 2.0));

        vec3 diskCol = mix(vec3(0.76, 0.22, 0.05), vec3(1.00, 0.62, 0.22), smoothstep(0.38, 1.05, doppler));
        diskCol = mix(diskCol, vec3(1.00, 0.90, 0.72), smoothstep(1.02, 1.58, doppler));
        vec3 fEm = diskCol * dInt * frontCross * 0.78;
        vec3 eEm = diskCol * (dInt * (1.0 - frontCross) + aInt) * 0.82 + vec3(1.0, 0.76, 0.42) * pRing;
        emit += (fEm + eEm * smoothstep(0.94, 1.02, bqr)) * accP;
        emit += vec3(0.95, 0.96, 1.0) * shockPt * 1.28 * accP;
        emit += opticalSpikes(qr - vec2(1.42, 0.18) * rBh, shockPt * 0.78, 0.50, 0.3, vec3(1.0, 0.84, 0.62));
      }
    `,
  },

  /* 7. COMET BREAKUP — Distinct String-of-Pearls Icy Nuclei + Dual Ion & Dust Tails */
  7: {
    extra: '',
    body: `
      vec2 qr = rot2(uAngle + vYaw * 0.65) * q;
      qr.y /= max(0.58, 1.0 - abs(pitchSin) * 0.38);
      float cometEnv = birthEnv * decayEnv;

      float pathU = p - 0.48;
      vec2 headPos = vec2(pathU * 1.42, -pathU * 0.34 - pathU * pathU * 0.28);
      float splitP = smoothstep(0.14, 0.92, p);
      float fragFlash = exp(-pow((p - 0.26) / 0.070, 2.0));

      vec2 ionDir = normalize(vec2(-0.94, 0.34));
      vec2 ionPerp = vec2(-ionDir.y, ionDir.x);

      vec2 dHead = qr - headPos;
      float alongI = dot(dHead, ionDir);
      float perpI = dot(dHead, ionPerp);
      if (alongI > -0.14 && alongI < 2.25) {
        float dustCurve = perpI - 0.16 * alongI * alongI - 0.08 * alongI;
        float dustW = 0.060 + max(alongI, 0.0) * (0.23 + splitP * 0.12);
        float dNoise = fbm4(vec2(alongI * 3.2 - evT * 1.6, dustCurve * 7.5 + uSeed * 4.0));
        float dustMask = exp(-pow(dustCurve / dustW, 2.0)) * smoothstep(-0.08, 0.12, alongI) * sstepDown(2.15, 0.18, alongI);
        vec3 dustCol = mix(vec3(1.00, 0.92, 0.74), vec3(0.92, 0.64, 0.36), clamp(alongI * 0.55, 0.0, 1.0));
        emit += dustCol * dustMask * (0.32 + 0.78 * dNoise) * 0.62 * cometEnv;

        float ionWave = sin(alongI * 7.8 - evT * 4.8) * 0.018 * alongI;
        float ionW = 0.022 + max(alongI, 0.0) * 0.072;
        float ionFil = ridged4(vec2(alongI * 4.6 - evT * 3.5, (perpI + ionWave) * 19.0 + uSeed * 2.0));
        float ionMask = exp(-sq((perpI + ionWave) / ionW)) * smoothstep(-0.05, 0.08, alongI) * sstepDown(2.25, 0.12, alongI);
        emit += mix(vec3(0.24, 0.80, 1.00), vec3(0.68, 0.96, 1.00), ionFil) * ionMask * (0.38 + 0.96 * ionFil) * 0.84 * cometEnv;
      }

      for (int k = 0; k < 7; k++) {
        float fk = float(k);
        float weight = exp(-fk * 0.24);
        float lag = (fk * 0.165 + fract(fk * 0.37) * 0.035) * splitP * 1.15;
        float lat = ((fk - 2.6) * 0.028 + sin(fk * 2.9 + uSeed * 5.0) * 0.022) * splitP;
        vec2 fPos = headPos + ionDir * lag + ionPerp * (lat + lag * lag * 0.16);
        vec2 df = qr - fPos;
        float fd = length(df);

        float fa = dot(df, ionDir);
        float fp = dot(df, ionPerp) - 0.08 * max(fa, 0.0) * max(fa, 0.0);
        float fLen = (0.28 + weight * 0.48) * (1.0 - splitP * 0.16);
        if (fa > -0.03 && fa < fLen) {
          float fw = (0.010 + weight * 0.012) + max(fa, 0.0) * 0.058;
          float ft = exp(-pow(fp / fw, 2.0)) * smoothstep(-0.015, 0.035, fa) * sstepDown(fLen, 0.04, fa);
          emit += mix(vec3(0.50, 0.92, 1.0), vec3(1.0, 0.90, 0.72), clamp(fa / fLen, 0.0, 1.0)) * ft * (0.28 + weight * 0.34) * cometEnv;
        }

        float comaR = (0.018 + weight * 0.028) * (1.0 + fragFlash * 0.35) * (1.0 - p * 0.20);
        if (fd < comaR * 4.5) {
          float core = exp(-pow(fd / (comaR * 0.30), 2.0)) * (0.95 + weight * 0.95);
          float coma = exp(-fd / comaR) * (0.24 + weight * 0.30);
          emit += (vec3(0.96, 1.0, 1.0) * core + vec3(0.28, 0.90, 0.96) * coma) * cometEnv;
        }
      }

      if (fragFlash > 0.004) {
        emit += opticalSpikes(qr - headPos, fragFlash * 0.88 * cometEnv, 0.54, -0.35, vec3(0.68, 0.96, 1.0));
      }
    `,
  },
};

/**
 * Build the compact fragment shader source for a single cosmic event type (`0..7`).
 */
export function getEventFrag(eventType) {
  const spec = BODIES[eventType] || BODIES[0];
  return `${COMMON_HEAD}\n${spec.extra}\n${MAIN_OPEN}\n${spec.body}\n${MAIN_CLOSE}`;
}
