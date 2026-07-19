import * as THREE from "three";
import { Physics, CharacterBody } from "./phys.js";
import { VehicleBody } from "./vehicle.js";
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
    this._rel = new THREE.Vector3();   // spark point temp (kept off _tmpA/_tmpB)
    this._cur = new THREE.Vector3();   // inward-normal dot-check temp
    this._lp = new THREE.Vector3();    // contact point in mesh-local
    this._ld = new THREE.Vector3();    // crumple dir in mesh-local
    this._scaleV = new THREE.Vector3();
    this._wpos = new THREE.Vector3();  // wheel world pos temp
    this._q = new THREE.Quaternion();
    // ---- wheel wrecking: a hit landing on a wheel damages it; once wrecked it
    // LOCKS (drags, no spin) via Ninja's live vb.setWheelLocked (no fake floppy
    // wheel — a destroyed wheel just stops rolling). Erik's spec.
    this.wheelLockAt = 3.2;            // accumulated per-wheel damage to lock it
    this.wheelDetachAt = 8;            // ...and to knock it clean off the car
    this.wheelHitRadius = 1.1;         // m — contact within this of a wheel counts
    this._wheelDmg = new WeakMap();    // car entity → [fl,fr,rl,rr] damage
    // ---- wreck smoke: world-space puff pool, driven by entity.damage -------
    // Only a genuinely beat-up car smokes — a light tap (severity ~0.2-0.5) must
    // NOT start it (Erik: "smoke shouldn't start until the car has taken some
    // damage"). Needs several solid hits or one real wreck to cross smokeStart.
    this.smokeStart = 9;               // damage value where the first wisps begin
    this.smokeFull = 28;               // damage where it's a black wrecked plume
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
    // expose the shot handler so the combat lane can route onHitCar into damage
    if (typeof window !== "undefined") window.__pfDamage = this;
  }

  /** combat SHOT handler (Erik: "shoot a tire → it goes flat"). Route General's
   *  onHitCar here — it applies body damage AND, if the bullet landed on a wheel,
   *  flattens that tire via Ninja's setWheelFlat (corner sags + drags + squishes). */
  shotHit(entity, amount, point, dir) {
    if (!entity) return;
    entity.damage = (entity.damage || 0) + (amount || 0);
    entity.smokeDmg = (entity.smokeDmg || 0) + (amount || 0) * 0.12;  // bullets smoke SLOWLY (~6 rifle hits)
    const vb = this._carVehicle(entity);
    if (vb && point && typeof vb.setWheelFlat === "function") {
      const keys = vb._wheelKeys ?? ["fl", "fr", "rl", "rr"];
      const S = vb.suspension;
      for (let i = 0; i < 4; i++) {
        const w = S?.wheels?.[keys[i]] ?? vb.wheels?.[keys[i]];
        if (!w) continue;
        w.getWorldPosition(this._wpos);
        if (this._wpos.distanceTo(point) < this.wheelHitRadius && !(vb._flat && vb._flat[i]))
          vb.setWheelFlat(i, true);            // shot a tire → flat
      }
    }
    entity.onCarHit?.(amount, dir);
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

  /** the CAR vehicle body on an entity — a VehicleBody with a Rapier body.
   *  Excludes CharacterBody (also has an `rb`) so people never dent or smoke. */
  _carVehicle(e) { return e?.components?.find((c) => c instanceof VehicleBody && c.rb); }

  _onContact({ entityA, entityB, force, point, normal }) {
    if (force < this.hitForce) return;
    const now = performance.now();
    // severity scales with REAL contact force, uncapped — tap ≈0.3, full wreck
    // ≈1.5, a semi 3+. Drives crumple depth/radius, sparks, smoke, damage tally.
    const severity = (force - this.hitForce) / (1200 * 12);
    // world-space contact point + inward crumple happen where the hit LANDED —
    // a frontal hit only folds the front, a corner hit only the corner, the rest
    // of the shell is untouched (Erik: don't crush sides that weren't hit).
    const wp = point ? this._tmpB.set(point.x, point.y, point.z) : null;
    for (const [me, other] of [[entityA, entityB], [entityB, entityA]]) {
      // deform CARS and PEOPLE (Erik loves the squished-character look) — a car
      // is a VehicleBody, a person a CharacterBody. People crumple LESS + never
      // smoke/spark (not metal); smoke is gated to cars in update() separately.
      const vb = me?.components?.find((c) => c.rb && (c instanceof VehicleBody || c instanceof CharacterBody));
      if (!vb) continue;
      const isCar = vb instanceof VehicleBody;
      const last = this._lastHit.get(me) ?? 0;
      if (now - last < this.debounceMs) continue;
      this._lastHit.set(me, now);

      // raw crumple axis from the contact normal (fall back to car→other, or
      // travel dir into static geometry, if no manifold normal).
      const dir = this._tmpA;
      const cp = wp ?? me.position;              // where to crumple around
      if (normal) dir.set(normal.x, normal.y, normal.z);
      else if (other?.position && (other.position.x || other.position.z)) dir.copy(other.position).sub(me.position);
      else if (vb.rb) { const lv = vb.rb.linvel(); dir.set(lv.x, 0, lv.z); }
      else dir.set(0, 0, 1);
      if (dir.lengthSq() < 1e-6) continue;
      dir.normalize();
      // FORCE it to point INTO the car (from the contact toward the car center),
      // whatever the source — verts then cave INWARD (dent), never bulge out.
      // (bug fix: the old check flipped this and the car grew where it was hit.)
      const ox = cp.x - me.position.x, oy = cp.y - me.position.y, oz = cp.z - me.position.z;
      if (dir.x * ox + dir.y * oy + dir.z * oz > 0) dir.negate();

      // localized crumple: verts within `radius` of the contact fold along `dir`
      // by `depth`, both in WORLD meters and scaling with severity. A semi's huge
      // force = deep + wide crush zone; repeated hits total the car realistically.
      // People get a SMALL, capped crumple so they squish funny but don't explode
      // (Erik: "limit the damage for the characters so they wont go all weird").
      const depth = isCar ? Math.min(0.6, 0.06 + 0.18 * severity) : Math.min(0.12, 0.04 + 0.05 * severity);
      const radius = isCar ? 0.45 + 0.3 * Math.min(4, severity) : 0.22 + 0.06 * Math.min(3, severity);
      this._dentCar(me, vb, cp, dir, depth, radius);

      if (isCar) {                                  // sparks are metal-on-metal only
        const pt = this._rel.copy(cp); pt.y += 0.1;
        this._sparks?.burst(Math.round(12 + Math.min(2, severity) * 60), pt);
        this._wheelWreck(me, vb, cp, severity);     // wheel that got hit may lock up
      }
      me.damage = (me.damage ?? 0) + severity;
      me.smokeDmg = (me.smokeDmg ?? 0) + severity;   // crashes wreck the engine → full smoke feed
      me.onCarHit?.(severity, dir.clone());
    }
  }

  // ---- per-frame: emit wreck smoke from damaged cars + advance the pool ----
  update(dt) {
    if (!this._smoke || !this._world) return;
    for (const e of this._world.entities) {
      // smoke keys off a SEPARATE accumulator (smokeDmg), not raw entity.damage:
      // a bullet adds 8-45 dmg but a crash-hit only ~1-3, so keying smoke off
      // entity.damage made ONE bullet smoke the car (Erik, 5x). Crashes feed
      // smokeDmg fully (wrecked engine); bullets feed it lightly (holes).
      const sd = e.smokeDmg ?? 0;
      if (!this._carVehicle(e) || sd < this.smokeStart) continue;
      // 0..1 severity across the smoke band → emission rate + darkness
      const sev = Math.min(1, (sd - this.smokeStart) / (this.smokeFull - this.smokeStart));
      const rate = 6 + sev * 34;                        // puffs/sec
      let acc = (this._emitAcc.get(e) ?? 0) + rate * dt;
      // engine bay = between the two FRONT TIRES (Erik). Use the real wheel
      // contacts when grounded; else quaternion forward — never euler yaw,
      // which lies the moment the body tilts (emitter wandered off the car).
      const vb = this._carVehicle(e);
      const wc = vb?.wheelContacts;
      let ex, ey, ez;
      if (wc?.FL && wc?.FR) {
        ex = (wc.FL.x + wc.FR.x) / 2;
        ey = (wc.FL.y + wc.FR.y) / 2 + 0.55;
        ez = (wc.FL.z + wc.FR.z) / 2;
      } else {
        const f = new THREE.Vector3(0, 0, 1).applyQuaternion(e.object3d.quaternion);
        ex = e.position.x + f.x * 1.35;
        ey = e.position.y + 0.45;
        ez = e.position.z + f.z * 1.35;
      }
      while (acc >= 1) { acc -= 1; this._spawnPuff(ex, ey, ez, sev); }
      this._emitAcc.set(e, acc);
    }
    this._stepSmoke(dt);
  }

  _spawnPuff(ex, ey, ez, sev) {
    const i = this._sNext; this._sNext = (this._sNext + 1) % this._sCount;
    this._sPos[i*3]   = ex + (Math.random() - 0.5) * 0.4;
    this._sPos[i*3+1] = ey + Math.random() * 0.2;
    this._sPos[i*3+2] = ez + (Math.random() - 0.5) * 0.4;
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

  /** a hit landing on/near a wheel damages that wheel; once it crosses the
   *  threshold, lock it solid so it drags (Ninja's vb.setWheelLocked). */
  _wheelWreck(entity, vb, cpWorld, severity) {
    if (typeof vb.setWheelLocked !== "function") return;
    const keys = vb._wheelKeys ?? ["fl", "fr", "rl", "rr"];
    const S = vb.suspension;
    let dmg = this._wheelDmg.get(entity);
    if (!dmg) { dmg = [0, 0, 0, 0]; this._wheelDmg.set(entity, dmg); }
    for (let i = 0; i < 4; i++) {
      const w = S?.wheels?.[keys[i]] ?? vb.wheels?.[keys[i]];
      if (!w) continue;
      w.getWorldPosition(this._wpos);
      const d = this._wpos.distanceTo(cpWorld);
      if (d >= this.wheelHitRadius) continue;
      dmg[i] += severity * (1 - d / this.wheelHitRadius);
      if (dmg[i] >= this.wheelLockAt && !(vb._locked && vb._locked[i]))
        vb.setWheelLocked(i, true);              // wrecked → locks + drags
      // extreme wheel damage → the wheel comes OFF (Erik's spec). Ninja's seam
      // drops that corner's suspension (car sags onto 3 + leans) + hides the
      // wheel. The loose free-rolling wheel body is deferred cosmetic polish.
      if (dmg[i] >= this.wheelDetachAt && typeof vb.setWheelDetached === "function"
          && !(vb._detached && vb._detached[i]))
        vb.setWheelDetached(i, true);
    }
  }

  /** LOCALIZED crumple: only verts within `radius` (m) of the world contact
   *  `pointW` fold inward along `dirW` by up to `depth` (m). No whole-body crush
   *  — a frontal hit only folds the front, a corner hit only the corner. */
  // tag each of a vehicle's wheel meshes so deformation skips them BY IDENTITY —
  // the de-skinned pack cars have all-unnamed meshes, so the name regex missed
  // the wheels and they were denting into wobbly blobs (Erik). Wheels are the
  // meshes under the vehicle's wheel nodes; they never crumple (a wrecked wheel
  // LOCKS via setWheelLocked instead).
  _markWheels(vb) {
    if (!vb || vb._wheelsMarked) return;
    const S = vb.suspension, keys = vb._wheelKeys ?? ["fl", "fr", "rl", "rr"];
    for (const k of keys) {
      const w = S?.wheels?.[k] ?? vb.wheels?.[k];
      w?.traverse?.((o) => { if (o.isMesh) o.userData._isWheel = true; });
    }
    vb._wheelsMarked = true;
  }

  _dentCar(entity, vb, pointW, dirW, depth, radius) {
    this._markWheels(vb);
    entity.object3d?.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      if (o.userData._isWheel || /wheel|tire|tyre|rim|glass|window/i.test(o.name)) return;  // wheels + glass never crumple
      this._dentMesh(o, pointW, dirW, depth, radius);
    });
  }

  _dentMesh(mesh, pointW, dirW, depth, radius) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const ud = mesh.userData;
    if (!ud._orig) ud._orig = new Float32Array(pos.array);   // cache rest shape once
    // contact point + crumple dir into THIS mesh's local frame
    mesh.updateWorldMatrix(true, false);
    const lp = mesh.worldToLocal(this._lp.copy(pointW));
    mesh.getWorldQuaternion(this._q);
    const ld = this._ld.copy(dirW).applyQuaternion(this._q.invert()).normalize();
    // world→local scale: car meshes are shrunk by their parent node, so convert
    // the metre radius/depth into this mesh's big local units
    mesh.getWorldScale(this._scaleV);
    const s = (this._scaleV.x + this._scaleV.y + this._scaleV.z) / 3 || 1;
    const lr = radius / s, ld_ = depth / s, r2 = lr * lr, cap = lr * 1.25;
    const orig = ud._orig;
    let touched = false;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      const dx = px - lp.x, dy = py - lp.y, dz = pz - lp.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;                             // outside the crush zone
      const fall = 1 - Math.sqrt(d2) / lr;               // 1 at contact → 0 at radius
      const push = ld_ * fall * fall;                    // smooth crater
      let nx = px + ld.x * push, ny = py + ld.y * push, nz = pz + ld.z * push;
      // clamp each vert's TOTAL travel from rest so repeated hits crush but don't explode
      const tx = nx - orig[i*3], ty = ny - orig[i*3+1], tz = nz - orig[i*3+2];
      const tl = Math.hypot(tx, ty, tz);
      if (tl > cap) { const k = cap / tl; nx = orig[i*3] + tx*k; ny = orig[i*3+1] + ty*k; nz = orig[i*3+2] + tz*k; }
      pos.setXYZ(i, nx, ny, nz);
      touched = true;
    }
    if (touched) { pos.needsUpdate = true; geo.computeVertexNormals(); }
  }
}
