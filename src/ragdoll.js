import * as THREE from "three";
import { R } from "./phys.js";

/**
 * Active ragdoll — the character as a jointed PHYSICS skeleton with muscles.
 *
 * Capsule rigid bodies built from Mixamo bones, connected by spherical/revolute
 * IMPULSE joints. Independent dynamic links self-collide (limbs can't pass through
 * each other) and respond to the applied muscle/ligament torque-impulses.
 * Each fixed step a PD controller applies muscle torque toward the Animator
 * pose. Muscle tone is a dial:
 *   tone 0   = unconscious noodle
 *   tone ~1  = stunned, flailing toward the pose
 *   tone 3+  = fights hard to hold the mocap pose
 *
 * Interactions (Half Sword / fight layer):
 *   rag.grab("handL", otherBody, worldPoint)  // pull / clinch
 *   rag.hit(point, impulse)                   // localized strike
 *   rag.trip(dir) / rag.clothesline(dir)      // fight moves
 *   rag.release() / rag.releaseAll()
 *
 * Usage:
 *   const rag = new Ragdoll(ch.bones, phys, { tone: 1.9 });
 *   rag.enter(velocity, impulse, impulsePoint);
 *   rag.update(); rag.fixedUpdate(dt);
 *   if (rag.settled()) rag.exit();
 */
const SEGMENTS = [
  // name        bone           child end          radius
  ["pelvis",    "Hips",         "Spine1",          0.14],
  ["chest",     "Spine1",       "Neck",            0.13],
  ["head",      "Head",         null,              0.10],
  ["upperArmL", "LeftArm",      "LeftForeArm",     0.05],
  ["forearmL",  "LeftForeArm",  "LeftHand",        0.045],
  ["handL",     "LeftHand",     "LeftHand",        0.04],
  ["upperArmR", "RightArm",     "RightForeArm",    0.05],
  ["forearmR",  "RightForeArm", "RightHand",       0.045],
  ["handR",     "RightHand",    "RightHand",       0.04],
  ["thighL",    "LeftUpLeg",    "LeftLeg",         0.07],
  ["shinL",     "LeftLeg",      "LeftFoot",        0.06],
  ["footL",     "LeftFoot",     "LeftToeBase",     0.045],
  ["thighR",    "RightUpLeg",   "RightLeg",        0.07],
  ["shinR",     "RightLeg",     "RightFoot",       0.06],
  ["footR",     "RightFoot",    "RightToeBase",    0.045],
];

// Joint tree (parent → child). Multibody requires a tree; order is parent-first.
// type: spherical (ball) | revolute (hinge). Revolute uses hard Rapier limits.
// limit = soft cone ROM for spherical (rad from bind). hinge = [min,max] for revolute.
// ROM limits are ANATOMICAL maxima (how far a real joint CAN travel from the
// T-pose bind), NOT "stay near the T-pose". A ragdoll settled on the ground
// naturally folds — spine curved, hips flexed, head turned — so tight cones made
// EVERY settled pose read as hyperextended and it could never come to rest. These
// generous cones let a natural heap sit WITHIN ROM (so settle fires) while still
// blocking impossible poses; the ugly backward-bend of knees/elbows is caught by
// the hard revolute hinge limits below, not these cones.
const JOINTS = [
  ["pelvis",    "chest",     "Spine1",       { type: "spherical", limit: 0.9 }],   // lumbar
  ["chest",     "head",      "Head",         { type: "spherical", limit: 1.0 }],   // neck
  ["chest",     "upperArmL", "LeftArm",      { type: "spherical", limit: 2.2 }],   // shoulder (very mobile)
  ["upperArmL", "forearmL",  "LeftForeArm",  { type: "revolute",  hinge: [-0.05, 2.45], limit: 1.3 }],
  ["forearmL",  "handL",     "LeftHand",     { type: "spherical", limit: 1.0 }],   // wrist
  ["chest",     "upperArmR", "RightArm",     { type: "spherical", limit: 2.2 }],
  ["upperArmR", "forearmR",  "RightForeArm", { type: "revolute",  hinge: [-0.05, 2.45], limit: 1.3 }],
  ["forearmR",  "handR",     "RightHand",    { type: "spherical", limit: 1.0 }],
  ["pelvis",    "thighL",    "LeftUpLeg",    { type: "spherical", limit: 2.0 }],   // hip (fetal flexion)
  ["thighL",    "shinL",     "LeftLeg",      { type: "revolute",  hinge: [-0.05, 2.25], limit: 1.2 }],
  ["shinL",     "footL",     "LeftFoot",     { type: "spherical", limit: 0.9 }],   // ankle
  ["pelvis",    "thighR",    "RightUpLeg",   { type: "spherical", limit: 2.0 }],
  ["thighR",    "shinR",     "RightLeg",     { type: "revolute",  hinge: [-0.05, 2.25], limit: 1.2 }],
  ["shinR",     "footR",     "RightFoot",    { type: "spherical", limit: 0.9 }],
];

// The "trunk" — pelvis + chest. Settle is judged on THESE alone: they carry the
// body's mass and come to rest cleanly. Even the head and thighs keep a ~2 rad/s
// angular jitter long after the pelvis is dead still, which (when they were in the
// settle set) held settleT at zero forever. The pelvis is where get-up teleports,
// so the trunk being at rest is the honest "the body has come to rest" signal.
const CORE_SEG = new Set(["pelvis", "chest"]);

const MASS_FRAC = {
  pelvis: 0.22, chest: 0.24, head: 0.07,
  upperArmL: 0.035, forearmL: 0.025, handL: 0.015,
  upperArmR: 0.035, forearmR: 0.025, handR: 0.015,
  thighL: 0.09, shinL: 0.05, footL: 0.02,
  thighR: 0.09, shinR: 0.05, footR: 0.02,
};

// ragdoll parts collide with everything INCLUDING each other — limbs must
// not pass through limbs (Erik). Adjacent jointed segments don't fight
// because each joint disables contacts between its own pair.
const RAGDOLL_GROUPS = (0x0002 << 16) | 0xffff;

let _grabId = 1;

export class Ragdoll {
  constructor(bones, phys, {
    totalMass = 75, tone = 1.8, collisionGroups = null, assist = 0.95,
    // ── stable muscle PD gains ──
    muscleKp = 42,       // proportional gain per unit tone (torque ∝ pose error).
    muscleKd = 12,       // derivative gain per unit tone — LINEAR in tone so the
                         //   damping ratio rises with stiffness (√tone left it
                         //   underdamped and it blew up to the clamp at high tone).
    muscleMaxTorque = 500, // hard cap on PD torque per step — divergence-proof.
    // ── firm, stable soft ROM (spine/shoulder/hip have no native Rapier limits) ──
    romMargin = 0.08,    // deadzone (rad) past the cone before the ligament engages.
    romSpring = 60,      // restoring torque per rad of overshoot. Firm enough to
                         //   visibly hold joint limits, but NOT so firm it rocks the
                         //   trunk and blocks settle (140 held limits harder but the
                         //   spine ligament kept pelvis+chest rocking → never settled).
    romDamp = 14,        // one-sided damping of the OPENING rate (near-critical).
    romMaxTorque = 380,  // cap on ligament torque.
    romHyper = 0.6,      // overshoot (rad) counting as EGREGIOUS (readout only).
    settleLinV = 0.35,   // TRUNK (pelvis+chest) linear-still threshold …
    settleAngV = 1.1,    // … AND angular-still threshold, sustained → get-up.
    // ── tension / knockdown model (Erik: "TENSION, not a wet towel") ──
    giveTime = 0.22,     // on knockdown: seconds of impact GIVE before tensing up.
    giveFloor = 0.55,    // tone fraction during the give (staggery react), rising to 1.
    proneY = 0.75,       // pelvis height (m) below which the body is treated as DOWN.
    settleRelax = 0.08,  // once DOWN, muscle tone × this so a tense body can still
                         //   come to rest and get up (ROM/limbs stay firm regardless).
    knockdownImpulse = 320, // hit impulse magnitude at/above which a strike KNOCKS
                         //   HIM DOWN; below it he staggers and stays up (used by labs).
  } = {}) {
    this.bones = bones;
    this.phys = phys;
    this.tone = tone;
    this.assist = assist;                 // gravity-compensation dial (muscle mode)
    this.muscleKp = muscleKp;
    this.muscleKd = muscleKd;
    this.muscleMaxTorque = muscleMaxTorque;
    this.romMargin = romMargin;
    this.romSpring = romSpring;
    this.romDamp = romDamp;
    this.romMaxTorque = romMaxTorque;
    this.romHyper = romHyper;
    this._hyperROM = 0;
    this.settleLinV = settleLinV;
    this.settleAngV = settleAngV;
    this.giveTime = giveTime;
    this.giveFloor = giveFloor;
    this.proneY = proneY;
    this.settleRelax = settleRelax;
    this.knockdownImpulse = knockdownImpulse;
    this._downT = 0;                      // time since knockdown (drives give→tense ramp)
    this._overROM = 0;                    // joints resting past ROM (live metric)
    this.collisionGroups = collisionGroups;
    this.active = false;
    this.muscle = false;
    this.segments = [];
    this._joints = [];
    this._grabs = [];                     // cross-body impulse/spring joints
    this._byName = {};
    this._anchorSeg = null;
    this._tmp = {
      v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
      q1: new THREE.Quaternion(), q2: new THREE.Quaternion(), q3: new THREE.Quaternion(),
      qA: new THREE.Quaternion(), qB: new THREE.Quaternion(),
      m1: new THREE.Matrix4(),
    };
    this.totalMass = totalMass;

    // ═══ 3-TIER MUSCLE STACK ═══
    this.layers = { procedural: Object.create(null), reflex: Object.create(null) };
    this.useLayers = true;
    this._hasLayers = false;

    this.reflexesEnabled = true;
    this._bracing = false;
    this.braceParams = { fallVy: -3.5, reach: 1.1, armStiff: 1.8, softStiff: 0.55, axis: "z" };
    this._settleT = 0;
  }

  /** build bodies + joints at the skeleton's CURRENT world pose */
  _build() {
    const P = this.phys;
    for (const [name, boneName, endName, radius] of SEGMENTS) {
      const bone = this.bones[boneName];
      if (!bone) continue;
      bone.updateWorldMatrix(true, false);
      const a = bone.getWorldPosition(new THREE.Vector3());
      let b;
      const boneQ = bone.getWorldQuaternion(new THREE.Quaternion());
      if (endName === boneName || (endName && !this.bones[endName] && /hand|foot/.test(name))) {
        // hand/foot stub when no child bone — short capsule along the limb tip
        const tip = name.startsWith("foot")
          ? new THREE.Vector3(0, 0, radius * 2.2)   // toes forward (Mixamo +Z)
          : new THREE.Vector3(0, -radius * 1.6, 0);
        b = a.clone().add(tip.applyQuaternion(boneQ));
      } else if (endName && this.bones[endName]) {
        b = this.bones[endName].getWorldPosition(new THREE.Vector3());
      } else {
        b = a.clone().add(new THREE.Vector3(0, radius * 1.8, 0));
      }
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a);
      const len = Math.max(dir.length(), radius * 1.6);
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      // extremities settle faster; core keeps a bit more life for readable tumbles.
      // Angular damping is a RATE resistance — high values barely affect a fast
      // tumble (the hit impulses dominate) but firmly kill the low-speed residual
      // writhe that used to keep the pile alive forever, so it comes to rest.
      const isTip = /hand|foot|head/.test(name);
      const linDamp = isTip ? 0.6 : 0.4;
      const angDamp = isTip ? 6.0 : 5.0;
      const rb = P.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(mid.x, mid.y, mid.z)
          .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
          .setLinearDamping(linDamp).setAngularDamping(angDamp).setCcdEnabled(true));
      const segMass = this.totalMass * (MASS_FRAC[name] ?? 0.03);
      const col = P.world.createCollider(
        R.ColliderDesc.capsule(Math.max(0.015, len / 2 - radius), radius)
          .setMass(segMass)
          .setFriction(0.9).setRestitution(0.05)
          .setCollisionGroups(this.collisionGroups ?? RAGDOLL_GROUPS), rb);
      const boneWorldQ = bone.getWorldQuaternion(new THREE.Quaternion());
      const seg = {
        name, bone, body: rb, col, radius, len,
        inertia: segMass * (3 * radius * radius + len * len) / 12,
        stiffMul: 1,
        qOff: quat.clone().invert().multiply(boneWorldQ),
        pOff: a.clone().sub(mid).applyQuaternion(quat.clone().invert()),
        targetQ: boneWorldQ.clone(),
        restPos: bone.position.clone(),
      };
      this.segments.push(seg);
      this._byName[name] = seg;
    }

    for (const [pn, cn, pivotBone, conf] of JOINTS) {
      const p = this._byName[pn], c = this._byName[cn];
      const bone = this.bones[pivotBone];
      if (!p || !c || !bone) continue;
      const pivot = bone.getWorldPosition(new THREE.Vector3());
      const a1 = this._worldToBody(p, pivot), a2 = this._worldToBody(c, pivot);
      const type = conf.type || "spherical";
      let params;
      if (type === "revolute") {
        const axis = this._hingeAxisLocal(p, c);
        params = R.JointData.revolute(
          { x: a1.x, y: a1.y, z: a1.z },
          { x: a2.x, y: a2.y, z: a2.z },
          axis);
      } else {
        params = R.JointData.spherical(
          { x: a1.x, y: a1.y, z: a1.z },
          { x: a2.x, y: a2.y, z: a2.z });
      }
      // IMPULSE joints (NOT multibody): links stay independent dynamic bodies, so
      // non-adjacent limbs SELF-COLLIDE (multibody links cannot) and the PD-muscle
      // + soft-ligament torque-impulses drive the solver as designed. Multibody's
      // reduced-coordinate solver swallowed those torques → the ragdoll thrashed and
      // never settled, and links passed through each other. Adjacent pairs disable
      // their mutual contact so the joint isn't fighting a collision.
      const j = P.world.createImpulseJoint(params, p.body, c.body, true);
      j.setContactsEnabled?.(false);
      let softHinge = false;
      if (type === "revolute" && conf.hinge) {
        if (typeof j.setLimits === "function") j.setLimits(conf.hinge[0], conf.hinge[1]);
        // build lacks revolute limits → soft ligament uses the hinge range as a proxy
        else softHinge = true;
      }
      const qp = p.body.rotation(), qc = c.body.rotation();
      const rel0 = new THREE.Quaternion(qp.x, qp.y, qp.z, qp.w).invert()
        .multiply(new THREE.Quaternion(qc.x, qc.y, qc.z, qc.w));
      this._joints.push({
        j, p, c, type,
        limit: softHinge && conf.hinge
          ? Math.max(Math.abs(conf.hinge[0]), Math.abs(conf.hinge[1]))
          : (conf.limit ?? 1.2),
        hinge: conf.hinge || null,
        softHinge,
        rel0, multibody: false,
      });
    }
  }

  /** hinge axis in a shared local frame (parent body). Prefer bone-plane normal. */
  _hingeAxisLocal(parentSeg, childSeg) {
    const T = this._tmp;
    const pq = parentSeg.body.rotation();
    const parentQ = T.q1.set(pq.x, pq.y, pq.z, pq.w);
    // capsule +Y = bone direction in world
    const pDir = T.v1.set(0, 1, 0).applyQuaternion(parentQ);
    const cq = childSeg.body.rotation();
    const childQ = T.q2.set(cq.x, cq.y, cq.z, cq.w);
    const cDir = T.v2.set(0, 1, 0).applyQuaternion(childQ);
    let axisW = T.v3.copy(pDir).cross(cDir);
    if (axisW.lengthSq() < 1e-8) {
      // nearly straight limb — use hips lateral as reference
      const hips = this.bones.Hips;
      if (hips) {
        hips.updateWorldMatrix(true, false);
        const right = T.v1.set(1, 0, 0).applyQuaternion(hips.getWorldQuaternion(T.q3));
        axisW.copy(pDir).cross(right);
        if (axisW.lengthSq() < 1e-8) axisW.set(1, 0, 0);
        else axisW.cross(pDir);
      } else {
        axisW.set(1, 0, 0);
      }
    }
    axisW.normalize();
    // Rapier JS revolute takes one axis vector applied in both local frames.
    // With co-axial capsules at bind (straight knee/elbow) parent≈child quat
    // around the bone, so parent-local ≈ child-local for an axis ⊥ bone.
    const axisL = axisW.applyQuaternion(parentQ.clone().invert());
    const len = axisL.length() || 1;
    return { x: axisL.x / len, y: axisL.y / len, z: axisL.z / len };
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
    // Capture the pose to HOLD, ONCE, from the animated skeleton — BEFORE any
    // physics runs. The PD (tension) targets THIS snapshot, never the live bones:
    // rag.update() rewrites the bones from the physics bodies every frame, so a PD
    // reading the bones would chase a one-frame-lagged copy of its own output —
    // positive feedback that flings the joints apart (peakSep in the hundreds of m,
    // the "stretch to infinity"). A fixed snapshot is a stable PD setpoint = real
    // muscle tension that resists deviation without pumping.
    this._snapshotHold();
    if (impulse && impulsePoint) this.hit(impulsePoint, impulse);
    this.active = true;
    this._settleT = 0;
    this._downT = 0;
  }

  /** snapshot the pose to HOLD: each body's orientation + each joint's RELATIVE
   *  rotation (the muscle PD targets the relative pose so the body can tumble as a
   *  whole while holding its shape), plus the muscle anchor pose. */
  _snapshotHold() {
    const T = this._tmp;
    for (const s of this.segments) {
      const q = s.body.rotation();
      s.holdBodyQ = (s.holdBodyQ || new THREE.Quaternion()).set(q.x, q.y, q.z, q.w);
      s.bone.updateWorldMatrix(true, false);
      s.holdQ = (s.holdQ || new THREE.Quaternion()).copy(s.bone.getWorldQuaternion(T.q1));
    }
    // per-joint snapshot relative rotation (child in parent's body frame)
    for (const L of this._joints) {
      L.holdRel = (L.holdRel || new THREE.Quaternion())
        .copy(L.p.holdBodyQ).invert().multiply(L.c.holdBodyQ);
    }
    const s = this._anchorSeg;
    if (s) {
      const bodyQ = s.bone.getWorldQuaternion(T.q1).multiply(s.qOff.clone().invert());
      const mid = s.bone.getWorldPosition(T.v1).sub(s.pOff.clone().applyQuaternion(bodyQ));
      this._anchorPose = { pos: mid.clone(), quat: bodyQ.clone() };
    }
  }
  /** re-capture the hold pose from the CURRENT bones (clip-tracking; call pre-update) */
  refreshMuscleTargets() { this._snapshotHold(); }

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

  /** ═══ MUSCLE MODE — hips pinned in place, limbs physically hold the pose ═══ */
  enterMuscle(tone = this.tone) {
    this.tone = tone;
    this.enter();                         // captures the hold snapshot (segments)
    this.muscle = true;
    const root = this._byName.pelvis || this._byName.chest;
    if (root) {
      this._anchorSeg = root;
      // Pin the pelvis with a REAL fixed joint to a static body — do NOT make it
      // kinematic. A kinematic anchor has infinite mass, so it ABSORBS the reaction
      // half of every per-joint muscle torque; the pelvis-connected children then
      // receive un-reacted torque, spin up (spherical joints don't resist spin),
      // and blow the joints apart. A dynamic pelvis held by a fixed joint keeps the
      // reactions in a real body (solver-managed) → the momentum-conserving PD stays
      // stable, exactly like the free ragdoll.
      const t = root.body.translation(), q = root.body.rotation();
      const stat = this.phys.world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(t.x, t.y, t.z).setRotation(q));
      const I = { x: 0, y: 0, z: 0, w: 1 }, O = { x: 0, y: 0, z: 0 };
      this._anchorJoint = this.phys.world.createImpulseJoint(
        R.JointData.fixed(O, I, O, I), stat, root.body, true);
      this._anchorStatic = stat;
    }
    this._snapshotHold();
    return true;
  }
  exitMuscle() {
    if (this._anchorJoint) { try { this.phys.world.removeImpulseJoint(this._anchorJoint, true); } catch (_) {} }
    if (this._anchorStatic) { try { this.phys.world.removeRigidBody(this._anchorStatic); } catch (_) {} }
    this._anchorJoint = null; this._anchorStatic = null;
    this.muscle = false; this._anchorSeg = null; this._anchorPose = null;
    this.releaseAll();
    this.exit();
  }

  /** cancel a tone-scaled fraction of gravity so muscle PD can hold a stand without
   *  sag. Applied as a per-step IMPULSE (force·dt), NOT addForce: Rapier's addForce
   *  PERSISTS and accumulates across steps unless reset, so calling it every frame
   *  built an unbounded upward force that launched the skeleton (the muscle-mode
   *  explosion). An impulse is one-shot and equivalent (impulse = m·g·k·dt). */
  _gravityAssist(dt) {
    if (!this.muscle || this.assist <= 0) return;
    const g = this.phys.world.gravity;
    const k = this.assist * dt;            // assist = direct gravity-comp fraction
    for (const s of this.segments) {
      if (s === this._anchorSeg) continue;
      if (typeof s.body.isEnabled === "function" && !s.body.isEnabled()) continue;
      const m = s.body.mass();
      s.body.applyImpulse({ x: -g.x * m * k, y: -g.y * m * k, z: -g.z * m * k }, true);
    }
  }

  /** shove a segment (default chest) — test poke / knockback */
  shove(dir, mag = 6, segName = "chest") {
    const s = this._byName[segName] || this._byName.chest; if (!s || !this.active) return;
    const n = new THREE.Vector3(dir.x || 0, dir.y || 0, dir.z || 0);
    if (n.lengthSq()) n.normalize(); else n.set(1, 0.15, 0);
    n.multiplyScalar(mag * s.body.mass());
    s.body.applyImpulse({ x: n.x, y: n.y, z: n.z }, true);
  }

  // ═══ FIGHT INTERACTIONS ═══

  /**
   * Localized hit: impulse at a world point on the nearest segment.
   * Clamped so one strike can't shred the solver (car-hit path uses this too).
   */
  hit(impulsePoint, impulse, { maxDeltaV = 16, soften = null } = {}) {
    if (!this.active && !this.segments.length) return null;
    if (!this.segments.length) this._build();
    let best = null, d = 1e9;
    const px = impulsePoint.x, py = impulsePoint.y, pz = impulsePoint.z;
    for (const s of this.segments) {
      const t = s.body.translation();
      const dd = (t.x - px) ** 2 + (t.y - py) ** 2 + (t.z - pz) ** 2;
      if (dd < d) { d = dd; best = s; }
    }
    if (!best) return null;
    const mag = Math.hypot(impulse.x, impulse.y, impulse.z);
    const cap = best.body.mass() * maxDeltaV;
    const k = mag > cap ? cap / mag : 1;
    best.body.applyImpulseAtPoint(
      { x: impulse.x * k, y: impulse.y * k, z: impulse.z * k },
      { x: px, y: py, z: pz }, true);
    // optional: briefly soften the hit region so it "gives" like flesh
    if (soften != null) {
      best.stiffMul = Math.min(best.stiffMul, soften);
      // restore after a short window
      const restore = best;
      const prev = 1;
      setTimeout(() => { if (restore) restore.stiffMul = prev; }, 280);
    }
    return best.name;
  }

  /** leg sweep / trip — soften legs + kick a shin so the body topples believably */
  trip(dir = { x: 1, y: 0, z: 0 }, mag = 5, side = "L") {
    if (!this.active) this.enter();
    const shin = this._byName[`shin${side}`] || this._byName.shinL || this._byName.shinR;
    const thigh = this._byName[`thigh${side}`] || this._byName.thighL;
    this._setStiff({
      thighL: 0.25, thighR: 0.25, shinL: 0.2, shinR: 0.2, footL: 0.2, footR: 0.2,
      pelvis: 0.55, chest: 0.7,
    });
    if (shin) {
      const n = new THREE.Vector3(dir.x || 0, dir.y || 0, dir.z || 0);
      if (n.lengthSq()) n.normalize(); else n.set(1, 0, 0);
      n.multiplyScalar(mag * shin.body.mass());
      const t = shin.body.translation();
      shin.body.applyImpulseAtPoint(
        { x: n.x, y: n.y + shin.body.mass() * 0.8, z: n.z },
        { x: t.x, y: t.y, z: t.z }, true);
    }
    if (thigh) thigh.stiffMul = 0.2;
    // clear soft legs after the tumble starts
    setTimeout(() => { if (this.active) this._setStiff(null); }, 650);
  }

  /** clothesline — high strike across chest/neck with a slight lift */
  clothesline(dir = { x: 1, y: 0, z: 0 }, mag = 9) {
    if (!this.active) this.enter();
    const chest = this._byName.chest || this._byName.pelvis;
    if (!chest) return;
    const t = chest.body.translation();
    const head = this._byName.head?.body.translation();
    const point = head
      ? { x: (t.x + head.x) * 0.5, y: (t.y + head.y) * 0.5, z: (t.z + head.z) * 0.5 }
      : { x: t.x, y: t.y + 0.25, z: t.z };
    const n = new THREE.Vector3(dir.x || 0, dir.y || 0, dir.z || 0);
    if (n.lengthSq()) n.normalize(); else n.set(1, 0, 0);
    n.y += 0.25; n.normalize();
    n.multiplyScalar(mag * chest.body.mass());
    this.hit(point, n, { maxDeltaV: 18, soften: 0.35 });
    // whip the head a bit more for the snap
    if (this._byName.head) {
      this._byName.head.body.applyImpulse(
        { x: n.x * 0.25, y: n.y * 0.15, z: n.z * 0.25 }, true);
    }
  }

  /**
   * Grab / pull — spring joint from one of our segments to another rigid body
   * (another ragdoll segment, a weapon, a ledge). Returns a handle for release().
   *   rag.grab("handL", otherRag._byName.forearmR.body, worldPoint)
   *   rag.grab("handR", { body, point })
   */
  grab(segName, target, worldPoint = null, {
    stiffness = 800, damping = 40, restLength = 0.02, mode = "spring",
  } = {}) {
    if (!this.active && !this.segments.length) this._build();
    if (!this.active) this.enter();
    const seg = this._byName[segName] || this._byName.handL || this._byName.forearmL;
    if (!seg) return null;

    let otherBody = null, otherPoint = null;
    if (target?.body) {
      otherBody = target.body;
      otherPoint = target.point || worldPoint;
    } else if (target?.translation || typeof target?.mass === "function") {
      otherBody = target;
      otherPoint = worldPoint;
    } else if (target instanceof Ragdoll) {
      const ts = target._byName.forearmR || target._byName.chest;
      if (!ts) return null;
      otherBody = ts.body;
      otherPoint = worldPoint;
    }
    if (!otherBody) return null;

    const wp = worldPoint
      ? new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z)
      : (() => { const t = seg.body.translation(); return new THREE.Vector3(t.x, t.y, t.z); })();
    const a1 = this._worldToBody(seg, wp);
    // other body local anchor
    const ot = otherBody.translation(), oq = otherBody.rotation();
    const a2 = wp.clone().sub(new THREE.Vector3(ot.x, ot.y, ot.z))
      .applyQuaternion(new THREE.Quaternion(oq.x, oq.y, oq.z, oq.w).invert());

    let params;
    if (mode === "spherical") {
      params = R.JointData.spherical(
        { x: a1.x, y: a1.y, z: a1.z },
        { x: a2.x, y: a2.y, z: a2.z });
    } else {
      params = R.JointData.spring(
        restLength, stiffness, damping,
        { x: a1.x, y: a1.y, z: a1.z },
        { x: a2.x, y: a2.y, z: a2.z });
    }
    // Cross-tree attachments MUST be impulse joints (multibody is a single tree).
    const j = this.phys.world.createImpulseJoint(params, seg.body, otherBody, true);
    j.setContactsEnabled?.(false);
    const id = _grabId++;
    const grab = { id, j, seg, otherBody, impulse: true };
    this._grabs.push(grab);
    // stiffen the grabbing arm so the pull reads through the shoulder chain
    if (/hand|forearm|upperArm/.test(seg.name)) {
      const side = seg.name.endsWith("L") ? "L" : "R";
      const arm = [`hand${side}`, `forearm${side}`, `upperArm${side}`];
      for (const n of arm) if (this._byName[n]) this._byName[n].stiffMul = Math.max(this._byName[n].stiffMul, 1.6);
    }
    return id;
  }

  release(id = null) {
    if (id == null) return this.releaseAll();
    const i = this._grabs.findIndex((g) => g.id === id);
    if (i < 0) return false;
    const g = this._grabs[i];
    try { this.phys.world.removeImpulseJoint(g.j, true); } catch (_) { /* already gone */ }
    this._grabs.splice(i, 1);
    return true;
  }
  releaseAll() {
    for (const g of this._grabs) {
      try { this.phys.world.removeImpulseJoint(g.j, true); } catch (_) { /* */ }
    }
    this._grabs.length = 0;
  }

  // ═══ 3-TIER MUSCLE STACK API ═══
  setProcedural(segName, deltaQ, weight = 1) { this._setLayer("procedural", segName, deltaQ, weight); }
  setReflex(segName, deltaQ, weight = 1) { this._setLayer("reflex", segName, deltaQ, weight); }
  clearProcedural(segName) { if (segName) delete this.layers.procedural[segName]; else this.layers.procedural = Object.create(null); this._refreshHasLayers(); }
  clearReflex(segName) { if (segName) delete this.layers.reflex[segName]; else this.layers.reflex = Object.create(null); this._refreshHasLayers(); }
  clearLayers() { this.layers.procedural = Object.create(null); this.layers.reflex = Object.create(null); this._hasLayers = false; }

  _setLayer(kind, segName, deltaQ, weight) {
    const bag = this.layers[kind];
    if (!deltaQ || weight <= 0) { delete bag[segName]; this._refreshHasLayers(); return; }
    const e = bag[segName] ?? (bag[segName] = { q: new THREE.Quaternion(), weight: 0 });
    e.q.copy(deltaQ); e.weight = Math.min(1, weight);
    this._hasLayers = true;
  }
  _refreshHasLayers() {
    this._hasLayers = Object.keys(this.layers.procedural).length > 0 || Object.keys(this.layers.reflex).length > 0;
  }

  _composeTarget(segName, baseW) {
    const T = this._tmp;
    const p = this.layers.procedural[segName];
    if (p && p.weight > 0) baseW.premultiply(T.qA.identity().slerp(p.q, p.weight));
    const r = this.layers.reflex[segName];
    if (r && r.weight > 0) baseW.premultiply(T.qB.identity().slerp(r.q, r.weight));
    return baseW;
  }

  /** FALL-BRACE reflex when falling hard */
  _updateReflexes() {
    if (!this.reflexesEnabled || !this.active) return;
    const chest = this._byName.chest || this._byName.pelvis;
    if (!chest) return;
    const lv = chest.body.linvel();
    const brace = lv.y < this.braceParams.fallVy && (this._settleT ?? 0) < 0.06;
    if (brace && !this._bracing) this._enterBrace();
    else if (!brace && this._bracing) this._exitBrace();
  }
  _enterBrace() {
    this._bracing = true;
    const T = this._tmp, Q = T.q1.constructor, V = T.v1.constructor, P = this.braceParams;
    const ax = P.axis;
    const mk = (sign) => new Q().setFromAxisAngle(new V(ax === "x" ? sign : 0, ax === "y" ? sign : 0, ax === "z" ? sign : 0).normalize(), P.reach);
    this.setReflex("upperArmL", mk(1), 0.9);
    this.setReflex("upperArmR", mk(-1), 0.9);
    this._setStiff({
      upperArmL: P.armStiff, upperArmR: P.armStiff,
      forearmL: P.armStiff * 0.9, forearmR: P.armStiff * 0.9,
      handL: P.armStiff * 0.7, handR: P.armStiff * 0.7,
      chest: P.softStiff, pelvis: P.softStiff,
      thighL: P.softStiff, thighR: P.softStiff, shinL: P.softStiff, shinR: P.softStiff,
    });
  }
  _exitBrace() {
    this._bracing = false;
    this.clearReflex("upperArmL"); this.clearReflex("upperArmR");
    this._setStiff(null);
  }
  _setStiff(map) { for (const s of this.segments) s.stiffMul = map ? (map[s.name] ?? 1) : 1; }

  /** per fixed step: capture animation targets + apply PD muscle torques */
  fixedUpdate(dt) {
    if (!this.active || !this.tone) return;
    this._downT += dt;
    this._updateReflexes();
    if (this.muscle) this._gravityAssist(dt);  // pelvis held by a fixed joint now
    // effective tone. MUSCLE mode holds FULL tone (anchored + gravity-assisted to
    // keep a pose). A FREE knockdown is TENSE, not limp (Erik: "not a wet towel"):
    //   • brief GIVE on impact (giveFloor) so a hit staggers/reads, then it TENSES
    //     up to full tone over giveTime — muscles brace.
    //   • BUT once the body is clearly DOWN (pelvis below proneY), relax the tone
    //     (× settleRelax) so a tense body can still come to rest + get up — a body
    //     fighting to stand while prone never settles. The FIRM ROM ligaments keep
    //     the limbs from noodling/hyperextending the whole time, independent of tone,
    //     so "down + relaxed" still looks boned, not like a rag.
    let effTone = this.tone;
    if (!this.muscle) {
      const k = Math.min(1, this._downT / Math.max(1e-3, this.giveTime));
      let tension = this.giveFloor + (1 - this.giveFloor) * k;
      const pel = this._byName.pelvis;
      if (pel && pel.body.translation().y < this.proneY) tension *= this.settleRelax;
      effTone = this.tone * tension;
    }
    const T = this._tmp;
    // ═══ MUSCLE PD — per JOINT, RELATIVE, momentum-conserving ═══
    // Drives each joint's relative rotation toward its snapshot (holdRel) with
    // EQUAL-AND-OPPOSITE torques on parent + child. This is THE stability fix: the
    // old per-segment PD torqued each body toward a WORLD orientation with no
    // reaction, injecting net angular momentum that the joints converted into linear
    // ejection — the whole skeleton flew off ("stretch to infinity"). Equal-opposite
    // torque conserves momentum (it can't launch the body), and targeting the
    // RELATIVE pose means the body can tumble freely as a whole while its limbs hold
    // their shape = real muscle tension. kd is LINEAR in tone so damping stays ≥
    // critical as stiffness rises. Torque is capped, so no single step can diverge.
    if (effTone > 0.001) {
      const pQ = T.q1, cQ = T.q2, curRel = T.q3, err = T.qA;
      for (const L of this._joints) {
        const stiff = L.c.stiffMul ?? 1;
        const kp = this.muscleKp * effTone * stiff;
        if (kp <= 0 || !L.holdRel) continue;
        const a = L.p.body.rotation(), b = L.c.body.rotation();
        pQ.set(a.x, a.y, a.z, a.w); cQ.set(b.x, b.y, b.z, b.w);
        curRel.copy(pQ).invert().multiply(cQ);            // child in parent frame
        pQ.set(a.x, a.y, a.z, a.w);                         // pQ was inverted above; restore
        err.copy(L.holdRel).multiply(curRel.invert());     // holdRel · curRel⁻¹
        if (err.w < 0) { err.x *= -1; err.y *= -1; err.z *= -1; err.w *= -1; }
        const angle = 2 * Math.acos(Math.min(1, Math.abs(err.w)));
        if (angle < 1e-3) continue;
        const s3 = Math.sqrt(Math.max(1e-9, 1 - err.w * err.w));
        const axis = T.v1.set(err.x / s3, err.y / s3, err.z / s3).applyQuaternion(pQ);
        const wp = L.p.body.angvel(), wc = L.c.body.angvel();
        const relW = (wc.x - wp.x) * axis.x + (wc.y - wp.y) * axis.y + (wc.z - wp.z) * axis.z;
        const kd = this.muscleKd * effTone * stiff;
        let mag = kp * Math.min(angle, 1.2) - kd * relW;
        if (mag > this.muscleMaxTorque) mag = this.muscleMaxTorque;
        else if (mag < -this.muscleMaxTorque) mag = -this.muscleMaxTorque;
        const Ir = (L.c.inertia * L.p.inertia) / (L.c.inertia + L.p.inertia);
        const k = Ir * dt * mag;
        L.c.body.applyTorqueImpulse({ x: axis.x * k, y: axis.y * k, z: axis.z * k }, true);
        L.p.body.applyTorqueImpulse({ x: -axis.x * k, y: -axis.y * k, z: -axis.z * k }, true);
      }
    }
    // ligaments / soft ROM — the spine/shoulder/hip/neck are SPHERICAL joints and
    // Rapier's JS build exposes no cone limit for them (only revolutes get native
    // setLimits). With the ROM cones widened to real anatomical maxima, a settled
    // heap sits WITHIN ROM on its own — so the ligament's only job is to catch the
    // EXTREME overshoots of a violent hit, gently. A velocity-projected "wall" was
    // tried and REJECTED: forcing an inward relative rate every step, on the 4
    // joints sharing the chest body, pumped ~20 rad/s of angular writhe that never
    // died. This is instead a mild damped restoring SPRING past a deadzone: torque
    // ∝ overshoot beyond the margin + one-sided damping of the opening rate, capped
    // low and scaled by the pair's reduced inertia. Below the deadzone it does
    // NOTHING, so normal settling is never disturbed (that was the writhe source).
    let overCount = 0, hyperCount = 0;
    const MARGIN = this.romMargin;
    for (const L of this._joints) {
      this._tendonDamp(L, dt);
      if (L.type === "revolute" && !L.softHinge) continue;   // native hard limits
      if (!L.limit) continue;
      const qp = L.p.body.rotation(), qc = L.c.body.rotation();
      const parentQ = T.q1.set(qp.x, qp.y, qp.z, qp.w);
      const rel = T.q2.copy(parentQ).invert().multiply(T.q3.set(qc.x, qc.y, qc.z, qc.w));
      const err = T.q3.copy(L.rel0).invert().multiply(rel);
      if (err.w < 0) { err.x *= -1; err.y *= -1; err.z *= -1; err.w *= -1; }
      const ang = 2 * Math.acos(Math.min(1, Math.abs(err.w)));
      const over = ang - L.limit;
      if (over > 0.02) overCount++;
      // EGREGIOUS hyperextension (visibly broken) — the only ROM state that must
      // block get-up. A joint a little past its cone in a settled heap is natural.
      if (over > this.romHyper) hyperCount++;
      if (over <= MARGIN) continue;          // deadzone: leave the settled pose alone
      const s3 = Math.sqrt(Math.max(1e-9, 1 - err.w * err.w));
      const bindW = T.q2.copy(parentQ).multiply(L.rel0);
      // axis of the deviation, in world — the direction opening PAST the limit
      const axis = T.v1.set(err.x / s3, err.y / s3, err.z / s3).applyQuaternion(bindW).normalize();
      const wp = L.p.body.angvel(), wc = L.c.body.angvel();
      const relW = (wc.x - wp.x) * axis.x + (wc.y - wp.y) * axis.y + (wc.z - wp.z) * axis.z;
      const Ir = (L.c.inertia * L.p.inertia) / (L.c.inertia + L.p.inertia);
      // spring back toward the limit + damp ONLY further opening (one-sided), capped.
      const mag = Math.min(this.romSpring * (over - MARGIN) + this.romDamp * Math.max(0, relW), this.romMaxTorque);
      const k = Ir * dt * mag;
      L.c.body.applyTorqueImpulse({ x: -axis.x * k, y: -axis.y * k, z: -axis.z * k }, true);
      L.p.body.applyTorqueImpulse({ x: axis.x * k, y: axis.y * k, z: axis.z * k }, true);
    }
    this._overROM = overCount;
    this._hyperROM = hyperCount;
    // soft sanity clamps — scale down runaway, never hard-zero (that was the
    // unpredictable "teleport stop" feel). Track whole-body max (readout) AND the
    // CORE (torso+hips) max separately — the core is what the settle test watches.
    let maxV = 0, maxW = 0, coreV = 0, coreW = 0;
    for (const s of this.segments) {
      const v = s.body.linvel(), w = s.body.angvel();
      let vl = Math.hypot(v.x, v.y, v.z), wl = Math.hypot(w.x, w.y, w.z);
      if (!isFinite(vl) || !isFinite(wl)) {
        s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        continue;
      }
      if (vl > 55) {
        const scl = 55 / vl;
        s.body.setLinvel({ x: v.x * scl, y: v.y * scl, z: v.z * scl }, true);
        vl = 55;
      }
      if (wl > 40) {
        const scl = 40 / wl;
        s.body.setAngvel({ x: w.x * scl, y: w.y * scl, z: w.z * scl }, true);
        wl = 40;
      }
      maxV = Math.max(maxV, vl);
      maxW = Math.max(maxW, wl);
      if (CORE_SEG.has(s.name)) { coreV = Math.max(coreV, vl); coreW = Math.max(coreW, wl); }
    }
    this._maxV = maxV; this._maxW = maxW; this._coreV = coreV; this._coreW = coreW;
    // SETTLE = the CORE (torso + hips) is linearly AND angularly still, sustained.
    // Watching every segment never worked: the tiny-inertia extremities (hands,
    // feet, forearms) keep spinning at ~5 rad/s toward an unreachable target and
    // the solver occasionally POPS a trapped limb to >10 rad/s — both kept resetting
    // the timer forever (the "settleT never rises" bug). None of that matters for
    // get-up, which teleports to the PELVIS and plays an animation that resets the
    // whole pose. So the core is the honest "the body has come to rest" signal.
    // (The old lin-ONLY test also missed the core's own angular writhe; we require
    // both.) Muscle mode never settles — it's meant to hold a pose.
    const still = !this.muscle && coreV < this.settleLinV && coreW < this.settleAngV;
    this._settleT = still ? (this._settleT ?? 0) + dt : 0;
  }

  _tendonDamp(L, dt) {
    const wp0 = L.p.body.angvel(), wc0 = L.c.body.angvel();
    const rx = wc0.x - wp0.x, ry = wc0.y - wp0.y, rz = wc0.z - wp0.z;
    const rl = Math.hypot(rx, ry, rz);
    if (rl > 0.5) {
      const dmag = Math.min(16 * rl, 520) * L.c.inertia * dt / rl;
      L.c.body.applyTorqueImpulse({ x: -rx * dmag, y: -ry * dmag, z: -rz * dmag }, true);
      L.p.body.applyTorqueImpulse({ x: rx * dmag, y: ry * dmag, z: rz * dmag }, true);
    }
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
      const pq = parent.getWorldQuaternion(T.q3);
      s.bone.quaternion.copy(pq.clone().invert().multiply(boneWorldQ));
      const lp = parent.worldToLocal(pivotWorld.clone());
      s.bone.position.copy(lp);
    }
  }

  settled(after = 1.2) { return this.active && (this._settleT ?? 0) > after; }

  groundOrientation() {
    const T = this._tmp;
    const get = (n) => this._byName[n]?.body.translation();
    const chest = get("chest"), pelvis = get("pelvis"), head = get("head");
    if (!chest || !pelvis) return { faceUp: true, yaw: 0 };
    const top = head || chest;
    const spine = T.v1.set(top.x - pelvis.x, top.y - pelvis.y, top.z - pelvis.z);
    const yaw = Math.atan2(spine.x, spine.z);
    let vote = 0, samples = 0;
    const cross = (rN, lN) => {
      const r = get(rN), l = get(lN); if (!r || !l) return;
      const side = T.v2.set(r.x - l.x, r.y - l.y, r.z - l.z);
      vote += Math.sign(T.v3.copy(side).cross(spine).y);
      samples++;
    };
    cross("upperArmR", "upperArmL");
    cross("thighR", "thighL");
    const faceUp = samples ? vote >= 0 : spine.y > -0.15;
    return { faceUp, yaw };
  }

  pelvisPos() {
    const t = this._byName.pelvis?.body.translation();
    return t ? new THREE.Vector3(t.x, t.y, t.z) : new THREE.Vector3();
  }

  /** world position of a named segment (for grab/aim helpers) */
  segPos(name) {
    const t = this._byName[name]?.body.translation();
    return t ? new THREE.Vector3(t.x, t.y, t.z) : null;
  }

  exit() {
    this.active = false;
    this.releaseAll();
    for (const s of this.segments) {
      s.body.setEnabled?.(false);
      s.bone.position.copy(s.restPos);
      s.stiffMul = 1;
    }
  }

  dispose() {
    this.releaseAll();
    for (const L of this._joints) {
      try {
        if (L.multibody) this.phys.world.removeMultibodyJoint(L.j, true);
        else this.phys.world.removeImpulseJoint(L.j ?? L, true);
      } catch (_) { /* */ }
    }
    for (const s of this.segments) this.phys.world.removeRigidBody(s.body);
    this.segments = []; this._joints = []; this._byName = {};
  }
}
