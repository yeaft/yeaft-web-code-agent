/**
 * Yeaft Cosmos — GPU Framebuffer Procedural Astronomical Texture Baker
 *
 * Synthesizes all 15 seamless 3D-spherical planetary surfaces, Saturn's Cassini ring strip,
 * ESO-style 360° Milky Way skybox (with embedded emission nebulae & Great Rift dust lanes),
 * 4-arm logarithmic spiral galaxy, and Worley dark-matter cosmic web entirely on the GPU
 * in a single ~30ms startup pass — ZERO external image downloads (0 KB bandwidth).
 */

const BAKE_VERT = `
  attribute vec2 aPos;
  varying vec2 vUv;
  void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

const BAKE_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform int uMapId;

  const float PI = 3.14159265359;
  const float TAU = 6.28318530718;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(i);
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
  }

  float fbm3(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise3(p);
      p = p * 2.04 + vec3(1.7, -1.3, 2.1);
      a *= 0.5;
    }
    return v;
  }

  float ridged3(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      float n = 1.0 - abs(noise3(p) * 2.0 - 1.0);
      v += a * n * n;
      p = p * 2.08 + vec3(-1.4, 2.3, 1.1);
      a *= 0.5;
    }
    return v;
  }

  float lobe(float lonDeg, float latDeg, float clon, float clat, float rlon, float rlat, float w) {
    float dl = mod(lonDeg - clon + 540.0, 360.0) - 180.0;
    float da = latDeg - clat;
    float d2 = (dl * dl) / (rlon * rlon) + (da * da) / (rlat * rlat);
    return w * exp(-d2 * 1.18);
  }

  float earthContinent(float lonRad, float latRad) {
    float lo = lonRad * 57.29578;
    float la = latRad * 57.29578;
    float f = 0.0;
    // Americas + Greenland
    f += lobe(lo, la, -104.0, 48.0, 29.0, 18.0, 1.06);
    f += lobe(lo, la, -92.0, 33.0, 18.0, 12.0, 0.86);
    f += lobe(lo, la, -138.0, 62.0, 16.0, 8.0, 0.82);
    f += lobe(lo, la, -99.0, 20.0, 9.0, 7.0, 0.72);
    f += lobe(lo, la, -42.0, 72.0, 14.0, 7.0, 0.92);
    f += lobe(lo, la, -62.0, -10.0, 17.0, 17.0, 1.06);
    f += lobe(lo, la, -66.0, -34.0, 9.0, 15.0, 0.88);
    f += lobe(lo, la, -46.0, -12.0, 12.0, 10.0, 0.86);
    // Europe & Africa
    f += lobe(lo, la, 14.0, 50.0, 22.0, 11.0, 0.96);
    f += lobe(lo, la, 24.0, 62.0, 18.0, 8.0, 0.84);
    f += lobe(lo, la, -4.0, 41.0, 8.0, 6.0, 0.72);
    f += lobe(lo, la, 18.0, 14.0, 24.0, 16.0, 1.12);
    f += lobe(lo, la, 26.0, -12.0, 15.0, 16.0, 0.98);
    f += lobe(lo, la, 45.0, 9.0, 8.0, 6.0, 0.74);
    f += lobe(lo, la, 47.0, -19.0, 4.0, 5.0, 0.76);
    // Eurasia & Australia
    f += lobe(lo, la, 68.0, 56.0, 36.0, 15.0, 1.16);
    f += lobe(lo, la, 108.0, 58.0, 34.0, 14.0, 1.08);
    f += lobe(lo, la, 102.0, 33.0, 24.0, 14.0, 1.12);
    f += lobe(lo, la, 78.0, 22.0, 12.0, 12.0, 0.95);
    f += lobe(lo, la, 46.0, 26.0, 14.0, 9.0, 0.90);
    f += lobe(lo, la, 104.0, 14.0, 10.0, 9.0, 0.76);
    f += lobe(lo, la, 139.0, 36.0, 5.0, 6.0, 0.72);
    f += lobe(lo, la, 116.0, -2.0, 12.0, 5.0, 0.64);
    f += lobe(lo, la, 134.0, -25.0, 19.0, 11.0, 1.05);
    f += lobe(lo, la, 172.0, -42.0, 5.0, 4.0, 0.65);
    // Antarctica
    f += smoothstep(-62.0, -74.0, la) * 1.25;
    return f;
  }

  // Procedural spherical crater field via 3D Worley cell distances
  float craterField(vec3 s, float scale) {
    vec3 p = s * scale;
    vec3 ip = floor(p);
    vec3 fp = fract(p);
    float dMin = 2.0;
    float hBest = 0.0;
    for (int z = -1; z <= 1; z++) {
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec3 o = vec3(float(x), float(y), float(z));
          vec3 cell = ip + o;
          vec3 rnd = vec3(
            hash31(cell + vec3(1.1, 2.3, 3.7)),
            hash31(cell + vec3(4.5, 5.9, 6.1)),
            hash31(cell + vec3(7.3, 8.7, 9.2))
          );
          float d = length(o + rnd * 0.78 - fp);
          if (d < dMin) {
            dMin = d;
            hBest = rnd.x;
          }
        }
      }
    }
    float r = 0.20 + hBest * 0.30;
    float u = dMin / r;
    float bowl = -smoothstep(0.86, 0.12, u) * 0.24;
    float rim = exp(-pow((u - 0.94) / 0.14, 2.0)) * 0.18;
    return bowl + rim;
  }

  void main() {
    float u = vUv.x;
    float v = vUv.y;
    float lat = (0.5 - v) * PI;
    float lon = (u - 0.5) * TAU;
    vec3 s = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
    float absLat = abs(lat) / (PI * 0.5);

    // 0: Sun Photosphere
    if (uMapId == 0) {
      float w1 = fbm3(s * 3.8 + vec3(1.2, 0.0, -0.7));
      float gran = fbm3(s * 14.5 + vec3(w1 * 1.4, -w1 * 1.1, w1 * 0.9));
      float cells = ridged3(s * 9.5 + vec3(3.1, -2.4, 1.7));
      float spot = smoothstep(0.68, 0.79, fbm3(s * 4.5 + vec3(7.2, -3.1, 2.0))) * (1.0 - abs(s.y) * 0.85);
      float heat = clamp(gran * 0.68 + cells * 0.44 - spot * 0.52, 0.0, 1.0);
      vec3 c = vec3(
        mix(0.78, 1.00, smoothstep(0.08, 0.76, heat)),
        mix(0.32, 0.95, smoothstep(0.18, 0.88, heat)),
        mix(0.07, 0.70, smoothstep(0.46, 0.98, heat))
      );
      gl_FragColor = vec4(c, 1.0);
      return;
    }

    // 1: Mercury (Cratered silicate crust)
    if (uMapId == 1) {
      float base = fbm3(s * 3.5 + vec3(2.1, -1.3, 4.2));
      float fine = fbm3(s * 14.0);
      float c1 = craterField(s, 4.6);
      float c2 = craterField(s + vec3(2.3, -1.7, 0.9), 11.0) * 0.55;
      float shade = clamp(0.48 + (base - 0.5) * 0.34 + (fine - 0.5) * 0.16 + c1 + c2, 0.0, 1.0);
      gl_FragColor = vec4(vec3(0.11) + vec3(0.70, 0.68, 0.66) * shade, 1.0);
      return;
    }

    // 2: Venus (Super-rotating amber sulfuric chevron clouds)
    if (uMapId == 2) {
      float chev = abs(lat) * 2.4;
      float swirl = fbm3(s * vec3(2.8, 4.4, 2.8) + vec3(4.1, 0.0, -1.6));
      float band = sin(lat * 9.5 + cos(lon + chev) * 0.55 + swirl * 3.4) * 0.5 + 0.5;
      float wisp = fbm3(s * vec3(7.2, 11.0, 7.2) + vec3(swirl * 1.6, 0.0, -swirl * 1.2));
      float t = clamp(0.32 + band * 0.34 + wisp * 0.38 - abs(s.y) * 0.12, 0.0, 1.0);
      gl_FragColor = vec4(mix(vec3(0.64, 0.44, 0.20), vec3(0.97, 0.82, 0.53), t), 1.0);
      return;
    }

    // 3: Earth Day (Recognizable 7 continents + oceans + deserts + forests + polar ice)
    if (uMapId == 3) {
      float macro = earthContinent(lon, lat);
      float coast = fbm3(s * 3.8 + vec3(2.4, -1.7, 0.9));
      float detail = fbm3(s * 12.0 + vec3(-3.2, 2.1, -1.4));
      float elev = macro + (coast - 0.52) * 0.60 + (detail - 0.5) * 0.18;
      if (elev <= 0.44) {
        float shelf = smoothstep(0.26, 0.44, elev);
        float oVar = fbm3(s * 5.0 + vec3(9.0));
        float ice = smoothstep(0.84, 0.93, absLat + (coast - 0.5) * 0.08);
        vec3 oc = mix(vec3(0.025, 0.11, 0.28), vec3(0.10, 0.35, 0.56), shelf) + vec3(0.02, 0.04, 0.06) * oVar;
        gl_FragColor = vec4(mix(oc, vec3(0.92, 0.95, 0.98), ice), 1.0);
      } else {
        float hN = clamp((elev - 0.44) / 0.82, 0.0, 1.0);
        float arid = clamp(exp(-pow((absLat - 0.27) / 0.16, 2.0)) * (0.45 + coast * 0.85), 0.0, 1.0);
        float mnt = ridged3(s * 10.5 + vec3(1.4, 0.0, -2.2));
        float snow = clamp(smoothstep(0.76, 0.90, absLat + hN * 0.24) + smoothstep(0.74, 0.92, hN + mnt * 0.28) * 0.7, 0.0, 1.0);
        vec3 col = mix(vec3(0.13, 0.34, 0.16), vec3(0.45, 0.44, 0.25), smoothstep(0.0, 0.55, hN));
        col = mix(col, vec3(0.72, 0.58, 0.39), arid * 0.85);
        col = mix(col, vec3(0.50, 0.46, 0.42), mnt * hN * 0.55);
        col = mix(col, vec3(0.93, 0.95, 0.98), snow);
        gl_FragColor = vec4(col, 1.0);
      }
      return;
    }

    // 4: Earth Night Lights (Coastal & temperate golden metropolitan networks)
    if (uMapId == 4) {
      float macro = earthContinent(lon, lat);
      float coast = fbm3(s * 3.8 + vec3(2.4, -1.7, 0.9));
      float detail = fbm3(s * 12.0 + vec3(-3.2, 2.1, -1.4));
      float elev = macro + (coast - 0.52) * 0.60 + (detail - 0.5) * 0.18;
      if (elev <= 0.44) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      float arid = clamp(exp(-pow((absLat - 0.27) / 0.16, 2.0)) * (0.45 + coast * 0.85), 0.0, 1.0);
      float hab = smoothstep(0.68, 0.26, absLat) * (1.0 - arid * 0.55);
      float cBoost = smoothstep(0.70, 0.45, elev) * 0.65 + 0.35;
      float cluster = fbm3(s * 16.0 + vec3(4.2, -2.1, 6.4));
      float spark = noise3(s * 54.0);
      float glow = clamp(smoothstep(0.54, 0.76, cluster) * (0.42 + 0.58 * smoothstep(0.50, 0.82, spark)) * hab * cBoost, 0.0, 1.0);
      gl_FragColor = vec4(glow, glow * 0.78, glow * 0.44, 1.0);
      return;
    }

    // 5: Earth Clouds (Swirling domain-warped cyclones + ITCZ band)
    if (uMapId == 5) {
      float w1 = fbm3(s * vec3(2.9, 3.8, 2.9) + vec3(5.1, 0.0, -3.3));
      float w2 = fbm3(s * vec3(6.8, 7.6, 6.8) + vec3(w1 * 2.1, -w1 * 1.4, w1 * 1.8));
      float itcz = exp(-pow(absLat / 0.16, 2.0)) * 0.14 + exp(-pow((absLat - 0.56) / 0.18, 2.0)) * 0.12;
      float cl = smoothstep(0.50, 0.78, w2 + itcz);
      gl_FragColor = vec4(cl, cl, cl, 1.0);
      return;
    }

    // 6: Mars (Rust regolith, dark basalt highlands, Valles Marineris, polar caps)
    if (uMapId == 6) {
      float n1 = fbm3(s * 3.2 + vec3(-1.5, 2.3, 0.8));
      float n2 = fbm3(s * 10.5 + vec3(4.1, 0.0, -2.9));
      float basalt = smoothstep(0.52, 0.72, fbm3(s * 2.2 + vec3(6.0, -1.1, 0.0)));
      float canyon = exp(-pow((lat + 0.16 + sin(lon * 2.0) * 0.04) / 0.045, 2.0))
                   * smoothstep(-1.4, -0.8, lon) * smoothstep(0.15, -0.35, lon);
      float cr = craterField(s, 5.2) * 0.55;
      float shade = clamp(0.52 + (n1 - 0.5) * 0.42 + (n2 - 0.5) * 0.18 - basalt * 0.24 - canyon * 0.28 + cr, 0.0, 1.0);
      float cap = smoothstep(0.86, 0.93, absLat + (n1 - 0.5) * 0.08);
      vec3 c = mix(vec3(0.41, 0.18, 0.12), vec3(0.86, 0.47, 0.29), shade);
      gl_FragColor = vec4(mix(c, vec3(0.94, 0.92, 0.90), cap), 1.0);
      return;
    }

    // 7: Jupiter (Turbulent zonal cloud bands + Great Red Spot)
    if (uMapId == 7) {
      float turb = fbm3(s * vec3(4.5, 9.5, 4.5) + vec3(1.8, 0.0, -2.1));
      float eddy = fbm3(s * vec3(11.0, 16.0, 11.0) + vec3(turb * 2.4, 0.0, -turb * 1.9));
      float yW = lat + (turb - 0.5) * 0.11 + (eddy - 0.5) * 0.035;
      float band = clamp(0.5 + sin(yW * 15.0) * 0.34 + cos(yW * 29.0 + turb * 2.2) * 0.18 + (eddy - 0.5) * 0.18, 0.0, 1.0);
      vec3 c = mix(vec3(0.57, 0.38, 0.26), vec3(0.93, 0.84, 0.70), band);
      float russet = smoothstep(0.35, 0.78, sin(yW * 8.5 + 0.6) * 0.5 + 0.5) * (1.0 - abs(s.y) * 0.65);
      c = mix(c, vec3(0.74, 0.45, 0.28), russet * 0.36);
      float pole = smoothstep(0.68, 0.96, abs(s.y));
      c = mix(c, vec3(0.50, 0.49, 0.48), pole * 0.55);
      float dLon = mod(lon - 0.55 + PI * 3.0, TAU) - PI;
      float dLat = lat + 0.36;
      float grsR = length(vec2(dLon / 0.28, dLat / 0.13));
      if (grsR < 1.25) {
        float sw = sin(grsR * 10.0 + atan(dLat, dLon) * 2.0 + eddy * 3.0) * 0.5 + 0.5;
        float m = smoothstep(1.18, 0.25, grsR);
        c = mix(c, mix(vec3(0.77, 0.31, 0.19), vec3(0.92, 0.49, 0.31), sw), m * 0.88);
      }
      gl_FragColor = vec4(c, 1.0);
      return;
    }

    // 8: Saturn (Silky champagne gold zonal bands)
    if (uMapId == 8) {
      float w = fbm3(s * vec3(3.2, 7.5, 3.2) + vec3(0.0, 1.2, 0.0));
      float yW = lat + (w - 0.5) * 0.045;
      float t = clamp(0.32 + (sin(yW * 16.0) * 0.5 + 0.5) * 0.38 + (cos(yW * 31.0 + w * 1.4) * 0.5 + 0.5) * 0.18 + (w - 0.5) * 0.12, 0.0, 1.0);
      float pole = smoothstep(0.72, 0.97, abs(s.y));
      vec3 c = mix(mix(vec3(0.71, 0.60, 0.42), vec3(0.94, 0.85, 0.66), t), vec3(0.57, 0.56, 0.49), pole * 0.45);
      gl_FragColor = vec4(c, 1.0);
      return;
    }

    // 9: Saturn 1D Ring Strip (C, B, Cassini Division, A, Encke Gap, F)
    if (uMapId == 9) {
      float alpha = 0.0;
      float bright = 0.80;
      if (u > 0.02 && u < 0.22) {
        float k = smoothstep(0.02, 0.08, u) * smoothstep(0.22, 0.18, u);
        alpha = 0.22 * k * (0.75 + 0.25 * sin(u * 210.0));
        bright = 0.62;
      } else if (u >= 0.22 && u < 0.60) {
        float k = smoothstep(0.22, 0.25, u) * smoothstep(0.60, 0.57, u);
        alpha = clamp(0.88 * k * (0.78 + 0.16 * sin(u * 280.0) + 0.09 * cos(u * 610.0)), 0.0, 1.0);
        bright = 0.88 + 0.12 * sin(u * 140.0);
      } else if (u >= 0.60 && u < 0.675) {
        alpha = 0.04;
        bright = 0.45;
      } else if (u >= 0.675 && u < 0.945) {
        float k = smoothstep(0.675, 0.70, u) * smoothstep(0.945, 0.92, u);
        float encke = 1.0 - 0.88 * exp(-pow((u - 0.875) / 0.008, 2.0));
        alpha = clamp(0.64 * k * encke * (0.82 + 0.14 * sin(u * 340.0)), 0.0, 1.0);
        bright = 0.78 + 0.10 * cos(u * 190.0);
      }
      alpha = max(alpha, 0.36 * exp(-pow((u - 0.976) / 0.006, 2.0)));
      gl_FragColor = vec4(vec3(0.91, 0.83, 0.68) * bright, alpha);
      return;
    }

    // 10: Uranus
    if (uMapId == 10) {
      float n = fbm3(s * vec3(3.0, 5.0, 3.0));
      float band = sin(lat * 6.0 + n * 0.9) * 0.5 + 0.5;
      float pole = smoothstep(0.5, 0.95, abs(s.y));
      gl_FragColor = vec4(mix(vec3(0.50, 0.83, 0.88), vec3(0.72, 0.94, 0.97), band * 0.40 + pole * 0.45), 1.0);
      return;
    }

    // 11: Neptune
    if (uMapId == 11) {
      float n1 = fbm3(s * vec3(3.8, 7.8, 3.8) + vec3(2.2, 0.0, -1.4));
      float band = sin(lat * 12.0 + n1 * 2.4) * 0.5 + 0.5;
      float dLon = mod(lon + 0.7 + PI * 3.0, TAU) - PI;
      float spot = exp(-pow(dLon / 0.26, 2.0) - pow((lat + 0.32) / 0.14, 2.0));
      float cirrus = smoothstep(0.68, 0.86, fbm3(s * vec3(8.5, 22.0, 8.5) + vec3(1.1, 0.0, 0.0))) * (1.0 - abs(s.y) * 0.6);
      vec3 c = mix(vec3(0.13, 0.26, 0.65), vec3(0.28, 0.50, 0.94), band) * (1.0 - vec3(0.45, 0.38, 0.22) * spot);
      gl_FragColor = vec4(mix(c, vec3(0.84, 0.90, 0.99), cirrus * 0.75), 1.0);
      return;
    }

    // 12: Serene Deep-Space Panoramic Milky Way Skybox (vast dark cosmos + delicate dust lanes)
    if (uMapId == 12) {
      float band = exp(-pow(lat / 0.21, 2.0));
      float wide = exp(-pow(lat / 0.52, 2.0));
      float coreAng = cos(lon - 0.15) * 0.5 + 0.5;
      float bulge = pow(coreAng, 3.6) * exp(-pow(lat / 0.16, 2.0));
      float w1 = fbm3(s * vec3(2.4, 3.2, 2.4) + vec3(1.4, 0.0, -2.1));
      float cloud = fbm3(s * vec3(7.2, 9.0, 7.2) + vec3(w1 * 1.8, -w1 * 1.2, w1 * 1.5));
      float fine = fbm3(s * 24.0);
      // Soft multi-octave dust veil (never a harsh black gash)
      float dust1 = fbm3(s * vec3(4.8, 7.4, 4.8) + vec3(w1 * 1.4, -0.6, 2.1));
      float dust2 = fbm3(s * vec3(11.5, 16.0, 11.5) + vec3(-w1, 1.2, 0.4));
      float riftBand = exp(-pow((lat - (w1 - 0.5) * 0.11) / 0.082, 2.0));
      float extinct = clamp(1.0 - smoothstep(0.38, 0.84, dust1 * 0.65 + dust2 * 0.35) * riftBand * 0.64, 0.28, 1.0);
      float h2 = smoothstep(0.68, 0.88, fbm3(s * vec3(10.0, 12.0, 10.0) + vec3(-4.2, 1.7, 3.1))) * band;
      float veil = smoothstep(0.66, 0.86, fbm3(s * 8.0 + vec3(6.4, -5.1, 0.0))) * wide;
      float starDust = (band * pow(clamp(cloud, 0.0, 1.0), 1.45) * (0.35 + 0.65 * coreAng) + wide * pow(clamp(cloud, 0.0, 1.0), 1.9) * 0.10) * extinct;
      float micro = pow(clamp(fine, 0.0, 1.0), 4.6) * band * 0.48 * extinct;
      vec3 c = starDust * vec3(0.32, 0.42, 0.62)
             + bulge * extinct * vec3(0.46, 0.35, 0.24)
             + h2 * vec3(0.24, 0.09, 0.20)
             + veil * vec3(0.07, 0.17, 0.34)
             + micro * vec3(0.70, 0.78, 0.96);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      return;
    }

    // 13: 2D Logarithmic Spiral Galaxy Disc (crisp sapphire arms, dark dust lanes, warm compact core)
    if (uMapId == 13) {
      vec2 q = vUv * 2.0 - 1.0;
      float r = length(q);
      if (r > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      float ang = atan(q.y, q.x);
      float warp = fbm3(vec3(q * 3.6, 0.8));
      float logR = log(max(r, 0.032));
      float ph2 = ang * 2.0 - logR * 4.6 + (warp - 0.5) * 1.3;
      float ph4 = ang * 4.0 - logR * 5.8 + (warp - 0.5) * 1.6;
      float armMain = pow(max(0.0, cos(ph2) * 0.5 + 0.5), 3.0);
      float armSub = pow(max(0.0, cos(ph4) * 0.5 + 0.5), 3.6) * 0.48;
      float dust = pow(max(0.0, cos(ph2 + 0.58) * 0.5 + 0.5), 4.5) * 0.74;
      float clumps = fbm3(vec3(q * 11.5 + vec2(warp * 1.3, -warp * 1.1), 1.7));
      float h2 = smoothstep(0.65, 0.84, clumps) * armMain * smoothstep(0.12, 0.36, r);
      float env = smoothstep(0.96, 0.16, r) * (0.10 + 0.90 * (armMain + armSub));
      float core = exp(-r * r * 24.0) * 0.88 + exp(-r * r * 6.5) * 0.16;
      float light = max(0.0, env * (0.42 + 0.78 * clumps) * (1.0 - dust * 0.78));
      vec3 c = core * vec3(1.00, 0.86, 0.64) + light * vec3(0.42, 0.62, 0.96) + h2 * vec3(0.68, 0.24, 0.48);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      return;
    }

    // 14: Tileable Organic Dark-Matter Cosmic Web Filaments (fine neural threads in deep black void)
    {
      // Two-octave domain-warped Worley ridge extraction so it looks organic & neural, never tiled blocks
      vec2 baseUv = vUv;
      vec2 warpVec = vec2(
        sin(baseUv.y * TAU * 2.0 + cos(baseUv.x * TAU * 3.0) * 1.4),
        cos(baseUv.x * TAU * 2.0 - sin(baseUv.y * TAU * 3.0) * 1.4)
      ) * 0.055;
      vec2 wUv = fract(baseUv + warpVec);

      // Macro supercluster web (cells = 6) + fine neural filaments (cells = 13)
      float macroFil = 0.0;
      float fineFil = 0.0;
      float hubs = 0.0;

      for (int layer = 0; layer < 2; layer++) {
        float cells = layer == 0 ? 6.0 : 13.0;
        vec2 fp = wUv * cells;
        vec2 ip = floor(fp);
        float d1 = 99.0, d2 = 99.0, d3 = 99.0;
        for (int oy = -1; oy <= 1; oy++) {
          for (int ox = -1; ox <= 1; ox++) {
            vec2 off = vec2(float(ox), float(oy));
            vec2 cid = mod(ip + off + cells, cells);
            vec2 rnd = vec2(
              hash31(vec3(cid, layer == 0 ? 1.7 : 9.1)),
              hash31(vec3(cid, layer == 0 ? 5.3 : 14.7))
            );
            vec2 pt = ip + off + 0.12 + rnd * 0.76;
            float d = length(pt - fp);
            if (d < d1) { d3 = d2; d2 = d1; d1 = d; }
            else if (d < d2) { d3 = d2; d2 = d; }
            else if (d < d3) { d3 = d; }
          }
        }
        float wLine = layer == 0 ? 0.032 : 0.028;
        float thread = exp(-pow((d2 - d1) / wLine, 2.0));
        float halo = exp(-pow((d2 - d1) / (wLine * 3.4), 2.0)) * 0.24;
        float node = exp(-pow((d3 - d1) / 0.14, 2.0));
        if (layer == 0) {
          macroFil = thread * 0.78 + halo;
          hubs += node * 0.85;
        } else {
          fineFil = thread * 0.42 + halo * 0.5;
          hubs += node * 0.28;
        }
      }

      float modCloud = 0.45 + 0.55 * fbm3(vec3(sin(wUv.x * TAU), cos(wUv.x * TAU), sin(wUv.y * TAU)) * 2.2);
      vec3 c = macroFil * modCloud * vec3(0.32, 0.40, 0.88)
             + fineFil * modCloud * vec3(0.24, 0.52, 0.86)
             + hubs * vec3(0.86, 0.72, 0.54) * 0.72;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  }
`;

const MAP_SPECS = [
  { key: 'sun',          id: 0,  w: 512, h: 256, wrapS: true },
  { key: 'mercury',      id: 1,  w: 512, h: 256, wrapS: true },
  { key: 'venus',        id: 2,  w: 512, h: 256, wrapS: true },
  { key: 'earth_day',    id: 3,  w: 768, h: 384, wrapS: true },
  { key: 'earth_night',  id: 4,  w: 512, h: 256, wrapS: true },
  { key: 'earth_clouds', id: 5,  w: 512, h: 256, wrapS: true },
  { key: 'mars',         id: 6,  w: 512, h: 256, wrapS: true },
  { key: 'jupiter',      id: 7,  w: 512, h: 256, wrapS: true },
  { key: 'saturn',       id: 8,  w: 512, h: 256, wrapS: true },
  { key: 'saturn_ring',  id: 9,  w: 512, h: 4,   wrapS: false },
  { key: 'uranus',       id: 10, w: 256, h: 128, wrapS: true },
  { key: 'neptune',      id: 11, w: 256, h: 128, wrapS: true },
  { key: 'milky',        id: 12, w: 1024, h: 512, wrapS: true },
  { key: 'galaxy',       id: 13, w: 512, h: 512, wrapS: false },
  { key: 'web',          id: 14, w: 384, h: 384, wrapS: true, wrapT: true },
];

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[Cosmos Baker] Shader error:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/**
 * Bake all 15 procedural astronomical WebGL textures directly on the GPU via FBO.
 * Uses `scaleMul` (e.g. 0.5 on CPU software renderers) for instantaneous startup everywhere.
 */
export function bakeProceduralWebGLTextures(gl, quadBuf, scaleMul = 1.0) {
  const vs = compile(gl, gl.VERTEX_SHADER, BAKE_VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, BAKE_FRAG);
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
    console.warn('[Cosmos Baker] Link error:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }

  const aPos = gl.getAttribLocation(prog, 'aPos');
  const uMapId = gl.getUniformLocation(prog, 'uMapId');
  const fbo = gl.createFramebuffer();
  const textures = {};

  gl.useProgram(prog);
  gl.disable(gl.BLEND);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

  for (const spec of MAP_SPECS) {
    const w = Math.max(64, Math.round(spec.w * scaleMul));
    const h = spec.h <= 4 ? spec.h : Math.max(32, Math.round(spec.h * scaleMul));
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, spec.wrapS ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, spec.wrapT ? gl.REPEAT : gl.CLAMP_TO_EDGE);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.uniform1i(uMapId, spec.id);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    textures[spec.key] = tex;
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteProgram(prog);
  return textures;
}
