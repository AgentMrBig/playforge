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
  CombatSystem, CombatHUD, loadProp, CharacterAim,
} from "../src/index.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

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
function colorAt(x, z, h, slope, out) {
  if (inRunway(x, z, 1)) { out.copy(TARMAC); return; }
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

function decorate(tile, group) {
  const { x0, z0, size } = tile;
  const r = mulberry((seed ^ (tile.ix * 668265263) ^ (tile.iz * 374761393)) >>> 0);
  tile.physBoxes = [];                                 // → Rapier statics in onTile

  // ---- forests ------------------------------------------------------------
  if (tile.res >= 24) {
    const spots = [];
    for (let t = 0; t < 60; t++) {
      const x = x0 + r() * size, z = z0 + r() * size;
      if (forestNoise(x, z) < 0.12) continue;
      const h = heightAt(x, z);
      if (h < SEA + 2 || h > 34) continue;
      if (inRunway(x, z, 8)) continue;
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
        tile.physBoxes.push({ half: [0.35 * sc, 2.2 * sc, 0.35 * sc], center: [x, h + 2.2 * sc, z] });
      });
      group.add(crowns, trunks);
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
      const big = s.type === "city" && sr() < 0.6;
      const w = big ? 8 + sr() * 6 : 5 + sr() * 3;
      const dep = big ? 8 + sr() * 6 : 5 + sr() * 3;
      const hgt = big ? 9 + sr() * 22 : 3.2 + sr() * 2.4;
      const gy = heightAt(bx, bz);
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
function attachTilePhysics(tile, mesh) {
  if (tile.dead) return;
  const cols = phys.addMeshCollider(mesh);             // the tile mesh IS the collider
  for (const b of tile.physBoxes ?? []) cols.push(phys.addBox(b.half, b.center));
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
      const planar = Math.hypot(body.velocity.x, body.velocity.z);
      if (!body.onGround) anim.play("jump", { fade: 0.1, once: true });
      else if (planar > 8) anim.play("run", { fade: 0.15 });
      else if (planar > 0.5) anim.play("walk", { fade: 0.18, speed: planar / 4.4 });
      else anim.play("idle", { fade: 0.3 });
    }
  }
}

const player = world.spawn("player")
  .at(RUN.x0 + 4, RUN.h + 1.5, RUN.z + RUN.w / 2 + 4)
  .add(new CharacterBody({ radius: 0.32, height: 1.7 }))   // real capsule vs EVERYTHING
  .add(new PlayerMove());
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

  // ---- ACTIVE RAGDOLL: get hit by a car → real jointed physics body -------
  // (muscle tone pulls toward whatever the Animator is playing — no scripts)
  physReady.then(() => {
    const rag = new Ragdoll(ch.bones, phys, { tone: 1.1 });
    window.__rag = rag;
    const cb = () => player.components.find((c) => c.ctrl && c.velocity);
    player.add({
      fixedUpdate(dt) {
        if (rag.active) {
          rag.fixedUpdate(dt);
          // camera + world logic follow the flying body
          const p = rag.pelvisPos();
          player.position.set(p.x, p.y - 0.9, p.z);
          const body = cb();
          if (body) body._lastSynced.copy(player.position);   // no teleport-fight
          if (rag.settled(1.3)) {                             // stand back up
            rag.exit();
            // get up WHERE the body came to rest — never below the terrain,
            // but keep the pelvis height when it settled on top of something
            // (snapping to raw terrain read as a teleport-respawn to Erik)
            const p2 = rag.pelvisPos();
            const g = heightAt(p2.x, p2.z);
            player.at(p2.x, Math.max(g + 0.2, p2.y - 0.55), p2.z);
            cb()?.setEnabled(true);
            ch.animator.play("idle", { fade: 0.55 });         // slow rise, not a pop
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
      update() { rag.update(); },                             // physics → bones
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
const FLEET = [
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
const cars = [];
for (const spec of FLEET) {
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
const roadNet = new RoadNetwork({ ground: heightAt });
const { roads: _roadLayout, graph: roadGraph } = generateRoads({ settlements, heightAt, islandR: ISLAND_R, sea: SEA, runway: RUN });
_roadLayout.forEach((r) => roadNet.addRoad(r.points, { width: r.width }));
world.spawn("roads").add(roadNet);

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
      combat.enabled = !drivingCar;                                // on-foot only for now
      combat.update(dt);
      combatHud.update({ name: combat.weapon.name, ammo: combat.ammo, maxAmmo: combat.weapon.ammo, kind: combat.weapon.kind });
    },
  });
  window.__pfCombat = combat;
} catch (e) { console.warn("[combat] mount failed (game continues):", e); }

engine.start();
window.__pf = { engine, world, audio, player, cars, terrain, phys, physReady, settlements, heightAt, RUN, roadGraph, get drivingCar() { return drivingCar; } };

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
