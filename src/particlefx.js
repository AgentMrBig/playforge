import * as THREE from "three";

/**
 * Particles — a cheap GPU point-sprite particle engine for the proving ground.
 * One preallocated buffer, a soft round texture, per-particle size-growth / colour
 * / alpha / drag / gravity driven on the CPU. Used for tyre smoke (soft, buoyant,
 * lingering, normal blend) and sparks (small, bright, gravity, additive). Ring-
 * buffer spawn, integrate in update(dt). (Separate from the game's Emitter.)
 *
 *   const smoke = new Particles(scene, { max: 1600 });
 *   smoke.spawn({ x,y,z, vx,vy,vz, size, grow, r,g,b, a, life, drag, gravity });
 *   smoke.update(dt);
 */
function softTexture() {
  const s = 64, c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let _tex = null;

export class Particles {
  constructor(scene, { max = 1500, blending = "normal", sizeScale = 320 } = {}) {
    this.max = max;
    const N = max;
    this.x = new Float32Array(N); this.y = new Float32Array(N); this.z = new Float32Array(N);
    this.vx = new Float32Array(N); this.vy = new Float32Array(N); this.vz = new Float32Array(N);
    this.life = new Float32Array(N); this.ml = new Float32Array(N);
    this.s0 = new Float32Array(N); this.sg = new Float32Array(N);
    this.r = new Float32Array(N); this.g = new Float32Array(N); this.b = new Float32Array(N);
    this.a0 = new Float32Array(N); this.drag = new Float32Array(N); this.grav = new Float32Array(N);
    this.pos = new Float32Array(N * 3);
    this.psize = new Float32Array(N);
    this.pcol = new Float32Array(N * 4);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("psize", new THREE.BufferAttribute(this.psize, 1));
    this.geo.setAttribute("pcolor", new THREE.BufferAttribute(this.pcol, 4));
    this.geo.setDrawRange(0, N);
    if (!_tex) _tex = softTexture();
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: _tex }, scale: { value: sizeScale } },
      transparent: true, depthWrite: false,
      blending: blending === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `
        attribute float psize; attribute vec4 pcolor; varying vec4 vColor; uniform float scale;
        void main(){ vColor = pcolor; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = psize * (scale / max(1.0, -mv.z)); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform sampler2D map; varying vec4 vColor;
        void main(){ vec4 t = texture2D(map, gl_PointCoord);
          float a = vColor.a * t.a; if (a < 0.01) discard;
          gl_FragColor = vec4(vColor.rgb, a); }`,
    });
    this.mesh = new THREE.Points(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.head = 0;
  }

  spawn(o) {
    const i = this.head; this.head = (this.head + 1) % this.max;
    this.x[i] = o.x; this.y[i] = o.y; this.z[i] = o.z;
    this.vx[i] = o.vx || 0; this.vy[i] = o.vy || 0; this.vz[i] = o.vz || 0;
    this.ml[i] = this.life[i] = o.life || 1;
    this.s0[i] = o.size || 1; this.sg[i] = o.grow || 0;
    this.r[i] = o.r ?? 1; this.g[i] = o.g ?? 1; this.b[i] = o.b ?? 1;
    this.a0[i] = o.a ?? 1; this.drag[i] = o.drag ?? 0; this.grav[i] = o.gravity ?? 0;
  }

  update(dt) {
    const N = this.max;
    for (let i = 0; i < N; i++) {
      let L = this.life[i];
      if (L <= 0) { this.pcol[i * 4 + 3] = 0; continue; }
      L -= dt; this.life[i] = L;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= d; this.vz[i] *= d; this.vy[i] = this.vy[i] * d + this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt; this.z[i] += this.vz[i] * dt;
      const age = 1 - L / this.ml[i];
      const j = i * 3; this.pos[j] = this.x[i]; this.pos[j + 1] = this.y[i]; this.pos[j + 2] = this.z[i];
      this.psize[i] = this.s0[i] + this.sg[i] * age;
      const fade = Math.min(1, L / (this.ml[i] * 0.5));   // hold, then fade the last half
      const k = i * 4; this.pcol[k] = this.r[i]; this.pcol[k + 1] = this.g[i]; this.pcol[k + 2] = this.b[i];
      this.pcol[k + 3] = this.a0[i] * fade;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.psize.needsUpdate = true;
    this.geo.attributes.pcolor.needsUpdate = true;
  }
}
