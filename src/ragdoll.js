import * as THREE from "three";
import { R, Physics } from "./phys.js";

/**
 * Active ragdoll — the character as a jointed PHYSICS skeleton with muscles.
 *
 * ~11 capsule rigid bodies (pelvis, chest, head, upper/lower arms, thighs,
 * shins) built from the character's real Mixamo bones, connected by spherical
 * joints at the anatomical pivots. Each fixed step a PD controller applies
 * muscle torque steering every segment toward the pose the Animator is
 * playing — so the body TRIES to hold its animation while physics throws it
 * around. Muscle tone is a dial:
 *   tone 0   = unconscious noodle
 *   tone ~1  = stunned, flailing toward the pose
 *   tone 3+  = fights hard to hold the mocap pose
 *
 * Usage:
 *   const rag = new Ragdoll(ch.bones, phys, { scaleRoot: ch.visual });
 *   rag.enter(worldPos, velocity);      // switch bones to physics control
 *   rag.update()                        // per-frame: physics pose → bones
 *   rag.fixedUpdate(dt)                 // per-step: PD muscle torques
 *   if (rag.settled()) rag.exit();      // calm → hand back to the Animator
 *
 * Everything here is real dynamics — no scripted flailing, no canned poses.
 */
const SEGMENTS = [
  // name        bone           child end        radius  is-root
  ["pelvis",    "Hips",         "Spine1",        0.14],
  ["chest",     "Spine1",       "Neck",          0.13],
  ["head",      "Head",         null,            0.10],
  ["upperArmL", "LeftArm",      "LeftForeArm",   0.05],
  ["forearmL",  "LeftForeArm",  "LeftHand",      0.045],
  ["upperArmR", "RightArm",     "RightForeArm",  0.05],
  ["forearmR",  "RightForeArm", "RightHand",     0.045],
  ["thighL",    "LeftUpLeg",    "LeftLeg",       0.07],
  ["shinL",     "LeftLeg",      "LeftFoot",      0.06],
  ["thighR",    "RightUpLeg",   "RightLeg",      0.07],
  ["shinR",     "RightLeg",     "RightFoot",     0.06],
];
const JOINTS = [
  // parent      child        at-bone            limit (rad from bind pose —
  //                                             anatomical range; Erik: "limit
  //                                             the damage so they wont go all
  //                                             weird")
  ["pelvis",    "chest",     "Spine1",        0.55],
  ["chest",     "head",      "Head",          0.85],
  ["chest",     "upperArmL", "LeftArm",       1.55],
  ["upperArmL", "forearmL",  "LeftForeArm",   1.45],
  ["chest",     "upperArmR", "RightArm",      1.55],
  ["upperArmR", "forearmR",  "RightForeArm",  1.45],
  ["pelvis",    "thighL",    "LeftUpLeg",     1.25],
  ["thighL",    "shinL",     "LeftLeg",       1.35],
  ["pelvis",    "thighR",    "RightUpLeg",    1.25],
  ["thighR",    "shinR",     "RightLeg",      1.35],
];
// ragdoll parts collide with everything INCLUDING each other — limbs must
// not pass through limbs (Erik). Adjacent jointed segments don't fight
// because each joint disables contacts between its own pair.
const RAGDOLL_GROUPS = (0x0002 << 16) | 0xffff;

export class Ragdoll {
  constructor(bones, phys, { totalMass = 75, tone = 1.2 } = {}) {
    this.bones = bones;
    this.phys = phys;
    this.tone = tone;
    this.active = false;
    this.segments = [];               // {name, bone, body, col, len, radius, boneQuatOff}
    this._joints = [];
    this._byName = {};
    this._tmp = {
      v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
      q1: new THREE.Quaternion(), q2: new THREE.Quaternion(), q3: new THREE.Quaternion(),
      m1: new THREE.Matrix4(),
    };
    this.totalMass = totalMass;
  }

  /** build bodies + joints at the skeleton's CURRENT world pose */
  _build() {
    const P = this.phys, T = this._tmp;
    const massFor = { pelvis: 0.26, chest: 0.28, head: 0.08, upperArmL: 0.05, forearmL: 0.04,
      upperArmR: 0.05, forearmR: 0.04, thighL: 0.1, shinL: 0.07, thighR: 0.1, shinR: 0.07 };
    for (const [name, boneName, endName, radius] of SEGMENTS) {
      const bone = this.bones[boneName];
      if (!bone) continue;
      bone.updateWorldMatrix(true, false);
      const a = bone.getWorldPosition(new THREE.Vector3());
      let b;
      if (endName && this.bones[endName]) b = this.bones[endName].getWorldPosition(new THREE.Vector3());
      else b = a.clone().add(new THREE.Vector3(0, radius * 1.8, 0));   // head stub
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a);
      const len = Math.max(dir.length(), radius * 1.6);
      // capsule axis is local +Y — orient it along the bone direction
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      const rb = P.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(mid.x, mid.y, mid.z)
          .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
          .setLinearDamping(0.15).setAngularDamping(0.6).setCcdEnabled(true));
      const col = P.world.createCollider(
        R.ColliderDesc.capsule(Math.max(0.02, len / 2 - radius), radius)
          .setMass(this.totalMass * (massFor[name] ?? 0.05))
          .setFriction(0.8).setRestitution(0.1)
          .setCollisionGroups(RAGDOLL_GROUPS), rb);
      // bone-in-body offsets so physics can drive the bone later
      const boneWorldQ = bone.getWorldQuaternion(new THREE.Quaternion());
      const segMass = this.totalMass * (massFor[name] ?? 0.05);
      const seg = {
        name, bone, body: rb, col, radius, len,
        // capsule angular inertia — muscle torques MUST scale by this, not
        // mass (mass-scaled torques spun segments ~70 rad/s per step and
        // blew up the solver)
        inertia: segMass * (3 * radius * radius + len * len) / 12,
        // orientation offset: body → bone
        qOff: quat.clone().invert().multiply(boneWorldQ),
        // bone pivot in body-local space
        pOff: a.clone().sub(mid).applyQuaternion(quat.clone().invert()),
        targetQ: boneWorldQ.clone(),
        // bone LOCAL rest position — update() overwrites bone positions while
        // ragdolling, and the clips are quaternion-only so nothing puts them
        // back. Without this restore every ragdoll left the skeleton a bit
        // more displaced until it was "liquid poured out" (Erik) and the
        // next enter() built bodies from the corrupted pose.
        restPos: bone.position.clone(),
      };
      this.segments.push(seg);
      this._byName[name] = seg;
    }
    for (const [pn, cn, pivotBone, limit] of JOINTS) {
      const p = this._byName[pn], c = this._byName[cn];
      const bone = this.bones[pivotBone];
      if (!p || !c || !bone) continue;
      const pivot = bone.getWorldPosition(new THREE.Vector3());
      const a1 = this._worldToBody(p, pivot), a2 = this._worldToBody(c, pivot);
      const j = P.world.createImpulseJoint(
        R.JointData.spherical({ x: a1.x, y: a1.y, z: a1.z }, { x: a2.x, y: a2.y, z: a2.z }),
        p.body, c.body, true);
      // connected pair: joint holds them, contacts would only fight it —
      // but NON-adjacent limbs now collide for real (groups include self)
      j.setContactsEnabled?.(false);
      // bind-pose relative orientation — the ligament limit is measured from here
      const qp = p.body.rotation(), qc = c.body.rotation();
      const rel0 = new THREE.Quaternion(qp.x, qp.y, qp.z, qp.w).invert()
        .multiply(new THREE.Quaternion(qc.x, qc.y, qc.z, qc.w));
      this._joints.push({ j, p, c, limit: limit ?? 1.5, rel0 });
    }
  }

  _worldToBody(seg, worldPos) {
    const t = seg.body.translation(), q = seg.body.rotation();
    return worldPos.clone().sub(new THREE.Vector3(t.x, t.y, t.z))
      .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w).invert());
  }

  /** switch to physics control, optionally inheriting a velocity + impulse */
  enter(velocity = null, impulse = null, impulsePoint = null) {
    if (this.active) return;
    if (!this.segments.length) this._build();
    else this._syncBodiesToBones();
    for (const s of this.segments) {
      s.body.setEnabled?.(true);
      if (velocity) s.body.setLinvel({ x: velocity.x, y: velocity.y, z: velocity.z }, true);
      s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    if (impulse && impulsePoint) {
      // hit the nearest segment so the body SPINS from the contact point.
      // Clamp to ~16 m/s of delta-v on that segment — the inherited velocity
      // already carries the momentum; an unclamped hit (51 m/s on one 20kg
      // part) whiplashed the joint solver and shredded the throw entirely.
      let best = null, d = 1e9;
      for (const s of this.segments) {
        const t = s.body.translation();
        const dd = impulsePoint.distanceToSquared(new THREE.Vector3(t.x, t.y, t.z));
        if (dd < d) { d = dd; best = s; }
      }
      if (best) {
        const mag = Math.hypot(impulse.x, impulse.y, impulse.z);
        const cap = best.body.mass() * 16;
        const k = mag > cap ? cap / mag : 1;
        best.body.applyImpulseAtPoint(
          { x: impulse.x * k, y: impulse.y * k, z: impulse.z * k },
          { x: impulsePoint.x, y: impulsePoint.y, z: impulsePoint.z }, true);
      }
    }
    this.active = true;
    this._settleT = 0;
  }

  /** rebuild body poses from the CURRENT animated skeleton (re-entering) */
  _syncBodiesToBones() {
    for (const s of this.segments) {
      s.bone.updateWorldMatrix(true, false);
      const bw = s.bone.getWorldQuaternion(this._tmp.q1);
      const bodyQ = bw.clone().multiply(s.qOff.clone().invert());
      const pivot = s.bone.getWorldPosition(this._tmp.v1);
      const mid = pivot.clone().sub(s.pOff.clone().applyQuaternion(bodyQ));
      s.body.setTranslation({ x: mid.x, y: mid.y, z: mid.z }, true);
      s.body.setRotation({ x: bodyQ.x, y: bodyQ.y, z: bodyQ.z, w: bodyQ.w }, true);
      s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  /** per fixed step: capture animation targets + apply PD muscle torques */
  fixedUpdate(dt) {
    if (!this.active || !this.tone) return;
    const T = this._tmp;
    for (const s of this.segments) {
      // target = where the ANIMATION wants this bone (the Animator keeps
      // playing underneath; its pose is the muscle target)
      s.bone.updateWorldMatrix(true, false);
      s.targetQ.copy(s.bone.getWorldQuaternion(T.q1)).multiply(s.qOff.clone().invert());
      const q = s.body.rotation();
      const cur = T.q2.set(q.x, q.y, q.z, q.w);
      const err = T.q3.copy(s.targetQ).multiply(cur.clone().invert());
      // shortest arc
      if (err.w < 0) { err.x *= -1; err.y *= -1; err.z *= -1; err.w *= -1; }
      const angle = 2 * Math.acos(Math.min(1, Math.abs(err.w)));
      if (angle > 1e-3) {
        const s3 = Math.sqrt(Math.max(1e-9, 1 - err.w * err.w));
        const axis = T.v1.set(err.x / s3, err.y / s3, err.z / s3);
        const av = s.body.angvel();
        const kp = 42 * this.tone, kd = 6 * Math.sqrt(Math.max(0.1, this.tone));
        const torque = axis.multiplyScalar(kp * angle)
          .sub(T.v2.set(av.x, av.y, av.z).multiplyScalar(kd));
        const k = s.inertia * dt;                    // inertia-scaled → stable
        s.body.applyTorqueImpulse({ x: torque.x * k, y: torque.y * k, z: torque.z * k }, true);
      }
    }
    // ligaments: past the anatomical limit, a stiff equal-and-opposite torque
    // pair shoves the joint back inside its range (elbows/knees no longer fold
    // backward). Same inertia-scaled discipline as the muscles.
    for (const L of this._joints) {
      if (!L.limit) continue;
      const qp = L.p.body.rotation(), qc = L.c.body.rotation();
      const parentQ = T.q1.set(qp.x, qp.y, qp.z, qp.w);
      const rel = T.q2.copy(parentQ).invert().multiply(T.q3.set(qc.x, qc.y, qc.z, qc.w));
      const err = T.q3.copy(L.rel0).invert().multiply(rel);
      if (err.w < 0) { err.x *= -1; err.y *= -1; err.z *= -1; err.w *= -1; }
      const ang = 2 * Math.acos(Math.min(1, Math.abs(err.w)));
      const over = ang - L.limit;
      if (over > 0) {
        const s3 = Math.sqrt(Math.max(1e-9, 1 - err.w * err.w));
        // err = rel0⁻¹·δ·rel0 — the axis lives in the CHILD-BIND frame, so
        // world = parentQ·rel0·axis (parentQ alone pushed sideways and FED
        // energy in: joints blew past π and the body never settled)
        const bindW = T.q2.copy(parentQ).multiply(L.rel0);
        const axis = T.v1.set(err.x / s3, err.y / s3, err.z / s3).applyQuaternion(bindW);
        const wp = L.p.body.angvel(), wc = L.c.body.angvel();
        const relW = T.v2.set(wc.x - wp.x, wc.y - wp.y, wc.z - wp.z).dot(axis);
        // gains in Δω terms: ~28·relW ≈ critically damped once both bodies
        // take their share; hard cap keeps one step from ever injecting more
        // than ~12 rad/s (420/45 uncapped chattered at 60Hz, hit 106 rad/s,
        // and the sanity clamp then bled ALL momentum — body plopped in place)
        const mag = Math.min(140 * over + 28 * Math.max(0, relW), 750);
        const k = L.c.inertia * dt * mag;
        L.c.body.applyTorqueImpulse({ x: -axis.x * k, y: -axis.y * k, z: -axis.z * k }, true);
        L.p.body.applyTorqueImpulse({ x: axis.x * k, y: axis.y * k, z: axis.z * k }, true);
      }
    }
    // settle tracking + hard sanity clamps (a bad tune must never feed the
    // solver runaway energy — that froze the page once)
    let maxV = 0;
    for (const s of this.segments) {
      const v = s.body.linvel(), w = s.body.angvel();
      const vl = Math.hypot(v.x, v.y, v.z), wl = Math.hypot(w.x, w.y, w.z);
      if (!isFinite(vl) || vl > 70) s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      if (!isFinite(wl) || wl > 45) s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      maxV = Math.max(maxV, isFinite(vl) ? vl : 0);
    }
    this._settleT = maxV < 0.8 ? (this._settleT ?? 0) + dt : 0;
  }

  /** per frame: physics bodies → visual bones (world-space override) */
  update() {
    if (!this.active) return;
    const T = this._tmp;
    for (const s of this.segments) {
      const t = s.body.translation(), q = s.body.rotation();
      const bodyQ = T.q1.set(q.x, q.y, q.z, q.w);
      const boneWorldQ = T.q2.copy(bodyQ).multiply(s.qOff);
      const pivotWorld = T.v1.copy(s.pOff).applyQuaternion(bodyQ).add(T.v2.set(t.x, t.y, t.z));
      const parent = s.bone.parent;
      parent.updateWorldMatrix(true, false);
      // world → local under the live parent
      const pq = parent.getWorldQuaternion(T.q3);
      s.bone.quaternion.copy(pq.clone().invert().multiply(boneWorldQ));
      const lp = parent.worldToLocal(pivotWorld.clone());
      s.bone.position.copy(lp);
    }
  }

  /** resting long enough to stand back up? */
  settled(after = 1.2) { return this.active && (this._settleT ?? 0) > after; }

  /** pelvis world position (respawn the capsule here) */
  pelvisPos() {
    const t = this._byName.pelvis?.body.translation();
    return t ? new THREE.Vector3(t.x, t.y, t.z) : new THREE.Vector3();
  }

  /** hand the bones back to the Animator */
  exit() {
    this.active = false;
    for (const s of this.segments) {
      s.body.setEnabled?.(false);
      s.bone.position.copy(s.restPos);       // undo update()'s position writes
    }
  }

  dispose() {
    for (const L of this._joints) this.phys.world.removeImpulseJoint(L.j ?? L, true);
    for (const s of this.segments) this.phys.world.removeRigidBody(s.body);
    this.segments = []; this._joints = [];
  }
}
