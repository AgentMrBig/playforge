// PlayForge road network — procedurally lays roads over the island and exposes a
// graph traffic can follow. Owned by General (#road-network slice).
//
// road.js (Ninja) is the place-and-RENDER tool (addRoad → terrain-conforming ribbon +
// lane paint). This module is the two missing pieces:
//   1) generateRoads(island) — where the roads GO: a ring/artery network wiring the
//      settlements together, routed to dodge water and stay on drivable land.
//   2) RoadGraph — a queryable follow-the-road API for AI cars: nearestOnRoad(),
//      advance(), laneTarget(). Pure data, no THREE, no rendering.
//
// Fully decoupled: island data in, road polylines + graph out. The caller feeds the
// polylines to a RoadNetwork for the visuals and hands the graph to the traffic AI.

/** deterministic hash → [0,1) so a given seed lays the same roads every load. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const hyp = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/**
 * Build the island's road network.
 * @param {object} island
 * @param {Array<{x,z,r?}>} island.settlements  town/city centers (roads wire these)
 * @param {(x:number,z:number)=>number} island.heightAt  terrain sampler
 * @param {number} [island.sea=0]        water level — roads never dip below this
 * @param {number} [island.islandR=1500] island radius (for the coastal pull)
 * @param {object} [island.runway]       {x0,z,len} — gets a spur road
 * @param {number} [island.seed=7777]
 * @returns {{ roads: Array<{points:number[][], width:number, kind:string}>, graph: RoadGraph }}
 */
export function generateRoads(island) {
  const { settlements = [], heightAt = () => 1, sea = 0, islandR = 1500, runway = null, seed = 7777 } = island;
  const rand = rng(seed);
  const roads = [];

  // waypoints = settlement centers that sit on land
  const towns = settlements.filter((s) => heightAt(s.x, s.z) > sea + 0.5).map((s) => ({ x: s.x, z: s.z, r: s.r ?? 80 }));

  // ---- route ONE road between two points, dodging water/steep by nudging inland ----
  // Roads conform to terrain vertically in road.js; here we only shape the PLAN path.
  const routeEdge = (a, b) => {
    const steps = Math.max(3, Math.round(hyp(a.x, a.z, b.x, b.z) / 90));
    const pts = [[a.x, a.z]];
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      let x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      // if this midpoint is under water or on a steep face, pull it toward island center
      let tries = 0;
      while (tries++ < 6) {
        const h = heightAt(x, z);
        const hN = heightAt(x + 6, z), hE = heightAt(x, z + 6);
        const grade = Math.max(Math.abs(hN - h), Math.abs(hE - h)) / 6;
        if (h > sea + 1.5 && grade < 0.6) break;          // good spot
        const cx = -x / (islandR || 1), cz = -z / (islandR || 1);  // dir to center
        const d = Math.hypot(cx, cz) || 1;
        x += (cx / d) * 55; z += (cz / d) * 55;           // step inland
      }
      pts.push([+x.toFixed(1), +z.toFixed(1)]);
    }
    pts.push([b.x, b.z]);
    return pts;
  };

  if (towns.length >= 2) {
    // order towns by angle around the island center → a coastal RING road
    const cx = towns.reduce((s, t) => s + t.x, 0) / towns.length;
    const cz = towns.reduce((s, t) => s + t.z, 0) / towns.length;
    const ring = [...towns].sort((p, q) => Math.atan2(p.z - cz, p.x - cx) - Math.atan2(q.z - cz, q.x - cx));
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (ring.length === 2 && i === 1) break;            // 2 towns → one road, not a doubled edge
      roads.push({ points: routeEdge(a, b), width: 13, kind: "artery" });
    }
    // one cross-island connector so the map isn't just a loop (link two opposite towns)
    if (ring.length >= 4) {
      const a = ring[0], b = ring[Math.floor(ring.length / 2)];
      roads.push({ points: routeEdge(a, b), width: 11, kind: "connector" });
    }
  } else if (towns.length === 1 && runway) {
    roads.push({ points: routeEdge(towns[0], { x: runway.x0, z: runway.z }), width: 12, kind: "artery" });
  }

  // runway spur: connect the crash-test runway to the nearest town
  if (runway && towns.length) {
    let near = towns[0], best = Infinity;
    for (const t of towns) { const d = hyp(t.x, t.z, runway.x0, runway.z); if (d < best) { best = d; near = t; } }
    roads.push({ points: routeEdge(near, { x: runway.x0, z: runway.z }), width: 10, kind: "spur" });
  }

  return { roads, graph: new RoadGraph(roads) };
}

/**
 * RoadGraph — the follow-the-road API for traffic AI. Densifies each road polyline into
 * evenly-spaced samples so an AI car can snap to the road and drive along it in a lane.
 * Pure math, world (x,z) space — no THREE.
 */
export class RoadGraph {
  /** @param {Array<{points:number[][], width:number}>} roads */
  constructor(roads = []) {
    this.lanes = 2;
    this.roads = roads.map((r, id) => {
      // densify to ~4m spacing with cumulative arc length + per-sample tangent
      const src = r.points;
      const s = [];
      for (let i = 0; i < src.length - 1; i++) {
        const [ax, az] = src[i], [bx, bz] = src[i + 1];
        const segLen = hyp(ax, az, bx, bz);
        const n = Math.max(1, Math.round(segLen / 4));
        for (let k = 0; k < n; k++) {
          const t = k / n;
          s.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t });
        }
      }
      s.push({ x: src[src.length - 1][0], z: src[src.length - 1][1] });
      let len = 0;
      for (let i = 0; i < s.length; i++) {
        const p = s[i], q = s[Math.min(s.length - 1, i + 1)], o = s[Math.max(0, i - 1)];
        s[i].d = len; if (i < s.length - 1) len += hyp(p.x, p.z, q.x, q.z);
        const tx = q.x - o.x, tz = q.z - o.z, tl = Math.hypot(tx, tz) || 1;
        s[i].tx = tx / tl; s[i].tz = tz / tl;              // unit tangent
      }
      return { id, width: r.width, samples: s, length: len };
    });
  }

  /** nearest point across ALL roads to (x,z). Returns lane/heading info for the AI. */
  nearestOnRoad(x, z) {
    let best = null, bd = Infinity;
    for (const road of this.roads) {
      for (let i = 0; i < road.samples.length; i++) {
        const s = road.samples[i];
        const d = hyp(x, z, s.x, s.z);
        if (d < bd) { bd = d; best = { road, i, s }; }
      }
    }
    if (!best) return null;
    const { road, i, s } = best;
    return {
      roadId: road.id, index: i, dist: bd,
      point: [s.x, s.z], tangent: [s.tx, s.tz],
      onRoad: bd <= road.width * 0.5 + 1,
      // lane center: offset half-lane to the driving side (right-hand: +right normal)
      laneRight: [s.x + s.tz * road.width * 0.25, z * 0 + s.z - s.tx * road.width * 0.25],
      arc: s.d, roadLength: road.length,
    };
  }

  /** advance `dist` metres along a road from arc position `arc`; wraps past the end. */
  advance(roadId, arc, dist) {
    const road = this.roads[roadId]; if (!road) return null;
    let a = (arc + dist) % road.length; if (a < 0) a += road.length;
    // find the sample bracketing arc `a`
    let lo = 0; for (let i = 0; i < road.samples.length; i++) { if (road.samples[i].d <= a) lo = i; else break; }
    const s = road.samples[lo];
    return { point: [s.x, s.z], tangent: [s.tx, s.tz], arc: a };
  }

  /** a lane-center target `ahead` metres in front of world pos (for steering an AI car). */
  laneTarget(x, z, ahead = 12) {
    const n = this.nearestOnRoad(x, z);
    if (!n) return null;
    const adv = this.advance(n.roadId, n.arc, ahead) ?? { point: n.point, tangent: n.tangent };
    const [tx, tz] = adv.tangent, w = this.roads[n.roadId].width;
    // push the target to the right-hand lane center
    return [adv.point[0] + tz * w * 0.25, adv.point[1] - tx * w * 0.25];
  }

  // ---- fast road membership test — for BAKING roads into the terrain surface
  // (vertex-color in colorAt) + skipping decoration on roads. nearestOnRoad is
  // O(all samples); this is O(nearby segments) via a spatial hash of segments,
  // cheap enough to call per terrain vertex. Roads become part of the map, not
  // a floating mesh (Erik 2026-07-20). ------------------------------------------
  _buildIndex() {
    const CELL = 24;                                    // > max road width; 3x3 neighborhood covers any hit
    this._cell = CELL;
    this._grid = new Map();
    const add = (cx, cz, seg) => { const k = cx + "," + cz; let a = this._grid.get(k); if (!a) { a = []; this._grid.set(k, a); } a.push(seg); };
    for (const road of this.roads) {
      const hw = road.width * 0.5;
      for (let i = 0; i < road.samples.length - 1; i++) {
        const a = road.samples[i], b = road.samples[i + 1];
        const seg = { ax: a.x, az: a.z, bx: b.x, bz: b.z, hw };
        const minx = Math.min(a.x, b.x) - hw, maxx = Math.max(a.x, b.x) + hw;
        const minz = Math.min(a.z, b.z) - hw, maxz = Math.max(a.z, b.z) + hw;
        for (let cx = Math.floor(minx / CELL); cx <= Math.floor(maxx / CELL); cx++)
          for (let cz = Math.floor(minz / CELL); cz <= Math.floor(maxz / CELL); cz++)
            add(cx, cz, seg);
      }
    }
  }

  _distToSeg(px, pz, s) {
    const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz;
    let t = l2 ? ((px - s.ax) * dx + (pz - s.az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (s.ax + t * dx), pz - (s.az + t * dz));
  }

  /** is world (x,z) on a road surface? `pad` widens the test (e.g. keep grass a
   *  bit off the shoulder). Fast — checks only segments in the local 3x3 cells. */
  isRoad(x, z, pad = 0) {
    if (!this._grid) this._buildIndex();
    const C = this._cell, cx = Math.floor(x / C), cz = Math.floor(z / C);
    for (let gx = cx - 1; gx <= cx + 1; gx++)
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const segs = this._grid.get(gx + "," + gz);
        if (!segs) continue;
        for (const s of segs) if (this._distToSeg(x, z, s) <= s.hw + pad) return true;
      }
    return false;
  }
}
