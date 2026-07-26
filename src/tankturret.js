import * as THREE from "three";

/**
 * TankTurret — War Thunder–style gun aim: world-space yaw/pitch from the mouse.
 * Hull can turn underneath; the gun holds its world aim until the player moves it.
 *
 *   turret.update(dt, { yaw, pitch, aimDir });
 *   turret.fire(aimDir);
 */
const _tq = new THREE.Quaternion();
const _tq2 = new THREE.Quaternion();
const _tv = new THREE.Vector3();
const _tv2 = new THREE.Vector3();
const _aim = new THREE.Vector3();

function aimBone(bone, bindWorld, deltaQ) {
  bone.parent.updateWorldMatrix(true, false);
  const pq = bone.parent.getWorldQuaternion(_tq2);
  _tq.copy(deltaQ).multiply(bindWorld);
  bone.quaternion.copy(pq.invert().multiply(_tq));
}

export class TankTurret {
  constructor(tank, {
    world, RAPIER, scene, camera,
    crates = [],
    onShake = null,
    onFlash = null,
    reload = 1.1,
    muzzleLocal = [0, 1.6, 3.4],
    shellSpeed = 120,
    shellRadius = 0.28,
    shellMass = 900,
    recoil = 9000,
    blastRadius = 5,
  } = {}) {
    this.tank = tank;
    this.world = world;
    this.RAPIER = RAPIER;
    this.scene = scene;
    this.camera = camera;
    this.crates = crates;
    this.onShake = onShake;
    this.onFlash = onFlash;
    Object.assign(this, { reload, muzzleLocal, shellSpeed, shellRadius, shellMass, recoil, blastRadius });
    this.ready = false;
    this.yaw = 0;           // body-local (smoothed)
    this.pitch = 0;
    this.worldYaw = 0;      // last commanded world aim
    this.worldPitch = 0;
    this.cd = 0;
    this._shell = null;
    this._shellMesh = null;
    this._shellSpd = null;
    this._shellAge = 0;
    this.bursts = [];
  }

  setup() {
    const tb = this.tank.turretBone;
    const bb = this.tank.barrelBone;
    if (!tb) return false;
    this.tank.mesh.updateWorldMatrix(true, true);
    this.tbone = tb;
    this.bbone = bb || null;
    this.tBindWorld = tb.getWorldQuaternion(new THREE.Quaternion());
    this.bBindWorld = bb ? bb.getWorldQuaternion(new THREE.Quaternion()) : null;
    this.ready = true;
    return true;
  }

  get cooling() { return this.cd > 0; }

  /**
   * @param {number} dt
   * @param {{ yaw: number, pitch: number, aimDir?: THREE.Vector3 }} worldAim
   *   yaw/pitch = world-space gun aim (radians). aimDir optional unit vector.
   */
  update(dt, worldAim = null) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life -= dt;
      b.mesh.scale.multiplyScalar(1 + 6 * dt);
      b.mesh.material.opacity = Math.max(0, b.life / b.max);
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mesh.material.dispose();
        this.bursts.splice(i, 1);
      }
    }

    if (this._shell) {
      const sv = this._shell.linvel();
      const spd = Math.hypot(sv.x, sv.y, sv.z);
      const st = this._shell.translation();
      this._shellSpd = this._shellSpd ?? spd;
      this._shellAge += dt;
      if (this._shellMesh) this._shellMesh.position.set(st.x, st.y, st.z);
      let near = st.y < 0.4;
      for (const c of this.crates) {
        const p = c.body.translation();
        if (Math.hypot(p.x - st.x, p.y - st.y, p.z - st.z) < 3.2) { near = true; break; }
      }
      if (near || spd < this._shellSpd * 0.66 || spd < 15 || this._shellAge > 2.5) {
        this._explode(st);
        this._clearShell();
      } else {
        this._shellSpd = Math.max(this._shellSpd, spd);
      }
    }

    if (!this.ready) return;
    if (this.cd > 0) this.cd = Math.max(0, this.cd - dt);

    // World aim → body-local. When the hull yaws under a fixed world aim, local
    // yaw changes so the gun stays pointed the same way in the world (WT feel).
    if (worldAim) {
      this.worldYaw = worldAim.yaw;
      this.worldPitch = worldAim.pitch;
      if (worldAim.aimDir) _tv.copy(worldAim.aimDir);
      else {
        const cp = Math.cos(worldAim.pitch);
        _tv.set(Math.sin(worldAim.yaw) * cp, Math.sin(worldAim.pitch), Math.cos(worldAim.yaw) * cp);
      }
    } else {
      this.camera.getWorldDirection(_tv);
    }
    const cr = this.tank.body.rotation();
    _tq2.set(cr.x, cr.y, cr.z, cr.w).invert();
    _tv2.copy(_tv).applyQuaternion(_tq2);
    const wantYaw = Math.atan2(_tv2.x, _tv2.z);
    const wantPitch = Math.max(-0.12, Math.min(0.35, Math.asin(Math.max(-1, Math.min(1, _tv2.y)))));
    this.yaw += (wantYaw - this.yaw) * Math.min(1, 8 * dt);
    this.pitch += (wantPitch - this.pitch) * Math.min(1, 8 * dt);

    _tv.set(0, 1, 0);
    aimBone(this.tbone, this.tBindWorld, new THREE.Quaternion().setFromAxisAngle(_tv, this.yaw));
    if (this.bbone && this.bBindWorld) {
      const yawQ = new THREE.Quaternion().setFromAxisAngle(_tv2.set(0, 1, 0), this.yaw);
      _tv.set(1, 0, 0).applyQuaternion(yawQ);
      aimBone(this.bbone, this.bBindWorld,
        new THREE.Quaternion().setFromAxisAngle(_tv, -this.pitch).multiply(yawQ));
    }
  }

  /** Fire along world aimDir (falls back to last world aim / camera). */
  fire(aimDir = null) {
    if (!this.ready || this.cd > 0) return false;
    this.cd = this.reload;
    if (aimDir) _aim.copy(aimDir).normalize();
    else {
      const cp = Math.cos(this.worldPitch);
      _aim.set(Math.sin(this.worldYaw) * cp, Math.sin(this.worldPitch), Math.cos(this.worldYaw) * cp);
    }
    const ct = this.tank.body.translation();
    const cr = this.tank.body.rotation();
    const [mx, my, mz] = this.muzzleLocal;
    const muzzle = _tv.set(mx, my, mz)
      .applyQuaternion(_tq.set(cr.x, cr.y, cr.z, cr.w))
      .add(_tv2.set(ct.x, ct.y, ct.z))
      .clone();
    muzzle.addScaledVector(_aim, 1.4);

    const r = this.shellRadius;
    const mass = this.shellMass;
    const sp = this.shellSpeed;
    const bd = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(muzzle.x, muzzle.y, muzzle.z)
      .setLinvel(_aim.x * sp, _aim.y * sp, _aim.z * sp)
      .setCcdEnabled(true);
    const body = this.world.createRigidBody(bd);
    const density = mass / ((4 / 3) * Math.PI * r * r * r);
    this.world.createCollider(
      this.RAPIER.ColliderDesc.ball(r).setDensity(density).setFriction(0.4).setRestitution(0.1)
        .setCollisionGroups((0x0008 << 16) | 0xffff), body);

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(r, 14, 10),
      new THREE.MeshStandardMaterial({
        color: 0x222222, metalness: 0.7, roughness: 0.4, emissive: 0x331100,
      }));
    mesh.castShadow = true;
    mesh.position.copy(muzzle);
    this.scene.add(mesh);

    this._shell = body;
    this._shellMesh = mesh;
    this._shellSpd = sp;
    this._shellAge = 0;

    this.tank.body.applyImpulse(
      { x: -_aim.x * this.recoil, y: 0, z: -_aim.z * this.recoil }, true);
    this._flash(muzzle, 0.55);
    if (this.onShake) this.onShake(0.6);
    if (this.onFlash) this.onFlash(muzzle);
    return true;
  }

  _explode(st) {
    const p = { x: st.x, y: st.y, z: st.z };
    this._flash(p, 1.1);
    if (this.onShake) this.onShake(0.5);
    if (this.onFlash) this.onFlash(p);
    for (const c of this.crates) {
      const at = c.body.translation();
      const d = Math.hypot(at.x - p.x, at.y - p.y, at.z - p.z);
      if (d >= this.blastRadius || d < 1e-3) continue;
      const falloff = 1 - d / this.blastRadius;
      const impulse = 4200 * falloff;
      c.body.applyImpulse({
        x: ((at.x - p.x) / d) * impulse,
        y: 0.4 * impulse,
        z: ((at.z - p.z) / d) * impulse,
      }, true);
    }
  }

  _flash(point, size = 0.6) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0xffaa44, transparent: true, opacity: 0.9, depthWrite: false,
      }));
    mesh.position.set(point.x, point.y, point.z);
    this.scene.add(mesh);
    this.bursts.push({ mesh, life: 0.22, max: 0.22 });
  }

  _clearShell() {
    if (this._shell) {
      this.world.removeRigidBody(this._shell);
      this._shell = null;
    }
    if (this._shellMesh) {
      this.scene.remove(this._shellMesh);
      this._shellMesh.geometry.dispose();
      this._shellMesh.material.dispose();
      this._shellMesh = null;
    }
    this._shellSpd = null;
    this._shellAge = 0;
  }
}
