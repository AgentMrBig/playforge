import * as THREE from "three";
import { raycast } from "./physics.js";

/**
 * ThirdPersonRig — the GTA-style third-person camera.
 *
 *   world.spawn("camera").add(new ThirdPersonRig(player));
 *
 * Behaviors (each one is a big part of the "AAA feel"):
 *  - free-look orbit (pointer-lock mouse / touch right-stick), scroll zoom
 *  - lazy auto-realign: idle mouse + moving player → camera drifts behind
 *    the movement heading; it never snaps and any mouse input cancels it
 *  - occlusion: ray from pivot to camera against physics Colliders — walls
 *    pull the camera in FAST, it releases back out SLOW
 *  - split smoothing: horizontal follow tight, vertical lazy (jumping doesn't
 *    bounce the camera; landing catches up gently)
 *  - pitch framing: looking up shortens the boom slightly (over-shoulder),
 *    looking down extends a touch (GTA overhead readability)
 *  - sprint FOV kick: pass `isSprinting` to get the subtle speed widening
 */
export class ThirdPersonRig {
  constructor(target, {
    distance = 6.5, minDist = 2.2, maxDist = 14,
    height = 1.55,                  // pivot above target origin (head-ish)
    shoulder = 0.55,                // sideways offset (0 = centered)
    pitch = 0.18, minPitch = -1.2, maxPitch = 1.35,
    sensitivity = 0.0026,
    recenterDelay = 1.2,            // idle seconds before drift-behind kicks in
    recenterRate = 1.6,             // rad/s max drift speed
    fov = 70, sprintFov = 78,
    collisionPad = 0.35,
    isSprinting = null,             // optional fn() → bool
  } = {}) {
    this.target = target;
    Object.assign(this, {
      distance, minDist, maxDist, height, shoulder,
      minPitch, maxPitch, sensitivity,
      recenterDelay, recenterRate, fov, sprintFov, collisionPad, isSprinting,
    });
    this.yaw = target ? target.rotation.y + Math.PI : 0;
    this.pitch = pitch;
    this._idleT = 0;
    this._curDist = distance;       // occlusion-smoothed boom length
    this._pivot = null;             // split-smoothed pivot
    this._fov = fov;
  }

  update(dt, { world, input }) {
    const cam = world.camera;
    const t = this.target;
    if (!t) return;

    // ---- look input (mouse under pointer lock, or touch right stick) ------
    const stick = input.stick("right");
    const lx = input.pointer.dx * this.sensitivity + stick.x * 3.2 * dt;
    const ly = input.pointer.dy * this.sensitivity + stick.y * 2.4 * dt;
    if (Math.abs(lx) > 1e-5 || Math.abs(ly) > 1e-5) this._idleT = 0;
    else this._idleT += dt;
    this.yaw -= lx;
    this.pitch = THREE.MathUtils.clamp(this.pitch + ly, this.minPitch, this.maxPitch);
    if (input.pointer.wheel)
      this.distance = THREE.MathUtils.clamp(
        this.distance * Math.pow(1.14, input.pointer.wheel), this.minDist, this.maxDist);

    // ---- lazy auto-realign behind movement heading ------------------------
    const body = t.components?.find((c) => c.velocity);
    const vel = body?.velocity ?? ZERO;
    const speed2 = vel.x * vel.x + vel.z * vel.z;
    if (this._idleT > this.recenterDelay && speed2 > 4) {
      const heading = Math.atan2(-vel.x, -vel.z); // camera sits opposite travel
      let diff = heading - this.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // shortest arc
      // drift rate scales with how far off we are — never snaps, always eases
      const rate = Math.min(Math.abs(diff), 1) * this.recenterRate;
      this.yaw += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
    }

    // ---- split-smoothed pivot (tight XZ, lazy Y) --------------------------
    const want = new THREE.Vector3(t.position.x, t.position.y + this.height, t.position.z);
    if (!this._pivot) this._pivot = want.clone();
    const kxz = 1 - Math.exp(-dt * 16);
    const ky = 1 - Math.exp(-dt * (body?.onGround ? 10 : 3.5)); // airborne = lazy Y
    this._pivot.x += (want.x - this._pivot.x) * kxz;
    this._pivot.z += (want.z - this._pivot.z) * kxz;
    this._pivot.y += (want.y - this._pivot.y) * ky;

    // ---- desired boom from yaw/pitch, with pitch framing ------------------
    const frame = 1 - 0.28 * Math.max(0, Math.sin(this.pitch));  // look up → closer
    const dist = this.distance * (frame + 0.12 * Math.max(0, -Math.sin(this.pitch)));
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const back = new THREE.Vector3(Math.sin(this.yaw) * cp, sp, Math.cos(this.yaw) * cp);
    const side = new THREE.Vector3(back.z, 0, -back.x).normalize().multiplyScalar(this.shoulder);
    const pivot = this._pivot.clone().add(side);

    // ---- occlusion: pull in fast, ease out slow ---------------------------
    let free = dist;
    const hit = raycast(world, pivot, back, dist + this.collisionPad);
    if (hit && hit.entity !== t) free = Math.max(hit.distance - this.collisionPad, 0.5);
    const k = free < this._curDist ? 1 - Math.exp(-dt * 30)   // wall: snap in
                                   : 1 - Math.exp(-dt * 4);   // clear: ease out
    this._curDist += (free - this._curDist) * k;

    cam.position.copy(pivot).addScaledVector(back, this._curDist);
    cam.lookAt(pivot.x, pivot.y + 0.1, pivot.z);

    // ---- sprint FOV kick --------------------------------------------------
    const wantFov = this.isSprinting?.() ? this.sprintFov : this.fov;
    this._fov += (wantFov - this._fov) * (1 - Math.exp(-dt * 6));
    if (Math.abs(cam.fov - this._fov) > 0.01) { cam.fov = this._fov; cam.updateProjectionMatrix(); }
  }
}

const ZERO = { x: 0, y: 0, z: 0 };
