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
const _imp = new THREE.Vector3();      // impulse to apply
const _tpos = new THREE.Vector3();     // chassis translation
const _q = new THREE.Quaternion();
export class Car {
  constructor(world, RAPIER, {
    pos = [0, 3, 0],
    size = [1.9, 1.0, 4.4],   // full W,H,L in meters (sedan-ish)
    mass = 1200,              // kg
    linDamp = 0.05,
    angDamp = 0.4,
    restitution = 0.2,
    friction = 0.9,
    // suspension tuning (per wheel)
    wheelRadius = 0.35,
    suspRest = 0.5,        // rest length of the spring (m)
    suspStiff = 30000,     // N/m  — ~0.2m sag under 300kg/corner at g=20
    suspDamp = 4000,       // N per (m/s)
    suspTravel = 0.35,     // max compression past rest before bottoming
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

    // ---- chassis: plain dynamic rigid body ------------------------------
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos[0], pos[1], pos[2])
      .setLinearDamping(linDamp)
      .setAngularDamping(angDamp)
      .setCanSleep(false);              // never sleep — we drive it every step
    this.body = world.createRigidBody(bodyDesc);

    const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
    const colDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setMass(mass)                    // real mass → Rapier derives the inertia tensor
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

    // ---- wheels: 4 corner mounts (local space) + cylinder visuals -------
    // mount slightly inboard of the shell and near its floor; +Z forward.
    const mx = hx - 0.15, mz = hz - 0.55, my = -hy + 0.15;
    this.wheels = [
      { name: "FL", mount: new THREE.Vector3(-mx, my, mz), grounded: false, dist: suspRest, comp: 0 },
      { name: "FR", mount: new THREE.Vector3(mx, my, mz), grounded: false, dist: suspRest, comp: 0 },
      { name: "RL", mount: new THREE.Vector3(-mx, my, -mz), grounded: false, dist: suspRest, comp: 0 },
      { name: "RR", mount: new THREE.Vector3(mx, my, -mz), grounded: false, dist: suspRest, comp: 0 },
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
    const t = body.translation();
    const r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _down.set(0, -1, 0).applyQuaternion(_q);

    // world center of mass + angular velocity for velocity-at-point
    const wc = body.worldCom();  _com.set(wc.x, wc.y, wc.z);
    const lv = body.linvel();
    const av = body.angvel();

    const reach = this.suspRest + this.wheelRadius;   // ray length: rest + tyre
    for (const w of this.wheels) {
      // mount in world space = chassis pos + rotated local mount
      _wpos.copy(w.mount).applyQuaternion(_q).add(_tpos.set(t.x, t.y, t.z));
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
        let force = this.suspStiff * w.comp - this.suspDamp * springVel;
        if (force < 0) force = 0;
        w.force = force;

        // integrated force (not a discrete impulse) → gravity/spring balance cleanly
        _imp.copy(_up).multiplyScalar(force);
        body.addForceAtPoint(_imp, { x: _wpos.x + _down.x * toi, y: _wpos.y + _down.y * toi, z: _wpos.z + _down.z * toi }, true);
      } else {
        w.grounded = false;
        w.dist = this.suspRest;                                 // droop to full extension
        w.comp = 0;
      }
    }
    this._placeWheels();
  }

  /** position wheel visuals along their travel (local space, no jitter) */
  _placeWheels() {
    for (const w of this.wheels) {
      w.mesh.position.set(w.mount.x, w.mount.y - w.dist, w.mount.z);
    }
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
