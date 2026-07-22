import * as THREE from "three";

/**
 * Trailer — articulated towing for the proving ground. A single-axle utility
 * trailer: dynamic Rapier body with raycast suspension at the axle (spring +
 * damper + lateral tyre grip) and a "jockey" contact under the tongue so it
 * stands when unhitched. Hitching creates a spherical (ball) joint between the
 * car's rear hitch point and the tongue tip — articulation, sway, and
 * jackknifing all emerge from the joint + tyre physics.
 */

const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(), _down = new THREE.Vector3(), _right = new THREE.Vector3(), _fwd = new THREE.Vector3();
const _wp = new THREE.Vector3(), _tp = new THREE.Vector3(), _rel = new THREE.Vector3();
const _cross = new THREE.Vector3(), _vel = new THREE.Vector3(), _imp = new THREE.Vector3(), _com = new THREE.Vector3();

export class Trailer {
  constructor(world, RAPIER, { pos = [5, 1.0, -5] } = {}) {
    this.world = world;
    this.RAPIER = RAPIER;
    this.mass = 320;
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos[0], pos[1], pos[2])
      .setLinearDamping(0.1).setAngularDamping(1.1).setCanSleep(false);
    this.body = world.createRigidBody(bd);
    // density, NOT setMass: setMass left the angular inertia degenerate — solver
    // noise alone torqued the free body (it tumbled itself). Density derives a
    // valid inertia tensor from the shape. 0.8×0.18×1.3 halves ≈ 1.5 m³ → ~320 kg.
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.8, 0.18, 1.3).setDensity(213).setFriction(0.8).setRestitution(0.05),
      this.body);

    this.wheelRadius = 0.3; this.suspRest = 0.35;
    this.stiff = 9000; this.damp = 1500; this.grip = 1.9;
    // axle pair + jockey under the tongue tip (holds it up when unhitched)
    this.points = [
      { x: -0.78, y: 0, z: -0.45, wheel: true },
      { x: 0.78, y: 0, z: -0.45, wheel: true },
      { x: 0, y: 0, z: 1.9, wheel: false },
    ];
    this.tongueTip = { x: 0, y: -0.05, z: 2.0 };   // local hitch anchor

    // ---- visual: flatbed + rails + tongue + wheels ----
    this.mesh = new THREE.Group();
    const grey = new THREE.MeshStandardMaterial({ color: 0x4a5561, metalness: 0.4, roughness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x39424c, metalness: 0.3, roughness: 0.8 });
    const bed = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 2.6), grey);
    bed.castShadow = true;
    this.mesh.add(bed);
    for (const s of [-0.75, 0.75]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 2.6), dark);
      rail.position.set(s, 0.2, 0); rail.castShadow = true;
      this.mesh.add(rail);
    }
    const tongue = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 1.1), dark);
    tongue.position.set(0, -0.05, 1.7);
    this.mesh.add(tongue);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.9 });
    for (const s of [-0.88, 0.88]) {
      const wm = new THREE.Mesh(new THREE.CylinderGeometry(this.wheelRadius, this.wheelRadius, 0.2, 16), wheelMat);
      wm.rotation.z = Math.PI / 2;
      wm.position.set(s, -0.18, -0.45);
      wm.castShadow = true;
      this.mesh.add(wm);
    }

    this.prevPos = new THREE.Vector3(pos[0], pos[1], pos[2]);
    this.currPos = this.prevPos.clone();
    this.prevQuat = new THREE.Quaternion();
    this.currQuat = new THREE.Quaternion();
    this.joint = null;             // set while hitched
  }

  snapshotPrev() { this.prevPos.copy(this.currPos); this.prevQuat.copy(this.currQuat); }
  snapshotCurr() {
    const t = this.body.translation(), r = this.body.rotation();
    this.currPos.set(t.x, t.y, t.z); this.currQuat.set(r.x, r.y, r.z, r.w);
  }
  interpolate(a) {
    this.mesh.position.lerpVectors(this.prevPos, this.currPos, a);
    this.mesh.quaternion.copy(this.prevQuat).slerp(this.currQuat, a);
  }

  fixedUpdate(dt) {
    const body = this.body;
    body.resetForces(false);       // Rapier forces PERSIST — clear last step's or they stack to orbit
    // watchdog: a rare intermittent solver kick can launch the trailer (still
    // hunting the root). If it ever runs away, calmly re-park it instead.
    {
      const tw = body.translation(), vw = body.linvel();
      if (tw.y > 30 || tw.y < -5 || Math.hypot(vw.x, vw.y, vw.z) > 70) {
        if (this.joint) { this.world.removeImpulseJoint(this.joint, true); this.joint = null; }
        body.setTranslation({ x: 8, y: 0.5, z: -8 }, true);
        body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        this.snapshotCurr(); this.snapshotPrev();
      }
    }
    const t = body.translation(), r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _down.set(0, -1, 0).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    const wc = body.worldCom(); _com.set(wc.x, wc.y, wc.z);
    const lv = body.linvel(), av = body.angvel();
    const reach = this.suspRest + this.wheelRadius;
    for (const p of this.points) {
      _wp.set(p.x, p.y, p.z).applyQuaternion(_q).add(_tp.set(t.x, t.y, t.z));
      const ray = new this.RAPIER.Ray(_wp, _down);
      const hit = this.world.castRay(ray, reach, true, undefined, undefined, undefined, body);
      if (!hit) continue;
      const toi = hit.timeOfImpact ?? hit.toi;
      const comp = this.suspRest - Math.max(0, toi - this.wheelRadius);
      _rel.copy(_down).multiplyScalar(toi).add(_wp).sub(_com);
      _cross.set(av.x, av.y, av.z).cross(_rel);
      _vel.set(lv.x + _cross.x, lv.y + _cross.y, lv.z + _cross.z);
      // jockey = a weak little support foot; at a 1.9m lever a full spring kicks
      // the nose over on any bounce
      const stiff = p.wheel ? this.stiff : 4500;
      const damp = p.wheel ? this.damp : 800;
      let load = stiff * comp - damp * _vel.dot(_up);
      if (load < 0) load = 0;
      if (load > (p.wheel ? 6000 : 2200)) load = p.wheel ? 6000 : 2200;   // clamp spikes
      let fLat = 0, fLong = 0;
      // grip capped by the STATIC load share, not the dynamic spike — a load spike
      // feeding the lateral cap was pumping energy in (the trailer hit orbit)
      const statCap = this.grip * (this.mass * 20 / 3);
      if (p.wheel) {
        fLat = Math.max(-statCap, Math.min(statCap, -_vel.dot(_right) * this.mass * 10));
        fLong = -_vel.dot(_fwd) * this.mass * 0.15;        // rolling drag
      } else if (!this.joint) {
        // jockey foot only matters when UNHITCHED (real trailers lift it when towing;
        // leaving it down fights the hitch joint and blows up the solver)
        fLat = Math.max(-statCap, Math.min(statCap, -_vel.dot(_right) * this.mass * 2));
        fLong = Math.max(-statCap, Math.min(statCap, -_vel.dot(_fwd) * this.mass * 2));
      } else {
        continue;                          // hitched → tongue rides on the ball, no foot
      }
      _imp.set(
        _up.x * load + _right.x * fLat + _fwd.x * fLong,
        _up.y * load + _right.y * fLat + _fwd.y * fLong,
        _up.z * load + _right.z * fLat + _fwd.z * fLong
      );
      body.addForceAtPoint(_imp, { x: _wp.x + _down.x * toi, y: _wp.y + _down.y * toi, z: _wp.z + _down.z * toi }, true);
    }
  }

  /** world position of the tongue tip (for hitch proximity + alignment) */
  tongueWorld(out) {
    const t = this.body.translation(), r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    return out.set(this.tongueTip.x, this.tongueTip.y, this.tongueTip.z).applyQuaternion(_q).add(_tp.set(t.x, t.y, t.z));
  }

  /** ball-joint the tongue to the car's rear hitch (teleport-aligns first, no yank) */
  hitchTo(car, RAPIER, world, carHitchLocal) {
    if (this.joint) return true;
    // align: put the tongue tip exactly on the car's hitch, matching the car's yaw
    const cr = car.body.rotation(); _q.set(cr.x, cr.y, cr.z, cr.w);
    const ct = car.body.translation();
    _wp.set(carHitchLocal.x, carHitchLocal.y, carHitchLocal.z).applyQuaternion(_q).add(_tp.set(ct.x, ct.y, ct.z));
    _rel.set(this.tongueTip.x, this.tongueTip.y, this.tongueTip.z).applyQuaternion(_q);
    this.body.setTranslation({ x: _wp.x - _rel.x, y: _wp.y - _rel.y, z: _wp.z - _rel.z }, true);
    this.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.snapshotCurr(); this.snapshotPrev();
    // revolute about Y = yaw-only articulation: swings + jackknifes freely, but
    // can't pitch up and hang off the ball or roll over the hitch (the spherical
    // version dragged around at 70° like a pendulum)
    const jd = RAPIER.JointData.revolute(carHitchLocal, this.tongueTip, { x: 0, y: 1, z: 0 });
    this.joint = world.createImpulseJoint(jd, car.body, this.body, true);
    // keep car↔trailer collision ON while joined: the boxes bumping bounds the
    // jackknife naturally, and unhitching can never happen mid-overlap (which
    // depenetration-launched the trailer into the sky)
    try { this.joint.setContactsEnabled(true); } catch (e) { /* older API */ }
    return true;
  }

  unhitch(world, car) {
    if (!this.joint) return;
    world.removeImpulseJoint(this.joint, true);
    this.joint = null;
    // clean release: the joint lets go in a stressed state, and re-leveling next to
    // the car can overlap boxes (either one = depenetration launch). So park the
    // trailer level, at ride height, 6m out from the CAR along the car→trailer
    // direction — geometrically can never overlap anything attached to the car.
    const t = this.body.translation(), r = this.body.rotation(), v = this.body.linvel();
    const yaw = Math.atan2(2 * (r.x * r.y + r.w * r.z), 1 - 2 * (r.x * r.x + r.y * r.y));
    let px = t.x, pz = t.z;
    if (car) {
      const c = car.body.translation();
      let dx = t.x - c.x, dz = t.z - c.z;
      const d = Math.hypot(dx, dz) || 1;
      px = c.x + (dx / d) * 6; pz = c.z + (dz / d) * 6;
    }
    this.body.setTranslation({ x: px, y: 0.45, z: pz }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: v.x * 0.5, y: 0, z: v.z * 0.5 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.snapshotCurr(); this.snapshotPrev();
  }
}
