import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

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
const _iq = new THREE.Quaternion();    // inverse chassis rotation (world→local)
const _lp = new THREE.Vector3();       // local impact epicenter
const _ld = new THREE.Vector3();       // local impact direction
const _vp = new THREE.Vector3();       // vertex scratch
const _off = new THREE.Vector3();      // vertex offset-from-original
const _m1 = new THREE.Matrix4();       // body-mesh world→local
const _sc = new THREE.Vector3();       // scale extraction
const _dp = new THREE.Vector3();       // debris: impact point
const _dc = new THREE.Vector3();       // debris: car world center
const _dw = new THREE.Vector3();       // debris: wheel world pos
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
    suspDamp = 1500,       // N per (m/s)  — Erik's feel default
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
    antiRoll = 29000,      // sway-bar stiffness (Erik default) — resists body roll, not bump
    // impact deform (Stage 5). Rapier contact forces run huge (~22k N per km/h of
    // closing speed), so these are in the 100k-millions range: dent from ~15 km/h,
    // full crumple by ~100 km/h.
    dentThreshold = 250000,  // min contact force (N) to leave a dent (~16 km/h)
    dentFullForce = 2000000, // force span above threshold for full severity (~100 km/h)
    dentRadius = 0.9,        // base dent spread (m)
    dentDepth = 0.28,        // base dent depth at full severity (m)
    dentMax = 0.5,           // max total displacement any vertex can accumulate (m)
    // mechanical damage (Stage 6)
    wheelDetachForce = 1100000, // contact force to tear a wheel off (~50 km/h corner hit)
    chunkForce = 1600000,       // force to break off a body chunk (~72 km/h)
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
    this.dentThreshold = dentThreshold;
    this.dentFullForce = dentFullForce;
    this.dentRadius = dentRadius;
    this.dentDepth = dentDepth;
    this.dentMax = dentMax;
    this.half = { x: size[0] / 2, y: size[1] / 2, z: size[2] / 2 };
    this.dents = 0;
    this.wheelDetachForce = wheelDetachForce;
    this.chunkForce = chunkForce;
    this.debris = [];          // loose pieces (knocked-off wheels + body chunks)
    this.screech = 0;          // tyre-squeal volume (0..1) — slide × force
    this.screechPitch = 0;     // tyre-squeal pitch (0..1) — slide speed / force
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
      .setCcdEnabled(true)              // fast car must not tunnel through thin walls
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
      .setFriction(friction)
      // the chassis floats on the suspension, so ANY chassis contact is a real
      // impact — fire force events above the dent threshold to drive deformation
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(dentThreshold);
    this.collider = world.createCollider(colDesc, this.body);

    // ---- visual (placeholder box + nose marker for orientation) ---------
    this.mesh = new THREE.Group();
    this.mesh.name = "car";
    // subdivided + welded so it crumples as a continuous skin (placeholder for the
    // real Synty body mesh at merge — deform is mesh-agnostic, runs on any geometry)
    let bodyGeo = new THREE.BoxGeometry(size[0], size[1], size[2], 12, 8, 18);
    bodyGeo = mergeVertices(bodyGeo);
    const bodyMesh = new THREE.Mesh(
      bodyGeo,
      new THREE.MeshStandardMaterial({ color: 0xcc3333, metalness: 0.2, roughness: 0.55, flatShading: false })
    );
    bodyMesh.castShadow = true;
    this.mesh.add(bodyMesh);
    this.bodyMesh = bodyMesh;
    this.origPos = Float32Array.from(bodyGeo.attributes.position.array);   // pristine, for repair
    this.bodyCenter = new THREE.Vector3(0, 0, 0);   // deform pushes verts toward here (local)
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(size[0] * 0.55, size[1] * 0.5, size[2] * 0.12),
      new THREE.MeshStandardMaterial({ color: 0xffdd33 })
    );
    nose.position.set(0, size[1] * 0.28, hz);   // +Z is forward
    nose.castShadow = true;
    this.mesh.add(nose);
    this.nose = nose;                            // placeholder marker (hidden when a model attaches)

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

    for (const w of this.wheels) {
      // a torn-off corner rides the bare hub: shorter rest (sits lower), heavier
      // damping (no pogo), and no tyre grip below — so it DRAGS, not springs/flips.
      const restLen = w.detached ? 0.22 : this.suspRest;
      const reach = restLen + this.wheelRadius;         // ray length: rest + tyre
      // mount in world space = chassis pos + rotated local mount
      _wpos.copy(w.mount).applyQuaternion(_q).add(_tpos.set(t.x, t.y, t.z));
      w.mwx = _wpos.x; w.mwy = _wpos.y; w.mwz = _wpos.z;   // mount world pos (anti-roll point)
      const ray = new this.RAPIER.Ray(_wpos, _down);
      const hit = this.world.castRay(ray, reach, true, undefined, undefined, undefined, body);

      if (hit) {
        const toi = hit.timeOfImpact ?? hit.toi;
        w.grounded = true;
        w.dist = Math.max(0, toi - this.wheelRadius);           // spring length now
        w.comp = restLen - w.dist;                              // compression (+ = compressed)

        // contact point = mount + down * toi  → velocity there (v = linvel + ω × r)
        _rel.copy(_down).multiplyScalar(toi).add(_wpos).sub(_com);
        _cross.set(av.x, av.y, av.z).cross(_rel);
        _vel.set(lv.x + _cross.x, lv.y + _cross.y, lv.z + _cross.z);
        const springVel = _vel.dot(_up);                        // + = extending

        // spring - damper, along chassis up; clamp >= 0 (no catapult/suction). A
        // torn-off corner gets heavy damping so it settles + drags without pogo.
        const damp = w.detached ? this.suspDamp * 2.5 : this.suspDamp;
        let load = this.suspStiff * w.comp - damp * springVel;
        if (load < 0) load = 0;
        w.force = load;

        // ---- tyre forces (a torn-off corner has none — the bare hub just drags) ----
        let fLong = 0, fLat = 0;
        if (!w.detached) {
          _fwd.set(0, 0, 1).applyQuaternion(_q);
          _right.set(1, 0, 0).applyQuaternion(_q);
          if (w.front) { _fwd.applyQuaternion(_steerQ); _right.applyQuaternion(_steerQ); }
          const vLong = _vel.dot(_fwd);
          const vLat = _vel.dot(_right);
          w.vLat = vLat;                                // lateral slide speed (for squeal pitch)
          w.spin += (vLong / this.wheelRadius) * dt;    // roll for the visual

          // grip budget (friction circle), load-based → weight transfer feeds it
          const gripMul = (w.front ? 1 : this.rearGripMul) * (this.handbrake && !w.front ? 0.5 : 1);
          const gripBudget = this.tireGrip * load * gripMul;

          // longitudinal: engine + brake + rolling resistance
          if (w.driven) fLong += this.throttle * this.engineForce;
          const brake = this.brakeInput + (this.handbrake && !w.front ? 1 : 0);
          if (brake > 0) fLong -= Math.sign(vLong) * Math.min(brake, 1) * this.brakeForce;
          fLong -= vLong * this.rollResist * load * 0.02;   // gentle coast-down

          // lateral: Pacejka-ish slip curve — grips, peaks, then breaks away
          const slip = Math.atan2(vLat, Math.abs(vLong) + 0.6);
          w.slip += (slip - w.slip) * Math.min(1, 12 * dt);   // anti-chatter
          fLat = -gripBudget * Math.sin(this.tireShapeC * Math.atan(this.tireStiffB * w.slip));

          // friction circle: drive/brake force eats lateral grip → power oversteer
          if (fLong > gripBudget) fLong = gripBudget;
          else if (fLong < -gripBudget) fLong = -gripBudget;
          const latRoom = Math.sqrt(Math.max(0, gripBudget * gripBudget - fLong * fLong));
          if (fLat > latRoom) fLat = latRoom;
          else if (fLat < -latRoom) fLat = -latRoom;
        }

        // ---- combine: suspension (up) + tyre (fwd + right), one force ----
        _imp.set(
          _up.x * load + _fwd.x * fLong + _right.x * fLat,
          _up.y * load + _fwd.y * fLong + _right.y * fLat,
          _up.z * load + _fwd.z * fLong + _right.z * fLat
        );
        if (w.detached) {
          // bare hub scrapes the ground: horizontal friction opposing motion at this
          // one corner → the car limps AND pulls toward the dead corner
          const vh = Math.hypot(_vel.x, _vel.z);
          if (vh > 0.05) {
            const scrape = Math.min(load * 1.1, this.mass * vh * 0.6);
            _imp.x -= (_vel.x / vh) * scrape;
            _imp.z -= (_vel.z / vh) * scrape;
          }
        }
        body.addForceAtPoint(_imp, { x: _wpos.x + _down.x * toi, y: _wpos.y + _down.y * toi, z: _wpos.z + _down.z * toi }, true);
      } else {
        w.grounded = false;
        w.dist = this.suspRest;                                 // droop to full extension
        w.comp = 0;
      }
    }
    this._applyAntiRoll(this.antiRoll);

    // tyre-squeal: volume from slide × tyre load (force), pitch from slide speed —
    // a lightly-loaded gentle slide is quiet + low; a hard, fast, heavy slide is
    // loud + high (Erik: squeal relational to the forces on the wheels)
    const nomLoad = this.mass * 5;              // ~vertical load per tyre at rest (g=20)
    let amt = 0, slideSpeed = 0;
    for (const w of this.wheels) {
      if (!w.grounded || w.detached) continue;
      const sliding = Math.min(1, Math.max(0, (Math.abs(w.slip) - 0.13) / 0.4));
      if (sliding <= 0) continue;
      const loadN = Math.min(1.4, (w.force || 0) / nomLoad);     // vertical force on this tyre
      amt = Math.max(amt, sliding * Math.min(1, 0.3 + loadN));
      slideSpeed = Math.max(slideSpeed, Math.abs(w.vLat || 0) * sliding);
    }
    const spdK = this.speedKmh;
    const burn = (this.throttle > 0.55 && spdK < 28) ? (1 - spdK / 28) * this.throttle : 0;
    if (burn > amt) { amt = burn; slideSpeed = Math.max(slideSpeed, burn * 11); }
    if (this.handbrake && spdK > 6) amt = Math.max(amt, 0.8);
    const volT = Math.max(0, Math.min(1, amt));
    const pitchT = Math.min(1, slideSpeed / 12);               // ~0 slow, ~1 at 12 m/s slide
    this.screech += (volT - this.screech) * Math.min(1, 9 * dt);
    this.screechPitch += (pitchT - this.screechPitch) * Math.min(1, 9 * dt);

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
      if (w.detached) continue;                 // it's loose debris now — don't move it
      w.mesh.position.set(w.mount.x, w.mount.y - w.dist, w.mount.z);
      w.mesh.rotation.set(w.spin, w.front ? this.steer : 0, 0, "YXZ");
      // model wheels: same suspension-driven placement as the cylinders so they
      // stay planted while the body heaves/rolls; steer about Y, roll about X
      if (w.modelWheel) {
        w.modelWheel.position.set(w.mount.x, w.mount.y - w.dist, w.mount.z);
        w.modelWheel.rotation.x = w.spin;
        if (w.front) w.modelWheel.rotation.y = this.steer;
      }
    }
  }

  /**
   * IMPACT DEFORM — dent the body mesh where a hard hit landed.
   * @param worldPoint {x,y,z}|null  contact point (world); null → infer from dir
   * @param mag        contact force magnitude (N)
   * @param worldDir   {x,y,z}       force direction on the car (world)
   */
  deform(worldPoint, mag, worldDir) {
    if (mag < this.dentThreshold) return;

    // sync the visual group to the body's CURRENT pose so matrixWorld is right even
    // headless (where render/interpolate hasn't run), then work in body-MESH local
    // space — this handles a nested/scaled model exactly like the flat box.
    const t = this.body.translation(), r = this.body.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    this.bodyMesh.updateWorldMatrix(true, false);
    _m1.copy(this.bodyMesh.matrixWorld).invert();          // world → body-mesh-local
    const s = _sc.setFromMatrixScale(this.bodyMesh.matrixWorld).x || 1;   // uniform scale

    // epicenter in body-mesh-local space
    if (worldPoint) {
      _lp.set(worldPoint.x, worldPoint.y, worldPoint.z).applyMatrix4(_m1);
    } else {
      _ld.set(worldDir.x, worldDir.y, worldDir.z).transformDirection(_m1).normalize();
      _lp.copy(this.bodyCenter).addScaledVector(_ld, -this.dentRadius / s);
    }

    // push toward the body's center → the panel caves as a unit (no per-vertex pinch)
    _ld.copy(this.bodyCenter).sub(_lp);
    if (_ld.lengthSq() < 1e-9) _ld.set(worldDir.x, worldDir.y, worldDir.z).transformDirection(_m1);
    _ld.normalize();

    const sev = Math.min(1, (mag - this.dentThreshold) / this.dentFullForce);
    const radius = (this.dentRadius / s) * (0.5 + sev);    // radius/depth in local units
    const depth = (this.dentDepth / s) * sev;
    const maxD = this.dentMax / s;

    const pos = this.bodyMesh.geometry.attributes.position;
    const op = this.origPos;
    let touched = false;
    for (let i = 0; i < pos.count; i++) {
      _vp.fromBufferAttribute(pos, i);
      const d = _vp.distanceTo(_lp);
      if (d >= radius) continue;
      const fall = 1 - d / radius;                          // deepest at the epicenter
      _vp.addScaledVector(_ld, depth * fall * fall);        // push metal inward
      // clamp accumulated displacement so repeated hits can't collapse the shell
      _off.set(_vp.x - op[i * 3], _vp.y - op[i * 3 + 1], _vp.z - op[i * 3 + 2]);
      if (_off.length() > maxD) _off.setLength(maxD);
      pos.setXYZ(i, op[i * 3] + _off.x, op[i * 3 + 1] + _off.y, op[i * 3 + 2] + _off.z);
      touched = true;
    }
    if (touched) {
      pos.needsUpdate = true;
      this.bodyMesh.geometry.computeVertexNormals();        // dents catch light correctly
      this.dents++;
    }
  }

  /**
   * Swap the placeholder box for a real loaded car model (from loadVehicle).
   * The largest non-wheel mesh becomes the deformable body; wheels are mapped to
   * the suspension for later articulation. Physics is untouched.
   */
  attachModel(rig) {
    // hide the placeholders (keep the CoG marker)
    this.bodyMesh.visible = false;
    if (this.nose) this.nose.visible = false;
    for (const w of this.wheels) w.mesh.visible = false;

    const v = rig.visual;
    // Measure the tyre-contact line in the MODEL'S OWN space — BEFORE parenting it
    // to the chassis. If we measured after add(), the world bbox would include
    // wherever the car happens to be when the async model finishes loading (ride
    // height, or mid-air), and the body would get seated relative to that.
    v.updateWorldMatrix(true, true);
    const modelMinY = new THREE.Box3().setFromObject(v).min.y;
    this.mesh.add(v);
    this.mesh.updateWorldMatrix(true, true);   // so wheel worldToLocal/attach are valid

    // adopt the model's tyre radius so suspension reach + contact height match
    if (rig.wheelRadius) this.wheelRadius = rig.wheelRadius;

    // Pull each model wheel OUT of the body and into chassis space, and move my
    // suspension mounts to the model's actual wheel positions. Now the body can
    // heave/pitch/roll on the springs while the wheels are re-planted every frame
    // (in _placeWheels) at their own ray-computed ground height — no ground clip.
    if (rig.wheels) {
      const map = { FL: "fl", FR: "fr", RL: "rl", RR: "rr" };
      const wp = new THREE.Vector3();
      for (const w of this.wheels) {
        const pivot = rig.wheels[map[w.name]];
        if (!pivot) { w.modelWheel = null; continue; }
        pivot.getWorldPosition(wp);
        this.mesh.worldToLocal(wp);
        w.mount.x = wp.x; w.mount.z = wp.z;       // ray + wheel X/Z = the real wheel well
        this.mesh.attach(pivot);                  // chassis space, keep scale/orientation
        pivot.rotation.set(0, 0, 0);              // wheel has no rotation rel. to the body
        w.modelWheel = pivot;
        w._wheelScale = pivot.scale.clone();      // remembered so reset can restore it exactly
      }
    }

    // drop the body so the TYRE-CONTACT line (measured with wheels, above) sits on
    // the ground — not the wheels-removed body underside (that sinks the body)
    const groundY = this.wheels[0].mount.y - this.suspRest * 0.6 - this.wheelRadius;
    v.position.y += groundY - modelMinY;
    this.modelVisual = v;

    // body = the largest remaining mesh (wheels are already reparented out of v)
    let best = null, bestCount = -1;
    v.traverse((o) => {
      if (!o.isMesh) return;
      const n = o.geometry.attributes.position.count;
      if (n > bestCount) { bestCount = n; best = o; }
    });
    if (best) {
      best.geometry = mergeVertices(best.geometry);       // weld → crumples as a skin
      best.geometry.computeBoundingBox();
      this.bodyMesh = best;
      this.origPos = Float32Array.from(best.geometry.attributes.position.array);
      this.bodyCenter = best.geometry.boundingBox.getCenter(new THREE.Vector3());
      this.dents = 0;
    }
    this.modelName = rig.name || "car";
  }

  /**
   * A hard hit landed: crumple the body, and above bigger thresholds tear off the
   * nearest wheel (with a real handling consequence) or break off a body chunk.
   */
  impact(worldPoint, mag, worldDir) {
    this.deform(worldPoint, mag, worldDir);     // crumple (also syncs mesh pose)
    if (!worldPoint) return;
    this.mesh.updateWorldMatrix(true, true);     // refresh WHEEL matrices for the distance test
    _dp.set(worldPoint.x, worldPoint.y, worldPoint.z);

    // wheel tear-off: nearest still-attached wheel within reach of the contact
    if (mag >= this.wheelDetachForce) {
      let near = null, nd = 1.6;
      for (const w of this.wheels) {
        if (w.detached || !w.modelWheel) continue;
        const d = w.modelWheel.getWorldPosition(_dw).distanceTo(_dp);
        if (d < nd) { nd = d; near = w; }
      }
      if (near) this._detachWheel(near);
    }
    // body chunk break-off on a really big hit
    if (mag >= this.chunkForce && this.debris.length < 20) this._spawnChunk(worldPoint, worldDir, mag);
  }

  /** tear a wheel off → loose debris; that corner loses spring + grip (it drags) */
  _detachWheel(w) {
    const scene = this.mesh.parent;
    const wheel = w.modelWheel;
    if (!scene || !wheel) return;
    w.detached = true;
    wheel.getWorldPosition(_dw);
    scene.attach(wheel);                         // keep world pose + scale
    wheel.userData.wheelRef = w;                 // so reset() can re-fit it
    const lv = this.body.linvel();
    this.mesh.getWorldPosition(_dc);
    _dp.copy(_dw).sub(_dc).setY(0).normalize();  // outward from car
    this._registerDebris(wheel,
      lv.x + _dp.x * 3, lv.y + 4, lv.z + _dp.z * 3, 9);
  }

  /** break a body-colored chunk off at the impact + gouge a deep dent there */
  _spawnChunk(worldPoint, worldDir, mag) {
    const scene = this.mesh.parent;
    if (!scene) return;
    const s = 0.35 + Math.random() * 0.3;
    const chunk = new THREE.Mesh(
      new THREE.BoxGeometry(s, 0.12, s * 0.8),
      new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.4, roughness: 0.6 })
    );
    chunk.castShadow = true;
    chunk.position.set(worldPoint.x, worldPoint.y, worldPoint.z);
    chunk.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    scene.add(chunk);
    const lv = this.body.linvel();
    this.mesh.getWorldPosition(_dc);
    _dp.set(worldPoint.x, worldPoint.y, worldPoint.z).sub(_dc).setY(0).normalize();
    this._registerDebris(chunk, lv.x + _dp.x * 4, lv.y + 4.5, lv.z + _dp.z * 4, 12);
    this.deform(worldPoint, mag * 1.6, worldDir);   // deeper gouge where it tore away
  }

  _registerDebris(mesh, vx, vy, vz, spin) {
    mesh.userData.vel = new THREE.Vector3(vx, vy, vz);
    mesh.userData.spin = new THREE.Vector3((Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin);
    mesh.userData.life = 6.0;
    this.debris.push(mesh);
  }

  /** integrate loose debris in plain JS (no extra physics bodies) — call each frame */
  updateDebris(dt) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const m = this.debris[i], ud = m.userData;
      ud.vel.y += -20 * dt;
      m.position.addScaledVector(ud.vel, dt);
      m.rotation.x += ud.spin.x * dt; m.rotation.y += ud.spin.y * dt; m.rotation.z += ud.spin.z * dt;
      if (m.position.y < 0.16) {                 // ground bounce + settle
        m.position.y = 0.16; ud.vel.y *= -0.35;
        ud.vel.x *= 0.7; ud.vel.z *= 0.7; ud.spin.multiplyScalar(0.6);
      }
      ud.life -= dt;
      if (ud.life < 1) m.traverse((o) => { if (o.material) { o.material.transparent = true; o.material.opacity = Math.max(0, ud.life); } });
      if (ud.life <= 0) { m.parent && m.parent.remove(m); this.debris.splice(i, 1); }
    }
  }

  get wheelsOff() { return this.wheels.filter((w) => w.detached).length; }

  /** restore the pristine body shape (repair) */
  repair() {
    const pos = this.bodyMesh.geometry.attributes.position;
    pos.array.set(this.origPos);
    pos.needsUpdate = true;
    this.bodyMesh.geometry.computeVertexNormals();
    this.dents = 0;
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
    this.repair();          // fresh body on reset
    // drop chunk debris
    for (const m of this.debris) if (!m.userData.wheelRef) m.parent && m.parent.remove(m);
    this.debris.length = 0;
    // re-fit knocked-off wheels — robust even if their debris already expired
    for (const w of this.wheels) {
      if (w.detached && w.modelWheel) {
        w.modelWheel.traverse((o) => { if (o.material) { o.material.opacity = 1; o.material.transparent = false; } });
        this.mesh.add(w.modelWheel);      // back on the car; _placeWheels re-seats it
        w.modelWheel.rotation.set(0, 0, 0);                        // clear debris tumble (was canting it)
        if (w._wheelScale) w.modelWheel.scale.copy(w._wheelScale); // restore exact scale
        w.detached = false;
      }
    }
  }

  // live-tunable setters (wired to the Garage HUD sliders)
  setLinearDamping(v) { this.body.setLinearDamping(v); }
  setAngularDamping(v) { this.body.setAngularDamping(v); }
  setRestitution(v) { this.collider.setRestitution(v); }
}
