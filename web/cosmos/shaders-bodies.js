/**
 * Yeaft Cosmos — Ray-Traced Sun, 8-Planet & 3D Procedural Moon WebGL Shaders
 * Physically motivated lighting, close-up terrain micro-relief, sculpted clouds,
 * restrained crisp ocean sheen, night city lights, polar aurora, Saturn 3D Cassini/Encke
 * fine ringlets + pitch-aware ring shadow, adaptive pixel-radius AA, and 5 procedural moon styles.
 */

export const BODY_VERT = `
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

export const BODY_FRAG = `
  precision highp float;
  varying vec2 vLocal;

  uniform int uBodyType;
  uniform float uRadiusRatio;
  uniform float uRadiusPx;
  uniform float uCloseup;
  uniform float uPitch;
  uniform float uTime;
  uniform float uRealTime;
  uniform float uSpin;
  uniform float uTilt;
  uniform float uOblate;
  uniform vec3 uLightDir;
  uniform vec3 uAtmoColor;
  uniform float uAlpha;
  uniform float uHighlight;
  uniform float uMoonStyle;

  uniform sampler2D uTexMain;
  uniform sampler2D uTexNight;
  uniform sampler2D uTexClouds;
  uniform sampler2D uTexRing;

  const float PI = 3.14159265359;

  /* Strictly ascending smoothstep falloff (GLSL ES 1.00 sec 8.3 safe when hi > lo) */
  float sstepDown(float hi, float lo, float x) {
    return 1.0 - smoothstep(lo, hi, x);
  }

  float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }

  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
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

  float fbm3(vec2 p) {
    float v = 0.0, a = 0.5;
    mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 3; i++) {
      v += a * noise2(p);
      p = rot * p * 2.07;
      a *= 0.5;
    }
    return v;
  }

  float fbm4(vec2 p) {
    float v = 0.0, a = 0.5;
    mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 4; i++) {
      v += a * noise2(p);
      p = rot * p * 2.09;
      a *= 0.5;
    }
    return v;
  }

  float ridged3(vec2 p) {
    float v = 0.0, a = 0.52;
    mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 3; i++) {
      float n = 1.0 - abs(noise2(p) * 2.0 - 1.0);
      v += a * n * n;
      p = rot * p * 2.12;
      a *= 0.48;
    }
    return v;
  }

  float ridged4(vec2 p) {
    float v = 0.0, a = 0.52;
    mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 4; i++) {
      float n = 1.0 - abs(noise2(p) * 2.0 - 1.0);
      v += a * n * n;
      p = rot * p * 2.14;
      a *= 0.48;
    }
    return v;
  }

  /* Procedural impact crater heightfield (bowl + raised rim) */
  float craterLayer(vec2 p, float scale) {
    vec2 g = p * scale;
    vec2 id = floor(g);
    vec2 f = fract(g);
    float h = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec2 cell = id + vec2(float(dx), float(dy));
        vec2 rnd = hash22(cell);
        if (rnd.x < 0.46) continue;
        vec2 cPos = vec2(float(dx), float(dy)) + 0.18 + rnd * 0.64;
        float d = length(f - cPos);
        float rad = 0.16 + 0.24 * fract(rnd.x * 17.3);
        float u = d / rad;
        if (u < 1.38) {
          float bowl = -sstepDown(1.0, 0.15, u) * 0.62;
          float rim = exp(-pow((u - 0.98) / 0.14, 2.0)) * 0.34;
          h += (bowl + rim) * (0.55 + 0.45 * rnd.y);
        }
      }
    }
    return h;
  }

  vec3 rotX(vec3 v, float a) {
    float c = cos(a), s = sin(a);
    return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
  }

  vec2 sphereUv(vec3 n, float spin, float tilt) {
    float ct = cos(tilt), st = sin(tilt);
    vec3 nr = vec3(n.x * ct - n.y * st, n.x * st + n.y * ct, n.z);
    return vec2(fract((atan(nr.x, nr.z) + spin) / (2.0 * PI) + 0.5), clamp(0.5 - asin(clamp(nr.y, -1.0, 1.0)) / PI, 0.002, 0.998));
  }

  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  vec3 getRingNorm(bool isUranus, float pitch) {
    vec3 baseN = isUranus ? normalize(vec3(0.88, 0.16, 0.44)) : normalize(vec3(-0.18, 0.85, 0.49));
    vec3 n = normalize(rotX(baseN, pitch * (isUranus ? 0.55 : 0.72)));
    if (abs(n.z) < 0.12) n = normalize(vec3(n.x, n.y, n.z >= 0.0 ? 0.12 : -0.12));
    return n;
  }

  vec4 evalRing(vec2 p, vec3 L, float oblate, bool isUranus, float realTime, vec3 rNorm, float closeup) {
    if (abs(rNorm.z) < 0.04) return vec4(0.0);
    vec3 hit = vec3(p, -(p.x * rNorm.x + p.y * rNorm.y) / rNorm.z);
    float rDist = length(hit);
    float rInner = isUranus ? 1.44 : 1.24;
    float rOuter = isUranus ? 1.90 : 2.44;
    if (rDist < rInner || rDist > rOuter) return vec4(0.0);

    float u = (rDist - rInner) / (rOuter - rInner);
    vec4 ringTex = texture2D(uTexRing, vec2(clamp(u, 0.005, 0.995), 0.5));
    float alpha = ringTex.a;
    vec3 rCol = ringTex.rgb * 1.16;

    if (!isUranus) {
      float ang = atan(hit.y, hit.x) + realTime * (0.28 / max(rDist, 1.0));
      float wave = 0.94 + 0.12 * sin(ang * 18.0 + u * 45.0) * sin(u * 90.0 - realTime * 1.4);
      if (closeup > 0.02) {
        /* High-frequency Cassini & Encke concentric ringlets + crystalline ice shimmer */
        float ringlets = 0.82 + 0.18 * sin(u * 210.0) * cos(u * 68.0 + 0.6)
                       + 0.10 * sin(u * 460.0 - 1.2);
        float enckeGap = 1.0 - exp(-pow((u - 0.845) / 0.011, 2.0)) * 0.72;
        float cassiniGap = 1.0 - exp(-pow((u - 0.585) / 0.024, 2.0)) * 0.55;
        float iceSparkle = pow(noise2(vec2(u * 180.0, ang * 26.0)), 4.0) * 0.32 * closeup;
        wave *= mix(1.0, ringlets * enckeGap * cassiniGap, closeup);
        rCol += vec3(1.0, 0.95, 0.84) * iceSparkle;
        alpha *= mix(1.0, clamp(0.76 + 0.34 * ringlets, 0.25, 1.12) * enckeGap, closeup * 0.72);
      }
      rCol *= wave;
    } else {
      float epsRing = exp(-pow((u - 0.78) / 0.048, 2.0)) * 0.54;
      float delRing = exp(-pow((u - 0.54) / 0.028, 2.0)) * 0.26 * (0.4 + 0.6 * closeup);
      float gamRing = exp(-pow((u - 0.36) / 0.036, 2.0)) * 0.24;
      float fineDust = closeup > 0.02 ? (0.06 * sin(u * 240.0) * 0.5 + 0.06) * smoothstep(0.05, 0.25, u) * sstepDown(0.98, 0.80, u) * closeup : 0.0;
      alpha = clamp(epsRing + delRing + gamRing + fineDust, 0.0, 0.86);
      rCol = mix(vec3(0.66, 0.86, 0.98), vec3(0.86, 0.96, 1.0), smoothstep(0.35, 0.82, u));
    }

    vec3 sHit = vec3(hit.x, hit.y / oblate, hit.z);
    vec3 sL = normalize(vec3(L.x, L.y / oblate, L.z));
    float b = dot(sHit, sL);
    float disc = b * b - (dot(sHit, sHit) - 1.0);
    float shadowSoft = mix(0.11, 0.055, closeup);
    float shadow = (disc > 0.0 && b < 0.0) ? mix(0.05, 1.0, sstepDown(shadowSoft, 0.0, sqrt(disc))) : 1.0;
    float edgeFeather = smoothstep(0.0, 0.025, u) * sstepDown(1.0, 0.97, u);
    return vec4(rCol * (0.60 + 0.40 * abs(dot(rNorm, L))) * shadow, clamp(alpha * 0.96 * edgeFeather, 0.0, 1.0));
  }

  void main() {
    vec2 p = vLocal / uRadiusRatio;

    /* Type 0: Living Solar Photosphere + Boiling Granules + Prominences + Flowing Corona */
    if (uBodyType == 0) {
      float r = length(p);
      float ang = atan(p.y, p.x);
      float t = uRealTime;
      float streamer = 0.78 + 0.24 * noise2(vec2(ang * 5.0 + t * 0.12, r * 1.4 - t * 0.18))
                     + 0.14 * noise2(vec2(ang * 11.0 - t * 0.09, r * 2.2 - t * 0.24));
      float corona = (exp(-max(r - 0.97, 0.0) * 3.5) * 0.85 + exp(-max(r - 0.94, 0.0) * 1.65) * 0.42 * streamer + pow(1.0 / max(r, 0.95), 2.75) * 0.22) * sstepDown(3.85, 1.02, r);
      float prom = exp(-pow((r - 1.055) / 0.052, 2.0)) * smoothstep(0.56, 0.88, noise2(vec2(ang * 7.5 + t * 0.08, t * 0.16))) * 0.78;
      float anamorphic = exp(-abs(p.y) * 9.5) * exp(-abs(p.x) * 0.88) * sstepDown(3.6, 0.9, abs(p.x)) * 0.18;

      vec3 coronaCol = mix(vec3(0.98, 0.44, 0.12), vec3(1.00, 0.94, 0.80), exp(-max(r - 0.97, 0.0) * 2.8));
      vec3 coronaLight = coronaCol * corona + vec3(1.0, 0.30, 0.08) * prom + vec3(1.0, 0.86, 0.68) * anamorphic;
      vec3 col = coronaLight;
      float a = clamp(max(corona, prom + anamorphic) * 0.92, 0.0, 1.0);

      if (r <= 1.04) {
        float z = sqrt(max(1.0 - min(r, 1.0) * min(r, 1.0), 0.0));
        vec3 n = vec3(p.x, p.y, z);
        vec2 uv1 = sphereUv(n, uSpin + t * 0.015, 0.11);
        vec2 uv2 = sphereUv(n, -uSpin * 0.62 + 0.37 - t * 0.011, -0.07);
        vec2 warp = vec2(noise2(uv1 * 18.0 + vec2(t * 0.12, -t * 0.08)) - 0.5, noise2(uv1 * 18.0 + vec2(-t * 0.09, t * 0.11)) - 0.5) * 0.012;
        vec3 gran = mix(texture2D(uTexMain, fract(uv1 + warp)).rgb, texture2D(uTexMain, fract(uv2 * 1.55 + vec2(t * 0.008, 0.0))).rgb, 0.36);
        vec3 photo = pow(gran, vec3(0.84)) * vec3(1.42, 1.10, 0.72) * (0.24 + 0.76 * pow(z, 0.56))
                   + vec3(0.56, 0.44, 0.26) * pow(z, 2.2) + vec3(1.0, 0.36, 0.08) * pow(1.0 - z, 2.5) * 0.85;
        float aa = sstepDown(1.015, 0.945, r);
        col = mix(coronaLight, photo, aa);
        a = clamp(max(aa, max(corona, prom + anamorphic) * 0.95), 0.0, 1.0);
      }
      gl_FragColor = vec4(col * a * uAlpha, a * uAlpha);
      return;
    }

    /* Type 9: Procedural 3D Natural Moons (Moon, Io, Europa, Enceladus, Titan, Phobos, Triton...) */
    if (uBodyType == 9) {
      float rM = length(p);
      float safeRadM = max(uRadiusPx, 6.0);
      float pxStepM = clamp(1.35 / safeRadM, 0.004, 0.14);
      vec3 L = normalize(uLightDir);
      if (rM > 1.20) {
        gl_FragColor = vec4(0.0);
        return;
      }
      vec3 colM = vec3(0.0);
      float alphaM = 0.0;
      if (rM <= 1.0 + pxStepM * 0.5) {
        float rc = min(rM, 1.0);
        float z = sqrt(max(1.0 - rc * rc, 0.0));
        vec3 n = normalize(vec3(p.x, p.y, z));
        vec3 nSample = abs(uPitch) > 0.001 ? normalize(rotX(n, uPitch)) : n;
        vec2 uv = sphereUv(nSample, uSpin, uTilt);
        vec2 mp = uv * vec2(2.0, 1.0);
        float detailM = clamp(smoothstep(5.0, 42.0, uRadiusPx), 0.0, 1.0);
        vec3 baseCol = vec3(0.76, 0.77, 0.79);
        float bumpScale = 0.75;
        float hC = 0.0, hX = 0.0, hY = 0.0;
        float eps = 0.0045;

        if (uMoonStyle < 0.5) {
          /* Lunar / Ganymede: dark basalt maria + bright highlands + multi-scale craters */
          float maria = smoothstep(0.46, 0.68, fbm3(mp * 3.2 + vec2(1.4, 2.1)));
          float regolith = fbm3(mp * 14.0);
          float c1 = craterLayer(mp, 5.5);
          float c2 = detailM > 0.1 ? craterLayer(mp + 3.7, 15.0) * 0.62 * detailM : 0.0;
          hC = c1 + c2 + regolith * 0.24;
          hX = craterLayer(mp + vec2(eps, 0.0), 5.5) + (detailM > 0.1 ? craterLayer(mp + vec2(eps, 0.0) + 3.7, 15.0) * 0.62 * detailM : 0.0) + fbm3((mp + vec2(eps, 0.0)) * 14.0) * 0.24;
          hY = craterLayer(mp + vec2(0.0, eps), 5.5) + (detailM > 0.1 ? craterLayer(mp + vec2(0.0, eps) + 3.7, 15.0) * 0.62 * detailM : 0.0) + fbm3((mp + vec2(0.0, eps)) * 14.0) * 0.24;
          vec3 highland = vec3(0.84, 0.84, 0.82) * (0.90 + 0.16 * regolith);
          vec3 mareCol = vec3(0.46, 0.48, 0.52) * (0.86 + 0.20 * regolith);
          baseCol = mix(highland, mareCol, maria * 0.78);
          baseCol *= (1.0 + clamp(c1 * 0.25 + c2 * 0.20, -0.22, 0.24));
          bumpScale = mix(0.85, 1.45, detailM);
        } else if (uMoonStyle < 1.5) {
          /* Io: sulfur yellow/orange volcanic plains + dark calderas */
          float sulf = fbm3(mp * 5.2 + vec2(2.3, 0.7));
          float cald = smoothstep(0.68, 0.84, noise2(mp * 13.0));
          hC = sulf * 0.35 - cald * 0.45;
          hX = fbm3((mp + vec2(eps, 0.0)) * 5.2 + vec2(2.3, 0.7)) * 0.35;
          hY = fbm3((mp + vec2(0.0, eps)) * 5.2 + vec2(2.3, 0.7)) * 0.35;
          baseCol = mix(vec3(0.95, 0.84, 0.36), vec3(0.86, 0.46, 0.16), smoothstep(0.32, 0.72, sulf));
          baseCol = mix(baseCol, vec3(0.28, 0.14, 0.09), cald * 0.82);
          bumpScale = 0.65;
        } else if (uMoonStyle < 2.5) {
          /* Europa / Enceladus / Triton: high-albedo icy crust + reddish tectonic lineae cracks */
          float iceN = fbm3(mp * 7.0);
          float crackA = 1.0 - abs(noise2(mp * vec2(11.0, 16.0) + vec2(iceN * 1.4)) * 2.0 - 1.0);
          float crackB = 1.0 - abs(noise2(mp * vec2(18.0, 9.0) + vec2(-iceN * 1.2)) * 2.0 - 1.0);
          float lineae = pow(max(crackA, crackB), 9.0);
          hC = iceN * 0.22 - lineae * 0.38;
          hX = fbm3((mp + vec2(eps, 0.0)) * 7.0) * 0.22;
          hY = fbm3((mp + vec2(0.0, eps)) * 7.0) * 0.22;
          baseCol = mix(vec3(0.88, 0.91, 0.96), vec3(0.76, 0.83, 0.92), iceN * 0.55);
          baseCol = mix(baseCol, vec3(0.62, 0.38, 0.28), lineae * 0.68);
          bumpScale = 0.55;
        } else if (uMoonStyle < 3.5) {
          /* Titan: golden-amber dense nitrogen-methane haze atmosphere */
          float band = fbm3(vec2(mp.x * 4.0, mp.y * 8.5));
          baseCol = mix(vec3(0.88, 0.64, 0.30), vec3(0.98, 0.80, 0.48), 0.45 + 0.55 * band);
          bumpScale = 0.0;
        } else {
          /* Phobos / Deimos / Callisto: dark carbonaceous heavily cratered rock */
          float c1 = craterLayer(mp, 6.2);
          float c2 = detailM > 0.1 ? craterLayer(mp + 5.1, 16.0) * 0.65 * detailM : 0.0;
          hC = c1 + c2;
          hX = craterLayer(mp + vec2(eps, 0.0), 6.2);
          hY = craterLayer(mp + vec2(0.0, eps), 6.2);
          baseCol = vec3(0.46, 0.43, 0.40) * (0.85 + 0.30 * fbm3(mp * 9.0) + c1 * 0.22);
          bumpScale = 1.25;
        }

        vec3 shadeN = n;
        if (bumpScale > 0.01) {
          vec3 tanX = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(0.001, 0.0, 0.0));
          vec3 tanY = normalize(cross(n, tanX));
          shadeN = normalize(n + tanX * ((hC - hX) * bumpScale) + tanY * ((hC - hY) * bumpScale));
        }
        float ndlM = dot(shadeN, L);
        float diffM = uMoonStyle > 2.5 && uMoonStyle < 3.5
          ? pow(clamp((dot(n, L) + 0.18) / 1.18, 0.0, 1.0), 0.72)
          : pow(clamp((ndlM + 0.04) / 1.04, 0.0, 1.0), 0.82);
        colM = baseCol * (0.045 + diffM * 1.22);
        if (uMoonStyle > 2.5 && uMoonStyle < 3.5) {
          float rimT = pow(1.0 - z, 3.2) * smoothstep(-0.15, 0.7, dot(n, L));
          colM += vec3(1.0, 0.78, 0.42) * rimT * 0.55;
        }
        alphaM = sstepDown(1.0 + pxStepM * 0.35, 1.0 - pxStepM * 1.1, rM);
      }
      /* Titan subtle atmospheric haze halo */
      if (uMoonStyle > 2.5 && uMoonStyle < 3.5 && rM > 0.96) {
        float haze = exp(-max(rM - 0.995, 0.0) * 18.0) * 0.34 * sstepDown(1.20, 1.02, rM);
        vec3 premul = colM * alphaM + vec3(1.0, 0.76, 0.38) * haze * (1.0 - alphaM);
        alphaM = clamp(alphaM + haze * (1.0 - alphaM), 0.0, 1.0);
        colM = alphaM > 0.001 ? premul / alphaM : vec3(0.0);
      }
      gl_FragColor = vec4(colM * alphaM * uAlpha, alphaM * uAlpha);
      return;
    }

    /* Planets (Types 1..8) */
    float oblate = uOblate;
    vec2 ps = vec2(p.x, p.y / oblate);
    float rSphere = length(ps);
    vec3 L = normalize(uLightDir);
    float closeup = clamp(uCloseup, 0.0, 1.0);
    float terrain = smoothstep(0.28, 1.25, uCloseup);
    float micro = smoothstep(0.65, 1.45, uCloseup);
    float pxStep = clamp(1.35 / max(uRadiusPx, 12.0), 0.0006, 0.032);

    bool hasRings = (uBodyType == 6 || uBodyType == 7);
    bool isUranus = (uBodyType == 7);
    vec3 rNorm = hasRings ? getRingNorm(isUranus, uPitch) : vec3(0.0, 0.0, 1.0);
    vec4 ringSample = hasRings ? evalRing(p, L, oblate, isUranus, uRealTime, rNorm, closeup) : vec4(0.0);
    float ringZ = hasRings ? -(p.x * rNorm.x + p.y * rNorm.y) / rNorm.z : -1.0;

    vec3 planetCol = vec3(0.0);
    float planetAlpha = 0.0;

    if (rSphere <= 1.24) {
      if (rSphere <= 1.0 + pxStep * 0.6) {
        float rc = min(rSphere, 1.0);
        float z = sqrt(max(1.0 - rc * rc, 0.0));
        vec3 n = normalize(vec3(ps.x, ps.y * oblate, z));
        vec3 nSample = abs(uPitch) > 0.001 ? normalize(rotX(n, uPitch)) : n;
        vec2 uv = sphereUv(nSample, uSpin, uTilt);
        if (uBodyType == 5) {
          float jetShear = sin(uv.y * 22.0) * 0.0045 * sin(uRealTime * 0.25);
          if (closeup > 0.02) {
            float eddy = (noise2(vec2(uv.x * 38.0, uv.y * 32.0 + uRealTime * 0.015)) - 0.5) * 0.006 * closeup;
            jetShear += eddy;
          }
          uv.x = fract(uv.x + jetShear);
        }

        vec3 tex = texture2D(uTexMain, uv).rgb;
        float sEps = mix(0.0018, 0.0011, closeup);
        vec3 texR = texture2D(uTexMain, vec2(fract(uv.x + sEps), uv.y)).rgb;
        vec3 texL = texture2D(uTexMain, vec2(fract(uv.x - sEps), uv.y)).rgb;
        vec3 texD = texture2D(uTexMain, vec2(uv.x, clamp(uv.y + sEps, 0.002, 0.998))).rgb;
        vec3 texU = texture2D(uTexMain, vec2(uv.x, clamp(uv.y - sEps, 0.002, 0.998))).rgb;
        vec3 texBlur = (texR + texL + texD + texU) * 0.25;
        tex = clamp(tex + (tex - texBlur) * mix(0.36, 0.62, closeup), 0.0, 1.0);

        float ndl = dot(n, L);
        vec3 shadeN = n;
        bool rockyRelief = (uBodyType == 1 || uBodyType == 4 || (uBodyType == 3 && closeup > 0.04));
        if (rockyRelief && ndl > -0.14) {
          float hC = luma(tex);
          float hR = luma(texR);
          float hU = luma(texU);
          vec3 tanX = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(0.001, 0.0, 0.0));
          vec3 tanY = normalize(cross(n, tanX));
          float bumpAmt = (uBodyType == 1)
            ? mix(0.68, 1.24, closeup)
            : ((uBodyType == 4) ? mix(0.54, 1.04, closeup) : 0.44 * closeup);
          if (uBodyType == 3) {
            float isLand = 1.0 - smoothstep(0.03, 0.14, tex.b - max(tex.r, tex.g) * 0.86);
            bumpAmt *= isLand;
          }
          float microX = 0.0, microY = 0.0;
          if (closeup > 0.04) {
            vec2 tUv = uv * vec2(2.0, 1.0);
            if (uBodyType == 1) {
              /* Mercury: 3-tier impact craters + rugged regolith micro-grain */
              float cA = craterLayer(tUv, 14.0);
              float cB = terrain > 0.03 ? craterLayer(tUv + 2.7, 38.0) * 0.78 * terrain : 0.0;
              float cC = micro > 0.03 ? craterLayer(tUv + 6.1, 92.0) * 0.55 * micro : 0.0;
              float cAx = craterLayer(tUv + vec2(0.0018, 0.0), 14.0);
              float cAy = craterLayer(tUv + vec2(0.0, 0.0018), 14.0);
              float ridge = ridged4(tUv * 28.0);
              float grit = micro > 0.03 ? (fbm3(tUv * 240.0) - 0.5) * 0.24 * micro : 0.0;
              microX = (cA - cAx) * (1.45 + 1.8 * terrain) + (cB + cC) * 0.42 + grit * 0.5;
              microY = (cA - cAy) * (1.45 + 1.8 * terrain) + (ridge - 0.42) * 0.32 * terrain - grit * 0.4;
              tex *= (0.93 + clamp((cA + cB + cC) * 0.28 + (ridge - 0.42) * 0.22 + grit, -0.24, 0.28) * closeup);
            } else if (uBodyType == 4) {
              /* Mars: Valles Marineris canyon ridges + craters + wind-carved dune ripples */
              float cM = craterLayer(tUv + 1.3, 12.0);
              float cM2 = terrain > 0.04 ? craterLayer(tUv + 4.9, 36.0) * 0.65 * terrain : 0.0;
              float rM = ridged4(tUv * 24.0);
              float rMx = ridged4((tUv + vec2(0.0018, 0.0)) * 24.0);
              float rMy = ridged4((tUv + vec2(0.0, 0.0018)) * 24.0);
              float fineR = terrain > 0.04 ? ridged3(tUv * 86.0) * terrain : 0.0;
              float dune = micro > 0.04 ? (noise2(tUv * vec2(260.0, 120.0)) - 0.5) * 0.26 * micro : 0.0;
              microX = (rM - rMx) * (1.85 + 2.5 * terrain) + (cM + cM2) * 0.34 + dune;
              microY = (rM - rMy) * (1.85 + 2.5 * terrain) + (fineR - 0.45) * 0.38 - (cM * 0.28);
              tex *= (0.93 + clamp((rM - 0.44) * 0.32 + (fineR - 0.42) * 0.18 + (cM + cM2) * 0.22 + dune * 0.36, -0.24, 0.28) * closeup);
            } else if (uBodyType == 3 && terrain > 0.02) {
              /* Earth continents: subtle realistic orbital mountain chains, basins & micro-grain */
              float isLand = 1.0 - smoothstep(0.025, 0.13, tex.b - max(tex.r, tex.g) * 0.86);
              if (isLand > 0.04) {
                float mtn1 = ridged3(tUv * 54.0);
                float mtnX = ridged3((tUv + vec2(0.0014, 0.0)) * 54.0);
                float mtnY = ridged3((tUv + vec2(0.0, 0.0014)) * 54.0);
                float mtn2 = terrain > 0.18 ? (1.0 - abs(noise2(tUv * 155.0) * 2.0 - 1.0)) * terrain : 0.0;
                float fineGrain = noise2(tUv * 310.0) * 0.62 + noise2(tUv * 620.0) * 0.38;
                float elevWeight = 0.42 + 0.58 * smoothstep(0.26, 0.72, mtn1);
                microX = (mtn1 - mtnX) * (1.35 + 0.85 * micro) * terrain * isLand * elevWeight;
                microY = (mtn1 - mtnY) * (1.35 + 0.85 * micro) * terrain * isLand * elevWeight;
                float landMod = ((mtn1 - 0.46) * 0.16 + (mtn2 - 0.48) * 0.09 + (fineGrain - 0.5) * 0.15);
                tex *= (1.0 + landMod * terrain * isLand);
                float peak = smoothstep(0.70, 0.90, mtn1 * 0.78 + mtn2 * 0.28) * smoothstep(0.32, 0.66, luma(tex)) * terrain * isLand;
                tex = mix(tex, vec3(0.93, 0.96, 0.99), peak * 0.28);
              }
            }
          }
          shadeN = normalize(n + tanX * ((hC - hR) * bumpAmt + microX) + tanY * ((hC - hU) * bumpAmt + microY));
        }

        /* Procedural micro-detail for Venus / Gas / Ice giants at closeup & terrain zoom */
        if (closeup > 0.02) {
          float detailGain = closeup + terrain * 0.75 + micro * 0.35;
          if (uBodyType == 2) {
            float sw = fbm4(vec2(fract(uv.x + uRealTime * 0.006) * 26.0 + sin(uv.y * 18.0) * 0.9, uv.y * 32.0));
            float swFine = terrain > 0.05 ? (fbm3(vec2(uv.x * 110.0, uv.y * 90.0)) - 0.5) * 0.14 * terrain : 0.0;
            tex = mix(tex, tex * (0.86 + 0.28 * sw + swFine) + vec3(0.05, 0.036, 0.012) * sw, min(0.82, detailGain * 0.48));
          } else if (uBodyType == 5) {
            float warp = fbm3(vec2(uv.x * 24.0, uv.y * 38.0)) * 0.065;
            float bands = fbm4(vec2((uv.x + warp) * 44.0 + sin(uv.y * 54.0) * 0.78, uv.y * 68.0));
            float fineTurbulence = terrain > 0.05 ? (fbm3(vec2((uv.x - warp) * 145.0, uv.y * 190.0)) - 0.48) * 0.18 * terrain : 0.0;
            tex *= (1.0 + ((bands - 0.48) * 0.24 + fineTurbulence) * min(1.5, detailGain));
          } else if (uBodyType == 6) {
            float sBand = sin(uv.y * 148.0) * 0.038 + (fbm4(vec2(uv.x * 30.0, uv.y * 78.0)) - 0.5) * 0.11;
            float sFine = terrain > 0.05 ? (fbm3(vec2(uv.x * 110.0, uv.y * 210.0)) - 0.5) * 0.09 * terrain : 0.0;
            tex *= (1.0 + (sBand + sFine) * min(1.45, detailGain));
          } else if (uBodyType == 7) {
            float iceHaze = sin(uv.y * 64.0) * 0.032 + (fbm4(vec2(uv.x * 24.0, uv.y * 44.0)) - 0.5) * 0.085;
            tex *= (1.0 + iceHaze * min(1.35, detailGain));
          } else if (uBodyType == 8) {
            float wisp = smoothstep(0.54, 0.84, fbm4(vec2(uv.x * 34.0 + uRealTime * 0.014, uv.y * 56.0)));
            float fineWisp = terrain > 0.05 ? smoothstep(0.58, 0.88, fbm3(vec2(uv.x * 125.0 + uRealTime * 0.02, uv.y * 165.0))) * 0.22 * terrain : 0.0;
            tex = mix(tex, vec3(0.80, 0.93, 1.0), (wisp * 0.36 + fineWisp) * min(1.3, detailGain) * smoothstep(0.08, 0.32, abs(uv.y - 0.5) * 2.0));
          }
        }

        float ndlRelief = dot(shadeN, L);
        float diff = (uBodyType == 1)
          ? pow(clamp(ndlRelief * 1.15, 0.0, 1.0), 0.76)
          : ((uBodyType == 2) ? pow(clamp((ndl + 0.16) / 1.16, 0.0, 1.0), 0.74) : pow(clamp((ndlRelief + 0.075) / 1.075, 0.0, 1.0), 0.84));

        float nightFloor = 0.048 + 0.032 * uHighlight + 0.012 * closeup;
        vec3 lit = tex * (nightFloor + diff * 1.22);
        if (uBodyType >= 5) lit *= (0.74 + 0.26 * pow(z, 0.44));

        if (uBodyType == 3) {
          vec2 uvCloud = sphereUv(nSample, uSpin * 1.24 + uRealTime * 0.012 + 0.12, uTilt);
          float clouds = texture2D(uTexClouds, uvCloud).r;
          float cDetail = 0.5;
          if (closeup > 0.02 && clouds > 0.03) {
            vec2 cUv = uvCloud * vec2(2.0, 1.0);
            float cMacro = fbm3(cUv * 44.0 + vec2(uRealTime * 0.008, 0.0));
            cDetail = terrain > 0.04 ? (noise2(cUv * 155.0 - vec2(cMacro * 0.6)) * 0.62 + noise2(cUv * 360.0) * 0.38) : 0.5;
            float sculpted = smoothstep(0.14, 0.78, clouds * (0.74 + 0.52 * cMacro) + (cDetail - 0.48) * 0.36 * terrain);
            clouds = mix(clouds, sculpted, clamp(closeup * 0.75 + terrain * 0.25, 0.0, 0.94));
          }
          float cloudLit = diff;
          if (ndl > -0.06 && clouds > 0.04) {
            float cEps = mix(0.0028, 0.0014, closeup);
            float cNext = texture2D(uTexClouds, vec2(fract(uvCloud.x + cEps), uvCloud.y)).r;
            float cRelief = (clouds - cNext) * mix(0.32, 0.56, closeup) + (cDetail - 0.5) * 0.38 * terrain;
            cloudLit = clamp(diff + cRelief * smoothstep(-0.05, 0.35, ndl), 0.0, 1.20);
          }
          if (diff > 0.02) {
            vec2 uvShadow = sphereUv(nSample, uSpin * 1.24 + uRealTime * 0.012 + 0.114 - L.x * mix(0.0048, 0.0078, closeup), uTilt);
            lit *= (1.0 - texture2D(uTexClouds, uvShadow).r * mix(0.32, 0.42, closeup) * diff);
          }
          float isOcean = smoothstep(0.03, 0.15, tex.b - max(tex.r, tex.g) * 0.86);
          if (isOcean > 0.04 && terrain > 0.05) {
            float swell = noise2(uv * vec2(210.0, 105.0) + vec2(uRealTime * 0.06, 0.0));
            lit *= (1.0 + (swell - 0.5) * 0.07 * isOcean * terrain);
          }
          /* Restrained ocean micro-glint (zero blown-out white center glare on close-up) */
          float spec = 0.0;
          if (ndl > 0.02 && isOcean > 0.04) {
            vec3 halfVec = normalize(L + vec3(0.0, 0.0, 1.0));
            float specPow = mix(84.0, 168.0, closeup);
            spec = pow(max(dot(n, halfVec), 0.0), specPow) * isOcean * (1.0 - clouds * 0.90) * smoothstep(0.02, 0.30, ndl);
            if (closeup > 0.02 && spec > 0.005) {
              spec *= (0.72 + 0.46 * noise2(uv * vec2(320.0, 160.0) + vec2(uRealTime * 0.22, 0.0)));
            }
          }
          lit = mix(lit, vec3(0.97, 0.985, 1.0) * (nightFloor + cloudLit * 1.16), clouds * mix(0.80, 0.74, terrain));
          lit += vec3(1.0, 0.95, 0.88) * spec * mix(0.24, 0.075, closeup);
          float nightMask = sstepDown(0.06, -0.16, ndl);
          if (nightMask > 0.01) {
            vec3 nightTex = texture2D(uTexNight, uv).rgb;
            lit += pow(nightTex, vec3(mix(1.12, 0.96, closeup))) * vec3(1.65, 1.14, 0.62) * nightMask * (1.0 - clouds * 0.52) * mix(1.32, 1.72, closeup) * (0.92 + 0.08 * sin(uRealTime * 1.6));
          }
          lit += vec3(0.98, 0.44, 0.16) * exp(-pow((ndl - 0.005) / 0.088, 2.0)) * (1.0 - z * 0.32) * mix(0.22, 0.34, closeup);
          if (closeup > 0.15) {
            float lat = abs(uv.y - 0.5) * 2.0;
            if (lat > 0.62 && lat < 0.92) {
              float oval = exp(-pow((lat - 0.78) / 0.055, 2.0));
              float curtain = smoothstep(0.38, 0.82, noise2(vec2(uv.x * 20.0 + uRealTime * 0.08, lat * 20.0 - uRealTime * 0.12)) * (0.75 + 0.25 * sin(uv.x * 64.0 + uRealTime * 0.5)));
              lit += vec3(0.18, 0.92, 0.64) * oval * curtain * (0.35 + 0.65 * nightMask) * 0.34 * smoothstep(0.15, 0.75, closeup);
            }
          }
        }

        if (uBodyType == 4 && closeup > 0.02) {
          lit += vec3(0.96, 0.50, 0.28) * exp(-pow((ndl - 0.02) / 0.11, 2.0)) * (1.0 - z * 0.35) * 0.18 * closeup;
        }

        if (uBodyType == 6) {
          float denom = dot(rNorm, L);
          if (abs(denom) > 0.02) {
            float tRing = -dot(n, rNorm) / denom;
            if (tRing > 0.0) {
              float rr = length(n + L * tRing);
              if (rr > 1.24 && rr < 2.44) {
                lit *= (1.0 - texture2D(uTexRing, vec2((rr - 1.24) / 1.20, 0.5)).a * 0.64 * smoothstep(-0.05, 0.12, ndl));
              }
            }
          }
        }

        if (uBodyType != 1) {
          float fresnel = pow(1.0 - z, mix(3.6, 4.2, closeup));
          float sunRim = smoothstep(-0.12, 0.62, ndl);
          float rimBoost = (uBodyType == 3) ? 0.74 : ((uBodyType == 4 || uBodyType == 5) ? 0.26 : 0.38);
          lit += uAtmoColor * fresnel * (0.04 + sunRim * rimBoost + uHighlight * mix(0.36, 0.16, closeup));
        } else if (uHighlight > 0.01) {
          lit += vec3(0.78, 0.88, 1.0) * pow(1.0 - z, 3.8) * uHighlight * mix(0.26, 0.12, closeup);
        }

        planetCol = lit;
        planetAlpha = sstepDown(1.0 + pxStep * 0.35, 1.0 - pxStep * 1.15, rSphere);
      }

      /* Smoothly feathered exterior atmospheric halo (zero hard cutoff ring) */
      float edgeFade = sstepDown(1.24, 1.03, rSphere);
      float hlScale = mix(1.0, 0.42, closeup);
      if (uBodyType != 1 && rSphere > 1.0 - pxStep * 1.6) {
        float sunSide = smoothstep(-0.18, 0.72, dot(vec3(normalize(ps + vec2(0.0001)), 0.22), L));
        float atmoStrength = (uBodyType == 3) ? 0.44 : ((uBodyType == 2 || uBodyType == 7 || uBodyType == 8) ? 0.24 : 0.15);
        float falloff = mix(18.0, 26.0, closeup);
        float outerAtmo = (exp(-max(rSphere - 0.996, 0.0) * falloff) * atmoStrength * sunSide
                        + uHighlight * hlScale * exp(-max(rSphere - 0.996, 0.0) * 14.0) * 0.24) * edgeFade;
        vec3 haloCol = uAtmoColor * (0.76 + 0.46 * sunSide);
        vec3 premulPlanet = planetCol * planetAlpha + haloCol * outerAtmo * (1.0 - planetAlpha);
        planetAlpha = clamp(planetAlpha + outerAtmo * (1.0 - planetAlpha), 0.0, 1.0);
        planetCol = planetAlpha > 0.001 ? premulPlanet / planetAlpha : vec3(0.0);
      } else if (uBodyType == 1 && uHighlight > 0.01 && rSphere > 1.0 - pxStep * 1.6) {
        float selHalo = uHighlight * hlScale * exp(-max(rSphere - 0.996, 0.0) * 14.0) * 0.22 * edgeFade;
        vec3 premulPlanet = planetCol * planetAlpha + vec3(0.80, 0.90, 1.0) * selHalo * (1.0 - planetAlpha);
        planetAlpha = clamp(planetAlpha + selHalo * (1.0 - planetAlpha), 0.0, 1.0);
        planetCol = planetAlpha > 0.001 ? premulPlanet / planetAlpha : vec3(0.0);
      }
    }

    vec3 outPremul = planetCol * planetAlpha;
    float outAlpha = planetAlpha;
    if (ringSample.a > 0.002) {
      if (ringZ < 0.0) {
        outPremul = outPremul + ringSample.rgb * ringSample.a * (1.0 - planetAlpha);
        outAlpha = planetAlpha + ringSample.a * (1.0 - planetAlpha);
      } else {
        outPremul = ringSample.rgb * ringSample.a + outPremul * (1.0 - ringSample.a);
        outAlpha = ringSample.a + outAlpha * (1.0 - ringSample.a);
      }
    }
    gl_FragColor = vec4(outPremul * uAlpha, outAlpha * uAlpha);
  }
`;
