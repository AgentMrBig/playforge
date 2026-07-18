import * as THREE from "three";
import { Physics } from "./phys.js";
import { Emitter } from "./particles.js";

/**
 * CarCollisions — Ember's damage lane, rebuilt onto Rapier (2026-07-18).
 *
 *   world.spawn("carCollisions").add(new CarCollisions({ audio }));
 *
 * The physical response (shove, spin, tumble) now belongs to Rapier — a car
 * hitting anything is real rigid-body dynamics in phys.js. So this system no
 * longer applies any forces (the old impulse loop DOUBLE-hit the Rapier body
 * and fought it). It is purely VISUAL + state:
 *
 *   - hooks Ninja's `phys.onContact` seam (the one built for this lane),
 *   - on a hard hit, DENTS the car's body panels toward the impact — permanent,
 *     accumulating, BeamNG-lite / NFS2-flavored crumple (no re-modeling: we push
 *     the existing body verts inward on the struck side and clamp the depth),
 *   - throws a spark burst at the contact side,
 *   - accumulates `entity.damage` and fires `entity.onCarHit(strength, dir)`.
 *
 * Audio stays in Ninja's onContact handler (crash pools) — this adds no sound,
 * so hits aren't doubled up. Wheels are never dented (they spin).
 */
export class CarCollisions {
  constructor({
    audio = null,            // kept for signature compat; audio lives in phys.onContact
    hitForce = 1200 * 8,     // contact force (N) before a hit counts as damage
    maxDent = 0.13,          // m — deepest a panel vert can be pushed from rest
    debounceMs = 110,        // per-car spacing so one contact ≠ instant crater
  } = {}) {
    this.hitForce = hitForce;
    this.maxDent = maxDent;
    this.debounceMs = debounceMs;
    this._sparks = null;
    this._world = null;
    this._lastHit = new WeakMap();     // entity → last-dent timestamp
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  init(entity, world) {
    this._world = world;
    this._sparks = new Emitter({
      count: 320, color: 0xffe08a, color2: 0xff5a22, size: 0.11,
      speed: [2, 9], life: [0.12, 0.45], gravity: 15, spread: Math.PI * 0.7,
    });
    entity.add(this._sparks);
    // register on the physics contact seam once it exists (Rapier init is async)
    const hook = () => {
      const phys = this._findPhysics(world);
      if (phys?.onContact) phys.onContact((e) => this._onContact(e));
      else setTimeout(hook, 200);
    };
    hook();
  }

  _findPhysics(world) {
    for (const e of world.entities)
      for (const c of e.components) if (c instanceof Physics) return c;
    return null;
  }

  /** the vehicle component on an entity (has a Rapier rigid body `rb`) */
  _carVehicle(e) { return e?.components?.find((c) => c.rb); }

  _onContact({ entityA, entityB, force }) {
    if (force < this.hitForce) return;
    const now = performance.now();
    // strength 0..1 above threshold (14× mass ≈ a big wreck)
    const strength = Math.min(1, (force - this.hitForce) / (1200 * 14));
    for (const [me, other] of [[entityA, entityB], [entityB, entityA]]) {
      const vb = this._carVehicle(me);
      if (!vb) continue;
      const last = this._lastHit.get(me) ?? 0;
      if (now - last < this.debounceMs) continue;
      this._lastHit.set(me, now);

      // world-space impact direction (from the car toward what it struck).
      // Prefer the other body's position; fall back to the car's travel dir
      // (drove into static geometry → the leading face crumples).
      const dir = this._tmpA;
      if (other?.position && (other.position.x || other.position.z)) {
        dir.copy(other.position).sub(me.position);
      } else if (vb.rb) {
        const lv = vb.rb.linvel(); dir.set(lv.x, 0, lv.z);
      } else dir.set(0, 0, 1);
      if (dir.lengthSq() < 1e-6) continue;
      dir.normalize();

      const amount = this.maxDent * (0.35 + 0.65 * strength);
      this._dentCar(me, dir, amount);

      // sparks at the struck side of the car
      const pt = this._tmpB.copy(me.position).addScaledVector(dir, 0.9);
      pt.y += 0.55;
      this._sparks?.burst(Math.round(12 + strength * 70), pt);

      me.damage = (me.damage ?? 0) + strength;
      me.onCarHit?.(strength, dir.clone());
    }
  }

  /** dent every body panel of a car toward `dirWorld` by up to `amount` (m). */
  _dentCar(entity, dirWorld, amount) {
    entity.object3d?.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      if (/wheel|tire|tyre|rim|glass|window/i.test(o.name)) return;  // skip spinners + glass
      this._dentMesh(o, dirWorld, amount);
    });
  }

  _dentMesh(mesh, dirWorld, amount) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const ud = mesh.userData;
    if (!ud._orig) {                                   // cache rest shape once
      ud._orig = new Float32Array(pos.array);
      geo.computeBoundingBox();
      ud._ctr = geo.boundingBox.getCenter(new THREE.Vector3());
    }
    // impact direction in the mesh's LOCAL frame (geometry space)
    mesh.getWorldQuaternion(this._q);
    const local = dirWorld.clone().applyQuaternion(this._q.invert()).normalize();
    const ctr = ud._ctr, orig = ud._orig, max = this.maxDent;
    const rel = this._tmpA, cur = this._tmpB;
    let touched = false;
    for (let i = 0; i < pos.count; i++) {
      rel.set(pos.getX(i) - ctr.x, pos.getY(i) - ctr.y, pos.getZ(i) - ctr.z);
      const r = rel.length() || 1e-4;
      const facing = (rel.x * local.x + rel.y * local.y + rel.z * local.z) / r;
      if (facing <= 0.15) continue;                    // only the struck side
      // push this vert inward (−local), scaled by how squarely it faces the hit
      cur.set(pos.getX(i) - local.x * amount * facing,
              pos.getY(i) - local.y * amount * facing,
              pos.getZ(i) - local.z * amount * facing);
      // clamp cumulative displacement from the rest position
      const dx = cur.x - orig[i * 3], dy = cur.y - orig[i * 3 + 1], dz = cur.z - orig[i * 3 + 2];
      const d = Math.hypot(dx, dy, dz);
      if (d > max) { const k = max / d; cur.set(orig[i * 3] + dx * k, orig[i * 3 + 1] + dy * k, orig[i * 3 + 2] + dz * k); }
      pos.setXYZ(i, cur.x, cur.y, cur.z);
      touched = true;
    }
    if (touched) { pos.needsUpdate = true; geo.computeVertexNormals(); }
  }
}
