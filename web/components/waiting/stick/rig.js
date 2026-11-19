/**
 * Skeleton of a stick figure: a pose in, joint positions out. Pure.
 *
 * A pose places the pelvis on the floor plan (`x`, `z`, heading `yaw`), sets
 * its height (`hip`) and the torso's forward `lean`, sideways `sway` and
 * shoulder `twist`, turns the head (`headYaw`, `headPitch`, `headRoll`), and
 * gives targets for the limbs. Feet are world positions on the floor,
 * `plants` as [x, lift, z] with toes pointing along `aim`, so a planted foot
 * stays put while the body moves over it. Hands are [forward, side, up] from
 * their own shoulder in the chest frame. Index 0 is the left limb, 1 the
 * right; `side` grows to the figure's right. Lengths are feet.
 */
import { add, cross, dot, length, mul, offset, sub, unit } from './vec.js';

/** Bone lengths for a figure about 6 ft 2 in tall. */
export const BODY = Object.freeze({
  torso: 1.72, neck: 0.24, head: 0.5, shoulder: 0.5, hip: 0.3,
  upperArm: 0.98, foreArm: 0.92, thigh: 1.52, shin: 1.5, ankle: 0.28, foot: 0.62,
});

const UP = [0, 1, 0];

/** Forward and right unit vectors for a heading; yaw 0 faces +x and its right is +z. */
export const heading = yaw => ({ f: [Math.cos(yaw), 0, Math.sin(yaw)], r: [-Math.sin(yaw), 0, Math.cos(yaw)] });

/** Two-bone IK in 3D. The middle joint bends toward `pole`. */
function reach(root, target, upper, lower, pole) {
  const toTarget = sub(target, root);
  const distance = length(toTarget) || 1e-6;
  const span = Math.min(upper + lower - 1e-3, Math.max(Math.abs(upper - lower) + 1e-3, distance));
  const along = mul(toTarget, 1 / distance);
  let bend = sub(pole, mul(along, dot(pole, along)));
  if (length(bend) < 1e-4) bend = cross(along, [0, 0, 1]);
  bend = unit(bend);
  const cosine = (upper * upper + span * span - lower * lower) / (2 * upper * span);
  const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  return {
    joint: add(root, add(mul(along, upper * cosine), mul(bend, upper * sine))),
    end: add(root, mul(along, span)),
  };
}

/** Pelvis, chest and shoulder positions of a pose, with the frames they hang from. */
export function torsoOf(pose, size = 1) {
  const { f, r } = heading(pose.yaw);
  const pelvis = [pose.x, pose.hip * size, pose.z];
  const spine = unit(add(add(mul(UP, Math.cos(pose.lean) * Math.cos(pose.sway)), mul(f, Math.sin(pose.lean))), mul(r, Math.sin(pose.sway))));
  const chest = add(pelvis, mul(spine, BODY.torso * size));
  const { f: cf, r: cr } = heading(pose.yaw + pose.twist);
  return {
    f, r, cf, cr, pelvis, chest, spine,
    shoulders: [add(chest, mul(cr, -BODY.shoulder * size)), add(chest, mul(cr, BODY.shoulder * size))],
  };
}

/**
 * @param pose Pose (see the module comment).
 * @param {number} size Scale of the bones.
 * @returns Joint positions and the direction vectors a renderer needs.
 */
export function solveFigure(pose, size = 1) {
  const { f, r, cf, cr, pelvis, chest, spine, shoulders } = torsoOf(pose, size);
  const ground = [pose.x, 0, pose.z];
  const hips = [add(pelvis, mul(r, -BODY.hip * size)), add(pelvis, mul(r, BODY.hip * size))];

  const faceYaw = pose.yaw + pose.twist + pose.headYaw;
  const pitchCos = Math.cos(pose.headPitch);
  // Positive pitch looks down.
  const face = [Math.cos(faceYaw) * pitchCos, -Math.sin(pose.headPitch), Math.sin(faceYaw) * pitchCos];
  const levelRight = [-Math.sin(faceYaw), 0, Math.cos(faceYaw)];
  const levelUp = cross(levelRight, face);
  // Positive roll drops the head toward the right shoulder.
  const headUp = add(mul(levelUp, Math.cos(pose.headRoll)), mul(levelRight, Math.sin(pose.headRoll)));
  // The neck stays more upright than the spine, as a head does over a bent back.
  const neck = add(chest, mul(unit(add(mul(spine, 0.55), mul(UP, 0.45))), BODY.neck * size));
  const head = add(neck, mul(unit(add(headUp, mul(face, 0.18))), BODY.head * size * 0.92));

  const legs = pose.plants.map(([x, lift, z], index) => {
    const out = index === 0 ? -1 : 1;
    const target = [x, BODY.ankle * size + lift, z];
    // The knee bends a quarter turn ahead of the leg's own direction: forward
    // under a standing figure, up when a fallen one's legs point along the
    // floor. Turning with the leg, it never flips from one side to the other.
    const along = unit(sub(target, hips[index]));
    const pole = add(add(mul(f, 0.05 - along[1]), mul(UP, dot(along, f))), mul(r, 0.2 * out));
    const { joint: knee, end: ankle } = reach(hips[index], target, BODY.thigh * size, BODY.shin * size, pole);
    // A planted foot lies flat and a lifted one hangs toe-down; `toeLift` raises the toe.
    const toeDrop = Math.min(0.5, lift * 0.45) - pose.toeLift[index];
    const toe = [
      ankle[0] + Math.cos(pose.aim[index]) * BODY.foot * size,
      Math.max(0.09 * size, ankle[1] - BODY.ankle * size * 0.72 - toeDrop),
      ankle[2] + Math.sin(pose.aim[index]) * BODY.foot * size,
    ];
    return { hip: hips[index], knee, ankle, toe };
  });

  const arms = pose.hands.map(([forward, side, up], index) => {
    const out = index === 0 ? -1 : 1;
    const root = add(shoulders[index], mul(cr, 0.1 * out * size));
    const target = offset(shoulders[index], cf, forward, cr, side, up);
    // The elbow bends a quarter turn behind the arm's own direction and a
    // little outward: back when the arm hangs, down when it reaches forward,
    // forward under a raised hand. Like the knee, it turns and never flips.
    const along = unit(sub(target, root));
    const pole = add(add(mul(cf, along[1]), [0, -0.15 - dot(along, cf), 0]), mul(cr, 0.45 * out));
    const { joint: elbow, end: hand } = reach(root, target, BODY.upperArm * size, BODY.foreArm * size, pole);
    return { root, elbow, hand };
  });

  return { size, ground, pelvis, chest, neck, head, face, headUp, forward: cf, right: cr, shoulders, hips, legs, arms };
}
