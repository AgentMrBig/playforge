import * as THREE from "three";

/**
 * OrbitRig — SketchUp-style camera (the scheme proven in CabForge's 3D view):
 * middle/left-drag orbit, right-drag pan, scroll zoom, smoothed motion.
 * Attach as a component on any entity; it drives world.camera.
 *
 *   world.spawn("camera").add(new OrbitRig({ target: [0, 1, 0], distance: 12 }));
 */
export class OrbitRig {
  // pitch > 0 = camera above the target looking down (0.5 ≈ comfortable iso)
  constructor({ target = [0, 0, 0], distance = 10, yaw = -Math.PI / 4, pitch = 0.5, minDist = 2, maxDist = 200 } = {}) {
    this.target = new THREE.Vector3(...target);
    this.distance = distance;
    this.yaw = yaw; this.pitch = pitch;
    this.minDist = minDist; this.maxDist = maxDist;
    // smoothed followers
    this._t = this.target.clone();
    this._d = distance; this._yaw = yaw; this._pitch = pitch;
  }

  update(dt, { world, input }) {
    const p = input.pointer;
    if (p.down || input.down("Mouse1")) {          // orbit
      this.yaw -= p.dx * 0.005;
      this.pitch = THREE.MathUtils.clamp(this.pitch + p.dy * 0.005, -1.45, 1.45);
    }
    if (p.rightDown) {                              // pan in view plane
      const cam = world.camera;
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
      const k = this.distance * 0.0016;
      this.target.addScaledVector(right, -p.dx * k).addScaledVector(up, p.dy * k);
    }
    if (p.wheel) this.distance = THREE.MathUtils.clamp(this.distance * Math.pow(1.12, p.wheel), this.minDist, this.maxDist);

    // exponential smoothing — the buttery feel
    const k = 1 - Math.exp(-dt * 14);
    this._yaw += (this.yaw - this._yaw) * k;
    this._pitch += (this.pitch - this._pitch) * k;
    this._d += (this.distance - this._d) * k;
    this._t.lerp(this.target, k);

    const cp = Math.cos(this._pitch), sp = Math.sin(this._pitch);
    const cam = world.camera;
    cam.position.set(
      this._t.x + Math.cos(this._yaw) * cp * this._d,
      this._t.y + sp * this._d,
      this._t.z + Math.sin(this._yaw) * cp * this._d,
    );
    cam.lookAt(this._t);
  }
}

/**
 * FollowRig — third-person chase camera: follows a target entity from behind
 * at a set distance/height with smoothing. For player-controlled games.
 */
export class FollowRig {
  constructor(targetEntity, { distance = 8, height = 4, stiffness = 8 } = {}) {
    this.targetEntity = targetEntity;
    this.distance = distance; this.height = height; this.stiffness = stiffness;
    this._pos = null;
  }
  update(dt, { world }) {
    const tp = this.targetEntity.position;
    const yaw = this.targetEntity.rotation.y;
    const want = new THREE.Vector3(
      tp.x - Math.sin(yaw) * -this.distance,
      tp.y + this.height,
      tp.z - Math.cos(yaw) * -this.distance,
    );
    if (!this._pos) this._pos = want.clone();
    this._pos.lerp(want, 1 - Math.exp(-dt * this.stiffness));
    world.camera.position.copy(this._pos);
    world.camera.lookAt(tp.x, tp.y + 1, tp.z);
  }
}
