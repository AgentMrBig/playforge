// PlayForge road tiling — snaps the RoadGraph onto the asset pack's 16m grid and emits
// one road-tile placement (role + yaw) per occupied cell. Pure: RoadGraph in, tile
// placements out — no THREE, no loadProp. Owned by General (#road-tiles slice).
//
// The pack author's Demonstration.fbx established the grammar (demo/data/demonstration-
// layout.json): full SM_road_* tiles on a strict 16m grid, quarter tiles at 4m joins,
// sidewalk props 1.5–4m off the edge. This module is the bridge from my procedural
// RoadGraph to that real tiled geometry.
//
// Design: the autotiler is mesh-AGNOSTIC. It classifies each cell by its N/E/S/W road
// neighbours into a ROLE (straight | corner | tee | cross | end) and a yaw in MY
// convention. The role→SM_road_* file map and each tile's authored-pivot + per-role yaw
// offset are applied at mount (mountRoadTiles), so calibration never touches this logic.

// dir index → grid step. N=-z, E=+x, S=+z, W=-x (clockwise from north).
const DIRS = [
  { d: 0, dx: 0, dz: -1 }, // N
  { d: 1, dx: 1, dz: 0 },  // E
  { d: 2, dx: 0, dz: 1 },  // S
  { d: 3, dx: -1, dz: 0 }, // W
];
const key = (cx, cz) => cx + "," + cz;
const has = (mask, d) => (mask & (1 << d)) !== 0;

/**
 * Mark every grid cell a road passes through, 4-CONNECTED. Roads are diagonal/curvy, so
 * a naive 8-connected raster leaves cells touching only at corners — the N/E/S/W autotiler
 * then reads those as false end-caps. Walking the dense (~4m) samples and stepping
 * orthogonally (x then z) guarantees each diagonal becomes a proper staircase of
 * orthogonally-adjacent cells: no phantom ends, corners only at real bends.
 */
function markRoadCells(cells, samples, grid) {
  let prev = null;
  for (const s of samples) {
    const cx = Math.floor(s.x / grid), cz = Math.floor(s.z / grid);
    if (!prev) { cells.add(key(cx, cz)); prev = [cx, cz]; continue; }
    let [px, pz] = prev, guard = 0;
    while ((px !== cx || pz !== cz) && guard++ < 5000) {
      if (px !== cx) px += Math.sign(cx - px);
      else pz += Math.sign(cz - pz);
      cells.add(key(px, pz));
    }
    prev = [cx, cz];
  }
}

/** mask → { role, yaw } in this module's convention (yaw degrees, calibrated at mount). */
function classify(mask) {
  const bits = [0, 1, 2, 3].filter((d) => has(mask, d));
  const n = bits.length;
  if (n === 4) return { role: "cross", yaw: 0 };
  if (n === 3) { const missing = [0, 1, 2, 3].find((d) => !has(mask, d)); return { role: "tee", yaw: missing * 90 }; }
  if (n === 2) {
    if (has(mask, 0) && has(mask, 2)) return { role: "straight", yaw: 90 }; // N–S
    if (has(mask, 1) && has(mask, 3)) return { role: "straight", yaw: 0 };  // E–W
    const cornerYaw = { "0,1": 0, "1,2": 90, "2,3": 180, "0,3": 270 };      // N,E / E,S / S,W / N,W
    return { role: "corner", yaw: cornerYaw[bits.join(",")] ?? 0 };
  }
  if (n === 1) return { role: "end", yaw: bits[0] * 90 };
  return { role: "straight", yaw: 0 }; // isolated cell
}

/**
 * @param {{roads:Array<{samples:Array<{x,z}>}>}} roadGraph  a RoadGraph (roadgen.js)
 * @param {object} [opts]
 * @param {number} [opts.grid=16]  cell size in metres (pack grammar = 16)
 * @returns {{grid:number, cells:Set<string>, placements:Array<{role,yaw,cx,cz,x,z}>, tally:object}}
 */
export function roadGraphToTiles(roadGraph, { grid = 16 } = {}) {
  const cells = new Set();
  for (const road of roadGraph.roads) markRoadCells(cells, road.samples, grid);
  const placements = [];
  const tally = { straight: 0, corner: 0, tee: 0, cross: 0, end: 0 };
  for (const k of cells) {
    const [cx, cz] = k.split(",").map(Number);
    let mask = 0;
    for (const { d, dx, dz } of DIRS) if (cells.has(key(cx + dx, cz + dz))) mask |= (1 << d);
    const { role, yaw } = classify(mask);
    tally[role]++;
    placements.push({ role, yaw, cx, cz, x: cx * grid + grid / 2, z: cz * grid + grid / 2 });
  }
  return { grid, cells, placements, tally };
}

/**
 * mountRoadTiles — instantiate real road-tile meshes at the placements. Self-corrects the
 * authored pivot (reads each tile's bbox centre from loadProp and offsets onto the cell)
 * and applies a per-role yaw offset from the map. Fill `roleMap` once the SM_road_*
 * variants are identified (which file is straight/corner/tee/cross/end).
 *
 * @param {object} o
 * @param {object} o.world     needs .scene
 * @param {object} o.THREE
 * @param {Function} o.loadProp  (url) => Promise<{group,size}>
 * @param {object} o.roadGraph
 * @param {(x,z)=>number} o.heightAt
 * @param {Object<string,{url:string, yawOffset?:number}>} o.roleMap  role → mesh + calibration
 * @param {number} [o.grid=16]
 * @param {number} [o.yOffset=0.05]  lift to beat z-fighting with terrain
 * @returns {Promise<{count:number, group:object, tally:object}>}
 */
export async function mountRoadTiles({ world, THREE, loadProp, roadGraph, heightAt, roleMap, grid = 16, yOffset = 0.05 }) {
  const { placements, tally } = roadGraphToTiles(roadGraph, { grid });
  // load each distinct role mesh once, capture its pivot→centre offset in the XZ plane
  const srcByRole = {};
  for (const role of Object.keys(roleMap)) {
    const { group, size } = await loadProp(roleMap[role].url);
    const box = new THREE.Box3().setFromObject(group);
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    srcByRole[role] = { group, offX: cx, offZ: cz, size };
  }
  const tileGroup = new THREE.Group();
  tileGroup.name = "roadTiles";
  for (const p of placements) {
    const src = srcByRole[p.role];
    if (!src) continue;
    const g = src.group.clone(true);
    const yaw = (p.yaw + (roleMap[p.role].yawOffset || 0)) * Math.PI / 180;
    // rotate the pivot offset into place so the tile centres on the cell after yaw
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const ox = src.offX * cos - src.offZ * sin, oz = src.offX * sin + src.offZ * cos;
    g.rotation.y = yaw;
    g.position.set(p.x - ox, heightAt(p.x, p.z) + yOffset, p.z - oz);
    tileGroup.add(g);
  }
  world.scene.add(tileGroup);
  return { count: placements.length, group: tileGroup, tally };
}
