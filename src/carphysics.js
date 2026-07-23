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
const _ck = new THREE.Vector3();       // crack plane normal (traveling tear)
const _dp = new THREE.Vector3();       // debris: impact point
const _dc = new THREE.Vector3();       // debris: car world center
const _dw = new THREE.Vector3();       // debris: wheel world pos
const ANTIROLL_AXLES = [[0, 1], [2, 3]];   // [FL,FR], [RL,RR]

// damage zones (D1): stable panel identity from a one-time spatial partition of
// the welded body mesh in its own local space — a bumper hit can't dent the roof.
export const ZONES = ["front", "rear", "left", "right", "roof", "center"];
function zoneOf(nx, ny, nz) {              // normalized [-1,1] local coords
  if (nz > 0.55) return 0;                 // front
  if (nz < -0.55) return 1;                // rear
  if (ny > 0.6) return 4;                  // roof
  if (nx < -0.35) return 2;                // left
  if (nx > 0.35) return 3;                 // right
  return 5;                                // center/cabin
}
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
    engineForce = 12000,   // N per driven wheel (muscle-car punch; sustains burnouts)
    brakeForce = 10000,    // N per wheel under full brake
    maxSteer = 0.55,       // rad (~31°) at the front wheels
    steerRate = 4.0,       // how fast steer angle chases input (per second)
    tireGrip = 2.2,        // peak lateral grip as a multiple of vertical load
    rearGripMul = 1.0,     // <1 loosens the rear → drift (the Stage-4 knob)
    rollResist = 0.015,    // rolling resistance fraction of load
    dragLin = 380,         // N per (m/s) — dominant: makes throttle % ≈ speed % (linear feel)
    dragQuad = 2,          // N per (m/s)² — mild aero wall at the top (~180 km/h stock)
    wheelInertia = 6,      // lumped driven-wheel inertia (higher = spins up slower)
    tireStiffB = 8.0,      // Pacejka B — slip stiffness (higher = sharper grip onset)
    tireShapeC = 1.15,     // Pacejka C — curve shape; ~1.1-1.2 = forgiving plateau (>1.4 spins out)
    antiRoll = 29000,      // sway-bar stiffness (Erik default) — resists body roll, not bump
    // impact deform (Stage 5). Rapier contact forces run huge (~22k N per km/h of
    // closing speed), so these are in the 100k-millions range: dent from ~15 km/h,
    // full crumple by ~100 km/h.
    dentThreshold = 250000,  // min contact force (N) to leave a dent (~16 km/h)
    dentFullForce = 1100000, // force span above threshold for full severity (~62 km/h — saturates sooner)
    dentRadius = 1.35,       // base dent spread (m) — real crumple, not a scuff
    dentDepth = 0.7,         // base dent depth at full severity (m)
    dentMax = 1.15,          // max total displacement any vertex can accumulate (m) — pancake territory
    // mechanical damage (Stage 6)
    wheelDetachForce = 900000,  // contact force to tear a wheel off (~41 km/h hit)
    chunkForce = 1600000,       // force to break off body chunks (~72 km/h)
    glassBreakForce = 700000,   // force to shatter the glass (~32 km/h)
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
    this.dragLin = dragLin;
    this.dragQuad = dragQuad;
    this.wheelInertia = wheelInertia;
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
    this.glassBreakForce = glassBreakForce;
    this.glassMats = [];       // glass materials (dimmed to 0 when shattered)
    this.glassBroken = false;
    this.debris = [];          // loose pieces (knocked-off wheels + body chunks + glass shards)
    // SHARED debris resources — building a fresh geometry + MeshStandardMaterial
    // per chunk on a big hit compiled ~40 shader variants + GPU-uploaded ~40
    // buffers in ONE frame, which is the multi-frame hang on a high-speed wall
    // hit (Erik). Reuse two unit geometries (scaled per piece) + a few materials.
    this._debGeo = { tet: new THREE.TetrahedronGeometry(1), box: new THREE.BoxGeometry(1, 0.5, 0.8) };
    this._debMat = {
      body: new THREE.MeshStandardMaterial({ color: 0x777b80, metalness: 0.55, roughness: 0.55 }),
      paint: new THREE.MeshStandardMaterial({ color: 0xcc3333, metalness: 0.55, roughness: 0.55 }),
      glass: new THREE.MeshStandardMaterial({ color: 0xbfe6ef, transparent: true, opacity: 0.5, metalness: 0.1, roughness: 0.05 }),
    };
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

    // D4 COMPOUND COLLIDER: 5 density-0 sub-boxes (cabin core + nose/tail/side
    // faces) instead of one cuboid. Heavy zone damage shifts that face INWARD
    // (setTranslationWrtParent) so a caved nose COLLIDES caved — push a wreck
    // against a wall and the crushed metal, not phantom pristine bumper, touches.
    // All faces fire contact-force events; mass still comes from the body props.
    const mkSub = (sx, sy, sz, px, py, pz) => world.createCollider(
      RAPIER.ColliderDesc.cuboid(sx, sy, sz)
        .setDensity(0)
        .setRestitution(restitution)
        .setFriction(friction)
        // the chassis floats on the suspension, so ANY chassis contact is a real
        // impact — fire force events above the dent threshold to drive deformation
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(dentThreshold)
        // own group bit (0x0004) so soft things (the ragdoll dummy) can opt out of
        // colliding with the chassis — his flailing limbs were denting the car
        .setCollisionGroups((0x0004 << 16) | 0xffff)
        .setTranslation(px, py, pz),
      this.body);
    this.collider = mkSub(hx * 0.72, hy, hz * 0.55, 0, 0, 0);              // cabin core
    this._subBase = {
      front: { x: 0, y: -hy * 0.05, z: hz * 0.76 },
      rear:  { x: 0, y: -hy * 0.05, z: -hz * 0.76 },
      left:  { x: hx * 0.84, y: -hy * 0.1, z: 0 },    // zone x labels are MESH-mirrored
      right: { x: -hx * 0.84, y: -hy * 0.1, z: 0 },   // vs physics x (see D2 note)
    };
    this.subCols = {
      front: mkSub(hx * 0.9, hy * 0.8, hz * 0.24, 0, -hy * 0.05, hz * 0.76),
      rear:  mkSub(hx * 0.9, hy * 0.8, hz * 0.24, 0, -hy * 0.05, -hz * 0.76),
      left:  mkSub(hx * 0.16, hy * 0.75, hz * 0.5, hx * 0.84, -hy * 0.1, 0),
      right: mkSub(hx * 0.16, hy * 0.75, hz * 0.5, -hx * 0.84, -hy * 0.1, 0),
    };
    this._crushMax = { front: hz * 0.5, rear: hz * 0.5, left: hx * 0.6, right: hx * 0.6 };
    this.colliderHandles = new Set([this.collider.handle,
      ...Object.values(this.subCols).map((c) => c.handle)]);

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
    this.shiftCut = false;                          // torque cut during gear shifts
    bodyGeo.computeBoundingBox();
    this._buildZones();                             // zones work on the placeholder box too
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
      { name: "FL", mount: new THREE.Vector3(-mx, my, mz), front: true, driven: false, grounded: false, dist: suspRest, comp: 0, spin: 0, slip: 0, spinRate: 0, omega: 0 },
      { name: "FR", mount: new THREE.Vector3(mx, my, mz), front: true, driven: false, grounded: false, dist: suspRest, comp: 0, spin: 0, slip: 0, spinRate: 0, omega: 0 },
      { name: "RL", mount: new THREE.Vector3(-mx, my, -mz), front: false, driven: true, grounded: false, dist: suspRest, comp: 0, spin: 0, slip: 0, spinRate: 0, omega: 0 },
      { name: "RR", mount: new THREE.Vector3(mx, my, -mz), front: false, driven: true, grounded: false, dist: suspRest, comp: 0, spin: 0, slip: 0, spinRate: 0, omega: 0 },
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

    // D2 FRAME BEND: corner damage bends the frame — that corner's spring sags
    // and softens, and a beat-up front end knocks the alignment out so the car
    // pulls. All driven by zoneHealth (the panels the deform system tracks).
    const zh = this.zoneHealth;
    if (zh) {
      for (const w of this.wheels) {
        // NOTE: zone left/right labels live in MESH-local x, which the Synty rig
        // mirrors vs the physics frame — verified empirically (probe 07-23)
        const side = w.mount.x < 0 ? zh.right : zh.left;
        const end = w.front ? zh.front : zh.rear;
        // blend, don't min: a head-on sags BOTH fronts evenly (no fake pull);
        // the pull appears only when one SIDE is chewed up too
        w.bend = (1 - end) * 0.55 + (1 - side) * 0.45;
      }
      // crooked steering: alignment pulled toward the more-damaged front corner
      // (sign verified by headless straight-line probe — pulls INTO the damage)
      this._steerBias = 0.055 * (this.wheels[1].bend - this.wheels[0].bend);
    } else this._steerBias = 0;

    // D3 MECHANICAL STATES — the drivetrain takes damage, not just the body:
    // • smashed front end (< 40%) cooks the radiator: engine torque fades
    //   ~1.5%/s down to a 40% limp, hood smoke ramps (vehiclefx reads overheat)
    if (zh && zh.front < 0.4) {
      this.overheat = Math.min(1, (this.overheat || 0) + dt * 0.3);
      this.heatMul = Math.max(0.4, (this.heatMul ?? 1) - 0.015 * dt);
    } else this.overheat = Math.max(0, (this.overheat || 0) - dt * 0.5);
    // • battered transmission: past ~4MN of lifetime hits, random brief torque
    //   dropouts with a backfire BANG (audio + exhaust flame read transPop)
    if (this._dropT > 0) this._dropT -= dt;
    else if ((this._accumMag || 0) > 4e6 && Math.abs(this.throttle) > 0.3) {
      this._dropCd = (this._dropCd ?? 0) - dt;
      if (this._dropCd <= 0) {
        this._dropT = 0.12 + Math.random() * 0.2;      // the dropout
        this._dropCd = 2.5 + Math.random() * 5;        // until the next one
        this.transPop = 1;                             // one-shot bang flag
      }
    }

    // smooth the steer angle toward the input target (no snap)
    const steerGoal = this.steerTarget * this.maxSteer + this._steerBias;
    this.steer += (steerGoal - this.steer) * Math.min(1, this.steerRate * dt);

    // hold Space at low speed + floor it = line-lock burnout (rears spin, fronts
    // braked to hold you); at speed, Space is the handbrake (rears lock → drift)
    const spdAbs = Math.abs(this.speedKmh);
    // burnout entry: handbrake+gas OR the classic BRAKE-STAND (brake+gas together)
    const burnoutMode = (this.handbrake || (this.brakeInput > 0.35 && this.throttle > 0.45)) && spdAbs < 8;
    // 1st-gear torque kick: FLOORING it (>90%) at low speed multiplies drive force —
    // cracks the rears loose from a dig (forward now lights up like reverse does);
    // feather the throttle and it launches clean. Fades out by ~36 km/h.
    const launchBoost = Math.abs(this.throttle) > 0.9
      ? 1 + 0.6 * Math.max(0, 1 - (spdAbs / 3.6) / 10) : 1;
    this._boost = launchBoost;
    this.burnout = burnoutMode;                 // exposed for audio (rev, don't drag)

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

    // drag = linear (driveline/rolling, dominant) + mild quadratic (aero). The
    // linear term makes throttle position map ~linearly to cruise speed — how a
    // real pedal feels — instead of cramming street speeds into the bottom 5%.
    const spd3 = Math.hypot(lv.x, lv.y, lv.z);
    if (spd3 > 0.5) {
      const fd = this.dragLin + this.dragQuad * spd3;   // F = −v · (k1 + k2·|v|)
      body.addForce({ x: -lv.x * fd, y: -lv.y * fd * 0.5, z: -lv.z * fd }, true);
    }

    for (const w of this.wheels) {
      // a torn-off corner rides the bare hub: shorter rest (sits lower), heavier
      // damping (no pogo), and no tyre grip below — so it DRAGS, not springs/flips.
      const restLen = w.detached ? 0.22 : this.suspRest * (1 - 0.16 * (w.bend || 0));   // bent corner SAGS
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
        // bent corner: crushed spring holds less rate (rides soggy over bumps)
        let load = this.suspStiff * (1 - 0.18 * (w.bend || 0)) * w.comp - damp * springVel;
        if (load < 0) load = 0;
        w.force = load;

        // hard-bump clunk for audio: a fast compression spike (kerb, landing, pothole)
        w._bumpCd = Math.max(0, (w._bumpCd || 0) - dt);
        if (springVel < -3 && w._bumpCd <= 0) {
          this.bumpPulse = Math.max(this.bumpPulse || 0, Math.min(1, (-springVel - 3) / 6));
          w._bumpCd = 0.3;
        }

        // ---- tyre forces (a torn-off corner has none — the bare hub just drags) ----
        let fLong = 0, fLat = 0;
        if (!w.detached) {
          _fwd.set(0, 0, 1).applyQuaternion(_q);
          _right.set(1, 0, 0).applyQuaternion(_q);
          if (w.front) { _fwd.applyQuaternion(_steerQ); _right.applyQuaternion(_steerQ); }
          const vLong = _vel.dot(_fwd);
          const vLat = _vel.dot(_right);
          w.vLat = vLat;                                // lateral slide speed (for squeal pitch)

          // grip budget (friction circle), load-based → weight transfer feeds it
          const gripMul = (w.front ? 1 : this.rearGripMul) * ((this.handbrake || burnoutMode) && !w.front ? 0.5 : 1);
          let gripBudget = this.tireGrip * load * gripMul;
          // kinetic friction: a spinning tyre grips LESS than a hooked-up one, so once
          // it breaks loose it keeps spinning on throttle alone (sustains a burnout
          // after you let off the handbrake) — more spin, less grip
          // kinetic friction while spinning — but a spinning tyre re-grips as ROAD
          // speed rises (slip ratio falls): burnouts sustain at low speed, a full-
          // throttle launch smokes off the line then hooks up around ~80 km/h.
          if (w.driven && Math.abs(w.spinRate || 0) > 4)
            gripBudget *= Math.min(1, 0.45 + (spdAbs / 3.6) / 45);

          // longitudinal: engine + brake + rolling resistance
          // gear-shift latency: torque cut synced to the audio gearbox's shift dip
          const driveMul = this._boost * (this.shiftCut ? 0.15 : 1)
            * (this.heatMul ?? 1) * (this._dropT > 0 ? 0.05 : 1);   // D3: overheat fade + trans dropout
          if (w.driven) fLong += this.throttle * this.engineForce * driveMul;
          // burnout: brake the FRONTS (hold the car); drift: brake the rears
          // in burnout mode ALL braking goes to the FRONTS (hold the car) — the rears
          // must stay free to spin; otherwise brakeInput brakes all four as normal
          const brake = burnoutMode
            ? (w.front ? Math.max(this.brakeInput, this.handbrake ? 1 : 0) : 0)
            : this.brakeInput + (this.handbrake && !w.front ? 1 : 0);
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

          // ---- wheelspin: drive force the tyre CAN'T put down spins the wheel up
          // faster than the ground (real traction break). Chassis force stays grip-
          // limited above; this is the surplus torque winding the wheel. -----------
          if (w.driven) {
            const driveForce = this.throttle * this.engineForce * driveMul;
            // Flooring AGAINST the direction of travel: the tyre fights the ground and
            // breaks loose immediately — the spin you get dropping it into reverse at
            // speed. Now symmetric: flooring W while rolling backwards spins them too,
            // and the kinetic sustain carries the burnout through the direction change.
            const opposing = Math.sign(driveForce) * vLong < -1.5 && Math.abs(driveForce) > gripBudget * 0.45;
            const excess = opposing ? Math.abs(driveForce) * 0.9
              : Math.max(0, Math.abs(driveForce) - gripBudget);             // unusable torque
            w.spinRate += Math.sign(driveForce || 1) * (excess * this.wheelRadius / this.wheelInertia) * dt;
            if (this.handbrake && !burnoutMode) w.spinRate = 0;    // drift = locked rears; burnout = let them spin
            w.spinRate -= w.spinRate * Math.min(1, 3 * dt);        // re-hooks as grip returns (slow)
          } else {
            w.spinRate = 0;
          }
          w.omega = vLong / this.wheelRadius + w.spinRate;
          w.spin += w.omega * dt;                                  // visual roll (fast when spinning)
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
        w.cx = _wpos.x + _down.x * toi;   // world ground-contact point (for skid marks)
        w.cy = _wpos.y + _down.y * toi;
        w.cz = _wpos.z + _down.z * toi;
        body.addForceAtPoint(_imp, { x: w.cx, y: w.cy, z: w.cz }, true);
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
    // burnout squeal from the ACTUAL wheelspin of the driven wheels
    let spinN = 0, rawSpin = 0;
    for (const w of this.wheels) {
      if (!w.driven || w.detached) continue;
      rawSpin = Math.max(rawSpin, Math.abs(w.spinRate || 0));
      spinN = Math.max(spinN, Math.min(1, rawSpin / 50));
    }
    this.driveSpin = rawSpin;                    // raw wheelspin (rad/s) for audio rev
    if (spinN > amt) { amt = spinN; slideSpeed = Math.max(slideSpeed, spinN * 14); }
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
      if (w.detached && !w._rfit) continue;     // loose debris — unless the replay re-fitted it
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
  deform(worldPoint, mag, worldDir, pose = null) {
    if (mag < this.dentThreshold) return;

    // sync the visual group to the pose the impact HAPPENED at — normally the
    // body's current pose; the replay passes the recorded crash pose so dents
    // land in the right spot when re-enacted later. Then work in body-MESH local
    // space — this handles a nested/scaled model exactly like the flat box.
    if (pose) {
      this.mesh.position.set(pose.px, pose.py, pose.pz);
      this.mesh.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
    } else {
      const t = this.body.translation(), r = this.body.rotation();
      this.mesh.position.set(t.x, t.y, t.z);
      this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
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

    // one coherent CRACK plane per impact (the "traveling tear"): verts past it
    // shear extra, opening a single realistic rip instead of shredding every edge
    _ck.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    // crush along the IMPACT direction — the way the metal was actually hit. A
    // head-on folds the nose straight back (not a sideways shear toward center).
    _ld.set(worldDir.x, worldDir.y, worldDir.z).transformDirection(_m1);
    if (_ld.lengthSq() < 1e-6) _ld.copy(this.bodyCenter).sub(_lp);
    _ld.normalize();
    // safety: the force direction must point INTO the body, whichever way Rapier
    // ordered the contact pair
    _off.copy(this.bodyCenter).sub(_lp);
    if (_ld.dot(_off) < 0) _ld.negate();
    _ck.cross(_ld).normalize();                 // crack plane normal ⊥ crush direction
    if (_ck.lengthSq() < 1e-6) _ck.set(1, 0, 0);

    // D1: which panel did we hit? Deform stays inside that zone (a bumper hit
    // can't bleed into the hood even if the radius reaches it).
    const zn = this._zoneNorm;
    const hitZone = zn ? zoneOf((_lp.x - zn.cx) / zn.hx, (_lp.y - zn.cy) / zn.hy, (_lp.z - zn.cz) / zn.hz) : -1;

    const sev = Math.min(1, (mag - this.dentThreshold) / this.dentFullForce);
    const radius = (this.dentRadius / s) * (0.5 + sev * 1.7);   // big hits reach the hood
    const depth = (this.dentDepth / s) * sev;
    const maxD = this.dentMax / s;
    // STRUCTURAL CRUMPLE WAVE (Erik): a violent hit doesn't stop at the bumper —
    // the shock travels down the frame. Above ~full dent force, EVERY vert gets a
    // secondary compression along the impact direction that decays with distance
    // downstream — nose takes the crater, the cockpit deforms some, the tail a
    // whisper. Ignores zone bounds (it's the frame carrying the energy, not the
    // panel), so a 50mph wall hit visibly shortens/wrinkles the whole car.
    const waveK = Math.min(1, Math.max(0, mag / this.dentFullForce - 0.85));
    const waveDepth = 0.3 * (this.dentDepth / s) * waveK;
    const waveReach = 5.2 / s;                                  // ~full body length

    // crumple EVERY body mesh (paint shell + trim + lights — the whole skin)
    const dfs = this.deformables || [{ mesh: this.bodyMesh, orig: this.origPos, zones: this.vertexZone }];
    let touched = false;
    for (const df of dfs) {
      const pos = df.mesh.geometry.attributes.position;
      const op = df.orig, zones2 = df.zones;
      let hit = false;
      for (let i = 0; i < pos.count; i++) {
        // D1 soft zone bound: full crumple in the hit panel, 50% spillover into neighbours
        const zw = (!zones2 || hitZone < 0 || zones2[i] === hitZone) ? 1 : 0.5;
        _vp.fromBufferAttribute(pos, i);
        const d = _vp.distanceTo(_lp);
        const ox = op[i * 3], oy = op[i * 3 + 1], oz = op[i * 3 + 2];
        // frame shock: axial distance downstream of the hit, along the crush dir
        let wave = 0;
        if (waveDepth > 0) {
          const ax = (ox - _lp.x) * _ld.x + (oy - _lp.y) * _ld.y + (oz - _lp.z) * _ld.z;
          if (ax > -0.3) {
            const wf = 1 - Math.min(1, Math.max(0, ax) / waveReach);
            wave = waveDepth * wf * wf;                       // quadratic falloff to the tail
          }
        }
        if (d >= radius && wave < 1e-4) continue;
        const fall = d < radius ? 1 - d / radius : 0;         // deepest at the epicenter
        _vp.addScaledVector(_ld, depth * fall * fall * zw + wave);   // local crater + frame shock
        // crumple texture: POSITION-hashed jitter — coincident (unwelded) verts get
        // identical offsets, so seams stay closed instead of shredding every edge
        const jit = 0.2 * depth * fall * zw + 0.35 * wave;    // the wave wrinkles what it passes through
        const s1 = Math.sin(ox * 12.9898 + oy * 78.233 + oz * 37.719) * 43758.5453;
        const s2 = Math.sin(ox * 93.989 + oy * 67.345 + oz * 24.123) * 24634.6345;
        const s3 = Math.sin(ox * 45.332 + oy * 12.788 + oz * 76.211) * 56445.2342;
        _vp.x += (s1 - Math.floor(s1) - 0.5) * jit;
        _vp.y += (s2 - Math.floor(s2) - 0.5) * jit;
        _vp.z += (s3 - Math.floor(s3) - 0.5) * jit;
        // the traveling tear: one side of the crack plane shears extra → a single
        // coherent rip radiating from the hit (fades with distance)
        const sd = (ox - _lp.x) * _ck.x + (oy - _lp.y) * _ck.y + (oz - _lp.z) * _ck.z;
        if (sd > 0 && fall > 0) _vp.addScaledVector(_ld, 0.3 * depth * fall * zw);
        _off.set(_vp.x - op[i * 3], _vp.y - op[i * 3 + 1], _vp.z - op[i * 3 + 2]);
        if (_off.length() > maxD) _off.setLength(maxD);       // accumulation cap
        pos.setXYZ(i, op[i * 3] + _off.x, op[i * 3 + 1] + _off.y, op[i * 3 + 2] + _off.z);
        hit = true;
      }
      if (hit) {
        pos.needsUpdate = true;
        df.mesh.geometry.computeVertexNormals();              // dents catch light correctly
        touched = true;
      }
    }
    if (touched) this.dents++;
    return touched && hitZone >= 0 ? ZONES[hitZone] : null;   // which panel took it
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

    // deform EVERY body mesh — the Synty bake splits the car per-material (paint
    // shell, trim, lights...); deforming only the largest left the painted body
    // visually invincible while the lights mesh dented (Erik's exact report).
    this.deformables = [];
    let best = null, bestCount = -1;
    const combined = new THREE.Box3();
    v.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry = mergeVertices(o.geometry);             // weld → crumples as a skin
      o.geometry.computeBoundingBox();
      combined.union(o.geometry.boundingBox);             // shared frame (sibling meshes)
      this.deformables.push({ mesh: o, orig: Float32Array.from(o.geometry.attributes.position.array), zones: null });
      const n = o.geometry.attributes.position.count;
      if (n > bestCount) { bestCount = n; best = o; }
    });
    if (best) {
      this.bodyMesh = best;
      this.origPos = this.deformables.find((d) => d.mesh === best).orig;
      this.bodyCenter = combined.getCenter(new THREE.Vector3());
      this.dents = 0;
      this._buildZones(combined);                         // D1: per-vertex panel identity, all meshes
    }
    // find glass materials (named "glass" or transparent) so we can shatter them
    this.glassMats = []; this.glassBroken = false;
    v.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        const nm = (m.name || "").toLowerCase();
        if ((nm.includes("glass") || (m.transparent && m.opacity < 0.92)) && !this.glassMats.includes(m)) {
          m.userData._op = m.opacity; this.glassMats.push(m);
        }
      }
    });
    this.modelName = rig.name || "car";
  }

  /** D4: shift each face sub-collider inward by its zone's damage — the physics
   *  shape follows the crush (per hit, never per frame; no shape rebuilds). */
  _refitDamageColliders() {
    const zh = this.zoneHealth;
    if (!zh || !this.subCols) return;
    for (const k in this.subCols) {
      const b = this._subBase[k], crush = (1 - zh[k]) * this._crushMax[k] * 0.8;
      const p = { x: b.x, y: b.y, z: b.z };
      if (k === "front") p.z -= crush;
      else if (k === "rear") p.z += crush;
      else if (k === "left") p.x -= crush;
      else p.x += crush;
      this.subCols[k].setTranslationWrtParent(p);
    }
  }

  /**
   * A hard hit landed: crumple the body, and above bigger thresholds tear off the
   * nearest wheel (with a real handling consequence) or break off a body chunk.
   */
  impact(worldPoint, mag, worldDir) {
    this._accumMag = (this._accumMag || 0) + mag;          // lifetime beating (D3 transmission)
    const zone = this.deform(worldPoint, mag, worldDir);   // crumple (also syncs mesh pose)
    // D1: dock the hit panel's health — feeds frame bend (D2) + mechanical states (D3)
    if (zone && this.zoneHealth) {
      const sev = Math.min(1, (mag - this.dentThreshold) / this.dentFullForce);
      this.zoneHealth[zone] = Math.max(0, this.zoneHealth[zone] - (0.1 + sev * 0.3));
      this._refitDamageColliders();      // D4: the caved face collides caved
    }
    if (!worldPoint) return;
    this.mesh.updateWorldMatrix(true, true);     // refresh WHEEL matrices for the distance test
    _dp.set(worldPoint.x, worldPoint.y, worldPoint.z);

    // wheel tear-off: nearest still-attached wheel within reach of the contact
    if (mag >= this.wheelDetachForce) {
      let near = null, nd = 1.9;
      for (const w of this.wheels) {
        if (w.detached || !w.modelWheel) continue;
        const d = w.modelWheel.getWorldPosition(_dw).distanceTo(_dp);
        if (d < nd) { nd = d; near = w; }
      }
      if (near) this._detachWheel(near);
    }
    // body chunks fly off on a really big hit
    if (mag >= this.chunkForce && this.debris.length < 80) this._spawnChunk(worldPoint, worldDir, mag);
    // glass shatters at a lower threshold
    if (mag >= this.glassBreakForce) this._breakGlass(worldPoint);
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

  /** scatter a cluster of little metal fragments at the impact + gouge a deep dent */
  _spawnChunk(worldPoint, worldDir, mag) {
    const scene = this.mesh.parent;
    if (!scene) return;
    const lv = this.body.linvel();
    this.mesh.getWorldPosition(_dc);
    _dp.set(worldPoint.x, worldPoint.y, worldPoint.z).sub(_dc).setY(0).normalize();
    // harder hit = more + bigger + more varied pieces
    const sev2 = Math.min(1, (mag - this.dentThreshold) / this.dentFullForce);
    const n = 4 + Math.floor(sev2 * 12 + Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const s = 0.08 + Math.random() * (0.16 + sev2 * 0.3);
      // SHARED geo + mat (scaled per piece) — no per-chunk shader compile/upload
      const piece = new THREE.Mesh(
        Math.random() < 0.5 ? this._debGeo.tet : this._debGeo.box,
        i % 3 === 0 ? this._debMat.paint : this._debMat.body);
      piece.scale.setScalar(s);
      piece.castShadow = true;
      piece.position.set(worldPoint.x + (Math.random() - 0.5) * 0.3, worldPoint.y + (Math.random() - 0.5) * 0.3, worldPoint.z + (Math.random() - 0.5) * 0.3);
      piece.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      scene.add(piece);
      const spread = 3 + Math.random() * 4;
      this._registerDebris(piece,
        lv.x + _dp.x * spread + (Math.random() - 0.5) * 4,
        lv.y + 3 + Math.random() * 4,
        lv.z + _dp.z * spread + (Math.random() - 0.5) * 4, 16);
    }
    this.deform(worldPoint, mag * 1.6, worldDir);   // deeper gouge where it tore away
  }

  /** shatter the glass: dim the glass materials to nothing + fling glass shards */
  _breakGlass() {
    if (this.glassBroken || !this.glassMats.length) return;
    this.glassBroken = true;
    // visible=false skips the faces entirely — opacity 0 still wrote depth and
    // punched see-through holes in the interior from some angles (Erik)
    for (const m of this.glassMats) { m.visible = false; m.needsUpdate = true; }
    const scene = this.mesh.parent;
    if (!scene) return;
    this.mesh.updateWorldMatrix(true, false);
    this.mesh.getWorldPosition(_dc);
    const q = this.body.rotation();
    _iq.set(q.x, q.y, q.z, q.w);
    const lv = this.body.linvel();
    const n = 12 + Math.floor(Math.random() * 8);
    for (let i = 0; i < n; i++) {
      const s = 0.05 + Math.random() * 0.11;
      const shard = new THREE.Mesh(this._debGeo.tet, this._debMat.glass);   // shared — no per-shard compile
      shard.scale.setScalar(s);
      // scatter around the greenhouse (upper body), rotated with the car
      _off.set((Math.random() - 0.5) * 1.5, 0.7 + Math.random() * 0.5, (Math.random() - 0.5) * 2.2).applyQuaternion(_iq);
      shard.position.set(_dc.x + _off.x, _dc.y + _off.y, _dc.z + _off.z);
      shard.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      scene.add(shard);
      this._registerDebris(shard,
        lv.x * 0.5 + (Math.random() - 0.5) * 5, lv.y + 2 + Math.random() * 3, lv.z * 0.5 + (Math.random() - 0.5) * 5, 18);
    }
  }

  _registerDebris(mesh, vx, vy, vz, spin) {
    mesh.userData.vel = new THREE.Vector3(vx, vy, vz);
    mesh.userData.spin = new THREE.Vector3((Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin);
    mesh.userData.life = 14.0;
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
      if (ud.wheelRef) continue;              // WHEELS are keepers — they lie where they fell
      ud.life -= dt;
      // shrink out (NOT material-opacity — the material is shared now; fading it
      // would ghost every other piece and permanently corrupt the shared mat)
      if (ud.life < 1) { const b = ud.baseScale ?? (ud.baseScale = m.scale.x); m.scale.setScalar(b * Math.max(0.001, ud.life)); }
      if (ud.life <= 0) { m.parent && m.parent.remove(m); this.debris.splice(i, 1); }
    }
  }

  get wheelsOff() { return this.wheels.filter((w) => w.detached).length; }

  /**
   * D1: one-time spatial partition of the body mesh into damage zones. Each vertex
   * gets a stable panel id from its normalized position in the body's own bbox;
   * per-zone health drives the mechanical consequences (D2/D3).
   */
  _buildZones(sharedBB = null) {
    const bb = sharedBB || this.bodyMesh.geometry.boundingBox;
    const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
    const hx = Math.max(0.001, (bb.max.x - bb.min.x) / 2);
    const hy = Math.max(0.001, (bb.max.y - bb.min.y) / 2);
    const hz = Math.max(0.001, (bb.max.z - bb.min.z) / 2);
    this._zoneNorm = { cx, cy, cz, hx, hy, hz };
    if (!this.deformables) this.deformables = [{ mesh: this.bodyMesh, orig: this.origPos, zones: null }];
    for (const df of this.deformables) {
      const pos = df.mesh.geometry.attributes.position;
      df.zones = new Uint8Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        df.zones[i] = zoneOf((pos.getX(i) - cx) / hx, (pos.getY(i) - cy) / hy, (pos.getZ(i) - cz) / hz);
      }
    }
    this.vertexZone = this.deformables.find((d) => d.mesh === this.bodyMesh)?.zones || null;
    this.zoneHealth = { front: 1, rear: 1, left: 1, right: 1, roof: 1, center: 1 };
  }

  /** restore the pristine body shape (repair) */
  repair() {
    const dfs = this.deformables || [{ mesh: this.bodyMesh, orig: this.origPos }];
    for (const df of dfs) {
      const pos = df.mesh.geometry.attributes.position;
      pos.array.set(df.orig);
      pos.needsUpdate = true;
      df.mesh.geometry.computeVertexNormals();
    }
    this.dents = 0;
    // panels good as new
    if (this.zoneHealth) for (const k in this.zoneHealth) this.zoneHealth[k] = 1;
    // D3: fresh radiator + transmission
    this.heatMul = 1; this.overheat = 0; this._accumMag = 0; this._dropT = 0; this._dropCd = 0;
    this._refitDamageColliders();       // D4: faces back to factory positions
    // un-shatter the glass
    if (this.glassBroken) {
      for (const m of this.glassMats) { m.visible = true; m.opacity = m.userData._op ?? 0.5; m.needsUpdate = true; }
      this.glassBroken = false;
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
    this.repair();          // fresh body on reset
    // drop chunk debris
    for (const m of this.debris) if (!m.userData.wheelRef) m.parent && m.parent.remove(m);
    this.debris.length = 0;
    // re-fit knocked-off wheels — robust even if their debris already expired
    for (const w of this.wheels) {
      if (w.detached && w.modelWheel) {
        w.modelWheel.traverse((o) => { if (o.material) { o.material.opacity = 1; o.material.transparent = false; } });
        this.mesh.add(w.modelWheel);      // back on the car; _placeWheels re-seats it
        w.modelWheel.visible = true;
        w.modelWheel.rotation.set(0, 0, 0);                        // clear debris tumble (was canting it)
        if (w._wheelScale) w.modelWheel.scale.copy(w._wheelScale); // restore exact scale
        w.detached = false;
        w._rfit = false;
      }
    }
  }

  // live-tunable setters (wired to the Garage HUD sliders)
  setLinearDamping(v) { this.body.setLinearDamping(v); }
  setAngularDamping(v) { this.body.setAngularDamping(v); }
  setRestitution(v) {
    this.collider.setRestitution(v);
    if (this.subCols) for (const k in this.subCols) this.subCols[k].setRestitution(v);
  }
}
