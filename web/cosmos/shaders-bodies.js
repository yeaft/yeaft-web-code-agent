/**
 * Yeaft Cosmos — Ray-Traced Sun & 8-Planet WebGL Shaders
 * Physically motivated lighting, ocean specular, moving cloud shadows, night city lights,
 * Saturn 3D Cassini ring + planetary umbra/ring shadows, and seamless atmospheric halos.
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
  uniform float uTime;
  uniform float uRealTime;
  uniform float uSpin;
  uniform float uTilt;
  uniform float uOblate;
  uniform vec3 uLightDir;
  uniform vec3 uAtmoColor;
  uniform float uAlpha;
  uniform float uHighlight;

  uniform sampler2D uTexMain;
  uniform sampler2D uTexNight;
  uniform sampler2D uTexClouds;
  uniform sampler2D uTexRing;

  const float PI = 3.14159265359;

  float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.345);
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

  vec2 sphereUv(vec3 n, float spin, float tilt) {
    float ct = cos(tilt), st = sin(tilt);
    vec3 nr = vec3(n.x * ct - n.y * st, n.x * st + n.y * ct, n.z);
    return vec2(fract((atan(nr.x, nr.z) + spin) / (2.0 * PI) + 0.5), clamp(0.5 - asin(clamp(nr.y, -1.0, 1.0)) / PI, 0.002, 0.998));
  }

  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  vec4 evalRing(vec2 p, vec3 L, float oblate, bool isUranus, float realTime) {
    vec3 rNorm = isUranus ? normalize(vec3(0.88, 0.16, 0.44)) : normalize(vec3(-0.18, 0.85, 0.49));
    if (abs(rNorm.z) < 0.02) return vec4(0.0);
    vec3 hit = vec3(p, -(p.x * rNorm.x + p.y * rNorm.y) / rNorm.z);
    float rDist = length(hit);
    float rInner = isUranus ? 1.46 : 1.24;
    float rOuter = isUranus ? 1.88 : 2.44;
    if (rDist < rInner || rDist > rOuter) return vec4(0.0);

    float u = (rDist - rInner) / (rOuter - rInner);
    vec4 ringTex = texture2D(uTexRing, vec2(clamp(u, 0.005, 0.995), 0.5));
    float alpha = ringTex.a;
    vec3 rCol = ringTex.rgb * 1.15;

    if (!isUranus) {
      float ang = atan(hit.y, hit.x) + realTime * (0.28 / max(rDist, 1.0));
      rCol *= (0.94 + 0.12 * sin(ang * 18.0 + u * 45.0) * sin(u * 90.0 - realTime * 1.4));
    } else {
      alpha = exp(-pow((u - 0.78) / 0.055, 2.0)) * 0.48 + exp(-pow((u - 0.36) / 0.045, 2.0)) * 0.22;
      rCol = vec3(0.72, 0.90, 0.98);
    }

    vec3 sHit = vec3(hit.x, hit.y / oblate, hit.z);
    vec3 sL = normalize(vec3(L.x, L.y / oblate, L.z));
    float b = dot(sHit, sL);
    float disc = b * b - (dot(sHit, sHit) - 1.0);
    float shadow = (disc > 0.0 && b < 0.0) ? mix(0.05, 1.0, smoothstep(0.11, 0.0, sqrt(disc))) : 1.0;
    return vec4(rCol * (0.60 + 0.40 * abs(dot(rNorm, L))) * shadow, alpha * 0.96);
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
      float corona = (exp(-max(r - 0.97, 0.0) * 3.5) * 0.85 + exp(-max(r - 0.94, 0.0) * 1.65) * 0.42 * streamer + pow(1.0 / max(r, 0.95), 2.75) * 0.22) * smoothstep(3.85, 1.02, r);
      float prom = exp(-pow((r - 1.055) / 0.052, 2.0)) * smoothstep(0.56, 0.88, noise2(vec2(ang * 7.5 + t * 0.08, t * 0.16))) * 0.78;
      float anamorphic = exp(-abs(p.y) * 9.5) * exp(-abs(p.x) * 0.88) * smoothstep(3.6, 0.9, abs(p.x)) * 0.18;

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
        float aa = smoothstep(1.015, 0.945, r);
        col = mix(coronaLight, photo, aa);
        a = clamp(max(aa, max(corona, prom + anamorphic) * 0.95), 0.0, 1.0);
      }
      gl_FragColor = vec4(col * a * uAlpha, a * uAlpha);
      return;
    }

    /* Planets (Types 1..8) */
    float oblate = uOblate;
    vec2 ps = vec2(p.x, p.y / oblate);
    float rSphere = length(ps);
    vec3 L = normalize(uLightDir);

    bool hasRings = (uBodyType == 6 || uBodyType == 7);
    bool isUranus = (uBodyType == 7);
    vec4 ringSample = hasRings ? evalRing(p, L, oblate, isUranus, uRealTime) : vec4(0.0);
    vec3 rNorm = isUranus ? normalize(vec3(0.88, 0.16, 0.44)) : normalize(vec3(-0.18, 0.85, 0.49));
    float ringZ = hasRings ? -(p.x * rNorm.x + p.y * rNorm.y) / rNorm.z : -1.0;

    vec3 planetCol = vec3(0.0);
    float planetAlpha = 0.0;

    if (rSphere <= 1.24) {
      if (rSphere <= 1.008) {
        float rc = min(rSphere, 1.0);
        float z = sqrt(max(1.0 - rc * rc, 0.0));
        vec3 n = normalize(vec3(ps.x, ps.y * oblate, z));
        vec2 uv = sphereUv(n, uSpin, uTilt);
        if (uBodyType == 5) uv.x = fract(uv.x + sin(uv.y * 22.0) * 0.0045 * sin(uRealTime * 0.25));

        vec3 tex = texture2D(uTexMain, uv).rgb;
        float sEps = 0.0022;
        vec3 texBlur = (
          texture2D(uTexMain, vec2(fract(uv.x + sEps), uv.y)).rgb +
          texture2D(uTexMain, vec2(fract(uv.x - sEps), uv.y)).rgb +
          texture2D(uTexMain, vec2(uv.x, clamp(uv.y + sEps, 0.002, 0.998))).rgb +
          texture2D(uTexMain, vec2(uv.x, clamp(uv.y - sEps, 0.002, 0.998))).rgb
        ) * 0.25;
        tex = clamp(tex + (tex - texBlur) * 0.40, 0.0, 1.0);

        vec3 shadeN = n;
        if (uBodyType == 1 || uBodyType == 4) {
          float eps = 0.0026;
          float hC = luma(tex);
          float hR = luma(texture2D(uTexMain, vec2(fract(uv.x + eps), uv.y)).rgb);
          float hU = luma(texture2D(uTexMain, vec2(uv.x, clamp(uv.y - eps, 0.002, 0.998))).rgb);
          vec3 tanX = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(0.001, 0.0, 0.0));
          shadeN = normalize(n + tanX * (hC - hR) * ((uBodyType == 1) ? 0.68 : 0.54) + normalize(cross(n, tanX)) * (hC - hU) * ((uBodyType == 1) ? 0.68 : 0.54));
        }

        float ndl = dot(n, L);
        float ndlRelief = dot(shadeN, L);
        float diff = (uBodyType == 1)
          ? pow(clamp(ndlRelief * 1.15, 0.0, 1.0), 0.76)
          : ((uBodyType == 2) ? pow(clamp((ndl + 0.16) / 1.16, 0.0, 1.0), 0.74) : pow(clamp((ndlRelief + 0.075) / 1.075, 0.0, 1.0), 0.84));

        float nightFloor = 0.052 + 0.032 * uHighlight;
        vec3 lit = tex * (nightFloor + diff * 1.24);
        if (uBodyType >= 5) lit *= (0.74 + 0.26 * pow(z, 0.44));

        if (uBodyType == 3) {
          vec2 uvCloud = sphereUv(n, uSpin * 1.24 + uRealTime * 0.012 + 0.12, uTilt);
          vec2 uvShadow = sphereUv(n, uSpin * 1.24 + uRealTime * 0.012 + 0.114 - L.x * 0.005, uTilt);
          float clouds = texture2D(uTexClouds, uvCloud).r;
          float cloudLit = clamp(diff + (clouds - texture2D(uTexClouds, vec2(fract(uvCloud.x + 0.003), uvCloud.y)).r) * 0.30 * smoothstep(-0.05, 0.35, ndl), 0.0, 1.2);
          float isOcean = smoothstep(0.03, 0.15, tex.b - max(tex.r, tex.g) * 0.86);
          float spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 34.0) * isOcean * (1.0 - clouds * 0.86) * smoothstep(-0.02, 0.22, ndl);
          lit *= (1.0 - texture2D(uTexClouds, uvShadow).r * 0.34 * diff);
          lit = mix(lit, vec3(0.98, 0.99, 1.0) * (nightFloor + cloudLit * 1.22), clouds * 0.78);
          lit += vec3(1.0, 0.94, 0.84) * spec * 0.76;
          lit += pow(texture2D(uTexNight, uv).rgb, vec3(1.1)) * vec3(1.65, 1.12, 0.60) * smoothstep(0.06, -0.16, ndl) * (1.0 - clouds * 0.48) * 1.45 * (0.92 + 0.08 * sin(uRealTime * 1.6));
          lit += vec3(0.98, 0.44, 0.16) * exp(-pow((ndl - 0.005) / 0.088, 2.0)) * (1.0 - z * 0.32) * 0.22;
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
          float fresnel = pow(1.0 - z, 3.6);
          float sunRim = smoothstep(-0.12, 0.62, ndl);
          float rimBoost = (uBodyType == 3) ? 0.74 : ((uBodyType == 4 || uBodyType == 5) ? 0.24 : 0.36);
          lit += uAtmoColor * fresnel * (0.04 + sunRim * rimBoost + uHighlight * 0.36);
        } else if (uHighlight > 0.01) {
          lit += vec3(0.78, 0.88, 1.0) * pow(1.0 - z, 3.6) * uHighlight * 0.26;
        }

        planetCol = lit;
        planetAlpha = smoothstep(1.003, 0.976, rSphere);
      }

      /* Smoothly feathered exterior atmospheric halo (zero hard cutoff ring) */
      float edgeFade = smoothstep(1.24, 1.03, rSphere);
      if (uBodyType != 1 && rSphere > 0.975) {
        float sunSide = smoothstep(-0.18, 0.72, dot(vec3(normalize(ps + vec2(0.0001)), 0.22), L));
        float atmoStrength = (uBodyType == 3) ? 0.42 : ((uBodyType == 2 || uBodyType == 7 || uBodyType == 8) ? 0.22 : 0.14);
        float outerAtmo = (exp(-max(rSphere - 0.995, 0.0) * 18.0) * atmoStrength * sunSide
                        + uHighlight * exp(-max(rSphere - 0.995, 0.0) * 12.0) * 0.26) * edgeFade;
        vec3 haloCol = uAtmoColor * (0.75 + 0.45 * sunSide);
        vec3 premulPlanet = planetCol * planetAlpha + haloCol * outerAtmo * (1.0 - planetAlpha);
        planetAlpha = clamp(planetAlpha + outerAtmo * (1.0 - planetAlpha), 0.0, 1.0);
        planetCol = planetAlpha > 0.001 ? premulPlanet / planetAlpha : vec3(0.0);
      } else if (uBodyType == 1 && uHighlight > 0.01 && rSphere > 0.975) {
        float selHalo = uHighlight * exp(-max(rSphere - 0.995, 0.0) * 12.0) * 0.24 * edgeFade;
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
