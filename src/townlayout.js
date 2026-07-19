// PlayForge town layout — arranges buildings into coherent towns that FRONT the roads.
// Owned by General (#town-layout slice, follows the road network).
//
// Pure + decoupled like roadgen: settlements + the RoadGraph + a building catalog in →
// building PLACEMENTS out ({x, z, rotY, type, footprint}). Knows nothing about meshes —
// the caller instantiates the real tileset piece per `type` (Ninja's asset pipeline).
//
// Layout rule (why towns read as towns, not scatter): for each settlement, walk its
// nearest road and drop lots in rows on BOTH shoulders, each building rotated to FACE the
// road, spaced by footprint + gap, set back past the road edge, on land, off the tarmac.

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const hyp = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/**
 * @param {object} opts
 * @param {Array<{x,z,r?,type?}>} opts.settlements
 * @param {import('./roadgen.js').RoadGraph} opts.roadGraph
 * @param {Array<{type:string, w:number, d:number}>} [opts.catalog]  building footprints
 * @param {(x,z)=>number} opts.heightAt
 * @param {number} [opts.sea=0]
 * @param {number} [opts.seed=7777]
 * @returns {Array<{x,z,rotY,type,w,d}>}
 */
export function layoutTowns({ settlements = [], roadGraph, catalog, heightAt = () => 1, sea = 0, seed = 7777 }) {
  // Real PlayForge building prefabs (Asset Drop/Buildings). Footprints here are PROVISIONAL —
  // the mount overrides w/d with the exact bbox Ninja's FBX import measures per type.
  const cat = (catalog && catalog.length) ? catalog
    : [
        { type: "trailerhouse_01", w: 4, d: 12 },
        { type: "trailerhouse_02", w: 4, d: 12 },
        { type: "gasstation", w: 14, d: 11 },
        { type: "barn", w: 12, d: 16 },
      ];
  const rand = rng(seed);
  const placements = [];
  const road = roadGraph;

  for (const s of settlements) {
    if (heightAt(s.x, s.z) <= sea + 0.5) continue;
    const R = s.r ?? 80;
    // find the road running through/near this settlement, then walk it
    const anchor = road?.nearestOnRoad(s.x, s.z);
    if (!anchor) continue;
    const roadInfo = road.roads[anchor.roadId];
    const roadW = roadInfo.width;
    // walk the road across the settlement footprint, dropping lots on both sides
    const span = Math.min(roadInfo.length, R * 2.2);
    let arc = Math.max(0, anchor.arc - span / 2);
    const end = Math.min(roadInfo.length, anchor.arc + span / 2);
    let guard = 0;
    while (arc < end && guard++ < 200) {
      const at = road.advance(anchor.roadId, arc, 0);
      const [tx, tz] = at.tangent;             // road direction
      const nx = tz, nz = -tx;                  // right normal
      const pick = cat[Math.floor(rand() * cat.length)];
      const step = Math.max(pick.w, 9) + 3 + rand() * 3;  // spacing along the road
      for (const side of [1, -1]) {
        if (rand() < 0.15) continue;            // occasional gap for variety
        const setback = roadW * 0.5 + 3 + pick.d * 0.5;
        const bx = at.point[0] + nx * side * setback;
        const bz = at.point[1] + nz * side * setback;
        if (heightAt(bx, bz) <= sea + 0.8) continue;                 // not in water
        if (hyp(bx, bz, s.x, s.z) > R * 1.6) continue;               // stay in town
        // face the road: front (+z of the model) points back toward the road
        const rotY = Math.atan2(-nx * side, -nz * side);
        placements.push({ x: +bx.toFixed(1), z: +bz.toFixed(1), rotY: +rotY.toFixed(3), type: pick.type, w: pick.w, d: pick.d });
      }
      arc += step;
    }
  }
  return placements;
}
