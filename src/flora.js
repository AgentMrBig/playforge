import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

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
    palette = null,          // array of hex colors → per-instance pick (flowers); else lerp colorA→B
    vertexColors = false,    // use the geometry's baked colors (trees/bushes: trunk brown, leaves green);
                             //   instanceColor then only lightly varies brightness so the bake shows
    bendScale = 1,           // how much wind+disturbers move this type (grass 1, trees ~0.15 = stiff)
    doubleSide = true,
  } = {}) {
    this.max = max;
    this.count = 0;
    this.palette = palette ? palette.map((c) => new THREE.Color(c)) : null;
    this.vertexColors = vertexColors;
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
      uBendScale: { value: bendScale },
    };

    const mat = new THREE.MeshStandardMaterial({
      color: baseColor, roughness: 0.95, metalness: 0,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide, vertexColors,
    });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", `#include <common>
          attribute float aScale; attribute float aYaw; attribute float aBendWeight;
          uniform float uTime; uniform vec2 uWindDir; uniform float uWindStr; uniform float uGust;
          uniform int uDistCount; uniform vec4 uDistA[${MAX_DIST}]; uniform vec4 uDistB[${MAX_DIST}];
          uniform float uBendScale;
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
          transformed.xz += bend * uBendScale * aBendWeight;`);
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
      // per-instance color: baked (trees/bushes → light brightness variation so the
      // trunk/leaf bake shows), palette pick (flowers), or colorA→B lerp (grass)
      if (this.vertexColors) { const g = 0.82 + Math.random() * 0.3; this._ct.setRGB(g, g, g); }
      else if (this.palette) this._ct.copy(this.palette[(Math.random() * this.palette.length) | 0]);
      else this._ct.copy(this._cA).lerp(this._cB, p.tint ?? Math.random());
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

// ── more flora niches. All carry aBendWeight (0=root → 1=tip) + uv so the shared
// FloraField bend shader animates them the same way. Trees/bushes bake per-vertex
// colors (trunk brown, leaves green) → FloraField({ vertexColors:true }). Flowers
// carry no color (FloraField({ palette:[...] }) tints the bloom per instance). ──

/** tag a positioned sub-geometry with a flat color + a y-based bend weight
 *  (rigid up to 20% height, then eases to full sway at the top). */
function _tag(g0, height, rgb) {
  // de-index so every part is non-indexed — mergeGeometries needs all parts the
  // same (Cylinder/Cone are indexed, Icosahedron is not; mixing them fails).
  const geo = g0.index ? g0.toNonIndexed() : g0;
  const pos = geo.attributes.position, n = pos.count;
  const col = new Float32Array(n * 3), bw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (rgb) { col[i * 3] = rgb[0]; col[i * 3 + 1] = rgb[1]; col[i * 3 + 2] = rgb[2]; }
    bw[i] = Math.max(0, Math.min(1, (pos.getY(i) / height - 0.2) / 0.8));
  }
  if (rgb) geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aBendWeight", new THREE.BufferAttribute(bw, 1));
  if (!geo.attributes.uv) geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return geo;
}

/** FLOWER: thin stem + a radiating bloom. No baked color — FloraField palette
 *  tints the whole flower per instance (stylized). */
export function makeFlower({ stemH = 0.32, petals = 6, bloom = 0.12, seed = 1 } = {}) {
  let s = seed * 2246 + 13; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const P = [], N = [], U = [], BW = [], I = []; let v = 0;
  const vert = (x, y, z, bw) => { P.push(x, y, z); N.push(0, 1, 0); U.push(0, bw); BW.push(bw); return v++; };
  const sw = 0.012;
  for (const [ax, az] of [[1, 0], [0, 1]]) {                 // stem: 2 crossed quads
    const dx = ax * sw, dz = az * sw;
    const a = vert(-dx, 0, -dz, 0), b = vert(dx, 0, dz, 0), c = vert(-dx, stemH, -dz, 0.6), d = vert(dx, stemH, dz, 0.6);
    I.push(a, c, b, b, c, d);
  }
  const ctr = vert(0, stemH, 0, 1);                          // bloom: petal fan
  for (let p = 0; p < petals; p++) {
    const a0 = (p / petals) * 6.2832, a1 = ((p + 1) / petals) * 6.2832, r = bloom * (0.8 + rnd() * 0.4), up = bloom * 0.4;
    const p0 = vert(Math.cos(a0) * r, stemH + up, Math.sin(a0) * r, 1);
    const p1 = vert(Math.cos(a1) * r, stemH + up, Math.sin(a1) * r, 1);
    I.push(ctr, p0, p1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
  g.setAttribute("aBendWeight", new THREE.Float32BufferAttribute(BW, 1));
  g.setIndex(I);
  return g;
}

/** BUSH: a few overlapping low-poly leaf blobs (green via FloraField colorA→B). */
export function makeBush({ size = 0.7 } = {}) {
  const blobs = [[0, size * 0.45, 0, size * 0.45], [size * 0.28, size * 0.35, 0.1, size * 0.32], [-size * 0.22, size * 0.4, -0.15, size * 0.3]];
  const parts = blobs.map(([x, y, z, r]) => { const b = new THREE.IcosahedronGeometry(r, 0); b.translate(x, y, z); return _tag(b, size, null); });
  return mergeGeometries(parts, false);
}

/** PINE: tapered trunk + stacked cone crown (tall, narrow). Baked colors. */
export function makePineTree({ height = 6, trunkR = 0.12 } = {}) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(trunkR * 0.6, trunkR, height, 6); trunk.translate(0, height / 2, 0);
  parts.push(_tag(trunk, height, [0.34, 0.25, 0.16]));
  const layers = 4;
  for (let k = 0; k < layers; k++) {
    const t = k / (layers - 1);
    const cone = new THREE.ConeGeometry(trunkR * (5.5 - t * 4), height * 0.3, 7);
    cone.translate(0, height * (0.35 + t * 0.6), 0);
    parts.push(_tag(cone, height, [0.13 + t * 0.05, 0.32 + t * 0.04, 0.15]));
  }
  return mergeGeometries(parts, false);
}

/** OAK: thick trunk + a rounded low-poly canopy. Baked colors. */
export function makeOakTree({ height = 5, trunkR = 0.17 } = {}) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(trunkR * 0.7, trunkR, height * 0.55, 6); trunk.translate(0, height * 0.275, 0);
  parts.push(_tag(trunk, height, [0.36, 0.26, 0.16]));
  const canopy = [[0, height * 0.72, 0, height * 0.34], [height * 0.2, height * 0.62, 0.12, height * 0.24],
    [-height * 0.18, height * 0.66, -0.13, height * 0.23], [0, height * 0.88, 0, height * 0.2]];
  for (const [x, y, z, r] of canopy) { const b = new THREE.IcosahedronGeometry(r, 0); b.translate(x, y, z); parts.push(_tag(b, height, [0.2, 0.38, 0.18])); }
  return mergeGeometries(parts, false);
}
