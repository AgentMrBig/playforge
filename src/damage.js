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
    this.maxDent = maxDent;            // dent-depth unit (scaled by severity)
    this.maxCrush = 0.7;              // m — hard clamp on any vert's total travel (pancake depth)
    this.debounceMs = debounceMs;
    this._sparks = null;
    this._world = null;
    this._lastHit = new WeakMap();     // entity → last-dent timestamp
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._dir = new THREE.Vector3();   // impact dir in mesh-local (own temp)
    this._rel = new THREE.Vector3();   // per-vertex temps (kept off _tmpA/_tmpB)
    this._cur = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    // ---- wreck smoke: world-space puff pool, driven by entity.damage -------
    this.smokeStart = 2.5;             // damage value where wisps begin
    this.smokeFull = 9;                // damage where it's a black wrecked plume
    this._smoke = null;                // THREE.Points pool (additive, fades to 0)
    this._sPos = null; this._sVel = null; this._sCol = null; this._sLife = null; this._sLife0 = null; this._sBase = null;
    this._sNext = 0; this._sCount = 240;
    this._emitAcc = new WeakMap();     // per-car fractional emission accumulator
  }

  init(entity, world) {
    this._world = world;
    this._sparks = new Emitter({
      count: 320, color: 0xffe08a, color2: 0xff5a22, size: 0.11,
      speed: [2, 9], life: [0.12, 0.45], gravity: 15, spread: Math.PI * 0.7,
    });
    entity.add(this._sparks);
    this._buildSmoke(entity);
    // register on the physics contact seam once it exists (Rapier init is async)
    const hook = () => {
      const phys = this._findPhysics(world);
      if (phys?.onContact) phys.onContact((e) => this._onContact(e));
      else setTimeout(hook, 200);
    };
    hook();
  }

  // world-space smoke pool (normal blend, so it can go dark unlike the additive
  // spark Emitter). Added to the system entity's node, which lives at world
  // origin in the scene, so puffs stay where they were emitted (not glued to
  // the car).
  _buildSmoke(entity) {
    const n = this._sCount;
    this._sPos = new Float32Array(n * 3);
    this._sVel = new Float32Array(n * 3);
    this._sCol = new Float32Array(n * 3);
    this._sLife = new Float32Array(n);
    this._sLife0 = new Float32Array(n);
    this._sBase = new Float32Array(n);     // per-puff base grey (faded by life)
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this._sPos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this._sCol, 3));
    // additive so faded/dead puffs (colour → 0) vanish cleanly, like the spark
    // Emitter. Wreck severity reads through DENSITY + size, not darkness.
    this._smoke = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.9, vertexColors: true, transparent: true, opacity: 0.6,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }));
    this._smoke.frustumCulled = false;
    geo.setDrawRange(0, 0);
    entity.object3d.add(this._smoke);
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
    // severity scales with REAL contact force, UNCAPPED at 1 — a fender tap is
    // ~0.3, a full-speed wreck ~1.5, a semi flattening a sedan 3+. That number
    // drives dent depth, whole-body crush, sparks, smoke, and the damage tally,
    // so "total destruction" is just a big force delivering a big severity.
    const severity = (force - this.hitForce) / (1200 * 12);
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

      // deformation is expressed as a FRACTION of each panel's own size (car
      // meshes live in big FBX-native local units, not meters) — dentFrac folds
      // the struck side, crush caves + flattens the whole shell. Both scale with
      // severity: a tap ≈ 4% dent, a full wreck ≈ 16%, a semi pancakes it.
      const dentFrac = Math.min(0.24, 0.03 + 0.13 * severity);
      const crush = Math.min(0.55, severity * 0.22);
      this._dentCar(me, dir, dentFrac, crush);

      // sparks at the struck side of the car
      const pt = this._tmpB.copy(me.position).addScaledVector(dir, 0.9);
      pt.y += 0.55;
      this._sparks?.burst(Math.round(12 + Math.min(2, severity) * 60), pt);

      me.damage = (me.damage ?? 0) + severity;
      me.onCarHit?.(severity, dir.clone());
    }
  }

  // ---- per-frame: emit wreck smoke from damaged cars + advance the pool ----
  update(dt) {
    if (!this._smoke || !this._world) return;
    for (const e of this._world.entities) {
      if (!this._carVehicle(e) || !e.damage || e.damage < this.smokeStart) continue;
      // 0..1 severity across the smoke band → emission rate + darkness
      const sev = Math.min(1, (e.damage - this.smokeStart) / (this.smokeFull - this.smokeStart));
      const rate = 6 + sev * 34;                        // puffs/sec
      let acc = (this._emitAcc.get(e) ?? 0) + rate * dt;
      const yaw = e.rotation.y;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);     // car forward = engine bay
      while (acc >= 1) { acc -= 1; this._spawnPuff(e, fx, fz, sev); }
      this._emitAcc.set(e, acc);
    }
    this._stepSmoke(dt);
  }

  _spawnPuff(car, fx, fz, sev) {
    const i = this._sNext; this._sNext = (this._sNext + 1) % this._sCount;
    const p = car.position;
    this._sPos[i*3]   = p.x + fx * 1.35 + (Math.random() - 0.5) * 0.4;
    this._sPos[i*3+1] = p.y + 0.7 + Math.random() * 0.2;
    this._sPos[i*3+2] = p.z + fz * 1.35 + (Math.random() - 0.5) * 0.4;
    this._sVel[i*3]   = (Math.random() - 0.5) * 0.5;
    this._sVel[i*3+1] = 1.2 + Math.random() * 0.9;      // rise
    this._sVel[i*3+2] = (Math.random() - 0.5) * 0.5;
    // sootier (lower base) when lightly hurt, thicker/brighter smoke when wrecked
    // — density does most of the "wrecked" work; base grey adds body
    this._sBase[i] = 0.28 + sev * 0.22;
    this._sLife[i] = this._sLife0[i] = 1.1 + Math.random() * 1.3 + sev * 0.8;
  }

  _stepSmoke(dt) {
    const P = this._sPos, V = this._sVel, C = this._sCol, L = this._sLife, L0 = this._sLife0, B = this._sBase;
    let maxAlive = 0;
    for (let i = 0; i < this._sCount; i++) {
      if (L[i] <= 0) { C[i*3] = C[i*3+1] = C[i*3+2] = 0; continue; }
      L[i] -= dt;
      V[i*3+1] += 0.4 * dt;                             // buoyant lift
      V[i*3] *= 0.98; V[i*3+2] *= 0.98;
      P[i*3] += V[i*3] * dt; P[i*3+1] += V[i*3+1] * dt; P[i*3+2] += V[i*3+2] * dt;
      // fade in fast, out slow: brightness peaks early then dissolves to 0
      const t = Math.max(L[i], 0) / L0[i];              // 1 (new) → 0 (dead)
      const c = B[i] * Math.min(1, t * 3) * t;          // additive → clean vanish
      C[i*3] = C[i*3+1] = C[i*3+2] = c;
      maxAlive = i + 1;
    }
    const geo = this._smoke.geometry;
    geo.setDrawRange(0, maxAlive);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  /** deform a car: `dentFrac` (0..1 of panel size) crumples the struck side,
   *  `crush` (0..1) caves the WHOLE shell inward + flattens it (semi pancakes). */
  _dentCar(entity, dirWorld, dentFrac, crush) {
    entity.object3d?.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      if (/wheel|tire|tyre|rim|glass|window/i.test(o.name)) return;  // skip spinners + glass
      this._dentMesh(o, dirWorld, dentFrac, crush);
    });
  }

  _dentMesh(mesh, dirWorld, dentFrac, crush) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const ud = mesh.userData;
    if (!ud._orig) {                                   // cache rest shape + size once
      ud._orig = new Float32Array(pos.array);
      geo.computeBoundingBox();
      ud._ctr = geo.boundingBox.getCenter(new THREE.Vector3());
      ud._span = geo.boundingBox.getSize(new THREE.Vector3()).length() || 1;  // local-unit diagonal
    }
    // impact direction in the mesh's LOCAL frame (geometry space)
    mesh.getWorldQuaternion(this._q);
    const local = this._dir.copy(dirWorld).applyQuaternion(this._q.invert()).normalize();
    // dent + clamp in this panel's OWN units (fraction of its size)
    const dent = ud._span * dentFrac, maxD = ud._span * 0.5;
    const ctr = ud._ctr, orig = ud._orig;
    const rel = this._rel, cur = this._cur;
    let touched = false;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      rel.set(px - ctr.x, py - ctr.y, pz - ctr.z);
      const r = rel.length() || 1e-4;
      const facing = (rel.x * local.x + rel.y * local.y + rel.z * local.z) / r;
      let nx = px, ny = py, nz = pz;
      // 1) directional dent — the struck side folds inward
      if (facing > 0.15) {
        nx -= local.x * dent * facing;
        ny -= local.y * dent * facing;
        nz -= local.z * dent * facing;
      }
      // 2) whole-body crush — every vert caves toward the body center and
      // collapses vertically, so a big enough hit flattens the car (pancake).
      // rel is re-read each hit, so this converges toward center, never past.
      if (crush > 0) {
        nx -= rel.x * crush * 0.5;
        nz -= rel.z * crush * 0.5;
        ny -= rel.y * crush * 0.9;
      }
      cur.set(nx, ny, nz);
      // clamp each vert's TOTAL travel from rest (deep, for real destruction)
      const dx = cur.x - orig[i * 3], dy = cur.y - orig[i * 3 + 1], dz = cur.z - orig[i * 3 + 2];
      const d = Math.hypot(dx, dy, dz);
      if (d > maxD) { const k = maxD / d; cur.set(orig[i * 3] + dx * k, orig[i * 3 + 1] + dy * k, orig[i * 3 + 2] + dz * k); }
      if (d > 1e-4) { pos.setXYZ(i, cur.x, cur.y, cur.z); touched = true; }
    }
    if (touched) { pos.needsUpdate = true; geo.computeVertexNormals(); }
  }
}
