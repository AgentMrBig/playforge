// Procedural city generator: seeded grid city — roads, sidewalks, buildings
// with window textures, parks, streetlights. Returns the road graph for AI.
import { Collider, THREE } from "../src/index.js";

// deterministic RNG (mulberry32)
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- window texture variants (canvas, tiled per 3 world units) -------------
function windowTexture(base, lit, r) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = base; g.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      g.fillStyle = r() < 0.35 ? lit : "#1a2026";
      g.fillRect(x * 16 + 3, y * 16 + 3, 9, 11);
    }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function makeMaterials(r) {
  const defs = [
    ["#3a4048", "#ffe9a8"], // steel gray
    ["#5a4438", "#ffd9a0"], // brick brown
    ["#2e4a5e", "#bfe6ff"], // glass blue
    ["#6b6154", "#fff0c0"], // beige
  ];
  return defs.map(([base, lit]) => ({
    side: new THREE.MeshStandardMaterial({ map: windowTexture(base, lit, r), roughness: 0.8 }),
    roof: new THREE.MeshStandardMaterial({ color: new THREE.Color(base).multiplyScalar(0.55), roughness: 1 }),
  }));
}

// scale box UVs so windows tile every ~3 world units on the sides
function buildingGeometry(w, h, d) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv, nrm = geo.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i));
    if (ny > 0.5) { uv.setXY(i, uv.getX(i) * w / 3, uv.getY(i) * d / 3); }
    else {
      const horiz = nx > 0.5 ? d : w;
      uv.setXY(i, uv.getX(i) * horiz / 3, uv.getY(i) * h / 3);
    }
  }
  return geo;
}

/**
 * generateCity(world, seed, opts) → { grid, cell, roads, spawn }
 *   grid: N (city is N×N blocks) · cell: world units per block+road
 *   roads: { lines: [coord...], laneOffset } for car AI
 */
export function generateCity(world, seed = 1337, { N = 8, CELL = 26, ROAD = 7 } = {}) {
  const r = rng(seed);
  const mats = makeMaterials(r);
  const size = N * CELL + ROAD;           // total city span
  const half = size / 2;
  const blockW = CELL - ROAD;             // buildable block width
  const SW = 2.2;                          // sidewalk depth

  // ground (one big collider) — asphalt base
  world.spawn("ground")
    .mesh(receiving(new THREE.Mesh(
      new THREE.BoxGeometry(size + 40, 1, size + 40),
      new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 1 }),
    )))
    .at(0, -0.5, 0)
    .add(new Collider({ size: [size + 40, 1, size + 40] }));

  // road lane dashes + sidewalks + blocks
  const dashMat = new THREE.MeshStandardMaterial({ color: 0xd8d3c3 });
  const sideMat = new THREE.MeshStandardMaterial({ color: 0x8f9297, roughness: 1 });
  const parkMat = new THREE.MeshStandardMaterial({ color: 0x3f7a3f, roughness: 1 });
  const dashes = [], walks = [];

  const lines = [];
  for (let i = 0; i <= N; i++) lines.push(-half + ROAD / 2 + i * CELL);

  // center dashes along every road line, both axes
  for (const c of lines) {
    for (let d = -half + 2; d < half - 2; d += 6) {
      dashes.push(box(0.35, 0.05, 2.6, c, 0.03, d + 1.3));
      dashes.push(box(2.6, 0.05, 0.35, d + 1.3, 0.03, c));
    }
  }
  world.spawn("dashes").mesh(mergedMesh(dashes, dashMat));

  // blocks: sidewalk slab + buildings or park
  for (let bx = 0; bx < N; bx++)
    for (let bz = 0; bz < N; bz++) {
      const cx = -half + ROAD + blockW / 2 + bx * CELL;
      const cz = -half + ROAD + blockW / 2 + bz * CELL;
      walks.push(box(blockW, 0.25, blockW, cx, 0.125, cz));
      // real curb: cars mount it (step-up), players hop it
      world.spawn("curb").at(cx, 0, cz)
        .add(new Collider({ size: [blockW, 0.5, blockW], offset: [0, 0, 0] }));

      const isPark = r() < 0.12;
      if (isPark) {
        world.spawn("park").mesh(receiving(new THREE.Mesh(
          new THREE.BoxGeometry(blockW - SW * 2, 0.1, blockW - SW * 2), parkMat,
        ))).at(cx, 0.3, cz);
        const trees = 3 + Math.floor(r() * 5);
        for (let t = 0; t < trees; t++) {
          const tx = cx + (r() - 0.5) * (blockW - 6), tz = cz + (r() - 0.5) * (blockW - 6);
          world.spawn("tree").mesh(makeTree(r)).at(tx, 0.3, tz);
        }
        continue;
      }

      // 2×2 lots per block, buildings with downtown height falloff
      const lotW = (blockW - SW * 2) / 2;
      for (let lx = 0; lx < 2; lx++)
        for (let lz = 0; lz < 2; lz++) {
          if (r() < 0.08) continue; // empty lot
          const px = cx - lotW / 2 + lx * lotW + (r() - 0.5) * 1.5;
          const pz = cz - lotW / 2 + lz * lotW + (r() - 0.5) * 1.5;
          const centerDist = Math.hypot(px, pz) / half; // 0 center → 1 edge
          const hMax = 42 * Math.pow(1 - centerDist, 1.8) + 6;
          const h = 4 + r() * hMax;
          const w = lotW * (0.62 + r() * 0.3), d = lotW * (0.62 + r() * 0.3);
          const m = mats[Math.floor(r() * mats.length)];
          const mesh = new THREE.Mesh(buildingGeometry(w, h, d),
            [m.side, m.side, m.roof, m.roof, m.side, m.side]);
          mesh.castShadow = true; mesh.receiveShadow = true;
          world.spawn("building").mesh(mesh).at(px, 0.25 + h / 2, pz)
            .add(new Collider({ size: [w, h, d] }));
        }
    }
  world.spawn("sidewalks").mesh(mergedMesh(walks, sideMat, true));

  // streetlights at intersections (emissive, no real lights — cheap)
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x30343a });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xffd75e, emissiveIntensity: 1.2 });
  for (const x of lines) for (const z of lines) {
    if (r() < 0.5) continue;
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 5, 6), poleMat);
    pole.position.y = 2.5;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), lampMat);
    lamp.position.y = 5.1;
    g.add(pole, lamp);
    world.spawn("lamp").mesh(g).at(x + ROAD / 2 - 0.6, 0, z + ROAD / 2 - 0.6);
  }

  return { N, CELL, ROAD, half, lines, laneOffset: ROAD / 4, spawn: [lines[0] + 2, 0.3, lines[0] + 2] };

  function box(w, h, d, x, y, z) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g;
  }
}

function makeTree(r) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.25, 1.4, 6),
    new THREE.MeshStandardMaterial({ color: 0x5a4432 }));
  trunk.position.y = 0.7;
  const crown = new THREE.Mesh(new THREE.ConeGeometry(1.1 + r() * 0.7, 2.4 + r() * 1.4, 7),
    new THREE.MeshStandardMaterial({ color: 0x2f6b33 }));
  crown.position.y = 2.4;
  crown.castShadow = true;
  g.add(trunk, crown);
  return g;
}

function mergedMesh(geos, mat, receive = false) {
  // manual merge: BufferGeometryUtils without the import ceremony
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  const idx = [];
  let vo = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx.push(gi[i] + vo);
    vo += g.attributes.position.count;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const m = new THREE.Mesh(geo, mat);
  if (receive) m.receiveShadow = true;
  return m;
}

function receiving(m) { m.receiveShadow = true; return m; }
