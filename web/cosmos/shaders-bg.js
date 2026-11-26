/**
 * Yeaft Cosmos — WebGL Background Skybox, Galaxy, Cosmic Web, Gargantua Black Hole & Particle Shaders
 *
 * Renders the full 360° ESO Milky Way + Hubble Veil Nebula + JWST Deep Field spherical skybox,
 * multi-octave 3D parallax starfield with warp streaking, Hubble M51 + 4-arm Spiral Galaxy,
 * unsharp-masked 3D Cosmic Web neural filaments, and relativistic Gargantua Black Hole lensing.
 */

export const BG_VERT = `
  attribute vec2 aPos;
  varying vec2 vUv;
  void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

export const BG_FRAG = `
  precision highp float;
  varying vec2 vUv;

  uniform vec2 uRes;
  uniform float uTime;
  uniform float uRealTime;
  uniform float uScaleLog;
  uniform vec2 uParallax;
  uniform vec2 uCamRot;
  uniform float uWarp;
  uniform float uFovZoom;
  uniform vec4 uShockWave;
  uniform vec4 uEventLens;
  uniform vec4 uEventAmbient;
  uniform float uSkyBright;
  uniform float uStarDensity;
  uniform float uQuality;

  uniform vec2 uBhPos;
  uniform float uBhRadius;
  uniform float uBhStrength;

  uniform vec2 uGalPos;
  uniform float uGalRadius;
  uniform float uGalAlpha;
  uniform float uGalTilt;

  uniform vec2 uWebPos;
  uniform float uWebRadius;
  uniform float uWebAlpha;

  uniform sampler2D uTexMilky;
  uniform sampler2D uTexNebula;
  uniform sampler2D uTexDeep;
  uniform sampler2D uTexGalaxy;
  uniform sampler2D uTexGalaxyDisc;
  uniform sampler2D uTexWeb;

  const float PI = 3.14159265359;
  const float TAU = 6.28318530718;

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  vec3 starTint(float h) {
    if (h < 0.16) return vec3(0.64, 0.82, 1.00);
    if (h < 0.44) return vec3(0.92, 0.96, 1.00);
    if (h < 0.72) return vec3(1.00, 0.94, 0.84);
    if (h < 0.90) return vec3(1.00, 0.82, 0.62);
    return vec3(1.00, 0.66, 0.48);
  }

  vec3 starLayer(vec2 p, float scale, float threshold, float sizeMul, float warpStr, vec2 radialDir) {
    vec2 gv = fract(p * scale) - 0.5;
    vec2 id = floor(p * scale);
    float h = hash21(id);
    if (h < threshold) return vec3(0.0);

    vec2 offset = vec2(hash21(id + 11.7) - 0.5, hash21(id + 27.3) - 0.5) * 0.72;
    vec2 dv = gv - offset;

    if (warpStr > 0.005) {
      float along = dot(dv, radialDir);
      vec2 perp = dv - radialDir * along;
      dv = perp + radialDir * (along / (1.0 + warpStr * 4.8));
    }

    float d2 = dot(dv, dv);
    if (d2 > 0.14) return vec3(0.0);
    float d = sqrt(d2);
    float mag = fract(h * 19.37);
    float mag2 = mag * mag;
    float sharp = mix(420.0, 1550.0, 1.0 - mag) / max(sizeMul, 0.55);
    float core = exp(-d2 * sharp);
    float halo = exp(-d * 18.0) * 0.16 * mag2;

    float spike = 0.0;
    if (mag > 0.84) {
      float sx = exp(-abs(dv.y) * 95.0) * exp(-abs(dv.x) * 11.0);
      float sy = exp(-abs(dv.x) * 95.0) * exp(-abs(dv.y) * 11.0);
      spike = (sx + sy) * (mag - 0.84) * 1.45;
    }

    float twinkle = 0.88 + 0.12 * sin(uRealTime * (0.9 + mag * 1.9) + h * 61.0);
    return starTint(fract(h * 7.13)) * (core + halo + spike) * mix(0.26, 1.55, mag2) * twinkle;
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
      p = rot * p * 2.07;
      a *= 0.5;
    }
    return v;
  }

  mat2 rot2(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, -s, s, c);
  }

  vec2 mirrorUv(vec2 uv) {
    return clamp(abs(fract(uv * 0.5) * 2.0 - 1.0), 0.002, 0.998);
  }

  vec3 rotate3D(vec3 v, float yaw, float pitch, float roll) {
    float cy = cos(yaw), sy = sin(yaw);
    v = vec3(v.x * cy + v.z * sy, v.y, -v.x * sy + v.z * cy);
    float cp = cos(pitch), sp = sin(pitch);
    v = vec3(v.x, v.y * cp - v.z * sp, v.y * sp + v.z * cp);
    float cr = cos(roll), sr = sin(roll);
    return vec3(v.x * cr - v.y * sr, v.x * sr + v.y * cr, v.z);
  }

  void main() {
    float aspect = uRes.x / max(uRes.y, 1.0);
    vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
    vec2 radialDir = normalize(p + vec2(1e-5));
    float pRad = length(p);

    /* 1. Black Hole Gravitational Lensing */
    vec2 dBh = p - uBhPos;
    float rBh = length(dBh);
    float rs = max(uBhRadius, 0.0005);
    float einstein = rs * 1.56;
    vec2 lensedP = p;
    float shadowAlpha = 0.0;
    float einsteinBoost = 0.0;

    if (uBhStrength > 0.001) {
      shadowAlpha = (1.0 - smoothstep(rs * 0.95, rs * 1.015, rBh)) * clamp(uBhStrength, 0.0, 1.0);
      if (rBh > rs * 0.85) {
        float bend = min((einstein * einstein) / max(rBh - rs * 0.42, 0.0014), 0.62);
        lensedP = p - normalize(dBh + vec2(1e-5)) * bend * 0.52 * uBhStrength;
        einsteinBoost = exp(-pow((rBh - einstein * 1.05) / (rs * 0.36), 2.0)) * 0.55 * uBhStrength;
      }
    }

    /* 1b. Cosmic Event Gravitational Lensing & Spacetime Shockwave */
    float evEinsteinBoost = 0.0;
    if (uEventLens.w > 0.001 && uEventLens.z > 0.0005) {
      vec2 dEv = lensedP - uEventLens.xy;
      float rEv = length(dEv);
      float evRs = uEventLens.z;
      float evEin = evRs * 1.52;
      if (rEv > evRs * 0.65 && rEv < evRs * 9.5) {
        float fall = smoothstep(evRs * 9.5, evRs * 2.2, rEv);
        float evBend = min((evEin * evEin) / max(rEv - evRs * 0.36, 0.0016), 0.36);
        lensedP -= normalize(dEv + vec2(1e-5)) * evBend * 0.44 * uEventLens.w * fall;
        evEinsteinBoost = exp(-pow((rEv - evEin * 1.04) / max(evRs * 0.42, 0.004), 2.0)) * 0.62 * uEventLens.w;
      }
    }

    if (uShockWave.w > 0.001) {
      vec2 dSw = lensedP - uShockWave.xy;
      float rSw = length(dSw);
      float swWidth = clamp(uShockWave.z * 0.24, 0.014, 0.068);
      float bandSw = exp(-pow((rSw - uShockWave.z) / swWidth, 2.0));
      float freq = clamp(24.0 / max(swWidth * 10.0, 0.28), 28.0, 90.0);
      float rippleSw = sin((rSw - uShockWave.z) * freq) * bandSw * uShockWave.w;
      lensedP += normalize(dSw + vec2(1e-5)) * rippleSw * clamp(swWidth * 0.36, 0.005, 0.022);
    }

    /* 2. Wide-Field 3D Spherical Deep-Space Skybox (ESO Milky Way + Veil Nebula + JWST Deep Field) */
    float scaleDelta = uScaleLog - 13.0;
    float fovDiv = max(uFovZoom, 0.55);
    vec3 ray = normalize(vec3((lensedP / fovDiv) * 1.16, 0.92));
    float voyageYaw = uCamRot.x * 0.55 + uParallax.x * 0.075 + uRealTime * 0.0042 + uTime * 0.004;
    float voyagePitch = uCamRot.y * 0.42 + uParallax.y * 0.055 + sin(uRealTime * 0.05) * 0.012;
    vec3 skyDir = rotate3D(ray, voyageYaw, voyagePitch, -0.44);

    vec2 skyUv = vec2(fract(atan(skyDir.x, skyDir.z) / TAU + 0.52), clamp(0.5 - asin(clamp(skyDir.y, -1.0, 1.0)) / PI, 0.003, 0.997));
    vec3 eso = pow(max(texture2D(uTexMilky, skyUv).rgb, vec3(0.0)), vec3(1.36)) * (0.70 * uSkyBright);
    eso = eso * vec3(0.90, 0.96, 1.08) + pow(eso, vec3(2.4)) * 0.22;

    vec2 nebUv = mirrorUv(skyUv * vec2(2.0, 1.6) + vec2(0.18 + uRealTime * 0.0005, -0.08));
    float nebMask = smoothstep(0.22, 0.62, sin(skyUv.x * TAU + 0.8) * 0.5 + 0.5)
                  * smoothstep(0.82, 0.28, abs(skyUv.y - 0.46) * 2.0);
    vec3 neb = nebMask > 0.008 ? pow(max(texture2D(uTexNebula, nebUv).rgb, vec3(0.0)), vec3(1.65)) * 0.14 * nebMask * uSkyBright : vec3(0.0);
    vec3 deepField = pow(max(texture2D(uTexDeep, mirrorUv(skyUv * vec2(3.6, 2.4) + vec2(0.31, 0.14))).rgb, vec3(0.0)), vec3(2.2)) * 0.11 * uSkyBright;

    float skyPresence = 1.0 - smoothstep(19.5, 23.8, uScaleLog) * 0.52;
    float horizonSkyBoost = 1.0 + smoothstep(11.0, 7.2, uScaleLog) * 0.42;
    float totalEin = einsteinBoost + evEinsteinBoost;
    vec3 col = vec3(0.005, 0.009, 0.020)
             + (eso + neb + deepField) * skyPresence * horizonSkyBoost * (1.0 + totalEin);

    /* Subtle Interstellar Dust Illumination from Luminous Cosmic Events */
    if (uEventAmbient.a > 0.001) {
      float rAmb = length(p - uEventLens.xy);
      float ambRad = max(uEventLens.z * 3.8, 0.16);
      float dustLuma = dot(eso + neb, vec3(0.30, 0.58, 0.12));
      float scatter = exp(-rAmb / ambRad) * (0.28 + dustLuma * 1.85);
      col += uEventAmbient.rgb * scatter * uEventAmbient.a * 0.42;
    }

    /* 3. Multi-Octave 3D Depth Starfield */
    float threshA = clamp(0.982 - 0.014 * uStarDensity, 0.942, 0.995);
    float threshB = clamp(0.968 - 0.020 * uStarDensity, 0.922, 0.992);
    float zPhase = scaleDelta * 0.48 + uRealTime * 0.0018;
    vec2 starDrift = vec2(uRealTime * 0.0024, uRealTime * 0.00085) + uParallax * 0.032 + uCamRot * 0.12;
    float warpAmt = uWarp * clamp(pRad * 1.4, 0.0, 1.35);
    vec3 stars = vec3(0.0);

    for (int oct = 0; oct < 3; oct++) {
      if (oct == 2 && uQuality < 0.8) break;
      float fOct = float(oct);
      float cyc = fract(zPhase + fOct * 0.3333);
      float env = sin(PI * cyc);
      env *= env;
      vec2 sp = lensedP * (mix(1.95, 0.48, cyc) / fovDiv) + starDrift * (0.45 + fOct * 0.32) + vec2(fOct * 4.1, fOct * 6.7);
      stars += starLayer(sp, 24.0, threshA, 1.05, warpAmt, radialDir) * env;
      stars += starLayer(sp + 5.1, 62.0, threshB, 0.92, warpAmt * 0.65, radialDir) * env * 0.68;
    }
    vec2 deepSp = (lensedP / fovDiv) * (0.98 - scaleDelta * 0.006) + starDrift * 0.25;
    stars += starLayer(deepSp + 9.4, 132.0, threshB, 0.85, warpAmt * 0.3, radialDir) * 0.44;
    col += stars * (1.0 - smoothstep(22.0, 24.0, uScaleLog) * 0.32) * (1.0 + totalEin * 1.4);

    /* 4. Spiral Galaxy (10^21 m — Hubble M51 + 4-Arm Galactic Disc) */
    if (uGalAlpha > 0.002) {
      vec2 gp = rot2(-0.26) * ((lensedP - uGalPos) / max(uGalRadius, 0.001));
      gp.y /= max(uGalTilt, 0.26);
      float gr = length(gp);
      if (gr < 1.65) {
        vec2 gRot = rot2(-uRealTime * 0.016 - uTime * 0.012) * gp;
        vec2 m51Uv = gRot * vec2(0.42, 0.56) + 0.5;
        vec3 m51 = vec3(0.0);
        if (m51Uv.x > 0.0 && m51Uv.x < 1.0 && m51Uv.y > 0.0 && m51Uv.y < 1.0) {
          vec2 edge = smoothstep(0.0, 0.16, m51Uv) * smoothstep(1.0, 0.84, m51Uv);
          m51 = texture2D(uTexGalaxy, m51Uv).rgb * edge.x * edge.y;
        }
        vec2 discUv = gRot * 0.44 + 0.5;
        vec3 disc = (discUv.x > 0.0 && discUv.x < 1.0 && discUv.y > 0.0 && discUv.y < 1.0)
          ? texture2D(uTexGalaxyDisc, discUv).rgb
          : vec3(0.0);
        float pulse = 0.94 + 0.06 * sin(uRealTime * 0.55 - gr * 5.2);
        vec3 gCol = (pow(max(m51, vec3(0.0)), vec3(0.95)) * 1.18 + pow(max(disc, vec3(0.0)), vec3(1.05)) * 0.44) * pulse;
        col += (gCol + vec3(1.0, 0.90, 0.72) * exp(-gr * gr * 7.2) * 0.48) * smoothstep(1.48, 0.36, gr) * uGalAlpha;
      }
    }

    /* 5. 3D Cosmic Web (10^24 m — Unsharp-Masked Dark Matter Neural Filaments) */
    if (uWebAlpha > 0.002) {
      vec2 wp = (lensedP - uWebPos) / max(uWebRadius, 0.001);
      float wr = length(wp);
      if (wr < 2.15) {
        float edgeMask = uWebRadius > 0.55 ? smoothstep(2.12, 0.72, wr) : smoothstep(1.12, 0.18, wr);
        vec2 uvA = mirrorUv(rot2(0.18) * (wp * 0.34) + 0.52 + vec2(uRealTime * 0.0014, -uRealTime * 0.0009) + uParallax * 0.018);
        vec3 wA = texture2D(uTexWeb, uvA).rgb;
        vec2 uvB = mirrorUv(rot2(-0.08 + sin(uRealTime * 0.04) * 0.02) * (wp * 0.46) + 0.49 + vec2(-uRealTime * 0.0021, uRealTime * 0.0013) + uParallax * 0.042);
        vec3 wB = texture2D(uTexWeb, uvB).rgb;
        vec3 wSharp = wB;
        if (uWebRadius > 0.25) {
          vec3 wBlur = (
            texture2D(uTexWeb, mirrorUv(uvB + vec2(0.003, 0.0))).rgb +
            texture2D(uTexWeb, mirrorUv(uvB - vec2(0.003, 0.0))).rgb +
            texture2D(uTexWeb, mirrorUv(uvB + vec2(0.0, 0.003))).rgb +
            texture2D(uTexWeb, mirrorUv(uvB - vec2(0.0, 0.003))).rgb
          ) * 0.25;
          wSharp = max(wB + (wB - wBlur) * 1.45, vec3(0.0));
        }
        float ridge = max(wSharp.r, max(wSharp.g, wSharp.b));
        float wave1 = 0.5 + 0.5 * sin(wr * 8.5 - uRealTime * 1.35 + ridge * 6.0);
        float wave2 = 0.5 + 0.5 * sin(wp.x * 5.2 + wp.y * 4.4 - uRealTime * 0.95 + wA.b * 5.0);
        vec3 colWeb = wA * vec3(0.46, 0.44, 0.94) * 0.55 + wSharp * vec3(0.68, 0.86, 1.08) * 1.08
                    + vec3(0.92, 0.84, 1.05) * pow(ridge, 1.55) * (0.45 + 0.85 * wave1 * wave2) * 0.72
                    + vec3(1.00, 0.78, 0.46) * pow(ridge, 3.2) * (0.35 + 0.65 * wave1) * 0.55;
        col += colWeb * edgeMask * uWebAlpha;
      }
    }

    col *= (1.0 - shadowAlpha);

    /* 6. Relativistic Gargantua Black Hole */
    if (uBhStrength > 0.002 && rBh < rs * 7.8) {
      vec2 q = rot2(-0.15 + sin(uRealTime * 0.14) * 0.015) * (dBh / rs);
      float qr = length(q);
      float photonRing = exp(-pow((qr - 1.035) / 0.036, 2.0)) * 1.85 * (0.94 + 0.06 * sin(uRealTime * 1.8));
      float secondaryRing = exp(-pow((qr - 1.085) / 0.10, 2.0)) * 0.42;
      float innerGlow = exp(-max(qr - 1.0, 0.0) * 2.4) * smoothstep(0.96, 1.02, qr) * 0.40;

      vec2 eq = vec2(q.x, q.y / 0.175);
      float eqR = length(eq);
      float frontCross = smoothstep(0.055, -0.045, q.y);
      float diskBand = smoothstep(1.14, 1.48, eqR) * smoothstep(6.2, 1.95, eqR) * mix(smoothstep(0.96, 1.04, qr), 1.0, frontCross);
      float archMask = smoothstep(0.99, 1.12, qr) * smoothstep(2.75, 1.14, qr) * smoothstep(0.03, 0.62, abs(q.y) / max(qr, 0.16));

      float doppler = clamp(1.0 - 0.46 * (q.x / max(qr, 0.32)), 0.34, 1.74);
      vec3 colMid = vec3(1.00, 0.66, 0.28);
      vec3 colHot = vec3(1.00, 0.94, 0.82);
      vec3 diskCol = mix(vec3(0.76, 0.22, 0.05), colMid, smoothstep(0.34, 0.98, doppler));
      diskCol = mix(diskCol, colHot, smoothstep(0.94, 1.38, doppler));
      diskCol = mix(diskCol, vec3(0.84, 0.93, 1.00), smoothstep(1.36, 1.74, doppler) * 0.48);

      float bhFlow = uRealTime * 0.58 + uTime * 0.25;
      float diskIntensity = 0.0;
      if (diskBand > 0.003) {
        vec2 rotEq = rot2(bhFlow * (0.95 / pow(max(eqR, 0.85), 0.78)) + eqR * 2.65) * eq;
        float n1 = fbm4(rotEq * 1.45);
        float n2 = fbm4(rotEq * 3.1 + vec2(n1 * 1.8, -n1 * 1.4));
        diskIntensity = diskBand * (0.38 + 0.92 * n2) * (0.58 + 0.44 * sin(eqR * 12.0 + n1 * 5.8 + n2 * 3.2 - bhFlow * 0.6)) * mix(1.48, 0.42, smoothstep(1.30, 5.2, eqR)) * doppler;
      }
      float archIntensity = 0.0;
      if (archMask > 0.003) {
        vec2 rotArch = rot2(bhFlow * 0.68 + qr * 3.4) * q;
        float an1 = fbm4(rotArch * 2.2);
        float an2 = fbm4(rotArch * 4.6 + vec2(an1 * 1.5, -an1 * 1.1));
        archIntensity = archMask * (0.40 + 0.80 * an2) * (0.64 + 0.36 * sin(qr * 15.0 + an1 * 5.2 - bhFlow * 0.5)) * doppler * 0.92;
      }

      vec3 frontEmission = diskCol * diskIntensity * frontCross;
      vec3 extEmission = diskCol * (diskIntensity * (1.0 - frontCross) + archIntensity)
                       + mix(colMid, colHot, smoothstep(0.45, 1.45, doppler)) * (photonRing + secondaryRing) * doppler
                       + vec3(0.98, 0.56, 0.22) * (innerGlow + exp(-max(qr - 1.0, 0.0) * 0.85) * 0.14 * doppler);
      col += (frontEmission + extEmission * smoothstep(0.94, 1.02, qr)) * uBhStrength;
    }

    col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export const PARTICLE_VERT = `
  attribute vec2 aPosPx;
  attribute float aSize;
  attribute vec4 aColor;
  uniform vec2 uRes;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    vec2 clip = (aPosPx / uRes) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
    gl_PointSize = aSize;
  }
`;

export const PARTICLE_FRAG = `
  precision mediump float;
  varying vec4 vColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float a = clamp((exp(-r2 * 24.0) + smoothstep(0.25, 0.0, r2) * 0.45) * vColor.a, 0.0, 1.0);
    gl_FragColor = vec4(vColor.rgb * a, a);
  }
`;
