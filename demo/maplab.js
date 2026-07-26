// PLAYFORGE — Map Lab (large-world streaming proving ground)
//
// The map equivalent of the car Garage / ragdoll lab: an isolated scene whose
// ONLY job is to make large-world streaming measurable. A car auto-drives
// flat-out across infinite streamed terrain while a live frametime graph shows
// every hitch. Build the "very good" streaming here, prove it's smooth at speed,
// then merge into the game (same path the car + ragdoll took).
//
// What it measures/exposes:
//   • frametime graph (last ~3s) with the 16.7ms (60fps) line — hitches are red
//   • worst frame in the last 2s, hitch count, fps, tiles loaded, tiles/sec
//   • collider strategy A/B: ?col=heightfield (default) | trimesh | none
//   • WASD to drive, or leave it on autopilot (full-throttle gentle snake so it
//     always crosses fresh tiles — the streaming worst case)
//
// Own fixed-step loop (like garage) for exact frametime control. The Car drives
// via the phys _pre/_post hooks, same as CarVehicle.
import {
  Engine, World, Physics, initRapier, Car, StreamedTerrain,
  makeIslandTerrain, makeHeightmapTerrain, loadTerrarium, loadVehicle, THREE,
} from "../src/index.js";

// swap the placeholder box for the Synty muscle car (non-blocking; box works until loaded)
function attachMuscle(car) {
  loadVehicle("models/fabpack/SK_veh_Muscle_01.fbx", {
    targetLength: 4.6, textureDir: "models/fabpack", textureFlipY: true,
    textureMap: { palette: "T_colorPalette2048.PNG", veh: "T_colorPalette2048.PNG" },
  }).then((rig) => car.attachModel(rig)).catch((e) => console.warn("muscle load failed:", e.message));
}
import RAPIER from "@dimforge/rapier3d-compat";   // deduped — same singleton phys.js uses

const FIXED = 1 / 60;
const MAX_SUBSTEPS = 5;
const qs = new URLSearchParams(location.search);
const COL_MODE = qs.get("col") || "heightfield";     // heightfield | trimesh | none
const COL_CELL = +(qs.get("cell") || 1.5);           // collider cell size (m)

const engine = new Engine(document.getElementById("game"), { clearColor: 0xaacbe6, logDepth: true });
const world = new World();
engine.world = world;
const scene = world.scene;
// flight-sim view distance: far plane ~16km + logarithmic depth + atmospheric
// haze so distant terrain/ocean melt into the sky instead of hard-clipping.
world.camera.far = 16000;
world.camera.updateProjectionMatrix();
scene.fog = new THREE.FogExp2(0xbcd6ea, 0.00011);   // ~half haze by ~8km, faded out by ~20km

// ---- lights -----------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0xcfe0f0, 0x40402e, 0.9));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
sun.position.set(60, 120, 40); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, far: 320 });
scene.add(sun);
engine.renderer.shadowMap.enabled = true;
engine.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// ---- realistic procedural island (worldgen.js): domain-warped ridged ranges,
// carved valleys, wandering coastline, moisture biomes. Iterate it here, then
// swap into Big Island. ?seed=N for a different island. -------------------------
// Terrain is either a procedural island (worldgen) or a REAL heightmap
// (?real=alps → AWS Terrarium DEM tiles). The DEM loads async, so gen/heightAt
// resolve in boot() below, not synchronously here.
const SEED = +(qs.get("seed") || 1337);
const ISLAND_R = +(qs.get("islandR") || 1500);
const REAL = qs.get("real");
let gen = null, heightAt = null, colorAt = null;

// ---- physics ----------------------------------------------------------------
const phys = new Physics({ gravity: -20 });

// ---- free-fly camera (UE-style): F toggles; click to capture the mouse, WASD
// flies, Space/Ctrl up/down, Shift boosts. Streaming follows wherever you fly. --
const freeCam = { on: false, pos: new THREE.Vector3(), yaw: 0, pitch: -0.25, speed: 70 };
const _ORIGIN = new THREE.Vector3();

// ---- streamed terrain + per-tile collider (built in boot() once heightAt exists) --
let terrain = null;
let tilesBuilt = 0, colliderBuildMs = 0;   // telemetry
const pendingTiles = [];
function attachTileCollider(tile) {
  if (tile.dead) return;
  const t0 = performance.now();
  let col;
  if (COL_MODE === "trimesh") {
    // old path: dense trimesh sampled from heightAt (BVH build — the hitch)
    const cell = COL_CELL, cres = Math.max(8, Math.round(tile.size / cell)), N = cres + 1;
    const verts = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const wx = tile.x0 + (i / cres) * tile.size, wz = tile.z0 + (j / cres) * tile.size, o = (j * N + i) * 3;
      verts[o] = wx; verts[o + 1] = heightAt(wx, wz); verts[o + 2] = wz;
    }
    const idx = new Uint32Array(cres * cres * 6); let t = 0;
    for (let j = 0; j < cres; j++) for (let i = 0; i < cres; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b; idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
    col = phys.addTrimesh(verts, idx, { friction: 1.0 });
  } else {
    // new path: Rapier heightfield — no BVH, ~0.5ms build
    const n = Math.max(8, Math.round(tile.size / COL_CELL));
    col = phys.addHeightfield(tile.x0, tile.z0, tile.size, heightAt, { n, friction: 1.0 });
  }
  colliderBuildMs = performance.now() - t0;
  tile.cleanup.push(() => phys.removeCollider(col));
}

// ---- the car (raw Car; driven via phys hooks like CarVehicle) ---------------
let car = null;
const keys = {};
addEventListener("keydown", (e) => { keys[e.code] = true;
  if (e.code === "KeyR") resetCar();
  if (e.code === "KeyF") toggleFreeCam();
  if (e.code === "Space" && !freeCam.on) auto.on = !auto.on;   // in free cam Space = fly up
  if (["Space", "KeyW", "KeyS", "KeyA", "KeyD"].includes(e.code) && freeCam.on) e.preventDefault();
});
addEventListener("keyup", (e) => { keys[e.code] = false; });
const auto = { on: true, t: 0 };
function toggleFreeCam() {
  freeCam.on = !freeCam.on;
  if (freeCam.on) {
    freeCam.pos.copy(world.camera.position);
    const d = new THREE.Vector3(); world.camera.getWorldDirection(d);
    freeCam.yaw = Math.atan2(d.x, d.z); freeCam.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    engine.renderer.domElement.requestPointerLock?.();
  } else document.exitPointerLock?.();
}
engine.renderer.domElement.addEventListener("click", () => { if (freeCam.on && !document.pointerLockElement) engine.renderer.domElement.requestPointerLock?.(); });
addEventListener("mousemove", (e) => {
  if (!freeCam.on || !document.pointerLockElement) return;
  freeCam.yaw -= e.movementX * 0.0022;
  freeCam.pitch = THREE.MathUtils.clamp(freeCam.pitch - e.movementY * 0.0022, -1.5, 1.5);
});
function carInput() {
  if (freeCam.on) { auto.t += FIXED; return { throttle: 1, steer: 0.14 * Math.sin(auto.t * 0.12), brake: 0, handbrake: false }; } // car keeps cruising while you fly
  const up = keys.KeyW || keys.ArrowUp, down = keys.KeyS || keys.ArrowDown;
  const left = keys.KeyA || keys.ArrowLeft, right = keys.KeyD || keys.ArrowRight;
  if (up || down || left || right) { auto.on = false; }
  if (auto.on) { auto.t += FIXED; return { throttle: 1, steer: 0.14 * Math.sin(auto.t * 0.12), brake: 0, handbrake: false }; }
  return { throttle: (up ? 1 : 0) - (down ? 1 : 0), steer: (left ? 1 : 0) - (right ? 1 : 0), brake: 0, handbrake: !!keys.Space };
}
// pick a gentle inland spawn (not a peak, not the beach) so you start on drivable ground
function findSpawn() {
  for (let r = 0; r < ISLAND_R * 0.7; r += 45)
    for (let a = 0; a < 6.28; a += 0.5) {
      const x = Math.cos(a) * r, z = Math.sin(a) * r, h = heightAt(x, z);
      const s = Math.max(Math.abs(heightAt(x + 2, z) - h), Math.abs(heightAt(x, z + 2) - h)) / 2;
      if (h > 3 && h < 22 && s < 0.4) return { x, z, h };
    }
  return { x: 0, z: 0, h: heightAt(0, 0) };
}
let spawn = null;
function resetCar() {
  if (!car) return;
  const y = heightAt(spawn.x, spawn.z) + 2;
  car.body.setTranslation({ x: spawn.x, y, z: spawn.z }, true);
  car.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  car._read(car.currPos, car.currQuat); car.prevPos.copy(car.currPos); car.prevQuat.copy(car.currQuat);
  auto.t = 0;
}

// ---- cameras: chase (driving) or free-fly (exploring) -----------------------
const camTmp = new THREE.Vector3(), camGoal = new THREE.Vector3(), fwd = new THREE.Vector3();
const _fdir = new THREE.Vector3();
function updateCamera(dt) {
  const cam = world.camera;
  if (freeCam.on) {
    const cy = Math.cos(freeCam.yaw), sy = Math.sin(freeCam.yaw), cp = Math.cos(freeCam.pitch), sp = Math.sin(freeCam.pitch);
    _fdir.set(sy * cp, sp, cy * cp);                         // look direction from yaw/pitch
    const spd = freeCam.speed * (keys.ShiftLeft || keys.ShiftRight ? 4 : 1) * dt;
    if (keys.KeyW) freeCam.pos.addScaledVector(_fdir, spd);
    if (keys.KeyS) freeCam.pos.addScaledVector(_fdir, -spd);
    if (keys.KeyD) { freeCam.pos.x += cy * spd; freeCam.pos.z -= sy * spd; }   // strafe right
    if (keys.KeyA) { freeCam.pos.x -= cy * spd; freeCam.pos.z += sy * spd; }
    if (keys.Space) freeCam.pos.y += spd;
    if (keys.ControlLeft || keys.KeyC) freeCam.pos.y -= spd;
    cam.position.copy(freeCam.pos);
    cam.lookAt(freeCam.pos.x + _fdir.x, freeCam.pos.y + _fdir.y, freeCam.pos.z + _fdir.z);
    return;
  }
  if (!car) return;
  const p = car.mesh.position;
  fwd.set(0, 0, 1).applyQuaternion(car.mesh.quaternion);
  camGoal.set(p.x - fwd.x * 11, p.y + 5.5, p.z - fwd.z * 11);
  cam.position.lerp(camGoal, 0.12);
  camTmp.set(p.x + fwd.x * 6, p.y + 1.2, p.z + fwd.z * 6);
  cam.lookAt(camTmp);
}

// ---- boot (async: real DEM tiles load over the network) ---------------------
async function buildGen() {
  if (REAL === "alps") {
    const tiles = [];
    for (const y of [1455, 1456, 1457]) for (const x of [2134, 2135, 2136]) tiles.push({ x, y });
    const hm = await loadTerrarium({ dir: "heightmaps/alps", tiles, span: 3 });
    return makeHeightmapTerrain({ grid: hm.grid, N: hm.N, worldExtent: 20400, seed: SEED }); // ~20km of real Alps
  }
  return makeIslandTerrain({ seed: SEED, islandR: ISLAND_R, sea: 0, erosion: qs.get("erode") !== "0" });
}
(async () => {
  setStatus(REAL ? "loading real terrain…" : "generating terrain…");
  gen = await buildGen();
  heightAt = gen.heightAt; colorAt = gen.colorAt;
  const w = gen.waterMesh(REAL ? 60000 : 42000); if (w) scene.add(w);
  scene.add(gen.backdropMesh(REAL ? 400 : 320));
  terrain = new StreamedTerrain({
    heightAt, colorAt, tileSize: 128, rings: [[1, 96], [2, 40], [5, 14]],
    anchor: () => freeCam.on ? freeCam.pos : (car ? car.mesh.position : _ORIGIN),
  });
  terrain.onTile = (tile) => {
    tilesBuilt++;
    if (COL_MODE === "none") return;
    if (!phys.world) { pendingTiles.push(tile); return; }
    attachTileCollider(tile);
  };
  spawn = findSpawn();
  await initRapier();
  world.spawn("physics").add(phys);
  for (const t of pendingTiles) attachTileCollider(t);
  pendingTiles.length = 0;
  car = new Car(phys.world, RAPIER, { pos: [spawn.x, heightAt(spawn.x, spawn.z) + 2, spawn.z] });
  scene.add(car.mesh);
  attachMuscle(car);
  world.spawn("terrain").add(terrain);
  phys._pre.push(() => { car.snapshotPrev(); car.setInput(carInput()); car.fixedUpdate(FIXED); });
  phys._post.push(() => car.snapshotCurr());
  setStatus(REAL ? `real terrain: Alps · ${Math.round(gen.maxH - gen.minH)}m relief — F to fly` : "driving (autopilot) — press F for free-fly cam to explore");
})().catch((e) => setStatus("BOOT FAILED: " + e.message));

// ---- fixed-step loop + frametime capture ------------------------------------
const FT = new Float32Array(180); let ftI = 0;      // rolling frametime ring (ms)
let last = performance.now() / 1000, acc = 0;
let hitches = 0, worst2s = 0, worst2sT = 0;
let fpsAvg = 60;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000;
  let dt = now - last; last = now;
  if (dt > 0.25) dt = FIXED;                 // tab was backgrounded — don't spiral
  const ms = dt * 1000;
  FT[ftI = (ftI + 1) % FT.length] = ms;
  fpsAvg += ((1 / Math.max(1e-3, dt)) - fpsAvg) * 0.1;
  if (ms > 20) hitches++;
  worst2s = Math.max(worst2s, ms); worst2sT += dt;
  if (worst2sT > 2) { worst2sT = 0; worst2s = ms; }

  acc += dt;
  let steps = 0;
  while (acc >= FIXED && steps < MAX_SUBSTEPS) { world._fixedUpdate(FIXED, engine); acc -= FIXED; steps++; }
  if (steps === MAX_SUBSTEPS) acc = 0;
  world._update(dt, engine);                 // terrain streaming + any components
  if (car) car.interpolate(Math.min(1, acc / FIXED));
  updateCamera(dt);
  drawGraph();
  updateHUD();
  engine.renderer.render(scene, world.camera);
}
requestAnimationFrame(frame);
function fit() { engine.renderer.setSize(innerWidth, innerHeight, false); world.camera.aspect = innerWidth / innerHeight; world.camera.updateProjectionMatrix(); }
fit(); addEventListener("resize", fit);

// ---- HUD: frametime graph + readouts ---------------------------------------
function setStatus(t) { const el = document.getElementById("status"); if (el) el.textContent = t; }
let gctx = null;
function drawGraph() {
  const cv = document.getElementById("ftgraph"); if (!cv) return;
  if (!gctx) { gctx = cv.getContext("2d"); }
  const w = cv.width, h = cv.height, g = gctx;
  g.clearRect(0, 0, w, h);
  g.fillStyle = "rgba(10,14,18,.72)"; g.fillRect(0, 0, w, h);
  const scaleY = h / 40;                       // 0..40ms range
  // 16.7ms (60fps) + 33.3ms (30fps) lines
  g.strokeStyle = "rgba(120,220,140,.5)"; g.beginPath(); g.moveTo(0, h - 16.7 * scaleY); g.lineTo(w, h - 16.7 * scaleY); g.stroke();
  g.strokeStyle = "rgba(230,170,70,.5)"; g.beginPath(); g.moveTo(0, h - 33.3 * scaleY); g.lineTo(w, h - 33.3 * scaleY); g.stroke();
  const n = FT.length, bw = w / n;
  for (let k = 0; k < n; k++) {
    const v = FT[(ftI + 1 + k) % n];
    const bh = Math.min(h, v * scaleY);
    g.fillStyle = v > 33.3 ? "#e05555" : v > 18 ? "#e0a020" : "#5fbf7f";
    g.fillRect(k * bw, h - bh, Math.max(1, bw - 0.5), bh);
  }
}
function updateHUD() {
  const el = document.getElementById("readouts"); if (!el) return;
  const spd = car ? Math.hypot(car.body.linvel().x, car.body.linvel().y, car.body.linvel().z) * 3.6 : 0;
  const line = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  el.innerHTML =
    line("mode", freeCam.on ? "FREE-FLY" : "drive") +
    line("collider", COL_MODE + (COL_MODE !== "none" ? ` @${COL_CELL}m` : "")) +
    line("fps", fpsAvg.toFixed(0)) +
    line("worst 2s", worst2s.toFixed(1) + "ms") +
    line("hitches >20ms", hitches) +
    line("last collider build", colliderBuildMs.toFixed(1) + "ms") +
    line("tiles loaded", terrain ? terrain.tileCount : 0) +
    line("tiles built", tilesBuilt) +
    line("car", spd.toFixed(0) + " km/h");
}

// ---- headless verification handle ------------------------------------------
window.__map = {
  engine, world, phys, get terrain() { return terrain; }, get car() { return car; },
  get heightAt() { return heightAt; }, freeCam, updateCamera,
  frametimes: FT, get hitches() { return hitches; }, get worst2s() { return worst2s; },
  get tilesBuilt() { return tilesBuilt; }, setAuto: (v) => { auto.on = v; },
  // measure a single collider build cost for the current mode at (x0,z0)
  timeColliderBuild(x0 = 500, z0 = 500) {
    const t = { dead: false, x0, z0, size: 128, cleanup: [] };
    const t0 = performance.now(); attachTileCollider(t); const dt = performance.now() - t0;
    for (const f of t.cleanup) f();
    return +dt.toFixed(2);
  },
};
