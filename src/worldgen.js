import * as THREE from "three";
import { fbm, ridged, mulberry } from "./noise.js";

/**
 * makeIslandTerrain — realistic island via HEIGHTMAP + PROCEDURAL:
 *
 *   1. bake a coarse procedural macro shape into a grid (island falloff + ridged
 *      mountain ranges),
 *   2. run a HYDRAULIC EROSION pass over that grid — thousands of water droplets
 *      run downhill, cutting drainage valleys + river channels and depositing
 *      sediment in the lowlands. This is what pure noise can't do: real
 *      geography (branching valleys, sharp ridgelines, alluvial plains),
 *   3. heightAt = bilinear-sample the eroded heightmap (macro) + high-frequency
 *      procedural noise (micro detail), so detail stays crisp below the grid's
 *      cell size and the world can still be sampled anywhere.
 *
 * The bake runs once at construction (~0.5s for a 512² grid). Returns
 * { heightAt, colorAt, waterMesh } for StreamedTerrain.  ?erode=0 to A/B.
 */
export function makeIslandTerrain({
  seed = 1337, islandR = 1500, sea = 0,
  gridN = 512, erosion = true, droplets = 60000, detail = true,
} = {}) {
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
  const PEAK = 240;
  const EXT = islandR * 2.2;          // grid covers [-EXT/2, EXT/2] in x and z
  const W = gridN + 1;                // grid vertices per side
  const cell = EXT / gridN;
  const half = EXT / 2;

  // ── 1. macro shape: domain-warped island falloff + ridged mountain ranges ──
  function macroAt(x, z) {
    const wf = 0.7 / islandR;
    const wax = x + fbm(x * wf + 11, z * wf + 11, { octaves: 2, seed: seed + 3 }) * islandR * 0.11;
    const waz = z + fbm(x * wf + 31, z * wf + 31, { octaves: 2, seed: seed + 4 }) * islandR * 0.11;
    const nx = wax / islandR, nz = waz / islandR, d = Math.hypot(nx, nz);
    const coastN = fbm(nx * 2.4 + 7, nz * 2.4 + 7, { octaves: 3, seed: seed + 9 });
    const shore = 0.82 + coastN * 0.22;
    const land = smooth((shore - d) / 0.30);
    if (land <= 0) return sea - 3 - smooth((d - shore) / 0.6) * 45;   // sea floor
    const relief = fbm(nx * 5 + 20, nz * 5 + 20, { octaves: 4, seed }) * 0.5 + 0.5;
    const range = clamp01(fbm(nx * 1.4 + 50, nz * 1.4 + 50, { octaves: 2, seed: seed + 21 }) * 2.1 + 0.28);
    const rg = ridged(nx * 5.5 + 3, nz * 5.5 + 3, { octaves: 5, seed: seed + 7 });
    const peak = Math.pow(rg, 1.2) * range;
    return land * (4 + relief * 18 + peak * peak * PEAK);
  }

  const H = new Float32Array(W * W);
  for (let j = 0; j < W; j++)
    for (let i = 0; i < W; i++)
      H[j * W + i] = macroAt(i * cell - half, j * cell - half);

  // ── 2. hydraulic erosion (droplet model) ──
  if (erosion) erodeHeightmap(H, W, seed, droplets);

  // ── 3. bilinear grid sampler + procedural micro-detail ──
  function sample(x, z) {
    const fx = (x + half) / cell, fz = (z + half) / cell;
    if (fx < 0 || fx >= gridN || fz < 0 || fz >= gridN) return sea - 8;   // beyond the island = open sea
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, o = j * W + i;
    const a = H[o], b = H[o + 1], c = H[o + W], e = H[o + W + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + e * u) * v;
  }
  function heightAt(x, z) {
    const macro = sample(x, z);
    if (!detail || macro < sea + 0.3) return macro;
    const dt = fbm(x * 0.035 + 70, z * 0.035 + 70, { octaves: 3, seed: seed + 80 }) * 2.4
             + (ridged(x * 0.09 + 5, z * 0.09 + 5, { octaves: 2, seed: seed + 81 }) - 0.5) * 1.8;
    return macro + dt * clamp01((macro - sea) / 3);   // fade detail in above the waterline
  }

  // ── biome colouring: height + slope + moisture ──
  const C = {
    seabed: new THREE.Color(0x274b60), sand: new THREE.Color(0xdac48a),
    grass: new THREE.Color(0x4f8f47), lush: new THREE.Color(0x2f6b39),
    dry: new THREE.Color(0x8a9a52), rock: new THREE.Color(0x776f66),
    scree: new THREE.Color(0x928a80), snow: new THREE.Color(0xf3f5f8),
  };
  function colorAt(x, z, h, slope, out) {
    if (h < sea - 0.2) { out.copy(C.seabed); return; }
    if (h < sea + 1.8) { out.copy(C.sand); return; }                    // beach
    if (slope > 1.0 || h > PEAK * 0.5) {                                // carved walls, cliffs, high ground
      out.copy((h > PEAK * 0.6 && slope < 1.0) ? C.snow : slope > 1.3 ? C.rock : C.scree);
      return;
    }
    const moist = fbm(x * 0.0035 + 90, z * 0.0035 + 90, { octaves: 2, seed: seed + 55 }) * 0.5 + 0.5;
    out.copy(C.grass).lerp(C.lush, clamp01(moist * 1.3 - 0.15)).lerp(C.dry, clamp01(0.35 - moist) * 1.6);
    if (h > PEAK * 0.36) out.lerp(C.scree, smooth((h - PEAK * 0.36) / (PEAK * 0.2)) * 0.7);   // treeline
  }

  function waterMesh(size = islandR * 4) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: 0x2b6d90, transparent: true, opacity: 0.82, roughness: 0.25, metalness: 0.1 }));
    m.rotation.x = -Math.PI / 2; m.position.y = sea;
    return m;
  }

  /**
   * BACKDROP: one coarse static mesh of the WHOLE island, so it's visible from
   * altitude out to the horizon without streaming thousands of tiles. Sits a hair
   * below the surface (drop) so the high-detail streamed tiles always win where
   * they overlap near the camera; the offset is invisible at distance/haze.
   */
  function backdropMesh(res = 256, drop = 0.5) {
    const N = res + 1, step = EXT / res;
    const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3), nrm = new Float32Array(N * N * 3);
    const c = new THREE.Color();
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const wx = -half + i * step, wz = -half + j * step, o = (j * N + i) * 3;
        const h = heightAt(wx, wz);
        pos[o] = wx; pos[o + 1] = h - drop; pos[o + 2] = wz;
        const dhdx = (heightAt(wx + step, wz) - heightAt(wx - step, wz)) / (2 * step);
        const dhdz = (heightAt(wx, wz + step) - heightAt(wx, wz - step)) / (2 * step);
        const inv = 1 / Math.hypot(dhdx, 1, dhdz);
        nrm[o] = -dhdx * inv; nrm[o + 1] = inv; nrm[o + 2] = -dhdz * inv;
        colorAt(wx, wz, h, Math.max(Math.abs(dhdx), Math.abs(dhdz)), c);
        col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      }
    const idx = [];
    for (let j = 0; j < res; j++)
      for (let i = 0; i < res; i++) { const a = j * N + i, b = a + 1, d = a + N, e = d + 1; idx.push(a, d, b, b, d, e); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96 }));
    mesh.receiveShadow = true;
    return mesh;
  }

  return { heightAt, colorAt, waterMesh, backdropMesh, islandR, sea, PEAK, extent: EXT };
}

/**
 * Droplet hydraulic erosion (Beyer / Lague model). Each droplet runs downhill
 * carrying water + sediment: it picks up soil on steep descents (up to a
 * speed/water-scaled capacity) and drops it when it slows or climbs, cutting
 * dendritic valleys and laying sediment fans. Mutates H in place. Erosion is
 * spread over a small brush so channels are smooth, not single-pixel gouges.
 */
function erodeHeightmap(H, W, seed, droplets) {
  const N = W - 1;
  const rnd = mulberry((seed ^ 0x9e3779b9) >>> 0);
  const MAX_STEPS = 30, INERTIA = 0.05, CAP = 4.0, MIN_SLOPE = 0.01,
        DEPOSIT = 0.3, ERODE = 0.3, EVAP = 0.02, GRAV = 12, R = 2;

  // erosion brush: offsets + normalized weights within radius R (smooth channels)
  const bOff = [], bW = []; let bSum = 0;
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const dd = Math.hypot(dx, dy);
      if (dd > R) continue;
      const w = 1 - dd / R; bOff.push(dx, dy); bW.push(w); bSum += w;
    }
  for (let k = 0; k < bW.length; k++) bW[k] /= bSum;

  const hg = (i, j) => H[j * W + i];
  // bilinear height + gradient at fractional grid coords
  function probe(px, pz) {
    const i = px | 0, j = pz | 0, u = px - i, v = pz - j, o = j * W + i;
    const nw = H[o], ne = H[o + 1], sw = H[o + W], se = H[o + W + 1];
    return {
      h: nw * (1 - u) * (1 - v) + ne * u * (1 - v) + sw * (1 - u) * v + se * u * v,
      gx: (ne - nw) * (1 - v) + (se - sw) * v,
      gz: (sw - nw) * (1 - u) + (se - ne) * u,
      i, j, u, v,
    };
  }
  function depositBilinear(i, j, u, v, amt) {
    H[j * W + i] += amt * (1 - u) * (1 - v);
    H[j * W + i + 1] += amt * u * (1 - v);
    H[(j + 1) * W + i] += amt * (1 - u) * v;
    H[(j + 1) * W + i + 1] += amt * u * v;
  }
  function erodeBrush(i, j, amt) {
    for (let k = 0; k < bW.length; k++) {
      const bi = i + bOff[k * 2], bj = j + bOff[k * 2 + 1];
      if (bi < 0 || bi > N || bj < 0 || bj > N) continue;
      H[bj * W + bi] -= amt * bW[k];
    }
  }

  for (let d = 0; d < droplets; d++) {
    let px = 1 + rnd() * (N - 2), pz = 1 + rnd() * (N - 2);
    let dx = 0, dz = 0, speed = 1, water = 1, sed = 0;
    for (let s = 0; s < MAX_STEPS; s++) {
      const p = probe(px, pz);
      dx = dx * INERTIA - p.gx * (1 - INERTIA);
      dz = dz * INERTIA - p.gz * (1 - INERTIA);
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) { dx = rnd() - 0.5; dz = rnd() - 0.5; } else { dx /= len; dz /= len; }
      px += dx; pz += dz;
      if (px < 1 || px > N - 1 || pz < 1 || pz > N - 1) break;
      const dH = probe(px, pz).h - p.h;                 // + uphill, − downhill
      if (dH >= 0) {                                    // hit a pit/slope up → drop sediment to fill
        const dep = Math.min(dH + 1e-3, sed);
        depositBilinear(p.i, p.j, p.u, p.v, dep); sed -= dep;
      } else {
        const cap = Math.max(-dH, MIN_SLOPE) * speed * water * CAP;
        if (sed > cap) {
          const dep = (sed - cap) * DEPOSIT;
          depositBilinear(p.i, p.j, p.u, p.v, dep); sed -= dep;
        } else {
          const ero = Math.min((cap - sed) * ERODE, -dH);
          erodeBrush(p.i, p.j, ero); sed += ero;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dH * GRAV));   // downhill (dH<0) speeds up
      water *= (1 - EVAP);
      if (water < 0.01) break;
    }
  }
}
