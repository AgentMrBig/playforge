import * as THREE from "three";
import { raycast } from "./physics.js";
import { R } from "./phys.js";

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
    phys = null,                    // Physics (Rapier) → real occlusion vs terrain/buildings
    heightAt = null,                // (x,z)=>y terrain height → keep the camera above ground
  } = {}) {
    this.target = target;
    Object.assign(this, {
      distance, minDist, maxDist, height, shoulder,
      minPitch, maxPitch, sensitivity,
      recenterDelay, recenterRate, fov, sprintFov, collisionPad, isSprinting, phys, heightAt,
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
    // in TEST MODE the mouse belongs to the inspector (IK drags/orbit) — consuming it
    // here also spun the player, which made dragged limbs loop in circles (Erik)
    const tm = (typeof window !== "undefined" && window.__pfTest && window.__pfTest.active && !window.__pfTest.livePlay) ? 0 : 1;
    const stick = input.stick("right");
    const lx = (input.pointer.dx * this.sensitivity + stick.x * 3.2 * dt) * tm;
    const ly = (input.pointer.dy * this.sensitivity + stick.y * 2.4 * dt) * tm;
    if (Math.abs(lx) > 1e-5 || Math.abs(ly) > 1e-5) this._idleT = 0;
    else this._idleT += dt;
    this.yaw -= lx;
    this.pitch = THREE.MathUtils.clamp(this.pitch + ly, this.minPitch, this.maxPitch);
    if (input.pointer.wheel)
      this.distance = THREE.MathUtils.clamp(
        this.distance * Math.pow(1.14, input.pointer.wheel), this.minDist, this.maxDist);

    // ---- lazy auto-realign behind movement heading ------------------------
    // ONLY when the player runs AWAY from the camera (forward). Strafing sideways
    // must NOT pull the camera around — with camera-relative movement that creates
    // a feedback loop where "right" keeps redefining itself and the player spirals
    // in a circle (Erik's D-orbit bug). Gate the drift by forward-alignment.
    const body = t.components?.find((c) => c.velocity);
    const vel = body?.velocity ?? ZERO;
    const speed2 = vel.x * vel.x + vel.z * vel.z;
    if (this._idleT > this.recenterDelay && speed2 > 4) {
      const inv = 1 / Math.sqrt(speed2);
      const vdx = vel.x * inv, vdz = vel.z * inv;
      // camera's view direction on the ground plane is -back = (-sinYaw, -cosYaw)
      const fwdAlign = Math.max(0, vdx * -Math.sin(this.yaw) + vdz * -Math.cos(this.yaw));
      if (fwdAlign > 0.15) {
        const heading = Math.atan2(-vel.x, -vel.z); // camera sits opposite travel
        let diff = heading - this.yaw;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // shortest arc
        // drift rate scales with how far off we are AND how forward we're moving —
        // never snaps, always eases, and fades to nothing as motion turns lateral
        const rate = Math.min(Math.abs(diff), 1) * this.recenterRate * fwdAlign;
        this.yaw += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
      }
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

    // ---- occlusion vs the REAL world: cast against the Rapier colliders so terrain,
    // buildings and walls (all trimeshes now) actually push the camera in — the old AABB
    // raycast never saw them, so the camera flew through the map (Erik). Exclude the
    // player's own capsule so the ray doesn't jam on him.
    let free = dist;
    const phys = this.phys || (typeof window !== "undefined" && window.__pf && window.__pf.phys);
    if (R && phys?.world) {
      if (this._excludeCol === undefined) {
        const cb = t.components?.find((c) => c.col && c.velocity && c.onGround !== undefined);
        this._excludeCol = cb?.col ?? null;   // CharacterBody capsule collider
      }
      const ray = this._ray || (this._ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }));
      ray.origin.x = pivot.x; ray.origin.y = pivot.y; ray.origin.z = pivot.z;
      ray.dir.x = back.x; ray.dir.y = back.y; ray.dir.z = back.z;
      const hit = phys.world.castRay(ray, dist + this.collisionPad, true, undefined, undefined, this._excludeCol || undefined);
      if (hit) { const toi = hit.timeOfImpact ?? hit.toi; free = Math.max(toi - this.collisionPad, this.minDist * 0.5); }
    } else {
      const hit = raycast(world, pivot, back, dist + this.collisionPad);   // fallback (pre-physics)
      if (hit && hit.entity !== t) free = Math.max(hit.distance - this.collisionPad, 0.5);
    }
    const k = free < this._curDist ? 1 - Math.exp(-dt * 30)   // wall: snap in
                                   : 1 - Math.exp(-dt * 4);   // clear: ease out
    this._curDist += (free - this._curDist) * k;

    cam.position.copy(pivot).addScaledVector(back, this._curDist);
    // never let the camera dip under the terrain (orbiting low / steep hills)
    if (this.heightAt) {
      const g = this.heightAt(cam.position.x, cam.position.z);
      if (g > -Infinity && cam.position.y < g + 0.4) cam.position.y = g + 0.4;
    }
    cam.lookAt(pivot.x, pivot.y + 0.1, pivot.z);

    // ---- sprint FOV kick --------------------------------------------------
    const wantFov = this.isSprinting?.() ? this.sprintFov : this.fov;
    this._fov += (wantFov - this._fov) * (1 - Math.exp(-dt * 6));
    if (Math.abs(cam.fov - this._fov) > 0.01) { cam.fov = this._fov; cam.updateProjectionMatrix(); }
  }
}

const ZERO = { x: 0, y: 0, z: 0 };
