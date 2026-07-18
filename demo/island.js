// PLAYFORGE ISLAND — seeded island: beaches, meadows, ridged mountains,
// snow caps, palm-ish trees, swimmable sea. R = new island, ?seed= pins one.
import {
  Engine, World, ThirdPersonRig, Audio, Body, Heightfield,
  fbm, ridged, mulberry, THREE,
} from "../src/index.js";

const seed = Number(new URLSearchParams(location.search).get("seed")) ||
             Math.floor(Math.random() * 100000);
document.getElementById("seed").textContent = seed;

const engine = new Engine(document.getElementById("game"), { clearColor: 0x87b7dd });
const world = new World();
const audio = new Audio();
engine.world = world;
world.scene.fog = new THREE.Fog(0x87b7dd, 120, 420);

// sun
world.spawn("sun").mesh((() => {
  const g = new THREE.Group();
  const sun = new THREE.DirectionalLight(0xfff0d0, 2.3);
  sun.position.set(80, 110, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const s = 220;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, far: 500 });
  g.add(sun, new THREE.AmbientLight(0xa8c0e0, 0.7));
  return g;
})());

// ---- the island ------------------------------------------------------------
const SIZE = 420, SEA = 0;
function islandHeight(x, z) {
  const nx = x / SIZE, nz = z / SIZE;
  const d = Math.hypot(nx, nz) * 2;                        // 0 center → 1 edge
  const falloff = Math.max(0, 1 - d * d * 1.15);           // radial island mask
  const base = fbm(nx * 3 + 10, nz * 3 + 10, { octaves: 5, seed }) * 0.5 + 0.5;
  const mtn = ridged(nx * 3.6, nz * 3.6, { octaves: 4, seed: seed + 7 });
  // mountains only rise well inland
  const inland = Math.max(0, falloff - 0.35) / 0.65;
  let h = -6 + falloff * (10 + base * 14) + inland * inland * mtn * 55;
  return h;
}

const hf = new Heightfield({ size: SIZE, res: 220, heightAt: islandHeight });
const SAND = new THREE.Color(0xd9c58a), GRASS = new THREE.Color(0x4a8f43);
const ROCK = new THREE.Color(0x7a7570), SNOW = new THREE.Color(0xf2f4f7);
const DEEPSAND = new THREE.Color(0xb5a26e);
world.spawn("terrain").mesh(hf.buildMesh((x, z, h, slope, out) => {
  if (h < SEA + 0.6) out.copy(DEEPSAND).lerp(SAND, THREE.MathUtils.clamp((h - SEA + 2) / 2.6, 0, 1));
  else if (h < SEA + 2.2) out.copy(SAND);
  else if (h > 30 && slope < 0.9) out.copy(SNOW);
  else if (slope > 0.75 || h > 20) out.copy(ROCK);
  else out.copy(GRASS).offsetHSL(0, 0, (fbm(x * 0.05, z * 0.05, { seed: seed + 3 })) * 0.04);
})).add(hf);

// sea: two planes — animated surface + deep tint below
const seaMat = new THREE.MeshStandardMaterial({
  color: 0x2e6d9e, transparent: true, opacity: 0.78, roughness: 0.25, metalness: 0.1,
});
const sea = world.spawn("sea").mesh(new THREE.Mesh(new THREE.PlaneGeometry(SIZE * 2, SIZE * 2).rotateX(-Math.PI / 2), seaMat)).at(0, SEA, 0);
world.spawn("seafloor").mesh(new THREE.Mesh(
  new THREE.PlaneGeometry(SIZE * 2, SIZE * 2).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x1c4668 }),
)).at(0, SEA - 7, 0);
sea.add({ update(dt, { engine }) { sea.position.y = SEA + Math.sin(engine.time * 0.7) * 0.12; } });

// ---- trees on the meadows --------------------------------------------------
const r = mulberry(seed ^ 0xA11CE);
const trunkM = new THREE.MeshStandardMaterial({ color: 0x6b4a2f });
const crownM = new THREE.MeshStandardMaterial({ color: 0x2e7031 });
let planted = 0;
for (let tries = 0; tries < 900 && planted < 160; tries++) {
  const x = (r() - 0.5) * SIZE * 0.9, z = (r() - 0.5) * SIZE * 0.9;
  const h = hf.heightAt(x, z), s = hf.slopeAt(x, z);
  if (h < SEA + 2.5 || h > 22 || s > 0.5) continue; // beaches/cliffs/peaks: no trees
  const g = new THREE.Group();
  const th = 1.6 + r() * 1.6;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.26, th, 6), trunkM);
  trunk.position.y = th / 2;
  const crown = new THREE.Mesh(new THREE.ConeGeometry(1.2 + r(), 2.6 + r() * 2, 7), crownM);
  crown.position.y = th + 1.1;
  crown.castShadow = true;
  g.add(trunk, crown);
  world.spawn("tree").mesh(g).at(x, h, z);
  planted++;
}

// ---- player: walk the island, swim the sea ---------------------------------
class IslandMove {
  fixedUpdate(dt, { input, world, entity }) {
    const body = entity.get(Body);
    const cam = world.camera;
    const f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
    const rt = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    const stick = input.stick("left");
    const ix = input.axis("KeyA", "KeyD") + stick.x;
    const iz = input.axis("KeyS", "KeyW") - stick.y;
    const wish = f.multiplyScalar(iz).addScaledVector(rt, ix);
    if (wish.lengthSq() > 1) wish.normalize();

    const depth = SEA - hf.heightAt(entity.position.x, entity.position.z);
    const swimming = depth > 1.1 && entity.position.y < SEA + 0.4;
    const speed = swimming ? 3.2 : input.down("ShiftLeft") ? 11 : 6.5;
    body.velocity.x = wish.x * speed;
    body.velocity.z = wish.z * speed;
    if (swimming) { // float at the surface, Lumencraft-style buoyancy
      body.velocity.y = Math.max(body.velocity.y, 0) +
        (SEA - 0.55 - entity.position.y) * 6 * dt * 60 * 0.02;
      body.velocity.y = THREE.MathUtils.clamp(body.velocity.y, -1.5, 2.5);
      if (input.pressed("Space")) body.velocity.y = 3;
    } else if (input.pressed("Space") && body.onGround) {
      body.velocity.y = 9; audio.play("jump");
    }
    if (wish.lengthSq() > 0.01)
      entity.rotation.y = Math.atan2(body.velocity.x, body.velocity.z);
  }
}

// spawn on a beach: walk the +x axis until the first sand above sea level
let sx = SIZE / 2 - 4;
while (sx > 0 && hf.heightAt(sx, 0) < SEA + 1) sx -= 2;
const player = world.spawn("player")
  .mesh((() => {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xff7a3c }));
    b.position.y = 0.45; b.castShadow = true;
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xf2c9a0 }));
    h.position.y = 1.15; h.castShadow = true;
    g.add(b, h);
    return g;
  })())
  .at(sx, hf.heightAt(sx, 0) + 1, 0)
  .add(new Body({ size: [0.6, 1.35, 0.6], offset: [0, 0.55, 0] }))
  .add(new IslandMove());

engine.input.enablePointerLock();
world.spawn("camera").add(new ThirdPersonRig(player, {
  distance: 7,
  isSprinting: () => engine.input.down("ShiftLeft"),
}));

window.addEventListener("keydown", (e) => {
  if (e.code === "KeyR") location.search = "?seed=" + Math.floor(Math.random() * 100000);
});

engine.start();
window.__pf = { engine, world, audio, player, hf, SEA };
