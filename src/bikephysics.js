import * as THREE from "three";

/**
 * Bike — motorcycle physics for the proving ground. Same philosophy as the Car:
 * a real Rapier dynamic body on raycast-suspension wheels, no scripted states.
 *
 * The two-wheel twist: a bike doesn't grip its way around a corner upright —
 * it LEANS, and the lean IS the turn. So the controller:
 *   • computes a target lean from steer input + speed (a = v²/R physics)
 *   • applies PD roll torque toward that lean (the rider's body + trail geometry)
 *   • derives the actual front-wheel steer angle from the lean (counter-steer
 *     falls out naturally: to lean right you momentarily steer left)
 *   • below walking pace the stabilizer fades — stop with no feet down = tip over
 *
 * Crash = the same dynamics as the car: big impact or laid flat → the rider
 * (sandbox spawns him) ragdolls off and the bike tumbles free.
 */
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _down = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wpos = new THREE.Vector3();
const _tpos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _com = new THREE.Vector3();

export class Bike {
  constructor(world, RAPIER, {
    pos = [0, 1.5, 0],
    mass = 220,               // bike + rider
    wheelbase = 1.45,
    wheelRadius = 0.33,
    suspRest = 0.32,
    suspStiff = 26000,
    suspDamp = 2400,
    engineForce = 3400,       // N at the rear contact — sportbike shove
    brakeForce = 4200,
    tireGrip = 1.35,          // µ — bikes run sticky rubber
    maxLean = 0.9,            // rad (~52°) — knee-down territory
    leanRate = 30,            // PD stiffness toward target lean (must out-muscle
                              // the inverted-pendulum gravity torque ~m·g·h·lean)
    leanDamp = 6.5,
    maxSteer = 0.55,          // rad, at walking pace (full-lock U-turn)
    topSpeed = 58,            // m/s (~130 mph)
  } = {}) {
    this.world = world; this.RAPIER = RAPIER;
    Object.assign(this, { mass, wheelbase, wheelRadius, suspRest, suspStiff, suspDamp,
      engineForce, brakeForce, tireGrip, maxLean, leanRate, leanDamp, maxSteer, topSpeed });
    this.spawn = pos.slice();

    // chassis: slim box, CoM low (engine) — explicit mass props like the car
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos[0], pos[1], pos[2])
      .setLinearDamping(0.05).setAngularDamping(0.6)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(bd);
    const hx = 0.22, hy = 0.5, hz = 0.95;
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setDensity(0).setFriction(0.6).setRestitution(0.15)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(140000)
        .setCollisionGroups((0x0004 << 16) | 0xffff),   // same chassis bit as the car
      this.body);
    this.body.setAdditionalMassProperties(mass, { x: 0, y: -0.25, z: 0 },
      { x: mass * 0.18, y: mass * 0.22, z: mass * 0.08 }, { x: 0, y: 0, z: 0, w: 1 }, true);
    this.colliderHandles = new Set([this.collider.handle]);

    this.wheels = [
      { name: "F", mount: new THREE.Vector3(0, -0.1, wheelbase / 2), front: true, driven: false, grounded: false, dist: suspRest, comp: 0, spin: 0 },
      { name: "R", mount: new THREE.Vector3(0, -0.1, -wheelbase / 2), front: false, driven: true, grounded: false, dist: suspRest, comp: 0, spin: 0 },
    ];

    // inputs + state
    this.throttle = 0; this.steerTarget = 0; this.brakeInput = 0; this.handbrake = false;
    this.steer = 0; this.lean = 0;            // current lean angle (rad, + = right)
    this.crashed = false;                      // laid down — stabilizer off until reset
    this.screech = 0; this.screechPitch = 0; this.bumpPulse = 0;
    this.burnout = false; this.driveSpin = 0;

    // ---- visual: placeholder sportbike (swap for a Synty model later) -------
    this.mesh = new THREE.Group(); this.mesh.name = "bike";
    this.leanGroup = new THREE.Group();        // everything leans inside this
    this.mesh.add(this.leanGroup);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xb3271e, roughness: 0.45, metalness: 0.3 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.8 });
    const tank = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.75), frameMat);
    tank.position.set(0, 0.28, 0.12);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.55), darkMat);
    seat.position.set(0, 0.32, -0.42);
    const engine = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.6), darkMat);
    engine.position.set(0, -0.02, 0.05);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 0.05), darkMat);
    bar.position.set(0, 0.52, 0.62);
    this.forkGroup = new THREE.Group(); this.forkGroup.position.set(0, 0.1, wheelbase / 2);
    const fork = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.72, 0.08), darkMat);
    fork.rotation.x = 0.42; fork.position.y = -0.1;
    this.forkGroup.add(fork, (() => { const b2 = bar.clone(); b2.position.set(0, 0.32, 0); return b2; })());
    const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.12, 20);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.9 });
    for (const w of this.wheels) {
      w.mesh = new THREE.Mesh(wheelGeo, wheelMat);
      w.mesh.castShadow = true;
      this.leanGroup.add(w.mesh);
    }
    this.leanGroup.add(tank, seat, engine, this.forkGroup);
    this.leanGroup.traverse((o) => { if (o.isMesh) o.castShadow = true; });

    // render interpolation state
    this.prevPos = new THREE.Vector3(); this.currPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion(); this.currQuat = new THREE.Quaternion();
    this._read(this.currPos, this.currQuat);
    this.prevPos.copy(this.currPos); this.prevQuat.copy(this.currQuat);
  }

  get speedKmh() {
    const v = this.body.linvel();
    _q.copy(this.currQuat);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    return (v.x * _fwd.x + v.y * _fwd.y + v.z * _fwd.z) * 3.6;
  }
  get height() { return this.body.translation().y; }

  setInput({ throttle = 0, steer = 0, brake = 0, handbrake = false }) {
    this.throttle = throttle; this.steerTarget = steer;
    this.brakeInput = brake; this.handbrake = handbrake;
  }

  fixedUpdate(dt) {
    const body = this.body;
    body.resetForces(false); body.resetTorques(false);

    const t = body.translation();
    const r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _down.copy(_up).negate();
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);

    const lv = body.linvel();
    const av = body.angvel();
    const wc = body.worldCom(); _com.set(wc.x, wc.y, wc.z);
    const fwdSpeed = lv.x * _fwd.x + lv.y * _fwd.y + lv.z * _fwd.z;
    const spd = Math.abs(fwdSpeed);

    // current roll (lean) from the chassis-right's vertical dip
    this.lean = Math.asin(THREE.MathUtils.clamp(-_right.y, -1, 1));
    // laid down? (roll past ~65° = crash — stabilizer lets go until reset)
    if (Math.abs(this.lean) > 1.15 && spd > 1) this.crashed = true;

    // aero + rolling drag (throttle% ≈ speed%, like the car)
    const spd3 = Math.hypot(lv.x, lv.y, lv.z);
    if (spd3 > 0.5) {
      const fd = 55 + 0.9 * spd3;
      body.addForce({ x: -lv.x * fd, y: -lv.y * fd * 0.4, z: -lv.z * fd }, true);
    }

    // ---- steering + lean targets --------------------------------------------
    // full lock at walking pace, tiny angles at speed (δ ∝ 1/v²-ish)
    const steerCap = Math.min(this.maxSteer, 0.55 * 30 / Math.max(9, spd * spd));
    const steerGoal = this.steerTarget * steerCap;
    this.steer += (steerGoal - this.steer) * Math.min(1, 8 * dt);
    // target lean: the physics of the corner — tan(lean) = v² / (R g), R from
    // the kinematic steer geometry. Capped at maxLean (peg-scraping).
    let leanTarget = 0;
    if (spd > 2 && Math.abs(this.steer) > 1e-3) {
      const Rturn = this.wheelbase / Math.tan(Math.abs(this.steer));
      leanTarget = Math.min(this.maxLean, Math.atan((fwdSpeed * fwdSpeed) / (Rturn * 9.81)))
        * Math.sign(this.steer) * Math.sign(fwdSpeed || 1);
    }

    // ---- rider stabilizer: PD roll torque toward the target lean ------------
    // fades below walking pace (a stopped bike falls over) and cuts entirely
    // once crashed — the tumble is free dynamics.
    if (!this.crashed) {
      const auth = THREE.MathUtils.smoothstep(spd, 0.8, 3.5);   // 0 stopped → 1 rolling
      const rollErr = leanTarget - this.lean;
      // roll rate about the forward axis
      const rollRate = av.x * _fwd.x + av.y * _fwd.y + av.z * _fwd.z;
      // SIGN: +torque about +forward ROTATES right-side-up (right-hand rule),
      // which DECREASES lean-as-measured — so the position term is negated.
      // The damping term keeps its sign (lean velocity = −rollRate).
      const torque = (-this.leanRate * rollErr - this.leanDamp * rollRate)
        * this.mass * 0.35 * Math.max(0.15, auth);
      body.addTorque({ x: _fwd.x * torque, y: _fwd.y * torque, z: _fwd.z * torque }, true);
      // yaw damping keeps the headshake out
      body.addTorque({ x: -_up.x * av.y * 90, y: -_up.y * av.y * 90, z: -_up.z * av.y * 90 }, true);
    }

    // ---- wheels: raycast spring + tyre forces -------------------------------
    // rays cast WORLD-down, not chassis-down: a leaned bike's chassis-down ray
    // lengthens past reach and the wheels "took off" mid-corner (probe 07-23).
    // A real bike rolls onto the tyre shoulder — world-down approximates that
    // contact staying planted while the PD owns the lean.
    const WDOWN = { x: 0, y: -1, z: 0 };
    let groundedCount = 0;
    this.screech = 0;
    for (const w of this.wheels) {
      const reach = this.suspRest + this.wheelRadius;
      _wpos.copy(w.mount).applyQuaternion(_q).add(_tpos.set(t.x, t.y, t.z));
      const ray = new this.RAPIER.Ray(_wpos, WDOWN);
      const hit = this.world.castRay(ray, reach, true, undefined, undefined, undefined, body);
      if (!hit) { w.grounded = false; w.dist = this.suspRest; continue; }
      const toi = hit.timeOfImpact ?? hit.toi;
      w.grounded = true; groundedCount++;
      w.dist = Math.max(0, toi - this.wheelRadius);
      w.comp = this.suspRest - w.dist;

      _rel.set(0, -toi, 0).add(_wpos).sub(_com);
      _cross.set(av.x, av.y, av.z).cross(_rel);
      _vel.set(lv.x + _cross.x, lv.y + _cross.y, lv.z + _cross.z);
      const springVel = _vel.y;
      let load = this.suspStiff * w.comp - this.suspDamp * springVel;
      if (load < 0) load = 0;
      w.force = load;

      // tyre frame FLATTENED onto the ground plane — a 40° leaned chassis-right
      // points half into the dirt; the contact patch pushes horizontally
      const wf = _fwd.clone(), wr = _right.clone();
      if (w.front) {
        const sq = new THREE.Quaternion().setFromAxisAngle(_up, this.steer);
        wf.applyQuaternion(sq); wr.applyQuaternion(sq);
      }
      wf.y = 0; wf.normalize();
      wr.y = 0; if (wr.lengthSq() < 1e-4) wr.set(1, 0, 0); wr.normalize();
      const vLong = _vel.dot(wf), vLat = _vel.dot(wr);

      let fLong = 0;
      if (w.driven) {
        const drive = this.throttle * this.engineForce
          * Math.max(0.15, 1 - Math.abs(fwdSpeed) / this.topSpeed);
        fLong += drive;
        this.driveSpin = this.throttle > 0.85 && spd < 6 ? 30 : 0;   // launch spin flag (audio)
      }
      const brake = this.brakeInput + (this.handbrake && !w.front ? 1 : 0);
      if (brake > 0) fLong -= Math.sign(vLong) * Math.min(brake, 1) * this.brakeForce * (w.front ? 0.65 : 0.35);
      fLong -= vLong * 8;                                    // rolling resistance

      // grip budget from load; friction circle
      const gripBudget = this.tireGrip * load;
      const slip = Math.atan2(vLat, Math.abs(vLong) + 0.6);
      let fLat = -gripBudget * Math.sin(1.35 * Math.atan(9 * slip));
      if (fLong > gripBudget) fLong = gripBudget;
      else if (fLong < -gripBudget) fLong = -gripBudget;
      const latRoom = Math.sqrt(Math.max(0, gripBudget * gripBudget - fLong * fLong));
      fLat = THREE.MathUtils.clamp(fLat, -latRoom, latRoom);
      if (Math.abs(slip) > 0.22 && spd > 4) this.screech = Math.min(1, Math.abs(slip) * 2);
      this.screechPitch = Math.min(1, spd / 30);

      // apply at the contact point (spring pushes world-up to match the ray)
      body.addForceAtPoint({
        x: wf.x * fLong + wr.x * fLat,
        y: load,
        z: wf.z * fLong + wr.z * fLat,
      }, { x: _wpos.x, y: _wpos.y - toi, z: _wpos.z }, true);

      w.spin += (vLong / this.wheelRadius + (w.driven ? this.driveSpin : 0)) * dt;
    }
    this.grounded = groundedCount > 0;
    this.wheelspin = this.driveSpin > 0;
    this.sliding = this.screech > 0.3;

    // ---- WHEELIE / STOPPIE (stage 3) ---------------------------------------
    // pitch about chassis-right: +right torque = nose UP (right-hand rule).
    // Wheelie: hard throttle at street speed piles weight-transfer torque on —
    // enough to beat the rear-contact gravity moment (~2.2 kN·m), so the front
    // lifts and BALANCES on throttle; let off (or tap brake) and it drops.
    // Loop-out: hold it past ~65° and you're off the back — crash, free tumble.
    const pitch = Math.asin(THREE.MathUtils.clamp(_fwd.y, -1, 1));   // + = nose up
    this.pitch = pitch;
    const pitchRate = av.x * _right.x + av.y * _right.y + av.z * _right.z;
    if (!this.crashed) {
      const rearGrounded = this.wheels[1].grounded;
      const frontGrounded = this.wheels[0].grounded;
      // NOTE probed sign: −right torque = nose UP on this frame (z-fwd, x-right)
      let tq = 0;
      if (this.throttle > 0.85 && rearGrounded && spd > 1.5 && spd < 24)
        tq -= 3400 * this.throttle * (1 - spd / 26) * Math.max(0, 1 - pitch / 1.1);
      // stoppie: hard FRONT brake at speed vaults the tail up (nose-down torque)
      if (this.brakeInput > 0.85 && frontGrounded && spd > 7)
        tq += 2800 * Math.min(1, spd / 14) * Math.max(0, 1 + pitch / 0.8);
      tq -= 520 * pitchRate;                       // rider modulation (keeps it rideable)
      if (tq !== 0)
        body.addTorque({ x: _right.x * tq, y: _right.y * tq, z: _right.z * tq }, true);
      // over the balance point → looped out; past a stoppie endo → highside
      if (pitch > 1.15 || pitch < -0.95) this.crashed = true;
    }
  }

  /** RENDER: interpolate + pose the visual (wheels along travel, fork steer) */
  interpolate(alpha) {
    this.mesh.position.lerpVectors(this.prevPos, this.currPos, alpha);
    this.mesh.quaternion.copy(this.prevQuat).slerp(this.currQuat, alpha);
    for (const w of this.wheels) {
      w.mesh.position.set(w.mount.x, w.mount.y - w.dist, w.mount.z);
      w.mesh.rotation.set(w.spin, w.front ? this.steer : 0, 0, "YXZ");
    }
    this.forkGroup.rotation.y = this.steer * 1.6;   // visible bar input
  }

  snapshotPrev() { this.prevPos.copy(this.currPos); this.prevQuat.copy(this.currQuat); }
  snapshotCurr() { this._read(this.currPos, this.currQuat); }
  _read(p, q) {
    const t = this.body.translation(), r = this.body.rotation();
    p.set(t.x, t.y, t.z); q.set(r.x, r.y, r.z, r.w);
  }

  reset(height = null) {
    const p = this.spawn;
    this.body.setTranslation({ x: p[0], y: height == null ? p[1] : height, z: p[2] }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.crashed = false; this.steer = 0;
    this._read(this.currPos, this.currQuat);
    this.prevPos.copy(this.currPos); this.prevQuat.copy(this.currQuat);
  }
}
