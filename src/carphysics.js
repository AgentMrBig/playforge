import * as THREE from "three";

/**
 * carphysics.js — the ground-up vehicle module. Built in the Garage sandbox,
 * merged into the game once proven. See VEHICLE_REBUILD_PLAN.md.
 *
 * STAGE 1: the chassis — plain Rapier *dynamic* RigidBody + cuboid collider with
 *   REAL mass/inertia. NO Rapier built-in vehicle controller (that native
 *   suspension solver is the twitch source). Interpolation snapshots (prev/curr)
 *   so the harness renders SMOOTH between fixed steps. Fixed timestep + this =
 *   the anti-jerk foundation the old system never had.
 *
 * STAGE 2 (added): custom raycast suspension. Four corner rays cast straight down
 *   in chassis space; each is a Hooke's-law spring + damper whose force is pushed
 *   back into the body via applyImpulseAtPoint. The chassis floats on the rays —
 *   the box collider only touches ground in a crash. Anti-catapult clamp keeps a
 *   hard landing from launching. ALL per-frame vectors are hoisted (no GC).
 *
 * The visual is a placeholder box + cylinder wheels for now; the real Synty model
 * (already component-split) wires in at the deform stage.
 */

// ── hoisted scratch — reused every wheel every step, zero per-frame allocation ──
const _wpos = new THREE.Vector3();     // wheel mount, world space
const _down = new THREE.Vector3();     // chassis-down, world space
const _up = new THREE.Vector3();       // chassis-up, world space
const _com = new THREE.Vector3();      // world center of mass
const _rel = new THREE.Vector3();      // contact point - com
const _vel = new THREE.Vector3();      // velocity at contact point
const _cross = new THREE.Vector3();
const _imp = new THREE.Vector3();      // total force to apply at contact
const _tpos = new THREE.Vector3();     // chassis translation
const _fwd = new THREE.Vector3();      // wheel forward (world)
const _right = new THREE.Vector3();    // wheel right (world)
const _q = new THREE.Quaternion();
const _steerQ = new THREE.Quaternion();
const ANTIROLL_AXLES = [[0, 1], [2, 3]];   // [FL,FR], [RL,RR]
export class Car {
  constructor(world, RAPIER, {
    pos = [0, 3, 0],
    size = [1.9, 1.0, 4.4],   // full W,H,L in meters (sedan-ish)
    mass = 1200,              // kg
    linDamp = 0.05,
    angDamp = 0.4,
    restitution = 0.2,
    friction = 0.9,
    comY = null,           // CoG height offset from box center (null = auto low/sports-car)
    // suspension tuning (per wheel)
    wheelRadius = 0.35,
    suspRest = 0.5,        // rest length of the spring (m)
    suspStiff = 30000,     // N/m  — ~0.2m sag under 300kg/corner at g=20
    suspDamp = 4000,       // N per (m/s)
    suspTravel = 0.35,     // max compression past rest before bottoming
    // drivetrain / tires
    engineForce = 8000,    // N per driven wheel at full throttle
    brakeForce = 10000,    // N per wheel under full brake
    maxSteer = 0.55,       // rad (~31°) at the front wheels
    steerRate = 4.0,       // how fast steer angle chases input (per second)
    tireGrip = 2.2,        // peak lateral grip as a multiple of vertical load
    rearGripMul = 1.0,     // <1 loosens the rear → drift (the Stage-4 knob)
    rollResist = 0.015,    // rolling resistance fraction of load
    tireStiffB = 8.0,      // Pacejka B — slip stiffness (higher = sharper grip onset)
    tireShapeC = 1.15,     // Pacejka C — curve shape; ~1.1-1.2 = forgiving plateau (>1.4 spins out)
    antiRoll = 6000,       // sway-bar stiffness — resists body roll without stiffening bump
  } = {}) {
    this.world = world;
    this.RAPIER = RAPIER;
    this.size = size;
    this.spawn = pos.slice();
    this.wheelRadius = wheelRadius;
    this.suspRest = suspRest;
    this.suspStiff = suspStiff;
    this.suspDamp = suspDamp;
    this.suspTravel = suspTravel;
    this.engineForce = engineForce;
    this.brakeForce = brakeForce;
    this.maxSteer = maxSteer;
    this.steerRate = steerRate;
    this.tireGrip = tireGrip;
    this.rearGripMul = rearGripMul;
    this.rollResist = rollResist;
    this.tireStiffB = tireStiffB;
    this.tireShapeC = tireShapeC;
    this.antiRoll = antiRoll;
    this.mass = mass;
    // driver input (set each frame via setInput)
    this.throttle = 0;      // -1 (reverse) .. 1 (forward)
    this.brakeInput = 0;    // 0..1
    this.steerTarget = 0;   // -1..1
    this.steer = 0;         // current smoothed steer angle (rad)
    this.handbrake = false;

    // ---- chassis: plain dynamic rigid body ------------------------------
    const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];

    // Center of mass sits LOW (near axle height), like a real car — this is what
    // stops a hard corner from tipping the car onto its roof. We set explicit mass
    // properties instead of the uniform-density default (which puts CoM at box
    // center). Inertia = solid-box tensor about that CoM.
    const Ixx = (mass / 3) * (hy * hy + hz * hz);
    const Iyy = (mass / 3) * (hx * hx + hz * hz);
    const Izz = (mass / 3) * (hx * hx + hy * hy);
    this.inertia = { x: Ixx, y: Iyy, z: Izz };
    // CoG height (offset from box center): negative = LOW = stable sports car,
    // positive = HIGH = tippy bus/SUV. Live-adjustable via setCoM(). This is what
    // decides how easily a hard corner tips the car.
    this.comY = comY == null ? -Math.min(0.45, hy * 0.9) : comY;
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos[0], pos[1], pos[2])
      .setLinearDamping(linDamp)
      .setAngularDamping(angDamp)
      .setCanSleep(false)               // never sleep — we drive it every step
      .setAdditionalMassProperties(
        mass,
        { x: 0, y: this.comY, z: 0 },
        this.inertia,
        { x: 0, y: 0, z: 0, w: 1 }
      );
    this.body = world.createRigidBody(bodyDesc);

    // collider carries the shape only (density 0) — mass comes from the props above
    const colDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setDensity(0)
      .setRestitution(restitution)
      .setFriction(friction);
    this.collider = world.createCollider(colDesc, this.body);

    // ---- visual (placeholder box + nose marker for orientation) ---------
    this.mesh = new THREE.Group();
    this.mesh.name = "car";
    const bodyMesh = new THREE.Mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshStandardMaterial({ color: 0xcc3333, metalness: 0.2, roughness: 0.55 })
    );
    bodyMesh.castShadow = true;
    this.mesh.add(bodyMesh);
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(size[0] * 0.55, size[1] * 0.5, size[2] * 0.12),
      new THREE.MeshStandardMaterial({ color: 0xffdd33 })
    );
    nose.position.set(0, size[1] * 0.28, hz);   // +Z is forward
    nose.castShadow = true;
    this.mesh.add(nose);

    // visible CoG marker (bright sphere) so the CoG height is legible while tuning
    this.comMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0x33ff99, emissive: 0x0a3a22 })
    );
    this.comMarker.position.set(0, this.comY, 0);
    this.mesh.add(this.comMarker);

    // ---- wheels: 4 corner mounts (local space) + cylinder visuals -------
    // mount slightly inboard of the shell and near its floor; +Z forward.
    const mx = hx - 0.15, mz = hz - 0.55, my = -hy + 0.15;
    this.wheels = [
      { name: "FL", mount: new THREE.Vector3(-mx, my, mz), front: true, driven: false, grounded: false, dist: suspRest, comp: 0, spin: 0, slip: 0 },
      { name: "FR", mount: new THREE.Vector3(mx, my, mz), front: true, driven: false, grounded: false, dist: suspRest, comp: 0, spin: 0, slip: 0 },
      { name: "RL", mount: new THREE.Vector3(-mx, my, -mz), front: false, driven: true, grounded: false, dist: suspRest, comp: 0, spin: 0, slip: 0 },
      { name: "RR", mount: new THREE.Vector3(mx, my, -mz), front: false, driven: true, grounded: false, dist: suspRest, comp: 0, spin: 0, slip: 0 },
    ];
    const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.25, 16);
    wheelGeo.rotateZ(Math.PI / 2);   // roll about local X
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.8 });
    for (const w of this.wheels) {
      w.mesh = new THREE.Mesh(wheelGeo, wheelMat);
      w.mesh.castShadow = true;
      this.mesh.add(w.mesh);
    }

    // ---- interpolation snapshots ----------------------------------------
    this.prevPos = new THREE.Vector3();
    this.currPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();
    this.currQuat = new THREE.Quaternion();
    this._read(this.currPos, this.currQuat);
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }

  /** read the body's transform into the given scratch out-params */
  _read(pos, quat) {
    const t = this.body.translation();
    const r = this.body.rotation();
    pos.set(t.x, t.y, t.z);
    quat.set(r.x, r.y, r.z, r.w);
  }

  /**
   * SUSPENSION — run once per fixed step, BEFORE world.step().
   * Each wheel: cast a ray down (chassis space) from the mount, and if it hits
   * within reach, apply a Hooke's-law spring + damper impulse at the contact.
   */
  fixedUpdate(dt) {
    const body = this.body;
    body.resetForces(false);       // clear last step's suspension force + its torque
    body.resetTorques(false);

    // smooth the steer angle toward the input target (no snap)
    const steerGoal = this.steerTarget * this.maxSteer;
    this.steer += (steerGoal - this.steer) * Math.min(1, this.steerRate * dt);

    const t = body.translation();
    const r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _down.set(0, -1, 0).applyQuaternion(_q);
    _steerQ.setFromAxisAngle(_up, this.steer);   // rotate front wheels about chassis-up

    // world center of mass + angular velocity for velocity-at-point
    const wc = body.worldCom();  _com.set(wc.x, wc.y, wc.z);
    const lv = body.linvel();
    const av = body.angvel();

    const reach = this.suspRest + this.wheelRadius;   // ray length: rest + tyre
    for (const w of this.wheels) {
      // mount in world space = chassis pos + rotated local mount
      _wpos.copy(w.mount).applyQuaternion(_q).add(_tpos.set(t.x, t.y, t.z));
      w.mwx = _wpos.x; w.mwy = _wpos.y; w.mwz = _wpos.z;   // mount world pos (anti-roll point)
      const ray = new this.RAPIER.Ray(_wpos, _down);
      const hit = this.world.castRay(ray, reach, true, undefined, undefined, undefined, body);

      if (hit) {
        const toi = hit.timeOfImpact ?? hit.toi;
        w.grounded = true;
        w.dist = Math.max(0, toi - this.wheelRadius);           // spring length now
        w.comp = this.suspRest - w.dist;                        // compression (+ = compressed)

        // contact point = mount + down * toi  → velocity there (v = linvel + ω × r)
        _rel.copy(_down).multiplyScalar(toi).add(_wpos).sub(_com);
        _cross.set(av.x, av.y, av.z).cross(_rel);
        _vel.set(lv.x + _cross.x, lv.y + _cross.y, lv.z + _cross.z);
        const springVel = _vel.dot(_up);                        // + = extending

        // spring - damper, along chassis up; clamp >= 0 (no catapult/suction)
        let load = this.suspStiff * w.comp - this.suspDamp * springVel;
        if (load < 0) load = 0;
        w.force = load;

        // ---- tire directions: chassis fwd/right, front wheels steered ----
        _fwd.set(0, 0, 1).applyQuaternion(_q);
        _right.set(1, 0, 0).applyQuaternion(_q);
        if (w.front) { _fwd.applyQuaternion(_steerQ); _right.applyQuaternion(_steerQ); }
        const vLong = _vel.dot(_fwd);
        const vLat = _vel.dot(_right);
        w.spin += (vLong / this.wheelRadius) * dt;    // roll for the visual

        // ---- grip budget (friction circle), load-based → weight transfer feeds it ----
        const gripMul = (w.front ? 1 : this.rearGripMul) * (this.handbrake && !w.front ? 0.5 : 1);
        const gripBudget = this.tireGrip * load * gripMul;

        // ---- longitudinal: engine + brake + rolling resistance ----
        let fLong = 0;
        if (w.driven) fLong += this.throttle * this.engineForce;
        const brake = this.brakeInput + (this.handbrake && !w.front ? 1 : 0);
        if (brake > 0) fLong -= Math.sign(vLong) * Math.min(brake, 1) * this.brakeForce;
        fLong -= vLong * this.rollResist * load * 0.02;   // gentle coast-down

        // ---- lateral: Pacejka-ish slip curve — grips, peaks, then breaks away ----
        // slip angle between where the tyre points and where it's actually going.
        // +0.6 in the denominator softens the singularity at crawl speed.
        const slip = Math.atan2(vLat, Math.abs(vLong) + 0.6);
        w.slip += (slip - w.slip) * Math.min(1, 12 * dt);   // smooth a few frames (anti-chatter)
        let fLat = -gripBudget * Math.sin(this.tireShapeC * Math.atan(this.tireStiffB * w.slip));

        // ---- friction circle: drive/brake force eats lateral grip → power oversteer ----
        if (fLong > gripBudget) fLong = gripBudget;
        else if (fLong < -gripBudget) fLong = -gripBudget;
        const latRoom = Math.sqrt(Math.max(0, gripBudget * gripBudget - fLong * fLong));
        if (fLat > latRoom) fLat = latRoom;
        else if (fLat < -latRoom) fLat = -latRoom;

        // ---- combine: suspension (up) + tire (fwd + right), one force ----
        _imp.set(
          _up.x * load + _fwd.x * fLong + _right.x * fLat,
          _up.y * load + _fwd.y * fLong + _right.y * fLat,
          _up.z * load + _fwd.z * fLong + _right.z * fLat
        );
        body.addForceAtPoint(_imp, { x: _wpos.x + _down.x * toi, y: _wpos.y + _down.y * toi, z: _wpos.z + _down.z * toi }, true);
      } else {
        w.grounded = false;
        w.dist = this.suspRest;                                 // droop to full extension
        w.comp = 0;
      }
    }
    this._applyAntiRoll(this.antiRoll);
    this._placeWheels();
  }

  /**
   * Anti-roll (sway) bar: per axle, resist the DIFFERENCE in left/right suspension
   * compression with an opposing roll moment. Only differential compression (body
   * roll) is resisted — when both wheels compress together (a bump) the delta is 0,
   * so ride comfort is untouched. Net force ~0 (up one side, down the other) → pure
   * roll moment, ride height preserved.
   */
  _applyAntiRoll(k) {
    if (k <= 0) return;
    for (const [li, ri] of ANTIROLL_AXLES) {
      const L = this.wheels[li], R = this.wheels[ri];
      if (!L.grounded && !R.grounded) continue;
      const roll = (R.comp - L.comp) * k;    // >0 → right compressed more (rolling right)
      // push the more-compressed side UP, the other DOWN → levels the chassis
      this.body.addForceAtPoint({ x: _up.x * roll, y: _up.y * roll, z: _up.z * roll }, { x: R.mwx, y: R.mwy, z: R.mwz }, true);
      this.body.addForceAtPoint({ x: -_up.x * roll, y: -_up.y * roll, z: -_up.z * roll }, { x: L.mwx, y: L.mwy, z: L.mwz }, true);
    }
  }

  /** position wheel visuals along their travel + steer + roll (local space) */
  _placeWheels() {
    for (const w of this.wheels) {
      w.mesh.position.set(w.mount.x, w.mount.y - w.dist, w.mount.z);
      w.mesh.rotation.set(w.spin, w.front ? this.steer : 0, 0, "YXZ");
    }
  }

  /** live CoG height (offset from chassis center: − = low/stable, + = high/tippy) */
  setCoM(comY) {
    this.comY = comY;
    this.body.setAdditionalMassProperties(this.mass, { x: 0, y: comY, z: 0 }, this.inertia, { x: 0, y: 0, z: 0, w: 1 }, true);
    if (this.comMarker) this.comMarker.position.set(0, comY, 0);
  }

  /** driver input for this frame */
  setInput({ throttle = 0, steer = 0, brake = 0, handbrake = false }) {
    this.throttle = throttle;
    this.steerTarget = steer;
    this.brakeInput = brake;
    this.handbrake = handbrake;
  }

  /** call at the START of each fixed step: last curr becomes prev */
  snapshotPrev() {
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }

  /** call at the END of each fixed step: capture the new transform */
  snapshotCurr() {
    this._read(this.currPos, this.currQuat);
  }

  /** RENDER: interpolate the visual between the last two physics states */
  interpolate(alpha) {
    this.mesh.position.lerpVectors(this.prevPos, this.currPos, alpha);
    this.mesh.quaternion.copy(this.prevQuat).slerp(this.currQuat, alpha);
  }

  get speedKmh() {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z) * 3.6;
  }
  get height() { return this.body.translation().y; }

  /** drop the car back to the spawn point (or a given height) — settle test */
  reset(height = null) {
    const p = this.spawn;
    const y = height == null ? p[1] : height;
    this.body.setTranslation({ x: p[0], y, z: p[2] }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this._read(this.currPos, this.currQuat);
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }

  // live-tunable setters (wired to the Garage HUD sliders)
  setLinearDamping(v) { this.body.setLinearDamping(v); }
  setAngularDamping(v) { this.body.setAngularDamping(v); }
  setRestitution(v) { this.collider.setRestitution(v); }
}
