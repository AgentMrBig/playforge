import * as THREE from "three";

/**
 * verlet.js — a TINY active-ragdoll solver (Jakobsen-style Verlet) for the shippable
 * stickman fighter. No Rapier: point masses + distance constraints (bone lengths) +
 * a pose-drive term = "active ragdoll" in a few KB. Deterministic, stable at low
 * uniform mass, fixed timestep.
 *
 *   const v = new Verlet();
 *   const chest = v.addPoint(0, 1.4); const pelvis = v.addPoint(0, 1.0);
 *   v.addStick(chest, pelvis);                       // rigid bone length
 *   v.addDrive(pelvis, chest, new THREE.Vector3(0,1,0)); // active: chest driven "up" from pelvis
 *   v.step(1/60, { driveStrength: 1, facing: 1 });   // 1 = holds pose, 0 = flop/KO
 *
 * The whole FEEL lives in `driveStrength` (per-body or per-region): 1 = crisp
 * controlled fighter, 0 = full flop. Drop it in a struck region for a hit reaction.
 */
export class Verlet {
  constructor({ gravity = -22, damping = 0.08, iterations = 10, planar = true, groundFriction = 0.35, driveK = 0.34 } = {}) {
    this.driveK = driveK;   // pose-drive strength per step (lower = smoother, softer hold)
    this.g = gravity; this.damp = damping; this.iters = iterations; this.planar = planar; this.groundFriction = groundFriction;
    this.points = [];   // { p, o, pinned, r, invM }
    this.sticks = [];    // { a, b, len, stiff }
    this.drives = [];    // { parent, child, len, dir }  ← active-ragdoll pose targets
  }

  addPoint(x, y, z = 0, { pinned = false, r = 0.06, mass = 1 } = {}) {
    const pt = { p: new THREE.Vector3(x, y, z), o: new THREE.Vector3(x, y, z), pinned, r, mass, invM: pinned ? 0 : 1 / mass };
    this.points.push(pt); return pt;
  }
  /** pin/unpin a point (grab): pinned → invMass 0 (not integrated, not pushed by constraints) */
  setPinned(pt, on) { pt.pinned = on; pt.invM = on ? 0 : 1 / pt.mass; }
  /** rigid bone: keeps |a-b| at its initial length */
  addStick(a, b, stiff = 1) { const len = a.p.distanceTo(b.p); const s = { a, b, len, stiff }; this.sticks.push(s); return s; }
  /** active-ragdoll drive: each step pull `child` toward parent + dir(local)*len.
   *  `dir` is the bone's target unit direction in the character's facing frame. */
  addDrive(parent, child, dir) { const len = parent.p.distanceTo(child.p); const d = { parent, child, len, dir: dir.clone().normalize() }; this.drives.push(d); return d; }

  /** advance one fixed step. driveStrength 0..1 (global), facing ±1 (x mirror). */
  step(dt, { driveStrength = 1, facing = 1 } = {}) {
    const dampF = 1 - this.damp, gdt2 = this.g * dt * dt;
    // ── integrate (Verlet) ──
    for (const pt of this.points) {
      if (pt.pinned) continue;
      const vx = (pt.p.x - pt.o.x) * dampF, vy = (pt.p.y - pt.o.y) * dampF, vz = (pt.p.z - pt.o.z) * dampF;
      pt.o.copy(pt.p);
      pt.p.x += vx; pt.p.y += vy + gdt2; pt.p.z += vz;
    }
    // ── active-ragdoll POSE DRIVE ── pull each child toward its pose target, but move
    // its PREV point halfway too so the pull doesn't inject a big velocity spike (that
    // over-shoot + the stiff constraint network fighting back was the jitter). Gentle k.
    for (const d of this.drives) {
      const k = this.driveK * driveStrength * (d.k ?? 1);
      if (k <= 0 || d.child.pinned) continue;
      const c = d.child.p, o = d.child.o;
      const dx = (d.parent.p.x + d.dir.x * facing * d.len - c.x) * k;
      const dy = (d.parent.p.y + d.dir.y * d.len - c.y) * k;
      const dz = (d.parent.p.z + d.dir.z * d.len - c.z) * k;
      c.x += dx; c.y += dy; c.z += dz;
      o.x += dx * 0.5; o.y += dy * 0.5; o.z += dz * 0.5;   // damp injected velocity → smooth
    }
    // ── satisfy constraints (relaxation) + ground + planar ──
    for (let it = 0; it < this.iters; it++) {
      for (const s of this.sticks) {
        const a = s.a, b = s.b;
        const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y, dz = b.p.z - a.p.z;
        const dist = Math.hypot(dx, dy, dz) || 1e-6;
        const diff = ((dist - s.len) / dist) * s.stiff;
        const wt = a.invM + b.invM; if (wt === 0) continue;
        const fa = a.invM / wt, fb = b.invM / wt;
        a.p.x += dx * diff * fa; a.p.y += dy * diff * fa; a.p.z += dz * diff * fa;
        b.p.x -= dx * diff * fb; b.p.y -= dy * diff * fb; b.p.z -= dz * diff * fb;
      }
      for (const pt of this.points) {
        if (this.planar) { pt.p.z = 0; }
        if (pt.p.y < pt.r) {                     // ground contact
          pt.p.y = pt.r;
          pt.o.x += (pt.p.x - pt.o.x) * this.groundFriction;   // friction: bleed horizontal slide
          pt.o.y = pt.p.y;                                     // kill vertical bounce
        }
      }
    }
  }

  /** apply an impulse (world) to a point — hits, kicks, launches */
  impulse(pt, ix, iy, iz = 0) { pt.o.x -= ix; pt.o.y -= iy; pt.o.z -= iz; }
  /** current velocity of a point (for damage = impact magnitude) */
  vel(pt, out = new THREE.Vector3()) { return out.set(pt.p.x - pt.o.x, pt.p.y - pt.o.y, pt.p.z - pt.o.z); }
}
