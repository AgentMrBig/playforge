import * as THREE from "three";
import { loadVehicle } from "./vehicledef.js";

/**
 * Tank — a SPECIALIZED tracked-vehicle controller (Erik: a tank isn't a 4-wheel
 * car). Real differences modeled here:
 *   • MANY road wheels — 9 per side — each on its own raycast suspension, so the
 *     hull pitches/rolls over terrain like a real suspension, not a rigid box.
 *   • SKID STEER — no steered wheels. Each TRACK gets a longitudinal force;
 *     throttle drives both, steering biases them apart. Full opposite = pivot in
 *     place. Turning is the force couple between the two tracks, exactly like the
 *     real thing.
 *   • Tracks grip HARD longitudinally + laterally (rubber-on-everything), so it
 *     climbs, crushes, and doesn't slide out.
 * The visible linked track is layered on top in the lab (instanced links marching
 * around the road wheels); this file owns the physics + road-wheel articulation.
 *
 *   const tank = new Tank(world, RAPIER);
 *   await tank.load();                     // FBX → hull + 18 wheels + turret bones
 *   tank.setInput({throttle, steer, brake});
 *   tank.fixedUpdate(dt); world.step(); tank.snapshotCurr();
 *   tank.interpolate(alpha);               // render
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

export class Tank {
  constructor(world, RAPIER, {
    pos = [0, 1.5, 0],
    mass = 12000,             // kg — heavy but playable
    trackSep = 2.0,           // lateral distance between the two tracks (m)
    hull = [1.5, 0.5, 3.3],   // half extents W,H,L — SHALLOW so it rides on the
                              // wheels (a deep hull drags its belly, wheels never touch)
    hardpointY = -0.4,        // suspension ray origin, body-local (below hull bottom −0.5)
    suspRest = 0.45,
    suspStiff = 240000,       // stiff — holds 12t on 18 wheels without bottoming
    suspDamp = 16000,
    wheelRadius = 0.42,
    trackForce = 90000,       // N max drive force PER TRACK
    brakeForce = 120000,
    gripLong = 3.0,           // longitudinal traction (climbs walls)
    gripLat = 4.5,            // lateral grip — tracks resist sideways hard
    topSpeed = 13,            // m/s (~29 mph)
    yawAssist = 42000,        // extra pivot torque per unit steer (crisp skid-steer)
  } = {}) {
    this.world = world; this.RAPIER = RAPIER;
    Object.assign(this, { mass, trackSep, hull, hardpointY, suspRest, suspStiff, suspDamp, wheelRadius,
      trackForce, brakeForce, gripLong, gripLat, topSpeed, yawAssist });
    this.spawn = pos.slice();
    this.throttle = 0; this.steerInput = 0; this.brakeInput = 0;
    this.leftDrive = 0; this.rightDrive = 0;    // exposed for the track visual speed
    this.speedKmh = 0; this.crashed = false;

    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos[0], pos[1], pos[2])
      .setLinearDamping(0.15).setAngularDamping(0.9).setCcdEnabled(true);
    this.body = world.createRigidBody(bd);
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hull[0], hull[1], hull[2])
        .setDensity(0).setFriction(0.7).setRestitution(0.05)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(300000)
        .setCollisionGroups((0x0004 << 16) | 0xffff),
      this.body);
    // low, wide CoM so it corners flat and is very hard to roll
    this.body.setAdditionalMassProperties(mass, { x: 0, y: -0.45, z: 0 },
      { x: mass * 1.4, y: mass * 1.8, z: mass * 0.7 }, { x: 0, y: 0, z: 0, w: 1 }, true);
    this.colliderHandles = new Set([this.collider.handle]);

    // road-wheel local layout (forward frame: +Z front). Filled after load() from
    // the model bones; a sane default so physics works even if load lags.
    this.wheels = [];
    for (let side = 0; side < 2; side++) {
      const z = side === 0 ? -trackSep / 2 : trackSep / 2;   // left / right track line
      for (let i = 0; i < 9; i++) {
        const x = 2.5 - i * (5.0 / 8);                       // front(+) → rear(−) along length
        this.wheels.push({ side, local: new THREE.Vector3(z, hardpointY, x * 0.72),
          grounded: false, dist: suspRest, comp: 0 });
      }
    }

    this.mesh = new THREE.Group(); this.mesh.name = "tank";
    this.prevPos = new THREE.Vector3(); this.currPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion(); this.currQuat = new THREE.Quaternion();
    this._read(this.currPos, this.currQuat);
    this.prevPos.copy(this.currPos); this.prevQuat.copy(this.currQuat);
  }

  async load() {
    // preYaw −90°: native long-axis X → forward +Z, left/right consistent
    const rig = await loadVehicle("models/military/SK_Veh_Tank_USA_01.FBX", {
      targetLength: 6.8, textureDir: "models/military", textureFlipY: true,
      textureMap: { material: "T_PolygonMilitary_01_A.PNG" }, preYaw: -Math.PI / 2,
    });
    this.visual = rig.visual;
    // drop the model so its tracks sit at the wheel-contact line, not floating at
    // the body center (tuned empirically against the settled ride height)
    this.visual.position.y = -0.9;
    this.mesh.add(this.visual);
    // pull the real road-wheel + turret bones out of the rig for articulation
    this.roadWheels = { L: [], R: [] };
    this.visual.traverse((o) => {
      if (!o.isBone) return;
      const n = o.name;
      if (/Turret_01$/i.test(n)) this.turretBone = o;
      else if (/Turret_Barrel/i.test(n)) this.barrelBone = o;
      else {
        const m = n.match(/Track_Wheel_([LR])_(\d+)/i);
        if (m) this.roadWheels[m[1].toUpperCase()].push({ i: +m[2], bone: o, rest: o.position.y });
      }
    });
    // NOTE: the road-wheel bones are a PARENT-CHILD CHAIN (their world positions
    // stack vertically, not laid out across the hull), so they can't drive the
    // suspension layout and mustn't be written per-frame (it compounds down the
    // chain and flings the model apart). We keep the evenly-computed 18-wheel
    // layout for physics; the multi-point suspension gives the hull its
    // pitch/roll over terrain. Individual visual wheel bob is skipped in v1.
    return this;
  }

  get height() { return this.body.translation().y; }
  setInput({ throttle = 0, steer = 0, brake = 0 }) {
    this.throttle = throttle; this.steerInput = steer; this.brakeInput = brake;
  }

  fixedUpdate(dt) {
    const body = this.body;
    body.resetForces(false); body.resetTorques(false);
    const t = body.translation(), r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _down.copy(_up).negate();
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    const lv = body.linvel(), av = body.angvel();
    const wc = body.worldCom(); _com.set(wc.x, wc.y, wc.z);
    const fwdSpeed = lv.x * _fwd.x + lv.y * _fwd.y + lv.z * _fwd.z;
    this.speedKmh = fwdSpeed * 3.6;

    // ---- skid-steer track drive: base throttle ± steering bias per track -----
    const thr = THREE.MathUtils.clamp(this.throttle, -1, 1);
    const st = THREE.MathUtils.clamp(this.steerInput, -1, 1);
    // + steer = turn left → left track slower/reverse, right track faster
    const speedFade = Math.max(0.12, 1 - Math.abs(fwdSpeed) / this.topSpeed);
    let lCmd = thr - st, rCmd = thr + st;
    // pivot in place: with no throttle, steering still spins the tracks opposite
    lCmd = THREE.MathUtils.clamp(lCmd, -1, 1); rCmd = THREE.MathUtils.clamp(rCmd, -1, 1);
    this.leftDrive = lCmd; this.rightDrive = rCmd;

    // ---- per-wheel suspension + traction -------------------------------------
    const reach = this.suspRest + this.wheelRadius;
    let grounded = 0;
    const perWheelLong = { 0: lCmd * this.trackForce, 1: rCmd * this.trackForce };
    const nWheelsSide = this.wheels.length / 2;
    for (const w of this.wheels) {
      _wpos.copy(w.local).applyQuaternion(_q).add(_tpos.set(t.x, t.y, t.z));
      const ray = new this.RAPIER.Ray(_wpos, _down);
      const hit = this.world.castRay(ray, reach, true, undefined, undefined, undefined, body);
      if (!hit) { w.grounded = false; w.dist = this.suspRest; continue; }
      const toi = hit.timeOfImpact ?? hit.toi;
      w.grounded = true; grounded++;
      w.dist = Math.max(0, toi - this.wheelRadius);
      w.comp = this.suspRest - w.dist;
      _rel.copy(_down).multiplyScalar(toi).add(_wpos).sub(_com);
      _cross.set(av.x, av.y, av.z).cross(_rel);
      _vel.set(lv.x + _cross.x, lv.y + _cross.y, lv.z + _cross.z);
      const springVel = _vel.dot(_up);
      let load = this.suspStiff * w.comp - this.suspDamp * springVel;
      if (load < 0) load = 0;
      // traction budget from load, split across the wheels on this track
      const budget = this.gripLong * load;
      const vLong = _vel.dot(_fwd), vLat = _vel.dot(_right);
      let fLong = (perWheelLong[w.side] / nWheelsSide) * speedFade;
      if (this.brakeInput > 0.01 || Math.abs(thr) < 0.01 && Math.abs(st) < 0.01)
        fLong -= vLong * this.brakeForce / nWheelsSide * Math.max(this.brakeInput, 0.06);
      fLong = THREE.MathUtils.clamp(fLong, -budget, budget);
      // lateral: tracks resist sideways sliding hard (but yaw is allowed via the
      // track force couple + yaw assist below)
      let fLat = -vLat * this.gripLat * load * 0.02;
      const latMax = this.gripLat * load;
      fLat = THREE.MathUtils.clamp(fLat, -latMax, latMax);
      const px = _wpos.x + _down.x * toi, py = _wpos.y + _down.y * toi, pz = _wpos.z + _down.z * toi;
      body.addForceAtPoint({
        x: _up.x * load + _fwd.x * fLong + _right.x * fLat,
        y: _up.y * load + _fwd.y * fLong + _right.y * fLat,
        z: _up.z * load + _fwd.z * fLong + _right.z * fLat,
      }, { x: px, y: py, z: pz }, true);
    }
    this.grounded = grounded;

    // ---- yaw assist: crisp skid-steer response (real tanks turn HARD) --------
    if (grounded > 4 && Math.abs(st) > 0.01) {
      const yawT = -st * this.yawAssist * (0.4 + 0.6 * Math.abs(thr));   // sign: +steer → +yaw (left)
      body.addTorque({ x: _up.x * yawT, y: _up.y * yawT, z: _up.z * yawT }, true);
    }
    // aero-ish drag caps the top speed
    if (Math.hypot(lv.x, lv.z) > 0.3) {
      const fd = 900 + 40 * Math.hypot(lv.x, lv.z);
      body.addForce({ x: -lv.x * fd, y: 0, z: -lv.z * fd }, true);
    }
  }

  /** RENDER: interpolate the hull pose (road wheels are a bone chain — see load()) */
  interpolate(alpha) {
    this.mesh.position.lerpVectors(this.prevPos, this.currPos, alpha);
    this.mesh.quaternion.copy(this.prevQuat).slerp(this.currQuat, alpha);
  }

  snapshotPrev() { this.prevPos.copy(this.currPos); this.prevQuat.copy(this.currQuat); }
  snapshotCurr() { this._read(this.currPos, this.currQuat); }
  _read(p, q) { const t = this.body.translation(), r = this.body.rotation(); p.set(t.x, t.y, t.z); q.set(r.x, r.y, r.z, r.w); }

  reset(height = null) {
    const p = this.spawn;
    this.body.setTranslation({ x: p[0], y: height == null ? p[1] : height, z: p[2] }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.crashed = false;
    this._read(this.currPos, this.currQuat);
    this.prevPos.copy(this.currPos); this.prevQuat.copy(this.currQuat);
  }
}
