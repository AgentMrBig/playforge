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
 * Visuals use the Synty model: road-wheel bones spin/bob (siblings under root),
 * and Track_L / Track_R materials UV-scroll for tread motion. Do NOT rebind the
 * pack atlas onto Material 1 — its UVs are a long tread strip (V ≈ ±5).
 *
 *   const tank = new Tank(world, RAPIER);
 *   await tank.load();
 *   tank.setInput({throttle, steer, brake});
 *   tank.fixedUpdate(dt); world.step(); tank.snapshotCurr();
 *   tank.interpolate(alpha); tank.updateVisuals(dt);
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
const _spinQ = new THREE.Quaternion();
const _axle = new THREE.Vector3(0, 1, 0); // skeleton-space lateral = wheel axle

function makeTreadMaterial() {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 256;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#151714";
  ctx.fillRect(0, 0, 64, 256);
  for (let y = 0; y < 256; y += 16) {
    ctx.fillStyle = "#252922";
    ctx.fillRect(0, y, 64, 10);
    ctx.fillStyle = "#3a4034";
    ctx.fillRect(6, y + 2, 52, 5);
    ctx.fillStyle = "#0e100e";
    ctx.fillRect(0, y + 10, 64, 6);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return new THREE.MeshStandardMaterial({
    map: tex, color: 0xffffff, roughness: 0.94, metalness: 0.04, vertexColors: false,
  });
}

export class Tank {
  constructor(world, RAPIER, {
    pos = [0, 1.5, 0],
    mass = 12000,
    trackSep = 2.0,
    hull = [1.5, 0.5, 3.3],
    hardpointY = -0.4,
    suspRest = 0.45,
    suspStiff = 240000,
    suspDamp = 16000,
    wheelRadius = 0.42,
    trackForce = 90000,
    brakeForce = 120000,
    gripLong = 3.0,
    gripLat = 4.5,
    topSpeed = 13,
    yawAssist = 42000,
  } = {}) {
    this.world = world; this.RAPIER = RAPIER;
    Object.assign(this, { mass, trackSep, hull, hardpointY, suspRest, suspStiff, suspDamp, wheelRadius,
      trackForce, brakeForce, gripLong, gripLat, topSpeed, yawAssist });
    this.spawn = pos.slice();
    this.throttle = 0; this.steerInput = 0; this.brakeInput = 0;
    this.leftDrive = 0; this.rightDrive = 0;
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
    this.body.setAdditionalMassProperties(mass, { x: 0, y: -0.45, z: 0 },
      { x: mass * 1.4, y: mass * 1.8, z: mass * 0.7 }, { x: 0, y: 0, z: 0, w: 1 }, true);
    this.colliderHandles = new Set([this.collider.handle]);

    this.wheels = [];
    for (let side = 0; side < 2; side++) {
      const z = side === 0 ? -trackSep / 2 : trackSep / 2;
      for (let i = 0; i < 9; i++) {
        const x = 2.5 - i * (5.0 / 8);
        this.wheels.push({ side, local: new THREE.Vector3(z, hardpointY, x * 0.72),
          grounded: false, dist: suspRest, comp: 0 });
      }
    }

    this.mesh = new THREE.Group(); this.mesh.name = "tank";
    this.wheelBones = [];          // { bone, restPos, restQuat, side, i, phys }
    this.trackBoneL = null; this.trackBoneR = null;
    this.trackRestL = null; this.trackRestR = null;
    this.trackMatL = null; this.trackMatR = null;
    this._spinL = 0; this._spinR = 0;
    this._boneScale = 1;           // meters per skeleton unit
    this.prevPos = new THREE.Vector3(); this.currPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion(); this.currQuat = new THREE.Quaternion();
    this._read(this.currPos, this.currQuat);
    this.prevPos.copy(this.currPos); this.prevQuat.copy(this.currQuat);
  }

  async load() {
    const rig = await loadVehicle("models/military/SK_Veh_Tank_USA_01.FBX", {
      targetLength: 6.8, textureDir: "models/military", textureFlipY: true,
      // only hull Material 0 should use the pack atlas — keyword "material" also
      // hits Material 1 (tracks); we strip that atlas in _setupTrackMaterials()
      textureMap: { material: "T_PolygonMilitary_01_A.PNG" },
      // +π so the hull faces physics +Z (W = forward). Without it the model
      // stared at the camera while drive pushed the opposite way.
      preRotX: -Math.PI / 2, preYaw: Math.PI / 2 + Math.PI,
    });
    this.visual = rig.visual;
    this.visual.traverse((o) => {
      if (!(o.isMesh || o.isSkinnedMesh)) return;
      if (o.geometry?.attributes?.color) o.geometry.deleteAttribute("color");
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        if (!m) return;
        m.vertexColors = false;
        if (m.color) m.color.setHex(0xffffff);
        m.needsUpdate = true;
      });
      if (o.isSkinnedMesh) this._skinned = o;
    });
    this.visual.position.y = -0.9;
    this.mesh.add(this.visual);

    // skeleton units → meters (model scaled to targetLength)
    this._boneScale = Math.max(1e-4, this.visual.scale.x || 1);

    this.roadWheels = { L: [], R: [] };
    this.visual.traverse((o) => {
      if (!o.isBone) return;
      const n = o.name;
      if (/Turret_01$/i.test(n)) this.turretBone = o;
      else if (/Turret_Barrel/i.test(n)) this.barrelBone = o;
      else if (/Track_L$/i.test(n)) this.trackBoneL = o;
      else if (/Track_R$/i.test(n)) this.trackBoneR = o;
      else {
        const m = n.match(/Track_Wheel_([LR])_(\d+)/i);
        if (m) this.roadWheels[m[1].toUpperCase()].push({ i: +m[2], bone: o });
      }
    });
    if (this.trackBoneL) this.trackRestL = this.trackBoneL.position.clone();
    if (this.trackBoneR) this.trackRestR = this.trackBoneR.position.clone();

    if (this._skinned) this._setupTrackMaterials(this._skinned);
    this._bindWheelBones();
    return this;
  }

  /**
   * Material 1 is ONLY Track_L/R verts with tread-strip UVs (V ≈ ±5). The pack
   * atlas looks like rainbow noise on it. FBX geometry is NON-INDEXED — we must
   * not early-out on missing index. Replace with procedural tread mats and
   * split L/R so each side can UV-scroll independently during pivot turns.
   */
  _setupTrackMaterials(skinned) {
    const geo = skinned.geometry;
    if (!geo.groups?.length) return;
    const mats = Array.isArray(skinned.material) ? skinned.material.slice() : [skinned.material];
    const hullMat = mats[0];
    if (hullMat) { hullMat.vertexColors = false; hullMat.needsUpdate = true; }

    this.trackMatL = makeTreadMaterial();
    this.trackMatR = makeTreadMaterial();

    const bones = skinned.skeleton?.bones;
    const iL = bones ? bones.findIndex((b) => /Track_L$/i.test(b.name)) : -1;
    const iR = bones ? bones.findIndex((b) => /Track_R$/i.test(b.name)) : -1;
    const skinIndex = geo.attributes.skinIndex;
    const skinWeight = geo.attributes.skinWeight;
    const trackGrp = geo.groups.find((g) => g.materialIndex === 1) || geo.groups[1];
    const hullGrp = geo.groups[0];

    // Always strip the atlas off slot 1 — even if L/R split fails.
    if (!trackGrp || !skinIndex || iL < 0 || iR < 0) {
      mats[1] = this.trackMatL;
      skinned.material = mats;
      this.trackMatR = this.trackMatL;
      return;
    }

    const vertAt = (i) => (geo.index ? geo.index.getX(i) : i);
    const leftIdx = [], rightIdx = [];
    for (let i = trackGrp.start; i < trackGrp.start + trackGrp.count; i += 3) {
      let lScore = 0, rScore = 0;
      for (let t = 0; t < 3; t++) {
        const vi = vertAt(i + t);
        let bestB = 0, bestW = -1;
        for (let k = 0; k < 4; k++) {
          const w = skinWeight.getComponent(vi, k);
          if (w > bestW) { bestW = w; bestB = skinIndex.getComponent(vi, k); }
        }
        if (bestB === iL) lScore++;
        else if (bestB === iR) rScore++;
      }
      const dest = lScore >= rScore ? leftIdx : rightIdx;
      dest.push(vertAt(i), vertAt(i + 1), vertAt(i + 2));
    }

    const newIndices = [];
    for (let i = hullGrp.start; i < hullGrp.start + hullGrp.count; i++) newIndices.push(vertAt(i));
    const lStart = newIndices.length;
    newIndices.push(...leftIdx);
    const rStart = newIndices.length;
    newIndices.push(...rightIdx);
    geo.setIndex(newIndices);
    geo.clearGroups();
    geo.addGroup(0, hullGrp.count, 0);
    geo.addGroup(lStart, leftIdx.length, 1);
    geo.addGroup(rStart, rightIdx.length, 2);
    skinned.material = [hullMat, this.trackMatL, this.trackMatR];
  }

  /**
   * Bind Synty Track_Wheel_* bones (siblings under root — safe to write) to the
   * 18 physics hardpoints for spin + suspension bob.
   */
  _bindWheelBones() {
    this.wheelBones = [];
    for (const sideKey of ["L", "R"]) {
      const side = sideKey === "L" ? 0 : 1;
      const list = (this.roadWheels[sideKey] || []).slice().sort((a, b) => a.i - b.i);
      const phys = this.wheels.filter((w) => w.side === side);
      for (let i = 0; i < list.length; i++) {
        const { bone, i: idx } = list[i];
        this.wheelBones.push({
          bone,
          restPos: bone.position.clone(),
          restQuat: bone.quaternion.clone(),
          side,
          i: idx,
          phys: phys[i] || phys[phys.length - 1],
        });
      }
    }
  }

  /** RENDER: spin/bob model wheels, squat track bones, UV-scroll tread mats. */
  updateVisuals(dt) {
    const spinRate = 2.6 / Math.max(0.05, this.wheelRadius);
    this._spinL += this.leftDrive * spinRate * dt;
    this._spinR += this.rightDrive * spinRate * dt;

    // UV scroll along V (tread-strip axis). Independent L/R for pivot-in-place.
    const uvSpeed = 0.55;
    if (this.trackMatL?.map) {
      this.trackMatL.map.offset.y -= this.leftDrive * uvSpeed * dt;
      this.trackMatL.map.needsUpdate = true;
    }
    if (this.trackMatR?.map) {
      this.trackMatR.map.offset.y -= this.rightDrive * uvSpeed * dt;
      this.trackMatR.map.needsUpdate = true;
    }

    const s = this._boneScale;
    let sumCompL = 0, nL = 0, sumCompR = 0, nR = 0;
    for (const w of this.wheelBones) {
      const phys = w.phys;
      const dist = phys?.grounded ? phys.dist : this.suspRest;
      const comp = this.suspRest - dist;           // meters; + = compressed (wheel up)
      if (w.side === 0) { sumCompL += comp; nL++; } else { sumCompR += comp; nR++; }
      // skeleton Z ≈ up after FBX Y-up conversion; bob in skeleton units
      w.bone.position.copy(w.restPos);
      w.bone.position.z += comp / s;
      const spin = w.side === 0 ? this._spinL : this._spinR;
      _spinQ.setFromAxisAngle(_axle, spin);
      w.bone.quaternion.copy(w.restQuat).multiply(_spinQ);
    }

    // light track-bone squat so the belt rides with average wheel compression
    const squat = (sum, n) => (n ? (sum / n) : 0) / s;
    if (this.trackBoneL && this.trackRestL) {
      this.trackBoneL.position.copy(this.trackRestL);
      this.trackBoneL.position.z += squat(sumCompL, nL) * 0.85;
    }
    if (this.trackBoneR && this.trackRestR) {
      this.trackBoneR.position.copy(this.trackRestR);
      this.trackBoneR.position.z += squat(sumCompR, nR) * 0.85;
    }
  }

  // back-compat alias used by the lab
  updateWheelVisuals(dt) { this.updateVisuals(dt); }
  setupWheelVisuals() { return this; }

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

    const thr = THREE.MathUtils.clamp(this.throttle, -1, 1);
    const st = THREE.MathUtils.clamp(this.steerInput, -1, 1);
    const speedFade = Math.max(0.12, 1 - Math.abs(fwdSpeed) / this.topSpeed);
    let lCmd = thr - st, rCmd = thr + st;
    lCmd = THREE.MathUtils.clamp(lCmd, -1, 1); rCmd = THREE.MathUtils.clamp(rCmd, -1, 1);
    this.leftDrive = lCmd; this.rightDrive = rCmd;

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
      const budget = this.gripLong * load;
      const vLong = _vel.dot(_fwd), vLat = _vel.dot(_right);
      let fLong = (perWheelLong[w.side] / nWheelsSide) * speedFade;
      if (this.brakeInput > 0.01 || Math.abs(thr) < 0.01 && Math.abs(st) < 0.01)
        fLong -= vLong * this.brakeForce / nWheelsSide * Math.max(this.brakeInput, 0.06);
      fLong = THREE.MathUtils.clamp(fLong, -budget, budget);
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

    if (grounded > 4 && Math.abs(st) > 0.01) {
      const yawT = -st * this.yawAssist * (0.4 + 0.6 * Math.abs(thr));
      body.addTorque({ x: _up.x * yawT, y: _up.y * yawT, z: _up.z * yawT }, true);
    }
    if (Math.hypot(lv.x, lv.z) > 0.3) {
      const fd = 900 + 40 * Math.hypot(lv.x, lv.z);
      body.addForce({ x: -lv.x * fd, y: 0, z: -lv.z * fd }, true);
    }
  }

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
