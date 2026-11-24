/**
 * Clean architectural athlete renderer for the basketball waiting animation:
 * draws each player from their 19 motion-captured joints (hoops/tracks.js) in
 * crisp monochrome graphite/slate silhouette tones (matching the product's
 * Dragon Ball waiting scene aesthetic), with thin page-coloured separation
 * gaps where limbs cross so arms, legs and head always read as distinct human
 * anatomy at 50-80 px height without noisy jersey stripes, collars or facial
 * smudges.
 */
import { blend, rgb } from '../stage.js';
import { JOINT } from './tracks.js';

const TAU = Math.PI * 2;

/**
 * Append a smooth tapered capsule between (ax, ay, ra) and (bx, by, rb) to `path`.
 */
function capsule(path, ax, ay, ra, bx, by, rb) {
  const dx = bx - ax;
  const dy = by - ay;
  const dist = Math.hypot(dx, dy);
  if (dist <= Math.abs(ra - rb) + 1e-3) {
    const [cx, cy, r] = ra >= rb ? [ax, ay, ra] : [bx, by, rb];
    if (r > 0.1) {
      path.moveTo(cx + r, cy);
      path.arc(cx, cy, r, 0, TAU);
    }
    return;
  }
  const base = Math.atan2(dy, dx);
  const spread = Math.acos(Math.max(-1, Math.min(1, (ra - rb) / dist)));
  path.moveTo(ax + ra * Math.cos(base + spread), ay + ra * Math.sin(base + spread));
  path.arc(ax, ay, ra, base + spread, base + TAU - spread);
  path.arc(bx, by, rb, base - spread, base + spread);
  path.closePath();
}

/**
 * Clear a thin breathing gap (`destination-out`) around a crossing limb, then
 * fill the limb in `fillStyle`. Mirrors `stick/figure.js#clearStroke` so two
 * arms or legs in monochrome grey never merge into an unreadable blob.
 */
function paintPart(ctx, gap, fillStyle, build) {
  if (gap > 0.25) {
    const halo = new Path2D();
    build(halo, gap);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fill(halo);
    ctx.restore();
  }
  const body = new Path2D();
  build(body, 0);
  ctx.fillStyle = fillStyle;
  ctx.fill(body);
}

/**
 * Soft elliptical ground shadow beneath each foot, thinning as the foot lifts.
 */
export function drawPlayerShadow(ctx, camera, player, shade) {
  const S = player.size * camera.k;
  const pts = player.points;
  for (const [toeIdx, heelIdx, floor] of [
    [JOINT.toeL, JOINT.heelL, player.floorL],
    [JOINT.toeR, JOINT.heelR, player.floorR],
  ]) {
    const tx = camera.x(pts[toeIdx][0]);
    const ty = camera.y(pts[toeIdx][1]);
    const hx = camera.x(pts[heelIdx][0]);
    const hy = camera.y(pts[heelIdx][1]);
    const fy = camera.y(floor);
    const lift = Math.max(0, (fy - Math.max(ty, hy)) / Math.max(1, S));
    const fade = Math.max(0, 1 - lift * 2.4);
    if (fade <= 0.02) continue;
    const cx = 0.5 * (tx + hx);
    const rx = Math.max(2.2, (0.5 * Math.abs(tx - hx) + 0.055 * S) * (1 + 0.4 * lift));
    const ry = Math.max(1.0, 0.022 * S * (1 - 0.3 * lift));
    ctx.fillStyle = rgb(shade, 0.14 * fade);
    ctx.beginPath();
    ctx.ellipse(cx, fy, rx, ry, 0, 0, TAU);
    ctx.fill();
  }
}

export function createKit(spec) {
  return spec;
}

let scratch = null;
function getScratch(w, h) {
  if (!scratch) {
    if (typeof OffscreenCanvas !== 'undefined') {
      scratch = new OffscreenCanvas(w, h);
    } else if (typeof document !== 'undefined') {
      scratch = document.createElement('canvas');
    } else {
      return null;
    }
  }
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  return scratch;
}

/**
 * Draw one athlete at real proportions (1:7.8 head-to-height, broad deltoids,
 * athletic chest-to-waist taper, loose knee-length basketball shorts, sculpted
 * calves and low-profile sneakers) in clean monochrome ink/slate tones.
 */
export function drawPlayer(ctx, camera, player, kit, alpha = 1, between) {
  if (alpha <= 0.01) return;
  const target = alpha < 0.995 ? (() => {
    const surf = getScratch(ctx.canvas.width, ctx.canvas.height);
    if (!surf) return ctx;
    const sctx = surf.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, surf.width, surf.height);
    sctx.setTransform(ctx.getTransform());
    return sctx;
  })() : ctx;

  const P = idx => [camera.x(player.points[idx][0]), camera.y(player.points[idx][1])];
  const S = player.size * camera.k;
  const gap = Math.max(0.65, 0.010 * S);

  const nearCol = rgb(kit.near);
  const farCol = rgb(kit.far);
  const shortsNear = rgb(kit.shortsNear || kit.near);
  const shortsFar = rgb(kit.shortsFar || kit.far);

  const nose = P(JOINT.nose);
  const top = P(JOINT.top);
  const neck = P(JOINT.neck);
  const shoL = P(JOINT.shoulderL);
  const shoR = P(JOINT.shoulderR);
  const elbL = P(JOINT.elbowL);
  const elbR = P(JOINT.elbowR);
  const wriL = P(JOINT.wristL);
  const wriR = P(JOINT.wristR);
  const hipL = P(JOINT.hipL);
  const hipR = P(JOINT.hipR);
  const kneeL = P(JOINT.kneeL);
  const kneeR = P(JOINT.kneeR);
  const ankL = P(JOINT.ankleL);
  const ankR = P(JOINT.ankleR);
  const toeL = P(JOINT.toeL);
  const toeR = P(JOINT.toeR);
  const heelL = P(JOINT.heelL);
  const heelR = P(JOINT.heelR);

  const shMid = [0.5 * (shoL[0] + shoR[0]), 0.5 * (shoL[1] + shoR[1])];
  const hipMid = [0.5 * (hipL[0] + hipR[0]), 0.5 * (hipL[1] + hipR[1])];

  const drawLeg = (hip, knee, ank, heel, toe, isNear) => {
    const col = isNear ? nearCol : farCol;
    const sCol = isNear ? shortsNear : shortsFar;
    const hem = [hip[0] + 0.64 * (knee[0] - hip[0]), hip[1] + 0.64 * (knee[1] - hip[1])];
    const calf = [knee[0] + 0.30 * (ank[0] - knee[0]), knee[1] + 0.30 * (ank[1] - knee[1])];
    // Lower leg + sneaker first, with crisp gap only where near leg crosses over far leg
    paintPart(target, isNear ? gap * 0.85 : 0, col, (path, g) => {
      capsule(path, hem[0], hem[1], 0.033 * S + g, knee[0], knee[1], 0.028 * S + g);
      capsule(path, knee[0], knee[1], 0.028 * S + g, calf[0], calf[1], 0.032 * S + g);
      capsule(path, calf[0], calf[1], 0.032 * S + g, ank[0], ank[1], 0.019 * S + g);
      capsule(path, heel[0], heel[1], 0.026 * S + g, toe[0], toe[1], 0.020 * S + g);
    });
    // Loose basketball shorts leg (melds seamlessly into pelvis, subtle separation only on inner knee!)
    paintPart(target, 0, sCol, (path, g) => {
      capsule(path, hip[0], hip[1], 0.055 * S + g, hem[0], hem[1], 0.049 * S + g);
    });
  };

  const drawArm = (sho, elb, wri, isFront) => {
    const col = isFront ? nearCol : farCol;
    const fore = [elb[0] + 0.28 * (wri[0] - elb[0]), elb[1] + 0.28 * (wri[1] - elb[1])];
    const dx = wri[0] - elb[0];
    const dy = wri[1] - elb[1];
    const fl = Math.hypot(dx, dy) || 1;
    const hand = [wri[0] + (dx / fl) * 0.036 * S, wri[1] + (dy / fl) * 0.036 * S];
    // Start halo slightly below shoulder so deltoid stays smoothly joined to chest when behind,
    // and cleanly separated from torso/head when crossing in front!
    if (isFront && gap > 0.25) {
      const midUpper = [sho[0] + 0.38 * (elb[0] - sho[0]), sho[1] + 0.38 * (elb[1] - sho[1])];
      const halo = new Path2D();
      capsule(halo, midUpper[0], midUpper[1], 0.028 * S + gap, elb[0], elb[1], 0.023 * S + gap);
      capsule(halo, elb[0], elb[1], 0.023 * S + gap, fore[0], fore[1], 0.024 * S + gap);
      capsule(halo, fore[0], fore[1], 0.024 * S + gap, wri[0], wri[1], 0.017 * S + gap);
      capsule(halo, wri[0], wri[1], 0.019 * S + gap, hand[0], hand[1], 0.021 * S + gap);
      target.save();
      target.globalCompositeOperation = 'destination-out';
      target.fillStyle = '#000';
      target.fill(halo);
      target.restore();
    }
    const body = new Path2D();
    capsule(body, sho[0], sho[1], 0.032 * S, elb[0], elb[1], 0.023 * S);
    capsule(body, elb[0], elb[1], 0.023 * S, fore[0], fore[1], 0.024 * S);
    capsule(body, fore[0], fore[1], 0.024 * S, wri[0], wri[1], 0.017 * S);
    capsule(body, wri[0], wri[1], 0.019 * S, hand[0], hand[1], 0.021 * S);
    target.fillStyle = col;
    target.fill(body);
  };

  // 1. Far leg & back arms
  if (player.legLNear) {
    drawLeg(hipR, kneeR, ankR, heelR, toeR, false);
  } else {
    drawLeg(hipL, kneeL, ankL, heelL, toeL, false);
  }
  if (!player.armLFront) drawArm(shoL, elbL, wriL, false);
  if (!player.armRFront) drawArm(shoR, elbR, wriR, false);

  // 2. Torso (athletic V-taper from shoulder span down to waist + pelvis, seamlessly joined!)
  const shSpan = Math.hypot(shoR[0] - shoL[0], shoR[1] - shoL[1]);
  const hipSpan = Math.hypot(hipR[0] - hipL[0], hipR[1] - hipL[1]);
  const chestR = Math.max(0.068 * S, Math.min(0.112 * S, 0.46 * shSpan + 0.028 * S));
  const waistR = Math.max(0.054 * S, Math.min(0.084 * S, 0.45 * hipSpan + 0.024 * S));
  const chestPt = [hipMid[0] + 0.72 * (shMid[0] - hipMid[0]), hipMid[1] + 0.72 * (shMid[1] - hipMid[1])];
  paintPart(target, 0, kit.vest ? rgb(kit.vest) : nearCol, (path, g) => {
    capsule(path, shMid[0], shMid[1], chestR * 0.94 + g, chestPt[0], chestPt[1], chestR + g);
    capsule(path, chestPt[0], chestPt[1], chestR + g, hipMid[0], hipMid[1], waistR + g);
  });

  // 3. Near leg
  if (player.legLNear) {
    drawLeg(hipL, kneeL, ankL, heelL, toeL, true);
  } else {
    drawLeg(hipR, kneeR, ankR, heelR, toeR, true);
  }

  // 4. Clean athletic head & neck (neck joins shoulders naturally; skull has subtle halo when raised arms pass behind/around!)
  let hdx = top[0] - neck[0];
  let hdy = top[1] - neck[1];
  const hl = Math.hypot(hdx, hdy) || 1;
  const hLen = Math.max(0.105 * S, Math.min(0.135 * S, hl));
  hdx = (hdx / hl) * hLen;
  hdy = (hdy / hl) * hLen;
  const facePullX = Math.max(-0.018 * S, Math.min(0.018 * S, (nose[0] - (neck[0] + 0.5 * hdx)) * 0.35));
  const skull = [neck[0] + 0.64 * hdx + facePullX * 0.4, neck[1] + 0.64 * hdy];
  const jaw = [neck[0] + 0.36 * hdx + facePullX, neck[1] + 0.36 * hdy + 0.008 * S];
  paintPart(target, 0, nearCol, (path) => {
    capsule(path, neck[0], neck[1], 0.025 * S, jaw[0], jaw[1], 0.023 * S);
  });
  paintPart(target, gap * 0.7, nearCol, (path, g) => {
    capsule(path, jaw[0], jaw[1], 0.039 * S + g, skull[0], skull[1], 0.046 * S + g);
  });

  // 5. Held basketball between body/head and front arms!
  if (between) between(target);

  // 6. Front arms (crossing cleanly in front of chest/head with crisp gap!)
  if (player.armLFront) drawArm(shoL, elbL, wriL, true);
  if (player.armRFront) drawArm(shoR, elbR, wriR, true);

  if (target !== ctx) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha *= alpha;
    ctx.drawImage(target.canvas, 0, 0);
    ctx.restore();
  }
}
