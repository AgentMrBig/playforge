// PLAYFORGE — THE MAP. A massive streamed island on REAL physics:
// Rapier rigid bodies everywhere (terrain tiles, buildings, obstacles, cars),
// the mocap character on foot, the textured fleet to drive, and a crash-test
// runway with a brick wall for the live-damage direction.
import {
  Engine, World, ThirdPersonRig, Audio, Collider, StreamedTerrain,
  PlayerVehicleControls, EngineSound, SkidMarks, Animator,
  loadVehicle, VehicleRig, loadCharacter, CarCollisions,
  initRapier, Physics, RapierVehicle, CharacterBody, Ragdoll,
  fbm, ridged, mulberry, THREE, HUD, Minimap, RoadNetwork, generateRoads, TouchControls,
  CombatSystem, CombatHUD, loadProp, CharacterAim, TestMode, VehicleTestMode, BlendController, FootPlant, DayNight, BehaviorPlayer, BehaviorTriggers, MotionRecorder,
  spawnPedestrians, TrajectoryLean,
} from "../src/index.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { mountPickups } from "../src/pickups.js";   // Ember: guns/ammo/health spawner
import { initLoadingScreen } from "../src/loadingscreen.js";   // Ember: hold reveal until built

const seed = Number(new URLSearchParams(location.search).get("seed")) || 7777;
const seedEl = document.getElementById("seed"); if (seedEl) seedEl.textContent = seed;
// build stamp so "which build am I on" is answerable at a glance
const BUILD = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev";
if (seedEl) seedEl.textContent = seed + " · build " + BUILD;

const engine = new Engine(document.getElementById("game"), { clearColor: 0x8fb9dc });
const world = new World();
const audio = new Audio();
engine.world = world;
world.scene.fog = new THREE.Fog(0x8fb9dc, 180, 620);
world.camera.far = 3000;
world.camera.updateProjectionMatrix();

// SKY (Ember, lighting lane): DayNight owns the sun, moon, sky bounce, fog +
// background color and exposure — a game-time clock (24h in 10 real minutes)
// drives the sun's real arc, warm dawns, dark playable nights (moonlight),
// and the phase-1 camera-following shadow box rides along.
// Seams: window.__pfSky.setHour(h) · URL ?hour=18 ?daylen=600 ?hour=off
const sky = new DayNight({ engine, world });
world.spawn("sky").mesh(sky.group).add({ update(dt) { sky.update(dt); } });

// ============================================================================
// WORLD GEN — one deterministic height function for a ~3km island
// ============================================================================
const ISLAND_R = 1500, SEA = 0;

const SETTLE_CELL = 420;
const settlements = [];
{
  for (let gz = -3; gz <= 3; gz++)
    for (let gx = -3; gx <= 3; gx++) {
      const h = mulberry((seed ^ (gx * 73856093) ^ (gz * 19349663)) >>> 0);
      if (h() < 0.35) continue;                       // empty cell
      const cx = gx * SETTLE_CELL + (h() - 0.5) * SETTLE_CELL * 0.5;
      const cz = gz * SETTLE_CELL + (h() - 0.5) * SETTLE_CELL * 0.5;
      const base = rawHeight(cx, cz);
      if (base < SEA + 3 || base > 26) continue;      // coastal/inland flats only
      const big = h() < 0.3;
      settlements.push({
        x: cx, z: cz, h: base,
        r: big ? 150 : 70,
        type: big ? "city" : "town",
        seed: Math.floor(h() * 1e9),
      });
    }
}

function rawHeight(x, z) {
  const nx = x / ISLAND_R, nz = z / ISLAND_R;
  const d = Math.hypot(nx, nz);
  const falloff = Math.max(0, 1 - d * d * 1.05);
  const base = fbm(nx * 2.6 + 10, nz * 2.6 + 10, { octaves: 5, seed }) * 0.5 + 0.5;
  const belt = fbm(nx * 1.3 + 40, nz * 1.3 + 40, { octaves: 2, seed: seed + 13 });
  const mtn = ridged(nx * 5, nz * 5, { octaves: 4, seed: seed + 7 });
  const inland = Math.max(0, falloff - 0.25) / 0.75;
  return -8 + falloff * (11 + base * 16) +
         inland * Math.max(0, belt) * mtn * 85;
}

function settleHeight(x, z) {
  let h = rawHeight(x, z);
  for (const s of settlements) {
    const d = Math.hypot(x - s.x, z - s.z);
    if (d < s.r * 1.5) {
      const t = 1 - Math.min(d / (s.r * 1.5), 1);
      const pad = t * t * (3 - 2 * t);
      h = h + (s.h - h) * Math.min(1, pad * 1.6);
    }
  }
  return h;
}

// ---- crash-test runway: long flat strip ending in a brick wall -------------
const start = settlements[0] ?? { x: ISLAND_R * 0.55, z: 0, r: 40 };
const RUN = { x0: start.x + (start.r ?? 40) * 0.8, z: start.z, len: 260, w: 16 };
RUN.h = Math.max(settleHeight(RUN.x0 + RUN.len / 2, RUN.z), SEA + 2.5);

const inRunway = (x, z, pad = 0) =>
  x > RUN.x0 - pad && x < RUN.x0 + RUN.len + pad && Math.abs(z - RUN.z) < RUN.w / 2 + pad;

function heightAt(x, z) {
  let h = settleHeight(x, z);
  // runway flattens the land like a settlement pad, but rectangular
  const dx = Math.max(RUN.x0 - x, x - (RUN.x0 + RUN.len), 0);
  const dz = Math.max(Math.abs(z - RUN.z) - RUN.w / 2, 0);
  const d = Math.hypot(dx, dz);
  const m = 22;                                        // blend margin
  if (d < m) {
    const t = 1 - d / m, s = t * t * (3 - 2 * t);
    h = h + (RUN.h - h) * s;
  }
  return h;
}

const forestNoise = (x, z) => fbm(x / 260 + 99, z / 260 + 99, { octaves: 3, seed: seed + 31 });

// ---- colors ----------------------------------------------------------------
const SAND = new THREE.Color(0xd9c58a), GRASS = new THREE.Color(0x4c8a45);
const DRY = new THREE.Color(0x7a9b4e), ROCK = new THREE.Color(0x7b7671);
const SNOW = new THREE.Color(0xf2f4f7), PAVE = new THREE.Color(0x9a978f);
const TARMAC = new THREE.Color(0x34383e);
const ROAD = new THREE.Color(0x3b3f46);            // asphalt baked INTO the ground surface
function colorAt(x, z, h, slope, out) {
  if (inRunway(x, z, 1)) { out.copy(TARMAC); return; }
  // roads are PART OF THE MAP — painted onto the terrain surface (follows every
  // bump, zero float) instead of a lifted mesh that tires clipped through (Erik).
  if (roadGraph && roadGraph.isRoad(x, z)) { out.copy(ROAD); return; }
  for (const s of settlements) {
    if (Math.hypot(x - s.x, z - s.z) < s.r) { out.copy(PAVE); return; }
  }
  if (h < SEA + 1.6) out.copy(SAND);
  else if (h > 55 && slope < 1.0) out.copy(SNOW);
  else if (slope > 0.85 || h > 38) out.copy(ROCK);
  else out.copy(GRASS).lerp(DRY, Math.max(0, forestNoise(x, z)) * 0.9);
}

// ============================================================================
// per-tile content: trees, buildings, GRASS SPRIGS (speed perception!)
// ============================================================================
const TREE_GEO = new THREE.ConeGeometry(1.3, 3.4, 6);
const TREE_MAT = new THREE.MeshStandardMaterial({ color: 0x2e6e32 }); TREE_MAT._shared = true;
const TRUNK_GEO = new THREE.CylinderGeometry(0.18, 0.28, 1.5, 5);
const TRUNK_MAT = new THREE.MeshStandardMaterial({ color: 0x63452c }); TRUNK_MAT._shared = true;
const BLD_MATS = [0x8a8f96, 0x9a6a4f, 0x5e7d94, 0xa89a7d].map((c) => {
  const m = new THREE.MeshStandardMaterial({ color: c }); m._shared = true; return m;
});
const ROOF_MAT = new THREE.MeshStandardMaterial({ color: 0x8a4a3a }); ROOF_MAT._shared = true;
// grass sprig = two crossed quads with a real blade texture (plain quads
// read as "weird green cards" — Erik). Blades are drawn near-white so the
// per-instance color supplies the green.
const GRASS_TEX = (() => {
  const cv = document.createElement("canvas"); cv.width = 64; cv.height = 64;
  const g = cv.getContext("2d");
  g.clearRect(0, 0, 64, 64);
  for (let i = 0; i < 9; i++) {
    const bx = 6 + i * 6 + (i % 3) * 1.5;              // blade root x
    const lean = (i - 4) * 2.2;                         // fan out from center
    const h = 40 + (i % 4) * 6;                         // blade height
    const grad = g.createLinearGradient(0, 64, 0, 64 - h);
    grad.addColorStop(0, "rgba(210,225,190,1)");
    grad.addColorStop(1, "rgba(245,250,235,0.9)");
    g.strokeStyle = grad;
    g.lineWidth = 2.6;
    g.beginPath();
    g.moveTo(bx, 64);
    g.quadraticCurveTo(bx + lean * 0.4, 64 - h * 0.6, bx + lean, 64 - h);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const GRASS_GEO = (() => {
  const g1 = new THREE.PlaneGeometry(0.5, 0.44, 1, 1); g1.translate(0, 0.21, 0);
  const g2 = g1.clone().rotateY(Math.PI / 2);
  return mergeGeometries([g1, g2]);
})();
const GRASS_MAT = new THREE.MeshStandardMaterial({
  map: GRASS_TEX, alphaTest: 0.4, transparent: false,
  side: THREE.DoubleSide, roughness: 1,
});
GRASS_MAT._shared = true;

// ── SYNTY ENVIRONMENT (Erik: replace our trees/rocks with Synty's, keep grass) ──
// Load a few PolygonApocalypseWasteland trees + rocks ONCE, merge each into a single
// instanceable geometry sharing the pack atlas, then the forest scatter uses them instead
// of the old cone/cylinder trees. (Stopgap atlas = GangWarfare until the Wasteland atlas
// is exported — Synty share a palette so the trees read right; rocks a touch warm.)
let SYNTY_TREES = null, SYNTY_ROCKS = null, SYNTY_ENV_MAT = null, SYNTY_BLDS = null;
function mergeGroupGeo(groupObj) {
  groupObj.updateMatrixWorld(true);
  const geos = [];
  groupObj.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry.clone();
    // keep only the attributes every mesh shares so mergeGeometries never throws
    for (const a of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(a)) g.deleteAttribute(a);
    if (!g.attributes.uv && g.attributes.position) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    if (g.index) g.toNonIndexed && (g.index = null);   // normalize to non-indexed for a clean merge
    g.applyMatrix4(o.matrixWorld);
    geos.push(g);
  });
  return geos.length ? mergeGeometries(geos.map((g) => g.index ? g.toNonIndexed() : g), false) : null;
}
(async () => {
  try {
    const GW = { texture: "T_PolygonApocalypseWasteland_01_A.PNG", textureDir: "models/wasteland", textureFlipY: true };   // real Wasteland atlas now (was GW stopgap)
    const treeFiles = ["SM_Env_Tree_Dead_01", "SM_Env_Tree_Dead_02", "SM_Env_Tree_Mutant_01", "SM_Env_Tree_Palm_01"];
    const rockFiles = ["SM_Env_Rock_03", "SM_Env_Rock_01"];
    const trees = [], rocks = [];
    for (const f of treeFiles) {
      const r = await loadProp(`models/wasteland/${f}.FBX`, GW).catch(() => null);
      if (r) { const g = mergeGroupGeo(r.group); if (g) { trees.push(g); if (!SYNTY_ENV_MAT) { r.group.traverse((o) => { if (o.isMesh && !SYNTY_ENV_MAT) SYNTY_ENV_MAT = Array.isArray(o.material) ? o.material[0] : o.material; }); } } }
    }
    for (const f of rockFiles) { const r = await loadProp(`models/wasteland/${f}.FBX`, GW).catch(() => null); if (r) { const g = mergeGroupGeo(r.group); if (g) rocks.push(g); } }
    if (SYNTY_ENV_MAT) SYNTY_ENV_MAT._shared = true;
    SYNTY_TREES = trees.length ? trees : null;
    SYNTY_ROCKS = rocks.length ? rocks : null;
    // whole Synty buildings (Erik) — replace the placeholder boxes at settlement lots
    const blds = [];
    for (const n of ["01", "02", "03", "04", "04_Alt", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "17"]) {
      const r = await loadProp(`models/wasteland/SM_Bld_Building_${n}.FBX`, GW).catch(() => null);
      if (r && r.group) blds.push({ group: r.group, size: r.size });
    }
    // typed landmarks (Erik: gas stations/etc): a bar + a composite gas station (shop + pump
    // canopy grouped — Synty modular pieces share an origin so they align when stacked)
    { const bar = await loadProp("models/wasteland/SM_Bld_Bar_Entrance_01.FBX", GW).catch(() => null);
      if (bar?.group) blds.push({ group: bar.group, size: bar.size }); }
    { const shop = await loadProp("models/wasteland/SM_Bld_Gas_Station_01.FBX", GW).catch(() => null);
      const cover = await loadProp("models/wasteland/SM_Bld_Gas_Station_Cover_01.FBX", GW).catch(() => null);
      if (shop?.group) {
        const g = new THREE.Group(); g.add(shop.group);
        if (cover?.group) g.add(cover.group);
        blds.push({ group: g, size: shop.size });
      } }
    SYNTY_BLDS = blds.length ? blds : null;
    // spawn tiles decorated before this finished → rebuild them so buildings appear immediately
    if (SYNTY_BLDS && terrain && terrain.rebuild) terrain.rebuild(world);
    console.log(`[synty env] ${trees.length} trees, ${rocks.length} rocks, ${blds.length} buildings ready`);
  } catch (e) { console.warn("[synty env] load failed (falls back):", e.message); }
})();

// road mask — keep decoration (trees/grass) off Ember's roads (Erik: "trees and
// grass on the roads"). Queries the road graph; a cheap tile-level gate means only
// tiles a road actually crosses pay the per-item cost.
function onRoad(x, z, pad = 1.5) {
  if (!roadGraph) return false;
  const n = roadGraph.nearestOnRoad(x, z);
  if (!n) return false;
  const w = roadGraph.roads[n.roadId]?.width ?? 6;
  return n.dist <= w * 0.5 + pad;
}

function decorate(tile, group) {
  const { x0, z0, size } = tile;
  const r = mulberry((seed ^ (tile.ix * 668265263) ^ (tile.iz * 374761393)) >>> 0);
  tile.physBoxes = [];                                 // → Rapier box statics in onTile
  tile.physMeshes = [];                                // → Rapier TRIMESH statics in onTile (walls solid, doorways open)
  // does any road cross this tile? if not, skip all per-item road checks below
  let tileNearRoad = false;
  if (roadGraph) {
    const nc = roadGraph.nearestOnRoad(x0 + size / 2, z0 + size / 2);
    tileNearRoad = !!nc && nc.dist < size * 0.72 + 8;
  }

  // ---- forests ------------------------------------------------------------
  if (tile.res >= 24) {
    const spots = [];
    for (let t = 0; t < 60; t++) {
      const x = x0 + r() * size, z = z0 + r() * size;
      if (forestNoise(x, z) < 0.12) continue;
      const h = heightAt(x, z);
      if (h < SEA + 2 || h > 34) continue;
      if (inRunway(x, z, 8)) continue;
      if (tileNearRoad && onRoad(x, z, 3)) continue;     // no trees on the asphalt
      if (settlements.some((s) => Math.hypot(x - s.x, z - s.z) < s.r * 1.15)) continue;
      spots.push([x, h, z, 0.7 + r() * 0.9]);
    }
    if (spots.length && SYNTY_TREES) {
      // Synty trees: group the spots by tree variant, one InstancedMesh per variant.
      // loadProp already scaled to meters (~9m trees); base pivot sits on the ground.
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      const pos = new THREE.Vector3(), scl = new THREE.Vector3();
      const byVar = SYNTY_TREES.map(() => []);
      spots.forEach((sp) => { byVar[(Math.abs(sp[0] * 13 + sp[2] * 7) | 0) % SYNTY_TREES.length].push(sp); });
      byVar.forEach((list, vi) => {
        if (!list.length) return;
        const im = new THREE.InstancedMesh(SYNTY_TREES[vi], SYNTY_ENV_MAT, list.length);
        list.forEach(([x, h, z, sc], i) => {
          const s = 0.45 * sc;                                  // ~9m mesh → 3-6m trees
          q.setFromAxisAngle(up, (x * 3 + z) % (Math.PI * 2));
          m.compose(pos.set(x, h, z), q, scl.set(s, s, s));
          im.setMatrixAt(i, m);
          tile.physBoxes.push({ half: [0.3, 2.4 * sc, 0.3], center: [x, h + 2.4 * sc, z] });
        });
        group.add(im);
      });
    }
    // sparse Synty rocks on the same forest tiles
    if (spots.length && SYNTY_ROCKS) {
      const rockSpots = spots.filter((_, i) => i % 9 === 0);
      if (rockSpots.length) {
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
        const pos = new THREE.Vector3(), scl = new THREE.Vector3();
        const im = new THREE.InstancedMesh(SYNTY_ROCKS[(tile.ix + tile.iz) % SYNTY_ROCKS.length], SYNTY_ENV_MAT, rockSpots.length);
        rockSpots.forEach(([x, h, z, sc], i) => {
          const s = 0.5 * sc;
          q.setFromAxisAngle(up, (x + z * 2) % (Math.PI * 2));
          m.compose(pos.set(x, h, z), q, scl.set(s, s, s));
          im.setMatrixAt(i, m);
        });
        group.add(im);
      }
    }
  }

  // ---- grass sprigs: the ground finally rushes past you -------------------
  if (tile.res >= 24) {
    const want = tile.res >= 48 ? 560 : 170;
    const pts = [];
    for (let t = 0; t < want; t++) {
      const x = x0 + r() * size, z = z0 + r() * size;
      const h = heightAt(x, z);
      if (h < SEA + 1.8 || h > 34) continue;
      if (Math.abs(heightAt(x + 1.5, z) - h) > 1.1) continue;   // too steep
      if (inRunway(x, z, 2)) continue;
      if (tileNearRoad && onRoad(x, z, 1)) continue;     // no grass poking through the road
      if (settlements.some((s) => Math.hypot(x - s.x, z - s.z) < s.r)) continue;
      pts.push([x, h, z, 0.7 + r() * 0.7, r() * Math.PI, 0.28 + r() * 0.07, 0.28 + r() * 0.14]);
    }
    if (pts.length) {
      const im = new THREE.InstancedMesh(GRASS_GEO, GRASS_MAT, pts.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s3 = new THREE.Vector3();
      const e = new THREE.Euler(), p3 = new THREE.Vector3(), col = new THREE.Color();
      pts.forEach(([x, h, z, sc, rot, hue, li], i) => {
        q.setFromEuler(e.set(0, rot, 0));
        m.compose(p3.set(x, h, z), q, s3.set(sc, sc, sc));
        im.setMatrixAt(i, m);
        im.setColorAt(i, col.setHSL(hue, 0.5, li));
      });
      group.add(im);
    }
  }

  // ---- settlement buildings ------------------------------------------------
  for (const s of settlements) {
    const nx = Math.max(x0, Math.min(s.x, x0 + size)), nz = Math.max(z0, Math.min(s.z, z0 + size));
    if (Math.hypot(s.x - nx, s.z - nz) > s.r) continue;
    const sr = mulberry(s.seed);
    const lots = s.type === "city" ? 26 : 9;
    for (let i = 0; i < lots; i++) {
      const a = (i / lots) * Math.PI * 2 + sr() * 0.5;
      const d = (s.type === "city" ? 0.25 + 0.65 * sr() : 0.3 + 0.55 * sr()) * s.r;
      const bx = s.x + Math.cos(a) * d, bz = s.z + Math.sin(a) * d;
      if (bx < x0 || bx >= x0 + size || bz < z0 || bz >= z0 + size) continue;
      const gy = heightAt(bx, bz);
      if (SYNTY_BLDS) {
        // real Synty building at this lot (Erik). Clone shares geometry+atlas material (cheap);
        // sits base-on-ground, random facing; collision box from its footprint.
        const pick = SYNTY_BLDS[Math.floor(sr() * SYNTY_BLDS.length)];
        const bld = pick.group.clone();
        bld.position.set(bx, gy, bz);
        bld.rotation.y = Math.floor(sr() * 4) * (Math.PI / 2);
        bld.traverse((o) => { if (o.isMesh) o.castShadow = tile.res >= 24; });
        group.add(bld);
        // Erik: many buildings are OPEN — walk inside them. The player is a Rapier CAPSULE
        // (CharacterBody), so instead of a solid box we bake the building MESH as a Rapier
        // TRIMESH collider: walls are solid, doorways/openings are passable — for the player
        // AND cars, from one collider. Deferred to onTile (needs phys.world + world matrix).
        tile.physMeshes.push(bld);
        continue;
      }
      // fallback placeholder box (until buildings load)
      const big = s.type === "city" && sr() < 0.6;
      const w = big ? 8 + sr() * 6 : 5 + sr() * 3;
      const dep = big ? 8 + sr() * 6 : 5 + sr() * 3;
      const hgt = big ? 9 + sr() * 22 : 3.2 + sr() * 2.4;
      const bld = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, dep), BLD_MATS[Math.floor(sr() * BLD_MATS.length)]);
      bld.position.set(bx, gy + hgt / 2, bz);
      bld.castShadow = tile.res >= 24;
      group.add(bld);
      if (!big) {
        const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, dep) * 0.75, 1.8, 4), ROOF_MAT);
        roof.position.set(bx, gy + hgt + 0.9, bz);
        roof.rotation.y = Math.PI / 4;
        group.add(roof);
      }
      tile.addCollider(new Collider({ size: [w, hgt, dep], offset: [bx, gy + hgt / 2, bz] })); // walking player
      tile.physBoxes.push({ half: [w / 2, hgt / 2, dep / 2], center: [bx, gy + hgt / 2, bz] }); // cars
    }
  }
}

// ============================================================================
// scene wiring: streamed terrain with per-tile Rapier colliders
// ============================================================================
let drivingCar = null;
const terrain = new StreamedTerrain({
  heightAt, colorAt, decorate,
  tileSize: 128,
  rings: [[1, 48], [2, 24], [5, 12]],
  anchor: () => (drivingCar ?? player).position,
});
const phys = new Physics({ gravity: -20 });
const pendingTiles = [];
terrain.onTile = (tile, mesh) => {
  if (!phys.world) { pendingTiles.push([tile, mesh]); return; }
  attachTilePhysics(tile, mesh);
};
// FINE terrain collision (Ember 2026-07-20): the render mesh's collider is only
// ~2.67 m triangles, and Rapier trimesh collision uses FACE normals — so at speed
// the wheels launched off those coarse facets (the 140-160 km/h jitter). Bake a
// DENSER collision surface sampled from heightAt (collision ≠ visual) so the
// wheels ride the smooth curve. Only near tiles (where the car drives fast) pay
// for it; far tiles keep the cheap render-mesh collider. COLLISION_CELL = target
// collision cell size in metres (smaller = smoother, more triangles). Live A/B:
// default ON (fine); add ?coarsecol=1 to the URL to fall back to the coarse
// render-mesh collider so Erik can feel the difference at 140-160 km/h.
const COLLISION_CELL = new URLSearchParams(location.search).get("coarsecol") ? 0 : 1.5;
function fineTerrainCollider(x0, z0, size) {
  const cres = Math.max(8, Math.round(size / COLLISION_CELL));
  const N = cres + 1;
  const verts = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const wx = x0 + (i / cres) * size, wz = z0 + (j / cres) * size;
      const o = (j * N + i) * 3;
      verts[o] = wx; verts[o + 1] = heightAt(wx, wz); verts[o + 2] = wz;
    }
  const idx = new Uint32Array(cres * cres * 6);
  let t = 0;
  for (let j = 0; j < cres; j++)
    for (let i = 0; i < cres; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  return phys.addTrimesh(verts, idx, { friction: 1.0 });
}
function attachTilePhysics(tile, mesh) {
  if (tile.dead) return;
  const cols = [];
  if (tile.size <= 160 && COLLISION_CELL > 0) cols.push(fineTerrainCollider(tile.x0, tile.z0, tile.size)); // near: smooth collision
  else cols.push(...phys.addMeshCollider(mesh));                                                            // far / coarsecol: mesh collider
  for (const b of tile.physBoxes ?? []) cols.push(phys.addBox(b.half, b.center));
  for (const bm of tile.physMeshes ?? []) cols.push(...phys.addMeshCollider(bm)); // buildings → trimesh (walls solid, doorways open)
  tile.cleanup.push(() => cols.forEach((c) => phys.removeCollider(c)));
}
world.spawn("terrain").add(terrain);

// sea + catch-all follow the action
const sea = world.spawn("sea").mesh(new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x2e6d9e, transparent: true, opacity: 0.8, roughness: 0.3 }),
)).at(0, SEA, 0);
sea.add({ update(dt, { engine }) {
  const a = (drivingCar ?? player).position;
  sea.position.x = a.x; sea.position.z = a.z;
  sea.position.y = SEA + Math.sin(engine.time * 0.7) * 0.1;
} });

// ============================================================================
// PLAYER — the real mocap character (block guy is gone)
// ============================================================================
class PlayerMove {
  fixedUpdate(dt, { input, world, entity }) {
    const body = entity.components.find((c) => c.velocity && c.onGround !== undefined);
    if (!body) return;
    if (drivingCar) { body.velocity.x = 0; body.velocity.z = 0; return; }
    if (window.__pfGetup) { body.velocity.x = 0; body.velocity.z = 0; return; }   // getting up — don't drive/turn
    // Anima tools mode (test open, live-play OFF) freezes the character so WASD can't drive
    // it off while you pose; live-play ON falls through to normal movement (Erik's toggle)
    if (window.__pfTest && window.__pfTest.active && !window.__pfTest.livePlay) { body.velocity.x = 0; body.velocity.z = 0; return; }
    const cam = world.camera;
    const f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
    const rt = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    const stick = input.stick("left");
    const ix = input.axis("KeyA", "KeyD") + stick.x;
    const iz = input.axis("KeyS", "KeyW") - stick.y;
    const run = input.down("ShiftLeft") ? 9.3 : 5.0;  // walk trimmed to match the anim (Erik: still a touch fast)
    const wish = f.multiplyScalar(iz).addScaledVector(rt, ix);
    if (wish.lengthSq() > 1) wish.normalize();
    body.velocity.x = wish.x * run;
    body.velocity.z = wish.z * run;
    if (input.pressed("Space") && body.onGround) { body.velocity.y = 9; audio.play("jump"); }
    // ARMED: face where you're aiming (GTA-style). Else: ease toward movement dir.
    const armed = !!(window.__pfCombat && window.__pfCombat.enabled);
    if (armed) {
      const cf = new THREE.Vector3(); world.camera.getWorldDirection(cf);
      const want = Math.atan2(cf.x, cf.z);
      let d = want - entity.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
      entity.rotation.y += d * Math.min(1, dt * 12);
    } else if (wish.lengthSq() > 0.01) {
      const want = Math.atan2(body.velocity.x, body.velocity.z);
      let d = want - entity.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
      entity.rotation.y += d * Math.min(1, dt * 9);
    }
    const anim = entity.components.find((c) => c.play && c.mixer);
    if (anim) {
      // drive locomotion from INPUT intent, not body.velocity — the character controller keeps a
      // little slide-drift on the ground even when standing, which used to fake a constant walk.
      const moving = Math.hypot(ix, iz);
      const running = input.down("ShiftLeft");
      const cs = window.__pfCombat;
      const armed = cs && cs.enabled && cs.weapon && cs.weapon.kind === "ranged" && !drivingCar;
      // pose by weapon family (Erik): long guns (rifle/shotgun/AR/MG) share the rifle
      // hold; handgun-style (pistol, uzi) use the pistol hold
      const idleClip = armed ? (cs.weaponId === "pistol" || cs.weaponId === "smg" ? "pistolIdle" : "rifleIdle") : "idle";
      const forced = (window.__pfTest && window.__pfTest.active && window.__pfTest.anim) ||
        (window.__pfBPlayer && window.__pfBPlayer.active && "__behavior__");   // TEST MODE menu / a playing behavior owns the mixer
      // RMB = AIM (shouldered pose, Erik: "then he's in position"), LMB = shoot.
      // firing pose also flashes per shot + holds while auto-firing.
      const justFired = armed && (cs.aiming ||
        (cs.lastFireAt && performance.now() - cs.lastFireAt < 320) ||
        (cs.weapon.auto && (input.held?.("attack") || input.pointer?.down)));
      // BLENDED LAYERS (Erik): moving while aiming/firing = the legs play walk/run while
      // the upper body plays the firing pose — two clips at once, split by bone.
      const blend = anim._blend || (anim._blend = new BlendController(anim));
      if (forced && String(forced).startsWith("blend:")) {
        const [lo, up] = String(forced).slice(6).split("+");
        blend.set({ lower: lo, upper: up });
      } else if (forced) { blend.set(null); anim.play(forced, { fade: 0.2 }); }
      else if (justFired && moving > 0.15 && body.onGround) {
        blend.set({ lower: running ? "run" : "walk", upper: "firingRifle" });
      } else if (armed && moving > 0.15 && body.onGround) {
        // armed walk/run: legs move, arms KEEP HOLDING the gun (was swinging through it)
        blend.set({ lower: running ? "run" : "walk", upper: idleClip });
      } else {
        blend.set(null);
        if (justFired) anim.play("firingRifle", { fade: 0.06 });
        else if (!body.onGround) anim.play("jump", { fade: 0.1, once: true });
        else if (moving > 0.15 && running) anim.play("run", { fade: 0.15 });
        else if (moving > 0.15) anim.play("walk", { fade: 0.18, speed: Math.min(1.4, moving) });
        else anim.play(idleClip, { fade: 0.3 });
      }
    }
  }
}

const player = world.spawn("player")
  .at(RUN.x0 + 4, RUN.h + 1.5, RUN.z + RUN.w / 2 + 4)
  .add(new CharacterBody({ radius: 0.32, height: 1.7 }))   // real capsule vs EVERYTHING
  .add(new PlayerMove());

// NPC pedestrians — bring the towns alive (Erik). A VARIED Synty crowd: gang
// members, civilians, the boss, a street girl — each retargeted onto the Mixamo
// anims (retargetFrom the demo skeleton) and textured off the GangWarfare atlas.
const NPC_ANIMS = [
  { name: "idle", url: "models/character/anims/idle.fbx" },
  { name: "walk", url: "models/character/anims/walking.fbx" },
  { name: "run", url: "models/character/anims/running.fbx" },
];
// flipY TRUE for these Synty character UVs — false sampled the dark half of the palette
// atlas and crushed the skin near-black (Erik: "gangsters too black"); see character.js.
const GW_CHAR = { texture: "T_PolygonGangWarfare_01_A.PNG", textureDir: "models/gangwarfare", flipY: true, retargetFrom: "models/character/humanoid_male.fbx", animations: NPC_ANIMS };
spawnPedestrians(world, {
  // a diverse street crowd, not all dark gang members (Erik): gangsters of a few
  // ethnicities + civilians (cooks, plainclothes) for skin-tone + outfit variety.
  models: [
    "SK_Chr_GangMember_Male_01", "SK_Chr_GangMember_Male_02", "SK_Chr_GangMember_Female_01",
    "SK_Chr_StreetGirl_01", "SK_Chr_Asian_Gangster_Male_01", "SK_Chr_Italian_Gangster_01",
    "SK_Chr_Cook_Male_01", "SK_Chr_Cook_Female_01", "SK_Chr_DEA_Plainclothes_Male_01",
  ].map((n) => ({ model: `models/gangwarfare/${n}.FBX`, ...GW_CHAR })),
  heightAt,
  clusters: [
    { x: RUN.x0 + 20, z: RUN.z + RUN.w / 2 + 8, radius: 14, count: 6 },  // right by spawn
    { x: start.x, z: start.z, radius: 22, count: 8 },                     // the start town
  ],
}).then((npcs) => { window.__pfNpcs = npcs; console.log("[npc] spawned", npcs.length, "pedestrians"); })
  .catch((e) => console.warn("[npc] spawn failed:", e.message));
// the player is the ORIGINAL guy again (Erik: "I kind of like him more").
// The citizen + retarget pipeline stays for NPCs — swap the url + retargetFrom
// back to models/fabpack/SK_citizen_male_28.fbx to flip.
loadCharacter("models/character/humanoid_male.fbx", {
  targetHeight: 1.8,
  animations: [
    { name: "idle", url: "models/character/anims/idle.fbx" },
    { name: "walk", url: "models/character/anims/walking.fbx" },
    { name: "run", url: "models/character/anims/running.fbx" },
    { name: "jump", url: "models/character/anims/jumping up.fbx" },
    // armed poses (Erik's Mixamo drop) — the animator holds the gun by design
    { name: "rifleIdle", url: "models/character/anims/rifle_idle.fbx" },
    { name: "pistolIdle", url: "models/character/anims/pistol_idle.fbx" },
    { name: "firingRifle", url: "models/character/anims/firing_rifle.fbx" },
    // get-up from ragdoll (Erik's Mixamo drop) — front = face-down, back = face-up
    { name: "getupFront", url: "models/character/anims/getup_front.fbx" },
    { name: "getupBack", url: "models/character/anims/getup_back.fbx" },
  ],
}).then((ch) => {
  player.mesh(ch.visual).add(ch.animator);
  ch.animator.play("idle");
  window.__ch = ch;

  // PROCEDURAL AIM/CROUCH (General): layers over the clips — hold the weapon + aim
  // with the arms when armed, crouch on Ctrl/C. Live-tunable at window.__pfAnim.p.
  player.add(new CharacterAim(ch.bones, {
    camera: world.camera,
    // grounded gate: don't pitch the spine mid-jump (was rotating the head through the chest)
    isArmed: () => !!(window.__pfCombat && window.__pfCombat.enabled) && (player.components.find((c) => c.onGround !== undefined)?.onGround ?? true),
    isCrouch: () => engine.input.down("ControlLeft") || engine.input.down("KeyC"),
  }));

  // TRAJECTORY LEAN (General, RDR2 weight pass Step 3): lean the spine into the
  // capsule's acceleration — tip into a run, pitch back on a hard stop, bank into
  // turns. Pure procedural over the clip; live-tune at window.__pfLean.p (Erik drives).
  player.add(new TrajectoryLean(ch.bones, () => player.components.find((c) => c.velocity && c.onGround !== undefined)));

  // FOOT PLANTING (General): standing idle, the feet LOCK to the ground while the body
  // sways above (Erik: "the feet would actually stay planted"). Own entity spawned after
  // the player so it runs AFTER the animator each frame; releases on real steps.
  // BEHAVIOR PLAYBACK (General): workshop-authored behaviors run in the LIVE game.
  // __pfPlayBehavior("name") plays a saved behavior; the anim-select yields while it
  // runs and control returns automatically when it ends.
  const bPlayer = new BehaviorPlayer(ch.animator, ch.visual);
  window.__pfBPlayer = bPlayer;
  window.__pfPlayBehavior = (n) => bPlayer.play(n);
  // Anima behavior-triggers are DISABLED in live gameplay (Erik): key-bound behaviors were
  // firing while moving and slamming a bad/empty pose → random T-pose + torso twist. They
  // stay usable inside the Anima tool; they just no longer inject into normal movement.
  // Also clear any stored key-bindings + a console helper to wipe all Anima-authored data.
  try { localStorage.removeItem("pf.behavior.triggers"); } catch {}
  window.__pfClearAnima = () => { try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith("pf.behavior.")) localStorage.removeItem(k); } } catch {} return "Anima behaviors/poses cleared"; };
  // 🎥 motion recorder — always sampling the character so "capture moment" grabs the last
  // ~15s of real gameplay (Erik). Skips while a captured moment is being scrubbed in Anima.
  const motionRec = new MotionRecorder(ch.visual, player);
  world.spawn("motionrec").add({ update(dt) { if (!(window.__pfTest && window.__pfTest._momentScrub)) motionRec.update(dt); } });
  world.spawn("behaviorplayer").add({ update(dt) { bPlayer.update(dt); } });

  const footPlant = new FootPlant({ playerObj: ch.visual, player, heightAt });
  world.spawn("footplant").add({ update() {
    const body = player.components.find((c) => c.onGround !== undefined);
    const inp = engine.input;
    const stick = inp.stick ? inp.stick("left") : { x: 0, y: 0 };
    const moving = Math.hypot(inp.axis("KeyA", "KeyD") + stick.x, inp.axis("KeyS", "KeyW") - stick.y);
    const free = !drivingCar && !window.__pfGetup && !(window.__pfTest && window.__pfTest.active) && !(window.__rag && window.__rag.active);
    const standing = body && body.onGround && moving < 0.1 && free;
    const walking = body && body.onGround && moving >= 0.1 && free;
    footPlant.update(standing, walking);
  } });

  // ---- ACTIVE RAGDOLL: get hit by a car → real jointed physics body -------
  // (muscle tone pulls toward whatever the Animator is playing — no scripts)
  physReady.then(() => {
    // tone 1.6: a person who just got hit still has muscle — 1.1 read as a
    // wet noodle (Erik: "waaaay too floppy")
    const rag = new Ragdoll(ch.bones, phys, { tone: 1.6 });
    window.__rag = rag;
    const cb = () => player.components.find((c) => c.ctrl && c.velocity);
    let wasMuscle = false;   // 🫀 muscle mode (Euphoria layer): re-enable the capsule on exit
    let getup = null;        // { timer } while a get-up clip plays him up out of the ragdoll
    player.add({
      fixedUpdate(dt) {
        // NATURAL GET-UP: ragdoll settled → play a get-up clip (face-up vs face-down picked
        // from the resting pose) that RISES to standing, capsule OFF so physics can't fight,
        // then hand to idle + control. Replaces the old teleport-to-standing pop (Erik).
        if (getup) {
          window.__pfGetup = true;
          cb()?.setEnabled(false);
          // SAFE ground-pin: keep the feet-origin exactly on the terrain the whole get-up so he
          // can NEVER get shoved into / through the map (Erik). NOTE: the clip's vertical root
          // motion is stripped, so his LYING pose still hangs at hip height — the proper float fix
          // (keep the hips Y motion, scaled) is a focused pass; this at least makes it not dangerous.
          player.position.y = heightAt(player.position.x, player.position.z);
          getup.timer -= dt;
          if (getup.timer <= 0) {
            getup = null; window.__pfGetup = false;
            const b = cb(); if (b) { b.setEnabled(true); b.velocity.set(0, 0, 0); }
            ch.animator.play("idle", { fade: 0.3 });
          }
          return;
        }
        if (rag.active) {
          rag.fixedUpdate(dt);
          // 🫀 muscle mode = a LIVE authoring layer, not death: physics drives the bones,
          // but skip the follow/settle/stand-up recovery (the hips are anchored to the
          // animation). Disable the capsule so it can't fight the ragdoll bodies.
          if (rag.muscle) { cb()?.setEnabled(false); return; }
          // camera + world logic follow the flying body — but never let the follow point sink
          // far under the terrain (when he settles flat the pelvis is low → camera in the ground)
          const p = rag.pelvisPos();
          player.position.set(p.x, Math.max(heightAt(p.x, p.z) - 0.2, p.y - 0.9), p.z);
          const body = cb();
          if (body) body._lastSynced.copy(player.position);   // no teleport-fight
          if (rag.settled(1.3)) {                             // get up naturally
            const o = rag.groundOrientation();                // face-up/down + ground heading
            rag.exit();
            const p2 = rag.pelvisPos();
            const g = heightAt(p2.x, p2.z);
            player.at(p2.x, g, p2.z);                         // feet on the ground for the rise
            player.object3d.rotation.y = o.yaw;
            const b = cb();
            if (b) { b.setEnabled(false); b.velocity.set(0, 0, 0); b._lastSynced.copy(player.position); }
            const clip = o.faceUp ? "getupBack" : "getupFront";
            const dur = ch.animator.clips[clip]?.duration ?? 2.0;
            ch.animator.play(clip, { fade: 0.12, once: true });
            // cap the control-lock: a long clip (getupBack is 8.9s!) must not freeze the
            // player for that whole time — hand back after ~2.6s max even if the clip runs on
            getup = { timer: Math.min(dur, 2.8) * 0.92 };
            window.__pfGetup = true;
          }
          return;
        }
        if (drivingCar) return;
        // car-vs-player: fast car close to the capsule → you go flying
        for (const car of cars) {
          const vb = car.components.find((c) => c.rb);
          if (!vb?.rb) continue;
          const sp = vb.velocity.length();
          if (sp < 5) continue;
          const dx = car.position.x - player.position.x;
          const dz = car.position.z - player.position.z;
          // 3.5m: fires while the nose is arriving — the chassis otherwise
          // stops dead against the (infinite-mass) capsule just out of range
          if (dx * dx + dz * dz > 3.5 * 3.5) continue;
          if (Math.abs(car.position.y - player.position.y) > 2) continue;
          const chest = player.position.clone(); chest.y += 1.1;
          rag.enter(
            vb.velocity.clone().multiplyScalar(0.85).add(new THREE.Vector3(0, 2.5, 0)),
            vb.velocity.clone().multiplyScalar(12),           // spin seasoning; momentum rides the inherited velocity
            chest);
          cb()?.setEnabled(false);
          // person-vs-car: body thud layered over a medium metal hit
          const hitVol = Math.min(1, sp / 18);
          audio.playSfx("thud_body", { volume: hitVol });
          audio.playSfx("crash_metal_med", { volume: hitVol * 0.45, pitch: 1.15 });
          break;
        }
      },
      update() {
        rag.update();                                         // physics → bones
        if (wasMuscle && !rag.muscle) { cb()?.setEnabled(true); wasMuscle = false; }   // muscle ended → capsule back
        if (rag.muscle) wasMuscle = true;
      },
    });
  });
}).catch((e) => console.warn("character:", e.message));

// ============================================================================
// PHYSICS BOOTSTRAP + crash-test props
// ============================================================================
const props = [];                                       // [entity, opts] queued for physReady
function prop(mesh, x, y, z, opts) {
  const e = world.spawn("prop").mesh(mesh).at(x, y, z);
  props.push([e, opts]);
  return e;
}

// runway visual: centerline dashes + start numerals keep it readable
{
  const dashMat = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 1 });
  for (let x = RUN.x0 + 6; x < RUN.x0 + RUN.len - 6; x += 12) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(4, 0.4).rotateX(-Math.PI / 2), dashMat);
    dash.position.set(x, RUN.h + 0.03, RUN.z);
    world.scene.add(dash);
  }
}
// the BRICK WALL at the end of the runway
const WALL = { x: RUN.x0 + RUN.len + 8, half: [0.5, 1.7, RUN.w / 2 + 3] };
{
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(WALL.half[0] * 2, WALL.half[1] * 2, WALL.half[2] * 2),
    new THREE.MeshStandardMaterial({ color: 0x9c4a36, roughness: 0.95 }));
  wall.position.set(WALL.x, RUN.h + WALL.half[1], RUN.z);
  wall.castShadow = true;
  world.scene.add(wall);
}
// obstacle lane beside the runway: crates, cones, barriers, ramp, big ball
const LANE = RUN.z + RUN.w / 2 + 10;
const crateGeo = new THREE.BoxGeometry(0.85, 0.85, 0.85);
const crateMat = new THREE.MeshStandardMaterial({ color: 0xb08a4a, roughness: 0.9 });
for (let row = 0; row < 3; row++)                        // crate pyramid
  for (let i = 0; i < 3 - row; i++)
    prop(new THREE.Mesh(crateGeo, crateMat).clone(),
      RUN.x0 + 80 + i * 0.9 + row * 0.45, RUN.h + 0.43 + row * 0.86, LANE,
      { half: [0.425, 0.425, 0.425], mass: 25, restitution: 0.2 });
const coneGeo = new THREE.ConeGeometry(0.35, 0.9, 10);
const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1a });
for (let i = 0; i < 7; i++) {                            // cone slalom
  const g = new THREE.Group();
  const c = new THREE.Mesh(coneGeo, coneMat); c.position.y = 0.03; c.castShadow = true; // centered on the body
  g.add(c);
  prop(g, RUN.x0 + 120 + i * 10, RUN.h + 0.42, LANE, { half: [0.28, 0.42, 0.28], mass: 3.5, restitution: 0.35 });
}
// the push ball — striped so you SEE it roll (a plain sphere reads as sliding)
const ballTex = (() => {
  const cv = document.createElement("canvas"); cv.width = 128; cv.height = 64;
  const g = cv.getContext("2d");
  const cols = ["#c03a70", "#f0e8dc", "#3a6ec0", "#f0e8dc"];
  for (let i = 0; i < 8; i++) { g.fillStyle = cols[i % 4]; g.fillRect(i * 16, 0, 16, 64); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(1.4, 24, 16),
  new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.6 }));
ballMesh.castShadow = true;
prop(ballMesh, RUN.x0 + 205, RUN.h + 1.4, LANE, { half: { r: 1.4 }, mass: 120, shape: "ball", restitution: 0.55 });
// static concrete barriers
const BARRIERS = [];
for (let i = 0; i < 3; i++) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.0, 0.6),
    new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 1 }));
  const bx = RUN.x0 + 40 + i * 9, bz = LANE + (i % 2 ? 2.2 : -2.2);
  b.position.set(bx, RUN.h + 0.5, bz); b.castShadow = true;
  world.scene.add(b);
  BARRIERS.push({ half: [1.3, 0.5, 0.3], center: [bx, RUN.h + 0.5, bz] });
}
// a jump ramp on the far side of the runway
const rampMesh = (() => {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(15, 0); shape.lineTo(15, 3.8); shape.lineTo(0, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 10, bevelEnabled: false });
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9a5a2e, roughness: 1 }));
  mesh.position.set(RUN.x0 + 150, RUN.h, RUN.z - RUN.w / 2 - 16);
  mesh.castShadow = true; mesh.receiveShadow = true;
  world.scene.add(mesh);
  return mesh;
})();

const physReady = initRapier().then(() => {
  world.spawn("physics").add(phys);
  phys.addGroundPlane(SEA - 6);
  for (const [t, m] of pendingTiles) attachTilePhysics(t, m);
  pendingTiles.length = 0;
  phys.addBox(WALL.half, [WALL.x, RUN.h + WALL.half[1], RUN.z]);   // the wall
  for (const b of BARRIERS) phys.addBox(b.half, b.center);
  phys.addMeshCollider(rampMesh);
  for (const [e, opts] of props) phys.addDynamicProp(e, opts);

  // CRASH AUDIO — driven by the physics, not scripted:
  // chassis contact-force events (walls, cars, roof slams while tumbling).
  // Real Suno files when present (public/sfx/), synth recipes as fallback.
  let lastCrash = 0;
  phys.onContact(({ entityA, entityB, force }) => {
    const car = [entityA, entityB].find((e) => e?.components?.some((c) => c.rb));
    if (!car) return;
    const now = performance.now();
    if (now - lastCrash < 140) return;                  // debounce pile-up spam
    lastCrash = now;
    const mass = 1200;
    const big = force > mass * 14;
    const vol = Math.min(1, force / (mass * (big ? 30 : 14)));
    const pitch = 0.9 + Math.random() * 0.25;
    // real Suno files only — Erik killed the synth crash ("it's terrible")
    if (big) {
      audio.playSfx("crash_metal_big", { volume: vol, pitch });
      audio.playSfx("glass_pop", { volume: vol * 0.7, pitch: 1 + Math.random() * 0.2 });
    } else {
      audio.playSfx("crash_metal_med", { volume: vol * 0.8, pitch: pitch * 1.1 });
    }
  });
});
// hard wheel landings off jumps (suspension slam, not a chassis contact)
world.spawn("landingAudio").add({ fixedUpdate() {
  for (const c of cars) {
    const vb = c.components.find((x) => x.rb);
    if (vb?.justLanded > 5) {
      const vol = Math.min(1, vb.justLanded / 16);
      audio.playSfx("thump_landing", { volume: vol, pitch: 0.95 + Math.random() * 0.15 });
      vb.justLanded = 0;
    }
  }
} });
// Erik's Suno sound pools — variations load if the files exist, else the
// synth fallbacks above keep working (missing files are skipped silently)
audio.loadSfx({
  crash_metal_big: [1, 2, 3].map((i) => `sfx/crash_metal_big_${i}.mp3`)
    .concat([1, 2, 3].map((i) => `sfx/crash_metal_big_${i}.wav`)),
  crash_metal_med: [1, 2].map((i) => `sfx/crash_metal_med_${i}.mp3`)
    .concat([1, 2].map((i) => `sfx/crash_metal_med_${i}.wav`)),
  thud_body: [1, 2].map((i) => `sfx/thud_body_${i}.mp3`).concat([1, 2].map((i) => `sfx/thud_body_${i}.wav`)),
  thump_landing: [1, 2].map((i) => `sfx/thump_landing_${i}.mp3`).concat([1, 2].map((i) => `sfx/thump_landing_${i}.wav`)),
  glass_pop: [1, 2].map((i) => `sfx/glass_pop_${i}.mp3`).concat([1, 2].map((i) => `sfx/glass_pop_${i}.wav`)),
  crunch_plastic: [1, 2].map((i) => `sfx/crunch_plastic_${i}.mp3`).concat([1, 2].map((i) => `sfx/crunch_plastic_${i}.wav`)),
});

// ============================================================================
// THE FLEET — textured pack cars on real physics
// ============================================================================
world.spawn("carCollisions").add(new CarCollisions({ audio }));  // Ember's damage/sparks lane
// Erik: ONLY the official Assetsville set — the sedan-pack trio is retired.
// Every entry is a skeletal UE rig, de-skinned at load. UE material-instance
// paint doesn't survive FBX export — re-applied per spec where it matters.
// flipY TRUE for the whole pack — A/B proved it (black paint + whitewall
// tires vs orange-tire mud at false; the earlier per-texel "false" call was
// a palette-symmetry coincidence, same as the props)
const AV = (len) => ({ targetLength: len, textureDir: "models/fabpack", textureFlipY: true,
  textureMap: { palette: "T_colorPalette2048.PNG", veh: "T_colorPalette2048.PNG", policecar: "T_colorPalette2048.PNG" } });
// Synty GangWarfare vehicles: the FBX export left generic "Fbx Default Material N" names, so
// map on "material" → the pack's Vehicle atlas (Erik's all-Synty switch). Loads drivable
// (loadVehicle finds the separate wheel meshes + suspension), textured off the vehicle atlas.
const GWV = (len) => ({ targetLength: len, textureDir: "models/gangwarfare", textureFlipY: true,
  textureMap: { material: "T_PolygonGangWarfare_Vehicle_01.PNG" } });
const FLEET = [
  // ── Synty GangWarfare (Erik's all-Synty switch) — drivable + textured ──
  { name: "GW_LowCar",     file: "models/gangwarfare/SK_Veh_LowCar_01.FBX",      dz: -40, hp: 400, ep: 15, top: 58, siren: 0, opts: GWV(4.7) },
  { name: "GW_LowCar2",    file: "models/gangwarfare/SK_Veh_LowCar_02.FBX",      dz: -34, hp: 400, ep: 15, top: 58, siren: 0, opts: GWV(4.7) },
  { name: "GW_Van",        file: "models/gangwarfare/SK_Veh_Van_01.FBX",         dz: -28, hp: 260, ep: 11, top: 46, siren: 0, mass: 2100, opts: GWV(5.0) },
  { name: "Sedan",         file: "models/fabpack/SK_veh_Sedan_01.fbx",           dz: -40, hp: 280, ep: 12, top: 50, siren: 0, opts: AV(4.9) },
  { name: "Muscle",        file: "models/fabpack/SK_veh_Muscle_01.fbx",          dz: -35, hp: 450, ep: 16, top: 62, siren: 0, opts: AV(5.0) },
  { name: "SportClassic",  file: "models/fabpack/SK_veh_SportClassic_01.fbx",    dz: -30, hp: 400, ep: 15, top: 60, siren: 0, opts: AV(4.6) },
  { name: "SportClassicA", file: "models/fabpack/SK_veh_SportClassic_01a.fbx",   dz: -25, hp: 400, ep: 15, top: 60, siren: 0, opts: AV(4.6) },
  { name: "SportClassic2", file: "models/fabpack/SK_veh_SportClassic_02.fbx",    dz: -20, hp: 420, ep: 15, top: 61, siren: 0, opts: AV(4.7) },
  { name: "SUV",           file: "models/fabpack/SK_veh_SUV_01.fbx",             dz: -15, hp: 320, ep: 12, top: 50, siren: 0, mass: 1900, opts: AV(5.1) },
  { name: "Offroad",       file: "models/fabpack/SK_veh_Offroad_01.fbx",         dz: -10, hp: 340, ep: 13, top: 48, siren: 0, mass: 1900, opts: AV(4.8) },
  { name: "Pickup",        file: "models/fabpack/SK_veh_Pickup_01.fbx",          dz: -5,  hp: 300, ep: 12, top: 48, siren: 0, mass: 2000, opts: AV(5.4) },
  { name: "PickupOld",     file: "models/fabpack/SK_veh_PickupOld_01.fbx",       dz: 0,   hp: 220, ep: 10, top: 42, siren: 0, mass: 2000, opts: AV(5.2) },
  { name: "Van",           file: "models/fabpack/SK_veh_Van_01.fbx",             dz: 5,   hp: 240, ep: 11, top: 45, siren: 0, mass: 2100, opts: AV(5.4) },
  // liveried vehicles carry their OWN texture sheet (T_PoliceCar_01), not the
  // palette — this is Erik's "not simply textures for each car" system
  { name: "Police",        file: "models/fabpack/SK_veh_PoliceCarSedan_01.fbx",  dz: 10,  hp: 380, ep: 14, top: 58, siren: 6,
    opts: { ...AV(5.0), textureMap: { palette: "T_colorPalette2048.PNG", veh: "T_PoliceCar_01.PNG", policecar: "T_PoliceCar_01.PNG" } } },
  { name: "PoliceSUV",     file: "models/fabpack/SK_veh_PoliceCarSUV_01.fbx",    dz: 15,  hp: 360, ep: 13, top: 54, siren: 6, mass: 1950,
    opts: { ...AV(5.2), textureMap: { palette: "T_colorPalette2048.PNG", veh: "T_PoliceCar_01.PNG", policecar: "T_PoliceCar_01.PNG" } } },
  { name: "Hearse",        file: "models/fabpack/SK_veh_Hearse.fbx",             dz: 20,  hp: 300, ep: 13, top: 52, siren: 0, paint: 0x23262c, opts: AV(5.6) },
  { name: "Truck",         file: "models/fabpack/SK_veh_Truck_01.fbx",           dz: 25,  hp: 300, ep: 10, top: 40, siren: 0, mass: 3200, opts: AV(7.5) },
  { name: "TowTruck",      file: "models/fabpack/SK_veh_TruckTow.fbx",           dz: 30,  hp: 280, ep: 10, top: 40, siren: 0, mass: 3000, opts: AV(6.8) },
  { name: "SemiTruck",     file: "models/fabpack/SK_veh_TruckTrailer_01.fbx",    dz: 36,  hp: 500, ep: 9,  top: 38, siren: 0, mass: 4200, opts: AV(9.5) },
  { name: "VeggieTruck",   file: "models/fabpack/SK_veh_VegetableTruck.fbx",     dz: 43,  hp: 240, ep: 10, top: 40, siren: 0, mass: 2600, opts: AV(6.5) },
  { name: "CargoTruck",    file: "models/fabpack/SK_veh_CargoTruckOld.fbx",      dz: 49,  hp: 260, ep: 10, top: 40, siren: 0, mass: 2600, paint: 0x55804a, opts: AV(7.0) },
];
// TEST MODE (Erik): only spawn a truck + a sports car — 18 cars slow the reload.
// Full fleet back with ?cars=all (each spec stays intact above).
const wantCars = new URLSearchParams(location.search).get("cars");
const SPAWN = wantCars === "all" ? FLEET : FLEET.filter((s) => s.name === "GW_LowCar" || s.name === "GW_LowCar2" || s.name === "GW_Van");
const cars = [];
for (const spec of SPAWN) {
  Promise.all([physReady, loadVehicle(spec.file, spec.opts)])
    .then(([, rig]) => {
      if (spec.paint) rig.setPaint(spec.paint);
      const e = world.spawn("drivable").mesh(rig.visual)
        .at(RUN.x0 + 10, RUN.h + 0.4, RUN.z + spec.dz);
      e.rotation.y = Math.PI / 2;                       // face down the runway (+X)
      e.add(new RapierVehicle({
        suspension: rig.suspension, wheelRadius: rig.wheelRadius,
        enginePower: spec.ep, topSpeed: spec.top,
        ...(spec.mass ? { mass: spec.mass } : {}),      // trucks weigh like trucks
      }))
        .add(new VehicleRig(rig, { sirenHz: spec.siren }))
        .add(new EngineSound(audio, { hp: spec.hp }))
        .add(new SkidMarks());
      const self = e;
      e.add(new PlayerVehicleControls({ enabled: () => drivingCar === self }));
      e.specName = spec.name; e.rig = rig;
      cars.push(e);
    }).catch((err) => console.warn(spec.name, err.message));
}

// ============================================================================
// camera + controls + HUD
// ============================================================================
engine.input.enablePointerLock();
const rig = new ThirdPersonRig(player, { distance: 6.5, isSprinting: () => engine.input.down("ShiftLeft") });
world.spawn("camera").add(rig);

// TEST MODE (Erik): free orbit camera + a menu to force any character state.
// Spawned AFTER the camera rig so its per-frame camera override wins while active.
const testMode = new TestMode({ world, player, input: engine.input });
world.spawn("testmode").add({ update(dt) { testMode.update(dt); } });

// VEHICLE TEST MODE (Erik, Ember's lane): 🚗/V — orbit a car + drive the real
// damage pipeline (crash sides, wheel states, smoke, reset) from a panel.
const vehicleTest = new VehicleTestMode({ world });
world.spawn("vehicletest").add({ update() { vehicleTest.update(); } });

// phones/tablets get the full on-screen control overlay (Erik) — WASD d-pad
// (walk + drive) plus E enter/exit, Space jump/handbrake, F flip. Each button
// fires a synthetic key on window, so behavior is identical to keyboard.
new TouchControls();

window.addEventListener("keydown", (e) => {
  if (e.code === "KeyR" && !drivingCar) location.search = "?seed=" + Math.floor(Math.random() * 100000);
  if (e.code === "KeyE") {
    if (drivingCar) {
      drivingCar.components.find((c) => c.rpm !== undefined)?.stop();
      const q = drivingCar.object3d.quaternion;
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const yaw = Math.atan2(fwd.x, fwd.z);
      player.at(drivingCar.position.x + Math.cos(yaw) * 2.6, drivingCar.position.y + 0.4,
                drivingCar.position.z - Math.sin(yaw) * 2.6);
      player.object3d.visible = true; rig.target = player; rig.distance = 6.5; drivingCar = null;
    } else {
      let best = null, d = 4.5;
      for (const c of cars) { const dd = c.position.distanceTo(player.position); if (dd < d) { best = c; d = dd; } }
      if (best) {
        drivingCar = best; player.object3d.visible = false; audio.play("click");
        best.components.find((c) => c.rpm !== undefined)?.start();
        rig.target = best; rig.distance = 9.5;
      }
    }
  }
  const target = drivingCar ?? (() => { let b = null, d = 5; for (const c of cars) { const dd = c.position.distanceTo(player.position); if (dd < d) { b = c; d = dd; } } return b; })();
  if (e.code === "KeyF" && target) target.components.find((c) => c.rb)?.recover(target, world);
  const vr = target?.components.find((c) => c.openAll);
  if (!vr) return;
  if (e.code === "KeyO") vr.rig.openParts.some((p) => p.target > 0.5) ? vr.closeAll() : vr.openAll();
  if (e.code === "KeyL") vr.headlights = !vr.headlights;
  if (e.code === "KeyC") { const pal = [0xcc2222, 0x2255cc, 0x111418, 0xe0e0e0, 0x1f9d55, 0xe0a020];
    vr._pi = ((vr._pi ?? -1) + 1) % pal.length; vr.rig.setPaint(pal[vr._pi]); }
  const map = { Digit1: "door_fl", Digit2: "door_fr", Digit3: "door_bl", Digit4: "door_br", Digit5: "hood", Digit6: "trunk" };
  if (map[e.code]) vr.toggle(map[e.code]);
});

world.spawn("hud").add({ update() {
  const el = document.getElementById("stats"); if (!el) return;
  el.textContent = drivingCar
    ? `${drivingCar.specName} · ${Math.round(drivingCar.components.find((c) => c.rb)?.kmh ?? 0)} km/h · [O]panels [C]paint [L]lights [F]recover`
    : `${cars.length}/3 cars · tiles ${terrain.tileCount} · runway → brick wall dead ahead · [E] near a car to drive`;
} });

// SPEEDOMETER (General, #179 HUD lane): analog gauge, visible only while driving.
// Driven off the engine's own per-frame update — reads the current car's kmh read-only.
const speedo = new HUD().mount();
world.spawn("speedo").add({ update() {
  const rb = drivingCar?.components.find((c) => c.rb);
  speedo.canvas.style.display = rb ? "block" : "none";
  // FIXED gauge max from the car's top speed (+12% headroom), rounded to a tidy 20 —
  // so the dial never grows when you peg it (Erik 2026-07-18); needle just pins at top.
  if (rb) speedo.render({ kmh: rb.kmh ?? 0, topKmh: Math.ceil(((rb.topSpeed ?? 38) * 3.6 * 1.12) / 20) * 20, onGround: true });
} });

// MINIMAP (General, #179 HUD lane): top-right north-up radar of the island — land/water
// from heightAt, player heading arrow, fleet (yellow) + settlements (grey). Reads only.
const minimap = new Minimap({ corner: "tr", range: 450 }).mount();
const _mmFwd = new THREE.Vector3();
world.spawn("minimap").add({ update() {
  const who = drivingCar ?? player;
  who.object3d.getWorldDirection(_mmFwd);
  minimap.render({
    x: who.position.x, z: who.position.z,
    heading: Math.atan2(_mmFwd.x, -_mmFwd.z),
    sampleHeight: heightAt, sea: SEA,
    points: [
      ...settlements.map((s) => ({ x: s.x, z: s.z, color: "#c9c4bb", r: 3.5 })),
      ...cars.filter((c) => c !== drivingCar).map((c) => ({ x: c.position.x, z: c.position.z, color: "#ffd75e", r: 3 })),
    ],
  });
} });

// ROAD NETWORK (General slice): procedural roads wiring the settlements + runway spur,
// laid on the terrain through Ninja's RoadNetwork; RoadGraph exposed on __pf so traffic
// AI (Ember) can snap + follow lanes. Routes dodge water/steep ground (see roadgen.js).
const { roads: roadLayout, graph: roadGraph } = generateRoads({ settlements, heightAt, islandR: ISLAND_R, sea: SEA, runway: RUN });
// The asphalt COLOR is baked into the terrain surface (colorAt → roadGraph.isRoad)
// so there's a flush base with ZERO float. ON TOP we lay a textured RoadNetwork
// ribbon — real Synty asphalt with a double-yellow center + dashed lane markings
// (Erik 2026-07-20: make the roads look better). It rides the terrain via heightAt
// with a small lift + polygonOffset so it sits flush without z-fighting or tire
// clip (the old bug was a 14 cm lift). Graph still drives decoration-skip + traffic.
const roadNet = new RoadNetwork({ ground: heightAt, lift: 0.05 });
for (const r of roadLayout) roadNet.addRoad(r.points, { width: r.width });
world.spawn("roads").add(roadNet);
window.__roadNet = roadNet;

// TOWN CENTER — REMOVED (Erik 2026-07-20): the old fabpack Demonstration.fbx town was the
// "leftover junk" + "strange ground textures" (scrambled MAIN ST / COLOR ME street decals).
// Gone now; real Synty modular buildings replace the settlement placeholders next.

// 🎨 SYNTY SWITCH — first assets (Erik 2026-07-20: "we're going all synty"). A few
// PolygonGangWarfare props textured through the shared-atlas pipeline (loadProp + the pack's
// T_..._01_A atlas) — proof it works in-world, and the seed of the full art switch.
// Additive + defensive: never breaks the boot. Relocate live via window.__gw[i].position.
{
  const GW = { texture: "T_PolygonGangWarfare_01_A.PNG", textureDir: "models/gangwarfare", textureFlipY: true };
  Promise.all([
    loadProp("models/gangwarfare/SM_Prop_Dumpster_01.FBX", GW),
    loadProp("models/gangwarfare/SM_Prop_Barrel_Metal_01.FBX", GW),
  ]).then(([dump, barrel]) => {
    const p = player.position;
    // place, then collide against the prop's ACTUAL SHAPE — a trimesh baked from the
    // mesh, same as the buildings (Erik: always use the object's real shape, never a
    // box; a box on a round barrel leaves invisible corners). Static (these don't move).
    const place = (m, dx, dz) => {
      m.position.set(p.x + dx, heightAt(p.x + dx, p.z + dz), p.z + dz);
      m.rotation.y = Math.random() * Math.PI;
      world.scene.add(m);
      physReady.then(() => { m.updateWorldMatrix(true, true); phys.addMeshCollider(m, { friction: 1.0 }); });
    };
    place(dump.group, 3, 3.5);
    place(barrel.group, 4.6, 3.9);
    window.__gw = [dump.group, barrel.group];
  }).catch((e) => console.warn("[synty] prop load failed (game continues):", e.message));
}

// PICKUPS (Ember 2026-07-20) — a SPAWNER, not ground-scatter (Erik): guns/ammo/
// health at defined points near spawn, each floats + spins + is walk-over-grabbed
// and grants through the combat seam (window.__pfCombat). Data-driven in
// src/pickups.js. Defensive: a bad asset or missing seam never breaks the boot.
{
  const pp = player.position;
  mountPickups(
    { world, loadProp, player, heightAt, phys, physReady },
    [
      { type: "pistol", x: pp.x + 6, z: pp.z + 2 },
      { type: "shotgun", x: pp.x + 9, z: pp.z - 2 },
      { type: "smg", x: pp.x + 7, z: pp.z + 5 },
      { type: "rifle", x: pp.x + 12, z: pp.z + 3 },
      { type: "ammo_small", x: pp.x + 6, z: pp.z - 4 },
      { type: "ammo_large", x: pp.x + 10, z: pp.z + 6 },
      { type: "ammo_shells", x: pp.x + 9, z: pp.z + 1 },
      { type: "health", x: pp.x + 14, z: pp.z - 1 },
    ],
  ).catch((e) => console.warn("[pickups] mount failed (game continues):", e.message));
}


// COMBAT (General slice, first pass): equip a weapon + shoot. Ranged raycasts from the
// camera (crosshair = screen center); hits feed damage into Ember's car lane (entity.damage
// → wreck smoke). On-foot only for now. Defensive: combat must NEVER break the game boot.
try {
  audio.loadSfx({                                    // Erik's weapon audio (public/sfx/)
    gunshot: ["sfx/gunshot_1.mp3", "sfx/gunshot_2.mp3"],
    shotgun: ["sfx/shotgun_1.mp3"],
    chainsaw: ["sfx/chainsaw_1.mp3", "sfx/chainsaw_2.mp3", "sfx/chainsaw_3.mp3"],
  });
  const combatHud = new CombatHUD();
  const combat = new CombatSystem({
    camera: world.camera,
    input: engine.input,
    targets: () => cars,
    loadProp,
    player,
    scene: world.scene,
    sound: (name) => {
      if (name === "shot") audio.playSfx("gunshot", { volume: 0.85, pitch: 0.9 + Math.random() * 0.2 });
      else if (name === "shotgun") audio.playSfx("shotgun", { volume: 0.9, pitch: 0.95 + Math.random() * 0.1 });
      else if (name === "chainsaw") audio.playSfx("chainsaw", { volume: 0.75, pitch: 0.95 + Math.random() * 0.1 });
    },
    onHitCar: (e, amt, point, dir) => {
      // route through Ember's damage system (body damage + onCarHit + flatten a shot tire);
      // fall back to a plain damage bump if it isn't up yet
      if (window.__pfDamage?.shotHit) window.__pfDamage.shotHit(e, amt, point, dir);
      else { e.damage = (e.damage || 0) + amt; e.onCarHit?.(amt, dir); }
      combatHud.flashHit();
    },
  });
  combat.equip("rifle").then(() => { combat.ammo = Infinity; });   // infinite ammo for the first-pass feel test
  world.spawn("combat").add({
    update(dt) {
      combat.enabled = !drivingCar && !(window.__pfTest && window.__pfTest.active && !window.__pfTest.livePlay);  // on foot; off in Anima tools mode (mouse = inspector), ON in live play
      combat.update(dt);
      combatHud.update({ name: combat.weapon.name, ammo: combat.ammo, maxAmmo: combat.weapon.ammo, kind: combat.weapon.kind });
    },
  });
  window.__pfCombat = combat;
} catch (e) { console.warn("[combat] mount failed (game continues):", e); }

engine.start();
window.__pf = { engine, world, audio, player, cars, terrain, phys, physReady, settlements, heightAt, RUN, roadGraph, get drivingCar() { return drivingCar; } };
// LOADING SCREEN (Ember): hold the reveal until physics is up + the initial tiles
// and async decorations have had a beat to stream, so the player drops into a
// finished island instead of watching it pop in. The overlay auto-reveals on a
// hard timeout too, so it can never trap the player.
initLoadingScreen();
// ready once physics is up + a short settle for the initial tiles/decorations to
// stream (time-based so it's predictable even if fps dips during asset loading).
physReady.then(() => setTimeout(() => { window.__pfReady = true; }, 900));
window.__pfLoadProp = loadProp;   // Synty asset integration — load+atlas a prop from the console
window.__pfLoadVehicle = loadVehicle;   // + vehicle rig loader (wheels/suspension) for Synty car tests

// DEV: blow up the player to test the character damage/ragdoll system (Erik) — 💥 button + KeyB
function blowUpPlayer() {
  const rag = window.__rag; if (!rag || drivingCar) return;
  const R = () => Math.random() - 0.5;
  const chest = player.position.clone(); chest.y += 1.1;
  rag.enter(new THREE.Vector3(R() * 6, 9 + Math.random() * 4, R() * 6),     // explosive launch
            new THREE.Vector3(R() * 14, R() * 8, R() * 14), chest);          // wild spin
  player.components.find((c) => c.onGround !== undefined && c.setEnabled)?.setEnabled(false);
  player.damage = (player.damage || 0) + 100; player.onCarHit?.(100, new THREE.Vector3(0, 1, 0));
  audio.playSfx("crash_metal_big", { volume: 0.8 });
}
window.addEventListener("keydown", (e) => { if (e.code === "KeyB" && !drivingCar) blowUpPlayer(); });
{
  const b = document.createElement("button");
  b.textContent = "💥 BLOW UP (B)";
  b.style.cssText = "position:fixed;left:16px;top:16px;z-index:45;padding:10px 16px;border-radius:10px;border:0;" +
    "background:#c0392bdd;color:#fff;font:700 14px system-ui;cursor:pointer;touch-action:none";
  b.addEventListener("click", blowUpPlayer);
  b.addEventListener("touchstart", (ev) => { ev.preventDefault(); blowUpPlayer(); });
  document.body.appendChild(b);
}
