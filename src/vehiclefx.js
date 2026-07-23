import * as THREE from "three";
import { Particles } from "./particlefx.js";

const _p = new THREE.Vector3();   // exhaust tip world pos
const _d = new THREE.Vector3();   // exhaust blast direction

/**
 * VehicleFX — tyre smoke + sparks for the proving-ground car, driven by the
 * physics. Smoke billows from any wheel that's sliding or spinning (soft, buoyant,
 * lingering — a real burnout cloud). Sparks fly off a torn-off corner scraping the
 * ground and off hard impacts.
 *
 *   const fx = new VehicleFX(scene);
 *   fx.update(dt, car);            // each frame
 *   fx.onImpact(point, mag);       // from the collision handler
 */
export class VehicleFX {
  constructor(scene) {
    this.smoke = new Particles(scene, { max: 2000, blending: "normal", sizeScale: 340 });
    this.sparks = new Particles(scene, { max: 700, blending: "additive", sizeScale: 300 });
    this._acc = {};
  }

  _intensity(w) {
    const lat = Math.min(1, Math.max(0, (Math.abs(w.slip || 0) - 0.13) / 0.4));
    const spin = w.driven ? Math.min(1, Math.abs(w.spinRate || 0) / 45) : 0;
    return Math.max(lat, spin);
  }

  update(dt, car) {
    const spd = car.speedKmh;
    for (const w of car.wheels) {
      if (w.cx === undefined) continue;
      // ---- tyre smoke from sliding / spinning wheels (builds the longer you hold it) ----
      if (w.grounded && !w.detached) {
        const inten = this._intensity(w);
        const st = this._acc[w.name] || (this._acc[w.name] = { acc: 0, heat: 0 });
        // heat ramps up while burning out, cools off otherwise → progressive cloud
        st.heat = Math.max(0, Math.min(1, st.heat + (inten > 0.3 ? inten * 0.55 : -0.9) * dt));
        if (inten >= 0.16) {
          st.acc += (10 + 34 * st.heat) * inten * dt;      // more smoke as heat builds
          const h = st.heat;
          while (st.acc >= 1) {
            st.acc -= 1;
            const gray = (0.74 - h * 0.34) + Math.random() * 0.1;   // darker as it heats
            this.smoke.spawn({
              // HEAVY smoke: barely rises, hangs low and rolls (real burnout smoke)
              x: w.cx + (Math.random() - 0.5) * 0.35, y: 0.12, z: w.cz + (Math.random() - 0.5) * 0.35,
              vx: (Math.random() - 0.5) * 1.6, vy: 0.12 + Math.random() * 0.3 + h * 0.25, vz: (Math.random() - 0.5) * 1.6,
              size: 0.5 + h * 0.5, grow: 2.8 + Math.random() * 1.6 + h * 2.2, r: gray, g: gray, b: gray,
              a: 0.1 + inten * 0.26 + h * 0.16, life: 2.2 + Math.random() * 1.8 + h * 1.4, drag: 1.35, gravity: 0.03,
            });
          }
        }
      }
      // ---- sparks off a torn-off corner scraping the ground at speed ----
      if (w.detached && spd > 8) {
        const n = 1 + Math.floor(Math.min(5, spd / 22));
        for (let k = 0; k < n; k++) this._spark(w.cx, w.cy ?? 0.1, w.cz);
      }
    }
    // ---- D3: overheating engine — smoke curls off the hood, thicker as it cooks ----
    if ((car.overheat || 0) > 0.05) {
      const oh = car.overheat, cook = 1.5 - (car.heatMul ?? 1);   // darker/thicker as power fades
      this._hoodAcc = (this._hoodAcc || 0) + (3 + 16 * oh) * dt;
      const m = car.mesh;
      while (this._hoodAcc >= 1) {
        this._hoodAcc -= 1;
        _p.set((Math.random() - 0.5) * 0.7, 0.95, 1.3 + Math.random() * 0.5)
          .applyQuaternion(m.quaternion).add(m.position);
        const gray = 0.85 - cook * 0.35 + Math.random() * 0.08;   // steam → oily smoke
        this.smoke.spawn({
          x: _p.x, y: _p.y, z: _p.z,
          vx: (Math.random() - 0.5) * 0.7, vy: 0.5 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.7,
          size: 0.25 + oh * 0.3, grow: 1.6 + oh * 1.4, r: gray, g: gray, b: gray,
          a: 0.12 + oh * 0.2, life: 1.6 + Math.random() * 1.4, drag: 1.2, gravity: -0.12,
        });
      }
    }
    this._carAvoid(car);       // smoke flows AROUND the body, not through it
    this.smoke.update(dt);
    this.sparks.update(dt);
  }

  /** cheap car-aware smoke: particles inside the car's ellipsoid slide out sideways */
  _carAvoid(car) {
    const t = car.body.translation();
    const cx = t.x, cy = t.y + 0.35, cz = t.z, R = 2.2, R2 = R * R;
    const P = this.smoke;
    for (let i = 0; i < P.max; i++) {
      if (P.life[i] <= 0) continue;
      const dx = P.x[i] - cx, dy = (P.y[i] - cy) * 1.9, dz = P.z[i] - cz;   // squashed → ellipsoid
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < R2 && d2 > 1e-4) {
        const d = Math.sqrt(d2), push = (R - d) / R;
        const ux = dx / d, uz = dz / d;
        P.x[i] += ux * push * 0.3;
        P.z[i] += uz * push * 0.3;
        P.vx[i] += ux * push * 0.06;
        P.vz[i] += uz * push * 0.06;
      }
    }
  }

  _spark(x, y, z) {
    this.sparks.spawn({
      x, y: (y || 0.1) + 0.05, z,
      vx: (Math.random() - 0.5) * 5, vy: 1 + Math.random() * 3.5, vz: (Math.random() - 0.5) * 5,
      size: 0.11 + Math.random() * 0.06, grow: -0.05,
      r: 1, g: 0.65 + Math.random() * 0.3, b: 0.15, a: 1,
      life: 0.2 + Math.random() * 0.4, drag: 1.5, gravity: -16,
    });
  }

  /** FIRE out both exhaust tips — called per backfire pop (delay syncs with the bang) */
  exhaustFlame(car, delay = 0) {
    setTimeout(() => {
      const m = car.mesh;
      const hz = (car.half?.z || 2.2) + 0.12;
      for (const side of [-1, 1]) {
        _p.set(side * 0.38, -0.5, -hz).applyQuaternion(m.quaternion).add(m.position);
        _d.set(side * 0.12, 0.12, -1).applyQuaternion(m.quaternion);   // out the back
        const n = 9 + Math.floor(Math.random() * 6);   // more fire (Erik)
        for (let i = 0; i < n; i++) {
          const spd = 3 + Math.random() * 5;
          this.sparks.spawn({
            x: _p.x, y: _p.y, z: _p.z,
            vx: _d.x * spd + (Math.random() - 0.5) * 1.6,
            vy: _d.y * spd + (Math.random() - 0.5) * 1.6,
            vz: _d.z * spd + (Math.random() - 0.5) * 1.6,
            size: 0.3 + Math.random() * 0.25, grow: -0.2,
            r: 1, g: 0.5 + Math.random() * 0.4, b: 0.12, a: 0.95,
            life: 0.1 + Math.random() * 0.15, drag: 3, gravity: 2,
          });
        }
        // bright muzzle-flash core right at the tip
        this.sparks.spawn({
          x: _p.x, y: _p.y, z: _p.z, vx: _d.x * 2, vy: 0.2, vz: _d.z * 2,
          size: 0.75, grow: -0.55, r: 1, g: 0.85, b: 0.42, a: 1, life: 0.08, drag: 2, gravity: 0,
        });
      }
    }, Math.max(0, delay * 1000));
  }

  /** burst of sparks on a hard impact */
  onImpact(point, mag) {
    if (!point || mag < 350000) return;
    const n = Math.min(40, 6 + Math.floor(mag / 90000));
    for (let k = 0; k < n; k++) this._spark(point.x, point.y, point.z);
  }
}
