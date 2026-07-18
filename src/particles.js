import * as THREE from "three";

/**
 * Emitter — one component, three shapes of juice:
 *   burst:    emitter.burst(30)            explosions, pickups, impacts
 *   fountain: rate > 0                      continuous spray (fire, smoke)
 *   trail:    rate > 0 on a moving entity   comet tails, footsteps
 *
 * GPU-friendly: one THREE.Points per emitter, preallocated pool, zero garbage
 * per frame. Colors fade, sizes shrink, gravity optional.
 *
 *   const boom = new Emitter({ color: 0xffaa33, count: 200, speed: [2, 6],
 *                              life: [0.3, 0.8], gravity: 6, size: 0.18 });
 *   entity.add(boom);  boom.burst(40);
 */
export class Emitter {
  constructor({
    count = 256, color = 0xffffff, color2 = null, size = 0.15,
    speed = [1, 4], life = [0.4, 1.0], gravity = 0, spread = Math.PI,
    rate = 0, dir = [0, 1, 0],
  } = {}) {
    this.count = count;
    this.speedRange = speed; this.lifeRange = life;
    this.gravity = gravity; this.spread = spread; this.rate = rate;
    this.dir = new THREE.Vector3(...dir).normalize();
    this._emitAcc = 0;

    this._pos = new Float32Array(count * 3);
    this._col = new Float32Array(count * 3);
    this._vel = new Float32Array(count * 3);
    this._life = new Float32Array(count);   // remaining
    this._life0 = new Float32Array(count);  // initial
    this._next = 0;
    this._alive = 0;

    this._c1 = new THREE.Color(color);
    this._c2 = new THREE.Color(color2 ?? color).multiplyScalar(0.35);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this._pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this._col, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size, vertexColors: true, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    geo.setDrawRange(0, 0);
  }

  init(entity) { entity.object3d.add(this.points); }

  /** spawn n particles at the entity (or an explicit world position) */
  burst(n, at = null) {
    for (let i = 0; i < n; i++) this._spawn(at);
  }

  _spawn(at) {
    const i = this._next;
    this._next = (this._next + 1) % this.count;
    const [s0, s1] = this.speedRange, [l0, l1] = this.lifeRange;
    // random direction within `spread` of `dir`
    const u = Math.random(), v = Math.random();
    const theta = Math.acos(1 - u * (1 - Math.cos(this.spread)));
    const phi = v * Math.PI * 2;
    const d = new THREE.Vector3(
      Math.sin(theta) * Math.cos(phi),
      Math.cos(theta),
      Math.sin(theta) * Math.sin(phi),
    );
    // rotate so "up" aligns with this.dir
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.dir);
    d.applyQuaternion(q).multiplyScalar(s0 + Math.random() * (s1 - s0));

    const base = at ?? new THREE.Vector3(); // local space when attached
    this._pos.set([base.x, base.y, base.z], i * 3);
    this._vel.set([d.x, d.y, d.z], i * 3);
    this._life[i] = this._life0[i] = l0 + Math.random() * (l1 - l0);
  }

  update(dt) {
    if (this.rate > 0) {
      this._emitAcc += this.rate * dt;
      while (this._emitAcc >= 1) { this._spawn(null); this._emitAcc -= 1; }
    }
    const P = this._pos, V = this._vel, C = this._col, L = this._life;
    let maxAlive = 0;
    for (let i = 0; i < this.count; i++) {
      if (L[i] <= 0) { C[i * 3] = C[i * 3 + 1] = C[i * 3 + 2] = 0; continue; }
      L[i] -= dt;
      V[i * 3 + 1] -= this.gravity * dt;
      P[i * 3] += V[i * 3] * dt;
      P[i * 3 + 1] += V[i * 3 + 1] * dt;
      P[i * 3 + 2] += V[i * 3 + 2] * dt;
      const t = Math.max(L[i], 0) / this._life0[i]; // 1 → 0
      const r = this._c1.r * t + this._c2.r * (1 - t);
      const g = this._c1.g * t + this._c2.g * (1 - t);
      const b = this._c1.b * t + this._c2.b * (1 - t);
      C[i * 3] = r * t; C[i * 3 + 1] = g * t; C[i * 3 + 2] = b * t; // fade out
      maxAlive = i + 1;
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, maxAlive);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  dispose() { this.points.geometry.dispose(); this.points.material.dispose(); }
}
