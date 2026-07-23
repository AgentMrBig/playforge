import * as THREE from "three";
import { Particles } from "./particlefx.js";

/**
 * CarFire — Erik's fire system, stage 1: the CAR burns. Per-zone fire that
 * IGNITES on catastrophic damage, SPREADS across the body over time, gets
 * EXTINGUISHED by airflow (drive fast!), and eventually consumes the fuel and
 * burns out to a charred wreck. Real state, not a looping effect.
 *
 *   fire = new CarFire(scene, car);
 *   fire.update(dt);                  // each render frame
 *   fire.ignite("front", 0.35);      // from the crash handler
 *   fire.douse();                     // repair/reset
 */
const ZONE_ANCHORS = {
  front:  new THREE.Vector3(0, 0.55, 1.7),
  rear:   new THREE.Vector3(0, 0.55, -1.7),
  left:   new THREE.Vector3(0.8, 0.5, 0),     // mesh-mirrored x (see carphysics D2 note)
  right:  new THREE.Vector3(-0.8, 0.5, 0),
  roof:   new THREE.Vector3(0, 1.1, -0.2),
  center: new THREE.Vector3(0, 0.7, 0.3),
};
const SPREAD = {   // who catches next once a zone is fully involved
  front: ["center", "left", "right"], rear: ["center", "left", "right"],
  left: ["center", "front", "rear"], right: ["center", "front", "rear"],
  center: ["roof", "front", "rear"], roof: ["center"],
};
const _p = new THREE.Vector3();

export class CarFire {
  constructor(scene, car) {
    this.scene = scene; this.car = car;
    this.zones = { front: 0, rear: 0, left: 0, right: 0, roof: 0, center: 0 };
    this.fuel = 1;                      // burns to 0 → charred, flames die
    this.burning = false;
    this.charred = 0;                   // 0..1 paint scorch
    this.flames = new Particles(scene, { max: 900, blending: "additive", sizeScale: 330 });
    this.smoke = new Particles(scene, { max: 1200, blending: "normal", sizeScale: 360 });
    this.light = new THREE.PointLight(0xff7726, 0, 9, 2);
    this.light.visible = false;
    scene.add(this.light);
    this._acc = 0;
  }

  ignite(zone = "front", amount = 0.3) {
    if (this.fuel <= 0) return;                       // nothing left to burn
    this.zones[zone] = Math.min(1, this.zones[zone] + amount);
    this.burning = true;
  }

  /** total fire across the car, 0..~6 */
  get total() { let t = 0; for (const k in this.zones) t += this.zones[k]; return t; }

  douse() {
    for (const k in this.zones) this.zones[k] = 0;
    this.burning = false;
    this.fuel = 1; this.charred = 0;
    this.light.visible = false;
    this._restorePaint();
  }

  update(dt) {
    const car = this.car;
    if (this.burning) {
      const spd = Math.abs(car.speedKmh || 0);
      // airflow knocks the fire down above ~55 km/h — outrun your own fire
      const wind = spd > 55 ? (spd - 55) / 260 : 0;
      let any = false;
      for (const k in this.zones) {
        let z = this.zones[k];
        if (z <= 0) continue;
        z += (0.045 - wind) * dt * (this.fuel > 0 ? 1 : -3);   // grow (or die fuel-less)
        // fully involved → neighbours catch
        if (z > 0.6) for (const n of SPREAD[k])
          this.zones[n] = Math.min(1, this.zones[n] + 0.035 * dt);
        this.zones[k] = Math.max(0, Math.min(1, z));
        if (this.zones[k] > 0.01) any = true;
      }
      this.fuel = Math.max(0, this.fuel - 0.004 * dt * this.total);
      // burning cooks the machine: zone paint + the D3 radiator
      if (car.zoneHealth) for (const k in this.zones) if (this.zones[k] > 0.3)
        car.zoneHealth[k] = Math.max(0, car.zoneHealth[k] - 0.01 * dt);
      if (this.zones.front > 0.4 && car.heatMul != null)
        car.heatMul = Math.max(0.4, car.heatMul - 0.02 * dt);
      this.charred = Math.min(1, this.charred + 0.012 * dt * this.total);
      this._scorchPaint();
      this.burning = any;
      if (!any) this.light.visible = false;
    }

    // ---- visuals ----------------------------------------------------------
    const T = this.total;
    if (T > 0.02) {
      const m = car.mesh;
      this._acc += (6 + 26 * Math.min(1, T)) * dt;
      while (this._acc >= 1) {
        this._acc -= 1;
        // pick a burning zone weighted by intensity
        let r = Math.random() * T, zk = "center";
        for (const k in this.zones) { r -= this.zones[k]; if (r <= 0) { zk = k; break; } }
        const zi = this.zones[zk];
        _p.copy(ZONE_ANCHORS[zk]);
        _p.x += (Math.random() - 0.5) * 0.5; _p.z += (Math.random() - 0.5) * 0.5;
        _p.applyQuaternion(m.quaternion).add(m.position);
        // flame tongue
        this.flames.spawn({
          x: _p.x, y: _p.y, z: _p.z,
          vx: (Math.random() - 0.5) * 0.8, vy: 1.4 + Math.random() * 1.6 * zi, vz: (Math.random() - 0.5) * 0.8,
          size: 0.28 + zi * 0.4, grow: -0.25, r: 1, g: 0.42 + Math.random() * 0.35, b: 0.1,
          a: 0.9, life: 0.25 + Math.random() * 0.35, drag: 1.4, gravity: -2.2,
        });
        // ember pop (sometimes)
        if (Math.random() < 0.25) this.flames.spawn({
          x: _p.x, y: _p.y + 0.2, z: _p.z,
          vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3, vz: (Math.random() - 0.5) * 3,
          size: 0.06, grow: -0.02, r: 1, g: 0.6, b: 0.15, a: 1,
          life: 0.6 + Math.random() * 0.8, drag: 1.1, gravity: 4,
        });
        // black smoke column — heavy, rises slow, lingers
        if (Math.random() < 0.7) {
          const gr = 0.12 + Math.random() * 0.08;
          this.smoke.spawn({
            x: _p.x, y: _p.y + 0.3, z: _p.z,
            vx: (Math.random() - 0.5) * 0.5, vy: 0.7 + Math.random() * 0.8, vz: (Math.random() - 0.5) * 0.5,
            size: 0.35 + zi * 0.4, grow: 2.4 + zi * 1.6, r: gr, g: gr, b: gr,
            a: 0.16 + zi * 0.18, life: 2.6 + Math.random() * 2.2, drag: 1.25, gravity: -0.25,
          });
        }
      }
      // flickering burn light riding the car
      this.light.visible = true;
      this.light.position.copy(car.mesh.position).y += 1;
      this.light.intensity = (6 + Math.random() * 5) * Math.min(1, T * 0.6);
    }
    this.flames.update(dt);
    this.smoke.update(dt);
  }

  _scorchPaint() {
    // progressively darken every body material toward charcoal
    if (!this._mats) {
      this._mats = [];
      this.car.mesh.traverse((o) => {
        if (o.isMesh && o.material && !Array.isArray(o.material) && o.material.color)
          this._mats.push([o.material, o.material.color.clone()]);
      });
    }
    const k = this.charred * 0.75;
    for (const [m, c0] of this._mats) m.color.copy(c0).multiplyScalar(1 - k);
  }
  _restorePaint() {
    if (this._mats) for (const [m, c0] of this._mats) m.color.copy(c0);
  }
}
