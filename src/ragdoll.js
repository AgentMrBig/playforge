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
  // tightened 2026-07-19: Erik read the wide ranges as "floppy" — these are
  // closer to true human ROM measured from a standing bind
  ["pelvis",    "chest",     "Spine1",        0.38],
  ["chest",     "head",      "Head",          0.6],
  ["chest",     "upperArmL", "LeftArm",       1.2],
  ["upperArmL", "forearmL",  "LeftForeArm",   1.3],
  ["chest",     "upperArmR", "RightArm",      1.2],
  ["upperArmR", "forearmR",  "RightForeArm",  1.3],
  ["pelvis",    "thighL",    "LeftUpLeg",     1.0],
  ["thighL",    "shinL",     "LeftLeg",       1.25],
  ["pelvis",    "thighR",    "RightUpLeg",    1.0],
  ["thighR",    "shinR",     "RightLeg",      1.25],
];
// ragdoll parts collide with everything INCLUDING each other — limbs must
// not pass through limbs (Erik). Adjacent jointed segments don't fight
// because each joint disables contacts between its own pair.
const RAGDOLL_GROUPS = (0x0002 << 16) | 0xffff;

export class Ragdoll {
  constructor(bones, phys, { totalMass = 75, tone = 1.9 } = {}) {   // 1.2 flailed (Erik: too floppy); 1.9 holds its pose more, still ragdolls. Live-dial __rag.tone
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
      qA: new THREE.Quaternion(), qB: new THREE.Quaternion(),
      m1: new THREE.Matrix4(),
    };
    this.totalMass = totalMass;

    // ═══ 3-TIER MUSCLE STACK (Erik's RDR2 §2A) ═══
    // Every PD joint target = TIER 1 base (the animation pose, what we track today)
    // ⊗ TIER 2 procedural (micro-adjust deltas: lean, look-at, hill-compensation)
    // ⊗ TIER 3 reflex (behavior-brain overrides: fall-brace, stumble-catch). Deltas are
    // world-space quaternions applied per-segment with a 0..1 weight. With NO layers set
    // this is byte-identical to the old single-tier PD — the death ragdoll + get-up are
    // untouched by default. `useLayers=false` is a hard A/B kill switch. Live at __rag.
    this.layers = { procedural: Object.create(null), reflex: Object.create(null) };
    this.useLayers = true;
    this._hasLayers = false;          // fast gate: skip composition entirely when empty

    // Tier-3 autonomous reflexes (fall-brace, §2B). ON by default now (Erik: "didn't
    // notice any behaviors") — verified it clears on landing so the resting pose is
    // unchanged. `__rag.reflexesEnabled=false` opts out; `__rag.braceParams` tunes feel.
    this.reflexesEnabled = true;
    this._bracing = false;
    this.braceParams = { fallVy: -3.5, reach: 1.1, armStiff: 1.8, softStiff: 0.55, axis: "z" };
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
          .setLinearDamping(0.4).setAngularDamping(1.9).setCcdEnabled(true));  // heavy damping kills the jello wobble — measured: settles ~3x faster (Erik)
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
        stiffMul: 1,                  // per-segment PD stiffness scale (reflexes dial this)
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

  /** ═══ MUSCLE MODE (our Euphoria, Layer 3) ═══
   * The same active-ragdoll physics + PD muscles, but a LIVE authoring layer instead of a
   * death state: the pelvis is anchored to the animated body (puppet-strings) so it stays
   * upright, while every other segment simulates and PD-tracks the animation. Shove it and
   * the limbs deflect then spring back — physically-reactive animation. tone = muscle tension
   * (high → tracks the clip and recovers; low → limp). Additive over enter/exit/fixedUpdate. */
  enterMuscle(tone = this.tone) {
    this.tone = tone;
    this.enter();                                   // build + activate at the current pose
    this.muscle = true;
    // Anchor the pelvis to the animated body (kinematic) so he's held upright while the
    // jitter-fixed muscles hold the limb poses (feet reach down, arms hold). NOTE: true
    // stand-on-your-feet balance (dynamic pelvis + foot support) is the next Euphoria
    // behavior — a real balance controller, tuned by eye. This pass = stable + smooth.
    const root = this._byName.pelvis || this._byName.chest;
    if (root) { root.body.setBodyType(R.RigidBodyType.KinematicPositionBased, true); this._anchorSeg = root; }
    return true;
  }
  exitMuscle() {
    if (this._anchorSeg) this._anchorSeg.body.setBodyType?.(R.RigidBodyType.Dynamic, true);
    this.muscle = false; this._anchorSeg = null;
    this.exit();
  }
  /** pin the anchored pelvis body to the animated bone each fixed step (kinematic follow) */
  _anchorStep() {
    const s = this._anchorSeg; if (!s) return;
    s.bone.updateWorldMatrix(true, false);
    const bodyQ = s.bone.getWorldQuaternion(this._tmp.q1).multiply(s.qOff.clone().invert());
    const mid = s.bone.getWorldPosition(this._tmp.v1).sub(s.pOff.clone().applyQuaternion(bodyQ));
    s.body.setNextKinematicTranslation({ x: mid.x, y: mid.y, z: mid.z });
    s.body.setNextKinematicRotation({ x: bodyQ.x, y: bodyQ.y, z: bodyQ.z, w: bodyQ.w });
  }
  /** BALANCE ASSIST via GRAVITY COMPENSATION: cancel (a tone-scaled fraction of) gravity
   * on every dynamic segment, so the muscle PD holds the standing pose without the body
   * sagging into a crouch — and with NO positional spring to oscillate. High tone → full
   * support (stands on its planted feet); low tone → gravity wins (sags, goes limp). The
   * spectrum (animated ↔ ragdoll) survives; a shove still perturbs and the muscles recover. */
  /** 👊 shove a segment (default chest) with an impulse in a world direction — the test poke */
  shove(dir, mag = 6, segName = "chest") {
    const s = this._byName[segName] || this._byName.chest; if (!s || !this.active) return;
    const n = new THREE.Vector3(dir.x || 0, dir.y || 0, dir.z || 0);
    if (n.lengthSq()) n.normalize(); else n.set(1, 0.15, 0);
    n.multiplyScalar(mag * s.body.mass());
    s.body.applyImpulse({ x: n.x, y: n.y, z: n.z }, true);
  }

  /** ═══ 3-TIER MUSCLE STACK API ═══
   * Set a per-segment target adjustment. `deltaQ` is a WORLD-space rotation applied on
   * top of the animation pose; `weight` 0..1 scales it (slerp from identity). Pass a
   * falsy deltaQ or weight<=0 to clear that segment's layer.
   *   TIER 2 — procedural: rag.setProcedural("chest", qLeanDelta, 0.6)
   *   TIER 3 — reflex:     rag.setReflex("upperArmL", qBraceDelta, 1.0)
   * Segment names: pelvis, chest, head, upperArm[L/R], forearm[L/R], thigh[L/R], shin[L/R]. */
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

  /** compose the 3 tiers into a world-space target for one segment (mutates + returns baseW).
   * reflex is applied outermost so it dominates the procedural nudge, which dominates base. */
  _composeTarget(segName, baseW) {
    const T = this._tmp;
    const p = this.layers.procedural[segName];
    if (p && p.weight > 0) baseW.premultiply(T.qA.identity().slerp(p.q, p.weight));   // ⊗ procedural
    const r = this.layers.reflex[segName];
    if (r && r.weight > 0) baseW.premultiply(T.qB.identity().slerp(r.q, r.weight));   // ⊗ reflex
    return baseW;
  }

  /** ═══ AUTONOMOUS REFLEXES (Tier 3, §2B) ═══
   * FALL-BRACE: when a segment is falling fast, throw the arms out (reflex target) and
   * stiffen them while softening the spine + legs, so the body physically braces for
   * impact instead of tracking the idle pose into the ground. Fully opt-in + self-clears
   * on landing, so the default death ragdoll is unchanged. Feel (axis/reach) = live params. */
  _updateReflexes() {
    if (!this.reflexesEnabled || !this.active) return;
    const chest = this._byName.chest || this._byName.pelvis;
    if (!chest) return;
    const lv = chest.body.linvel();
    // bracing while falling hard AND not yet settled (settle timer resets on impact)
    const brace = lv.y < this.braceParams.fallVy && (this._settleT ?? 0) < 0.06;
    if (brace && !this._bracing) this._enterBrace();
    else if (!brace && this._bracing) this._exitBrace();
  }
  _enterBrace() {
    this._bracing = true;
    const T = this._tmp, Q = T.q1.constructor, V = T.v1.constructor, P = this.braceParams;
    const ax = P.axis;
    const mk = (sign) => new Q().setFromAxisAngle(new V(ax === "x" ? sign : 0, ax === "y" ? sign : 0, ax === "z" ? sign : 0).normalize(), P.reach);
    this.setReflex("upperArmL", mk(1), 0.9);        // throw arms out to break the fall
    this.setReflex("upperArmR", mk(-1), 0.9);
    this._setStiff({ upperArmL: P.armStiff, upperArmR: P.armStiff, forearmL: P.armStiff * 0.9, forearmR: P.armStiff * 0.9,
      chest: P.softStiff, pelvis: P.softStiff, thighL: P.softStiff, thighR: P.softStiff, shinL: P.softStiff, shinR: P.softStiff });
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
    this._updateReflexes();
    if (this.muscle) this._anchorStep();
    const T = this._tmp;
    for (const s of this.segments) {
      // TIER 1 base: where the ANIMATION wants this bone (the Animator keeps
      // playing underneath; its pose is the muscle target). Then compose the
      // procedural + reflex tiers on top (skipped entirely when no layers set,
      // so the default death-ragdoll path is byte-identical).
      s.bone.updateWorldMatrix(true, false);
      let worldTarget = s.bone.getWorldQuaternion(T.q1);
      if (this.useLayers && this._hasLayers) worldTarget = this._composeTarget(s.name, worldTarget);
      s.targetQ.copy(worldTarget).multiply(s.qOff.clone().invert());
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
        const kp = 42 * this.tone * (s.stiffMul ?? 1), kd = 6 * Math.sqrt(Math.max(0.1, this.tone));
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
      // TENDON DAMPING — always on, not just past the limit. Real joints
      // resist rotation RATE everywhere (passive muscle, tendons, skin);
      // without it every joint is a free pendulum = "waaaay too floppy"
      // (Erik). Pure dissipation, capped per step, so it cannot blow up.
      {
        const wp0 = L.p.body.angvel(), wc0 = L.c.body.angvel();
        const rx = wc0.x - wp0.x, ry = wc0.y - wp0.y, rz = wc0.z - wp0.z;
        const rl = Math.hypot(rx, ry, rz);
        if (rl > 0.5) {
          const dmag = Math.min(14 * rl, 500) * L.c.inertia * dt / rl;
          L.c.body.applyTorqueImpulse({ x: -rx * dmag, y: -ry * dmag, z: -rz * dmag }, true);
          L.p.body.applyTorqueImpulse({ x: rx * dmag, y: ry * dmag, z: rz * dmag }, true);
        }
      }
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

  /** orientation of the settled body — pick the get-up clip + which way to stand.
   * faceUp = belly toward the sky (play the back get-up); yaw = the ground heading
   * (head direction) to orient the stand toward. Signs are best-guess (Erik confirms). */
  groundOrientation() {
    const T = this._tmp;
    const chest = this._byName.chest, pelvis = this._byName.pelvis;
    if (!chest || !pelvis) return { faceUp: true, yaw: 0 };
    const pc = chest.body.translation(), pp = pelvis.body.translation();
    const spine = T.v1.set(pc.x - pp.x, pc.y - pp.y, pc.z - pp.z);      // pelvis→chest
    const aR = this._byName.upperArmR, aL = this._byName.upperArmL;
    let faceUp = spine.y > -0.15;
    if (aR && aL) {
      const pr = aR.body.translation(), pl = aL.body.translation();
      const shoulder = T.v2.set(pr.x - pl.x, pr.y - pl.y, pr.z - pl.z);  // L→R
      faceUp = T.v3.copy(shoulder).cross(spine).y > 0;                   // ventral normal up?
    }
    return { faceUp, yaw: Math.atan2(spine.x, spine.z) };
  }

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
