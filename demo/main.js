// PlayForge demo: a tiny collect-the-cubes game.
// This file is the API pitch — if this reads well, the engine works.
import { Engine, World, OrbitRig, Audio, THREE } from "../src/index.js";

const engine = new Engine(document.getElementById("game"));
const world = new World();
const audio = new Audio();
engine.world = world;

// ---- lights & ground -------------------------------------------------------
world.spawn("sun").mesh(makeSun());
world.spawn("ground").mesh(new THREE.Mesh(
  new THREE.CylinderGeometry(14, 14, 0.5, 48),
  new THREE.MeshStandardMaterial({ color: 0x3d7a3f }),
)).at(0, -0.25, 0);
world.find("ground").object3d.children[0].receiveShadow = true;

function makeSun() {
  const g = new THREE.Group();
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.4);
  sun.position.set(12, 18, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 20;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
  g.add(sun, new THREE.AmbientLight(0x8899bb, 0.7));
  return g;
}

// ---- player ----------------------------------------------------------------
class PlayerController {
  constructor() { this.vel = new THREE.Vector3(); this.onGround = true; }
  fixedUpdate(dt, { input, world, entity }) {
    const cam = world.camera;
    // camera-relative WASD (stick support comes along free)
    const f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
    const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    const stick = input.stick("left");
    const ix = input.axis("KeyA", "KeyD") + stick.x;
    const iz = input.axis("KeyS", "KeyW") - stick.y;
    const wish = f.multiplyScalar(iz).addScaledVector(r, ix);
    if (wish.lengthSq() > 1) wish.normalize();
    this.vel.x = wish.x * 6; this.vel.z = wish.z * 6;

    if ((input.pressed("Space") || input.pressed("Mouse2")) && this.onGround) {
      this.vel.y = 8; this.onGround = false; audio.play("jump");
    }
    this.vel.y -= 24 * dt;
    entity.position.addScaledVector(this.vel, dt);
    if (entity.position.y <= 0.5) { entity.position.y = 0.5; this.vel.y = 0; this.onGround = true; }
    // face where you're going
    if (this.vel.x * this.vel.x + this.vel.z * this.vel.z > 0.1)
      entity.rotation.y = Math.atan2(this.vel.x, this.vel.z);
    // fell off the disc? back to center
    if (entity.position.distanceTo(new THREE.Vector3(0, entity.position.y, 0)) > 14.5) {
      entity.at(0, 0.5, 0); audio.play("die");
    }
  }
}

const player = world.spawn("player")
  .mesh(makeBody())
  .at(0, 0.5, 0)
  .add(new PlayerController());

function makeBody() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x4d8dff });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.5), mat);
  body.position.y = 0.15; body.castShadow = true;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5),
    new THREE.MeshStandardMaterial({ color: 0xf2c9a0 }));
  head.position.y = 0.9; head.castShadow = true;
  g.add(body, head);
  return g;
}

// ---- collectibles ----------------------------------------------------------
class Spin {
  constructor(speed = 2) { this.speed = speed; }
  update(dt, { entity, engine }) {
    entity.rotation.y += this.speed * dt;
    entity.position.y = 0.8 + Math.sin(engine.time * 3 + entity.position.x) * 0.15;
  }
}
class Collectible {
  fixedUpdate(_dt, { entity, world }) {
    const p = world.find("player");
    if (p && entity.position.distanceTo(p.position) < 1.0) {
      world.destroy(entity);
      audio.play("pickup");
      score++;
      document.getElementById("score").textContent = score;
      if (world.findAll("coin").length <= 1) { audio.play("win"); spawnCoins(); }
    }
  }
}

let score = 0;
function spawnCoins() {
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.random();
    const d = 4 + Math.random() * 8;
    world.spawn("coin")
      .mesh(shadowed(new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.5, 0.5),
        new THREE.MeshStandardMaterial({ color: 0xffd75e, emissive: 0x664400 }),
      )))
      .at(Math.cos(a) * d, 0.8, Math.sin(a) * d)
      .add(new Spin(2 + Math.random() * 2))
      .add(new Collectible());
  }
}
function shadowed(m) { m.castShadow = true; return m; }
spawnCoins();

// ---- camera ----------------------------------------------------------------
world.spawn("camera").add(new OrbitRig({ target: [0, 1, 0], distance: 16, pitch: 0.55 }));

engine.start();
window.__pf = { engine, world, audio }; // debug handle (also used by tests)
