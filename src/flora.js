import * as THREE from "three";

/**
 * flora.js — procedural, GPU-instanced flora with DATA-DRIVEN motion.
 *
 * The one idea (see FLORA_PLAN.md): every plant carries a per-vertex aBendWeight
 * (0 at the root → 1 at the tip). A shared vertex shader bends each vertex by
 *   bend = WIND(instancePos, time) + Σ DISTURBERS(instancePos)
 * scaled by aBendWeight, so roots stay planted and tips move most. Wind and hits
 * are the same cheap GPU op — animating a million blades costs ~nothing on the CPU.
 *
 * The game drives it purely through data, each frame:
 *   field.setWind({ dir:[x,z], strength, gust })
 *   field.setDisturbers([{ x,y,z, radius, strength, vx,vz }, ...])   // car/player/etc
 *
 * Phase 1: grass sprigs. Same field/shader will host flowers/bushes/trees.
 */

const MAX_DISturbERS = 24;   // uniform-array cap (car + player + a few projectiles)
const MAX_DIST = MAX_DISturbERS;

// ── procedural grass sprig: a fan of tapered blades, aBendWeight = height ──────
export function makeGrassSprig({ blades = 5, height = 0.5, width = 0.045, curve = 0.12, seed = 1 } = {}) {
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const pos = [], nrm = [], uv = [], bw = [], idx = [];
  let v = 0;
  for (let b = 0; b < blades; b++) {
    const yaw = (b / blades) * Math.PI * 2 + rnd() * 0.6;
    const lean = 0.05 + rnd() * 0.12;                       // outward lean
    const h = height * (0.7 + rnd() * 0.5);
    const w = width * (0.8 + rnd() * 0.4);
    const dx = Math.cos(yaw), dz = Math.sin(yaw);
    const SEG = 3;                                          // segments up the blade
    for (let k = 0; k <= SEG; k++) {
      const t = k / SEG;                                   // 0 root → 1 tip
      const taper = (1 - t) * w * 0.5;                     // narrows to a point
      const bend = curve * t * t + lean * t;               // gentle forward curve
      const cx = dx * bend * h, cz = dz * bend * h, cy = t * h;
      // two verts across the blade (left/right of the blade's local width axis)
      const px = -dz, pz = dx;                             // perpendicular in xz
      pos.push(cx + px * taper, cy, cz + pz * taper);
      pos.push(cx - px * taper, cy, cz - pz * taper);
      nrm.push(dx, 0.35, dz, dx, 0.35, dz);
      uv.push(0, t, 1, t);
      bw.push(t, t);                                       // bend weight = height
      if (k < SEG) {
        const a = v, b2 = v + 1, c = v + 2, d = v + 3;
        idx.push(a, c, b2, b2, c, d);
      }
      v += 2;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aBendWeight", new THREE.Float32BufferAttribute(bw, 1));
  g.setIndex(idx);
  return g;
}

/**
 * FloraField — one instanced flora layer with the shared bend shader.
 * @param opts.geometry   sprig geometry (from makeGrassSprig)
 * @param opts.max        max instances (buffer size)
 * @param opts.colorA/B   tint range (per-instance lerp)
 * @param opts.baseColor  material base color
 */
export class FloraField {
  constructor(scene, {
    geometry, max = 40000, colorA = 0x4c8a45, colorB = 0x81a24a, baseColor = 0xffffff,
  } = {}) {
    this.max = max;
    this.count = 0;
    this._disturbers = [];
    this.wind = { dir: new THREE.Vector2(1, 0.3).normalize(), strength: 0.0, gust: 0.5 };

    // per-instance attributes beyond instanceMatrix (translation only) + instanceColor
    const geo = geometry.clone();
    geo.setAttribute("aScale", new THREE.InstancedBufferAttribute(new Float32Array(max), 1));
    geo.setAttribute("aYaw", new THREE.InstancedBufferAttribute(new Float32Array(max), 1));
    this.geo = geo;

    // uniforms shared into MeshStandardMaterial via onBeforeCompile (keeps lighting/shadows)
    this.uniforms = {
      uTime: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uWindStr: { value: 0 },
      uGust: { value: 0.5 },
      uDistCount: { value: 0 },
      // disturber A = (x,y,z, radius) · B = (vx, vz, strength, _)
      uDistA: { value: Array.from({ length: MAX_DIST }, () => new THREE.Vector4()) },
      uDistB: { value: Array.from({ length: MAX_DIST }, () => new THREE.Vector4()) },
    };

    const mat = new THREE.MeshStandardMaterial({
      color: baseColor, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, vertexColors: false,
    });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", `#include <common>
          attribute float aScale; attribute float aYaw; attribute float aBendWeight;
          uniform float uTime; uniform vec2 uWindDir; uniform float uWindStr; uniform float uGust;
          uniform int uDistCount; uniform vec4 uDistA[${MAX_DIST}]; uniform vec4 uDistB[${MAX_DIST}];
          mat2 rot2(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          // per-instance size + facing (instanceMatrix carries translation only)
          transformed *= aScale;
          transformed.xz = rot2(aYaw) * transformed.xz;
          // instance world origin = its translation (modelMatrix is identity for the field)
          vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          // ---- WIND: directional sway + flutter, per-instance phase from position ----
          float phase = iPos.x * 0.7 + iPos.z * 0.9;
          float gust = uWindStr * (1.0 + uGust * sin(uTime * 0.5 + phase * 0.15));
          vec2 bend = uWindDir * gust * (0.35 * sin(uTime * 1.6 + phase)
                                        + 0.12 * sin(uTime * 5.0 + phase * 2.3));
          // ---- DISTURBERS: bend away from + along each mover within reach ----
          for (int i = 0; i < ${MAX_DIST}; i++) {
            if (i >= uDistCount) break;
            vec4 A = uDistA[i]; vec4 B = uDistB[i];   // A=(x,y,z,radius) B=(vx,vz,strength,_)
            vec2 away = iPos.xz - A.xz;                // from disturber to this plant
            float d = length(away);
            if (d < A.w) {
              float f = 1.0 - d / A.w;                 // 0 at edge → 1 at center
              f = f * f;                               // soften
              vec2 radial = d > 0.001 ? away / d : vec2(0.0, 1.0);
              vec2 travel = B.xy;                      // disturber velocity (xz)
              vec2 push = normalize(radial + travel * 0.6 + vec2(1e-4)) ;
              bend += push * (f * B.z);
            }
          }
          transformed.xz += bend * aBendWeight;`);
    };
    this.material = mat;

    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;                       // field spans the scene
    this.mesh.castShadow = false; this.mesh.receiveShadow = true;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    scene.add(this.mesh);

    this._m = new THREE.Matrix4();
    this._cA = new THREE.Color(colorA); this._cB = new THREE.Color(colorB); this._ct = new THREE.Color();
  }

  /** scatter `n` sprigs via a placement callback place(i) → {x,y,z, keep} */
  scatter(n, place) {
    n = Math.min(n, this.max);
    const sc = this.geo.getAttribute("aScale"), yw = this.geo.getAttribute("aYaw");
    let w = 0;
    for (let i = 0; i < n; i++) {
      const p = place(i);
      if (!p || p.keep === false) continue;
      this._m.makeTranslation(p.x, p.y, p.z);
      this.mesh.setMatrixAt(w, this._m);
      sc.array[w] = p.scale ?? 1;
      yw.array[w] = p.yaw ?? 0;
      this._ct.copy(this._cA).lerp(this._cB, p.tint ?? Math.random());
      this.mesh.setColorAt(w, this._ct);
      w++;
    }
    this.count = w;
    this.mesh.count = w;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    sc.needsUpdate = true; yw.needsUpdate = true;
  }

  /** density 0..1 — thin the field by rendering the first fraction (scatter in
   *  random order so this reads as uniform thinning, not a shrinking disc). */
  setDensity(frac) { this.mesh.count = Math.max(0, Math.min(this.count, Math.round(this.count * frac))); }

  setWind({ dir, strength, gust } = {}) {
    if (dir) this.uniforms.uWindDir.value.set(dir[0], dir[1]).normalize();
    if (strength != null) this.uniforms.uWindStr.value = strength;
    if (gust != null) this.uniforms.uGust.value = gust;
  }

  /** feed the movers that should push flora aside this frame */
  setDisturbers(list) {
    const n = Math.min(list.length, MAX_DIST);
    for (let i = 0; i < n; i++) {
      const d = list[i];
      this.uniforms.uDistA.value[i].set(d.x, d.y ?? 0, d.z, d.radius ?? 3);
      this.uniforms.uDistB.value[i].set(d.vx ?? 0, d.vz ?? 0, d.strength ?? 1, 0);
    }
    this.uniforms.uDistCount.value = n;
  }

  update(dt) { this.uniforms.uTime.value += dt; }

  dispose() { this.mesh.parent?.remove(this.mesh); this.geo.dispose(); this.material.dispose(); }
}
