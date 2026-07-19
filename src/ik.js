// PlayForge IK — two-bone inverse kinematics for posing and (later) in-game limb
// placement (ledge grabs, feet on stairs). Owned by General (character lane).
//
// Solver style: DELTA-FROM-CURRENT-POSE. We never assume bone local axes (this rig's
// bind frames bit us before) — every step measures world positions and applies a
// world-space corrective rotation to the joint, converted back to bone-local. Two
// alternating steps (set elbow/knee angle, swing the chain onto the target), iterated,
// converge for any humanoid chain regardless of how the FBX authored its axes.

import * as THREE from "three";

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _e = new THREE.Vector3();
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _ax = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qw = new THREE.Quaternion();

/** apply a WORLD-space delta rotation to a bone (keeps children attached) */
function rotateWorld(bone, deltaQ) {
  bone.parent.getWorldQuaternion(_qp);
  bone.getWorldQuaternion(_qw);
  _qw.premultiply(deltaQ);                      // new world orientation
  bone.quaternion.copy(_qp.invert().multiply(_qw));
  bone.updateMatrixWorld(true);
}

/**
 * Two-bone IK: bend `mid` and swing `root` so `eff` reaches `target` (world).
 * @returns {number} final distance from effector to target (metres, world)
 */
export function solveTwoBone({ root, mid, eff, target, iterations = 4 }) {
  for (let i = 0; i < iterations; i++) {
    root.updateWorldMatrix(true, true);
    root.getWorldPosition(_a); mid.getWorldPosition(_b); eff.getWorldPosition(_e);
    const l1 = _a.distanceTo(_b), l2 = _b.distanceTo(_e);
    const d = Math.min(Math.max(_a.distanceTo(target), 0.02), (l1 + l2) * 0.999);

    // ---- 1) elbow/knee: set the bend angle so |root→eff| == d --------------
    const cur = _t1.copy(_a).sub(_b).angleTo(_t2.copy(_e).sub(_b));
    const want = Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2))));
    _ax.copy(_t1.copy(_a).sub(_b)).cross(_t2.copy(_e).sub(_b));
    if (_ax.lengthSq() < 1e-6) {
      // straight limb (T-pose) = degenerate plane: bend toward the target instead
      _ax.copy(_t1.copy(_a).sub(_b)).cross(_t2.copy(target).sub(_b));
      if (_ax.lengthSq() < 1e-6) _ax.set(0, 1, 0).cross(_t1);           // last resort: any perpendicular
    }
    _ax.normalize();                                                     // hinge = plane normal
    rotateWorld(mid, _q.setFromAxisAngle(_ax, want - cur));

    // ---- 2) shoulder/hip: swing the whole chain onto the target ------------
    root.getWorldPosition(_a); eff.getWorldPosition(_e);
    _t1.copy(_e).sub(_a).normalize(); _t2.copy(target).sub(_a).normalize();
    rotateWorld(root, _q.setFromUnitVectors(_t1, _t2));
  }
  eff.getWorldPosition(_e);
  return _e.distanceTo(target);
}

/** find the {root, mid, eff} chain for a limb from the ACTUAL skinned skeleton.
 * ★ This rig has DUPLICATE same-named bones (even nested: RightArm→RightArm), so
 * independent name lookups can grab detached copies with garbage frames. Instead we
 * find effector candidates whose parent+grandparent match the chain names and take the
 * DEEPEST one — root/mid are then literally its ancestors, guaranteeing a connected,
 * correctly-framed chain. */
export function limbChain(playerObj, limb) {
  const NAMES = {
    handR: [/^rightarm$/i, /^rightforearm$/i, /^righthand$/i],
    handL: [/^leftarm$/i, /^leftforearm$/i, /^lefthand$/i],
    footR: [/^rightupleg$/i, /^rightleg$/i, /^rightfoot$/i],
    footL: [/^leftupleg$/i, /^leftleg$/i, /^leftfoot$/i],
  }[limb];
  if (!NAMES) return null;
  const [rootRe, midRe, effRe] = NAMES;
  let found = null;
  playerObj.traverse((o) => {
    if (found || !o.isSkinnedMesh || !o.skeleton) return;
    for (const b of o.skeleton.bones) {
      if (!effRe.test(b.name)) continue;
      // walk up, skipping same-named wrapper dups (RightHand→RightHand→…→RightForeArm)
      let mid = b.parent; while (mid && effRe.test(mid.name)) mid = mid.parent;
      if (!mid || !midRe.test(mid.name)) continue;
      let root = mid.parent; while (root && midRe.test(root.name)) root = root.parent;
      if (!root || !rootRe.test(root.name)) continue;
      found = { root, mid, eff: b };               // first connected chain wins
      break;
    }
  });
  return found;
}
