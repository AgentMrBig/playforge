import { Particles } from "./particlefx.js";

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
              x: w.cx + (Math.random() - 0.5) * 0.35, y: 0.12, z: w.cz + (Math.random() - 0.5) * 0.35,
              vx: (Math.random() - 0.5) * 1.5, vy: 0.5 + Math.random() * 0.9 + h * 0.7, vz: (Math.random() - 0.5) * 1.5,
              size: 0.5 + h * 0.5, grow: 2.8 + Math.random() * 1.6 + h * 2.2, r: gray, g: gray, b: gray,
              a: 0.1 + inten * 0.26 + h * 0.16, life: 1.7 + Math.random() * 1.5 + h * 1.2, drag: 1.05, gravity: 0.32,
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
    this.smoke.update(dt);
    this.sparks.update(dt);
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

  /** burst of sparks on a hard impact */
  onImpact(point, mag) {
    if (!point || mag < 350000) return;
    const n = Math.min(40, 6 + Math.floor(mag / 90000));
    for (let k = 0; k < n; k++) this._spark(point.x, point.y, point.z);
  }
}
