import * as THREE from "three";

/**
 * SkidTrails — dark tyre streaks on the ground for the proving-ground car. Driven
 * by the physics: every grounded wheel that's sliding (lateral slip past grip) or
 * spinning (wheelspin/burnout) extends a thin ribbon of quads at its real contact
 * point, opacity from how hard it's skidding. All four wheels (drift lays four
 * lines; a burnout lays two under the rears). One preallocated buffer used as a
 * ring — oldest marks recycled, so memory + draw cost are bounded.
 *
 *   const skid = new SkidTrails(scene);
 *   skid.update(car);   // each frame
 */
export class SkidTrails {
  constructor(scene, { maxQuads = 4000, width = 0.24 } = {}) {
    this.maxQuads = maxQuads;
    this.halfW = width / 2;
    this.pos = new Float32Array(maxQuads * 6 * 3);   // 2 tris = 6 verts / quad
    this.col = new Float32Array(maxQuads * 6 * 4);   // RGBA per vertex
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 4));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,   // above ground, no z-fight
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.head = 0; this.count = 0;
    this.state = {};
    this._dirty = false;
  }

  // how hard this wheel is marking (0..1): lateral slide OR driven wheelspin
  _intensity(w) {
    const lat = Math.min(1, Math.max(0, (Math.abs(w.slip || 0) - 0.13) / 0.4));
    const spin = w.driven ? Math.min(1, Math.abs(w.spinRate || 0) / 45) : 0;
    return Math.max(lat, spin);
  }

  update(car) {
    for (const w of car.wheels) {
      const st = this.state[w.name] || (this.state[w.name] = { on: false });
      const grounded = w.grounded && !w.detached && w.cx !== undefined;
      const lat = grounded ? Math.min(1, Math.max(0, (Math.abs(w.slip || 0) - 0.13) / 0.4)) : 0;
      const spin = grounded && w.driven ? Math.min(1, Math.abs(w.spinRate || 0) / 45) : 0;
      const inten = Math.max(lat, spin);
      const burnout = spin > lat ? spin : 0;          // wheelspin marks: darker + wider
      if (inten <= 0.06 || !grounded) { st.on = false; continue; }
      const cx = w.cx, cz = w.cz;
      if (!st.on) { st.on = true; st.px = cx; st.pz = cz; st.hasEdge = false; continue; }
      const dx = cx - st.px, dz = cz - st.pz, d = Math.hypot(dx, dz);
      if (d < 0.04) continue;                          // wait for a little travel
      const hw = this.halfW * (1 + burnout * 0.5);     // burnout lays a fatter stripe
      const wx = -dz / d, wz = dx / d;                 // perpendicular = strip width
      const clx = cx + wx * hw, clz = cz + wz * hw;
      const crx = cx - wx * hw, crz = cz - wz * hw;
      if (st.hasEdge) this._quad(st.plx, st.plz, st.prx, st.prz, clx, clz, crx, crz, inten, burnout);
      st.px = cx; st.pz = cz; st.plx = clx; st.plz = clz; st.prx = crx; st.prz = crz; st.hasEdge = true;
    }
    if (this._dirty) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
      this.geo.setDrawRange(0, this.count * 6);
      this._dirty = false;
    }
  }

  _quad(aLx, aLz, aRx, aRz, bLx, bLz, bRx, bRz, inten, burnout = 0) {
    const y = 0.02;
    const i = this.head * 18, c = this.head * 24;
    const P = this.pos, C = this.col;
    // tris: (aL,aR,bR) and (aL,bR,bL)
    P[i] = aLx; P[i + 1] = y; P[i + 2] = aLz;
    P[i + 3] = aRx; P[i + 4] = y; P[i + 5] = aRz;
    P[i + 6] = bRx; P[i + 7] = y; P[i + 8] = bRz;
    P[i + 9] = aLx; P[i + 10] = y; P[i + 11] = aLz;
    P[i + 12] = bRx; P[i + 13] = y; P[i + 14] = bRz;
    P[i + 15] = bLx; P[i + 16] = y; P[i + 17] = bLz;
    // near-black in LINEAR space so it displays black after the sRGB encode.
    // burnouts lay darker (heavier) rubber than a slide.
    const a = Math.min(0.96, 0.3 + inten * 0.5 + burnout * 0.35);
    for (let v = 0; v < 6; v++) { const o = c + v * 4; C[o] = 0.008; C[o + 1] = 0.008; C[o + 2] = 0.009; C[o + 3] = a; }
    this.head = (this.head + 1) % this.maxQuads;
    if (this.count < this.maxQuads) this.count++;
    this._dirty = true;
  }

  clear() { this.count = 0; this.head = 0; this.state = {}; this.geo.setDrawRange(0, 0); }
}
