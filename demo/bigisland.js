// PLAYFORGE — BIG ISLAND: a massive streamed world with cities and towns.
// ~3km island, mountain ranges, forests, deterministic settlements. The
// terrain streams in LOD tiles around you; physics runs on pure math.
import {
  Engine, World, ThirdPersonRig, Audio, Body, Collider, StreamedTerrain,
  VehicleBody, PlayerVehicleControls, EngineSound, Animator, buildHumanoid,
  SkidMarks, fbm, ridged, mulberry, THREE,
} from "../src/index.js";
import { muscle } from "./carmodels.js";

const seed = Number(new URLSearchParams(location.search).get("seed")) || 7777;
document.getElementById("seed").textContent = seed;

const engine = new Engine(document.getElementById("game"), { clearColor: 0x8fb9dc });
const world = new World();
const audio = new Audio();
engine.world = world;
world.scene.fog = new THREE.Fog(0x8fb9dc, 180, 620);
world.camera.far = 3000;
world.camera.updateProjectionMatrix();

world.spawn("sun").mesh((() => {
  const g = new THREE.Group();
  const sun = new THREE.DirectionalLight(0xfff0d0, 2.2);
  sun.position.set(120, 160, 60);
  g.add(sun, new THREE.AmbientLight(0xa8c0e0, 0.85));
  return g;
})());

// ============================================================================
// WORLD GEN — one deterministic height function for a ~3km island
// ============================================================================
const ISLAND_R = 1500, SEA = 0;

// settlements: hash a coarse grid, keep cells that land on viable ground
const SETTLE_CELL = 420;
const settlements = [];
{
  const r = mulberry(seed ^ 0x5E77);
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
        r: big ? 150 : 70,                            // pad radius
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
  // two mountain belts: ridged noise gated by a low-freq band mask
  const belt = fbm(nx * 1.3 + 40, nz * 1.3 + 40, { octaves: 2, seed: seed + 13 });
  const mtn = ridged(nx * 5, nz * 5, { octaves: 4, seed: seed + 7 });
  const inland = Math.max(0, falloff - 0.25) / 0.75;
  return -8 + falloff * (11 + base * 16) +
         inland * Math.max(0, belt) * mtn * 85;
}

function heightAt(x, z) {
  let h = rawHeight(x, z);
  // settlements flatten the land into building pads
  for (const s of settlements) {
    const d = Math.hypot(x - s.x, z - s.z);
    if (d < s.r * 1.5) {
      const t = 1 - Math.min(d / (s.r * 1.5), 1);
      const pad = t * t * (3 - 2 * t);               // smoothstep
      h = h + (s.h - h) * Math.min(1, pad * 1.6);
    }
  }
  return h;
}

const forestNoise = (x, z) => fbm(x / 260 + 99, z / 260 + 99, { octaves: 3, seed: seed + 31 });

// ---- colors ----------------------------------------------------------------
const SAND = new THREE.Color(0xd9c58a), GRASS = new THREE.Color(0x4c8a45);
const DRY = new THREE.Color(0x7a9b4e), ROCK = new THREE.Color(0x7b7671);
const SNOW = new THREE.Color(0xf2f4f7), PAVE = new THREE.Color(0x9a978f);
function colorAt(x, z, h, slope, out) {
  for (const s of settlements) {                      // paved pads
    if (Math.hypot(x - s.x, z - s.z) < s.r) { out.copy(PAVE); return; }
  }
  if (h < SEA + 1.6) out.copy(SAND);
  else if (h > 55 && slope < 1.0) out.copy(SNOW);
  else if (slope > 0.85 || h > 38) out.copy(ROCK);
  else out.copy(GRASS).lerp(DRY, Math.max(0, forestNoise(x, z)) * 0.9);
}

// ---- per-tile content: trees + settlement buildings ------------------------
const TREE_GEO = new THREE.ConeGeometry(1.3, 3.4, 6);
const TREE_MAT = new THREE.MeshStandardMaterial({ color: 0x2e6e32 }); TREE_MAT._shared = true;
const TRUNK_GEO = new THREE.CylinderGeometry(0.18, 0.28, 1.5, 5);
const TRUNK_MAT = new THREE.MeshStandardMaterial({ color: 0x63452c }); TRUNK_MAT._shared = true;
const BLD_MATS = [0x8a8f96, 0x9a6a4f, 0x5e7d94, 0xa89a7d].map((c) => {
  const m = new THREE.MeshStandardMaterial({ color: c }); m._shared = true; return m;
});
const ROOF_MAT = new THREE.MeshStandardMaterial({ color: 0x8a4a3a }); ROOF_MAT._shared = true;

function decorate(tile, group) {
  const { x0, z0, size } = tile;
  const r = mulberry((seed ^ (tile.ix * 668265263) ^ (tile.iz * 374761393)) >>> 0);

  // ---- forests (instanced per tile, skip low LOD far tiles) ---------------
  if (tile.res >= 24) {
    const spots = [];
    for (let t = 0; t < 60; t++) {
      const x = x0 + r() * size, z = z0 + r() * size;
      if (forestNoise(x, z) < 0.12) continue;
      const h = heightAt(x, z);
      if (h < SEA + 2 || h > 34) continue;
      if (settlements.some((s) => Math.hypot(x - s.x, z - s.z) < s.r * 1.15)) continue;
      spots.push([x, h, z, 0.7 + r() * 0.9]);
    }
    if (spots.length) {
      const crowns = new THREE.InstancedMesh(TREE_GEO, TREE_MAT, spots.length);
      const trunks = new THREE.InstancedMesh(TRUNK_GEO, TRUNK_MAT, spots.length);
      const m = new THREE.Matrix4(), s3 = new THREE.Vector3();
      spots.forEach(([x, h, z, sc], i) => {
        m.identity().setPosition(x, h + 2.6 * sc, z); m.scale(s3.set(sc, sc, sc));
        crowns.setMatrixAt(i, m);
        m.identity().setPosition(x, h + 0.7 * sc, z); m.scale(s3.set(sc, sc, sc));
        trunks.setMatrixAt(i, m);
      });
      group.add(crowns, trunks);
    }
  }

  // ---- settlement buildings inside this tile ------------------------------
  for (const s of settlements) {
    // quick reject: settlement circle vs tile rect
    const nx = Math.max(x0, Math.min(s.x, x0 + size)), nz = Math.max(z0, Math.min(s.z, z0 + size));
    if (Math.hypot(s.x - nx, s.z - nz) > s.r) continue;
    const sr = mulberry(s.seed);
    const lots = s.type === "city" ? 26 : 9;
    for (let i = 0; i < lots; i++) {
      // deterministic ring/grid placement per settlement (same every visit)
      const a = (i / lots) * Math.PI * 2 + sr() * 0.5;
      const d = (s.type === "city" ? 0.25 + 0.65 * sr() : 0.3 + 0.55 * sr()) * s.r;
      const bx = s.x + Math.cos(a) * d, bz = s.z + Math.sin(a) * d;
      if (bx < x0 || bx >= x0 + size || bz < z0 || bz >= z0 + size) continue;
      const big = s.type === "city" && sr() < 0.6;
      const w = big ? 8 + sr() * 6 : 5 + sr() * 3;
      const dep = big ? 8 + sr() * 6 : 5 + sr() * 3;
      const hgt = big ? 9 + sr() * 22 : 3.2 + sr() * 2.4;
      const gy = heightAt(bx, bz);
      const bld = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, dep), BLD_MATS[Math.floor(sr() * BLD_MATS.length)]);
      bld.position.set(bx, gy + hgt / 2, bz);
      bld.castShadow = tile.res >= 24;
      group.add(bld);
      if (!big) { // gable roof for houses
        const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, dep) * 0.75, 1.8, 4), ROOF_MAT);
        roof.position.set(bx, gy + hgt + 0.9, bz);
        roof.rotation.y = Math.PI / 4;
        group.add(roof);
      }
      tile.addCollider(new Collider({ size: [w, hgt, dep], offset: [bx, gy + hgt / 2, bz] }));
    }
  }
}

// ============================================================================
// scene wiring
// ============================================================================
const terrain = new StreamedTerrain({
  heightAt, colorAt, decorate,
  tileSize: 128,
  rings: [[1, 48], [2, 24], [5, 12]],
  anchor: () => player.position,
});
world.spawn("terrain").add(terrain);

// sea + seafloor follow the player (the illusion of an infinite ocean)
const sea = world.spawn("sea").mesh(new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x2e6d9e, transparent: true, opacity: 0.8, roughness: 0.3 }),
)).at(0, SEA, 0);
sea.add({ update(dt, { engine }) {
  sea.position.x = player.position.x; sea.position.z = player.position.z;
  sea.position.y = SEA + Math.sin(engine.time * 0.7) * 0.1;
} });

// ---- player ----------------------------------------------------------------
class PlayerMove {
  fixedUpdate(dt, { input, world, entity }) {
    const body = entity.get(Body);
    if (drivingCar) { body.velocity.x = 0; body.velocity.z = 0; return; }
    const cam = world.camera;
    const f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
    const rt = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    const stick = input.stick("left");
    const ix = input.axis("KeyA", "KeyD") + stick.x;
    const iz = input.axis("KeyS", "KeyW") - stick.y;
    const run = input.down("ShiftLeft") ? 11 : 6.5;
    const wish = f.multiplyScalar(iz).addScaledVector(rt, ix);
    if (wish.lengthSq() > 1) wish.normalize();
    body.velocity.x = wish.x * run;
    body.velocity.z = wish.z * run;
    if (input.pressed("Space") && body.onGround) { body.velocity.y = 9; audio.play("jump"); }
    if (wish.lengthSq() > 0.01)
      entity.rotation.y = Math.atan2(body.velocity.x, body.velocity.z);
    const anim = entity.get(Animator);
    if (anim) {
      const planar = Math.hypot(body.velocity.x, body.velocity.z);
      if (!body.onGround) anim.play("jump", { fade: 0.1, once: true });
      else if (planar > 8) anim.play("run", { fade: 0.15 });
      else if (planar > 0.5) anim.play("walk", { fade: 0.18, speed: planar / 4.4 });
      else anim.play("idle", { fade: 0.3 });
    }
  }
}

// spawn on the first town's edge (or the beach if no settlements rolled)
const start = settlements[0] ?? { x: ISLAND_R * 0.55, z: 0 };
const rigHuman = buildHumanoid({ shirt: 0xff7a3c });
const player = world.spawn("player")
  .mesh(rigHuman.root)
  .at(start.x, heightAt(start.x, start.z) + 2, start.z + (start.r ?? 40) * 0.7)
  .add(new Body({ size: [0.6, 1.55, 0.6], offset: [0, 0.78, 0] }))
  .add(new Animator(rigHuman.root, rigHuman.clips))
  .add(new PlayerMove());
player.get(Animator).play("idle");

// ---- a car to explore with (Muscle spec + engine sound) --------------------
let drivingCar = null;
const carBits = muscle(0xc23b3b);
const car = world.spawn("drivable")
  .mesh(carBits.visual)
  .at(player.position.x + 4, heightAt(player.position.x + 4, player.position.z), player.position.z)
  .add(new VehicleBody({ chassis: carBits.chassis, wheels: carBits.wheels, enginePower: 12, topSpeed: 42, maxLatAccel: 10 }))
  .add(new PlayerVehicleControls({ enabled: () => drivingCar === car }))
  .add(new EngineSound(audio, { hp: 450 }))
  .add(new SkidMarks({ rearOffset: 1.45, track: 0.8 }));
car.specName = "Muscle"; car.specHp = 450;

// camera + enter/exit + HUD
engine.input.enablePointerLock();
const rig = new ThirdPersonRig(player, {
  distance: 6.5,
  isSprinting: () => engine.input.down("ShiftLeft"),
});
world.spawn("camera").add(rig);

window.addEventListener("keydown", (e) => {
  if (e.code === "KeyR") location.search = "?seed=" + Math.floor(Math.random() * 100000);
  if (e.code === "KeyE") {
    if (drivingCar) {
      drivingCar.components.find((c) => c.rpm !== undefined)?.stop();
      const yaw = drivingCar.rotation.y;
      player.at(drivingCar.position.x + Math.cos(yaw) * 2.4, drivingCar.position.y + 0.5,
                drivingCar.position.z - Math.sin(yaw) * 2.4);
      player.object3d.visible = true;
      rig.target = player; rig.distance = 6.5;
      drivingCar = null;
    } else if (car.position.distanceTo(player.position) < 4) {
      drivingCar = car;
      player.object3d.visible = false;
      audio.play("click");
      car.components.find((c) => c.rpm !== undefined)?.start();
      rig.target = car; rig.distance = 10;
    }
  }
});

world.spawn("hud").add({
  update() {
    const el = document.getElementById("stats");
    if (el) el.textContent =
      "tiles " + terrain.tileCount +
      " · settlements " + settlements.length +
      (drivingCar ? " · " + Math.round(drivingCar.get(VehicleBody).kmh) + " km/h" : "");
  },
});

engine.start();
window.__pf = { engine, world, audio, player, car, terrain, settlements, heightAt };
