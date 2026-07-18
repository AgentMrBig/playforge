// PLAYFORGE CITY — GTA-style procedural city: seeded generator, AI traffic,
// on-foot player. R = new city, ?seed=N pins one.
import {
  Engine, World, OrbitRig, Audio, Body, Collider, THREE,
} from "../src/index.js";
import { generateCity, rng } from "./citygen.js";

const seed = Number(new URLSearchParams(location.search).get("seed")) ||
             Math.floor(Math.random() * 100000);
document.getElementById("seed").textContent = seed;

const engine = new Engine(document.getElementById("game"), { clearColor: 0x8db8d8 });
const world = new World();
const audio = new Audio();
engine.world = world;

// late-afternoon sun + sky fog
world.scene.fog = new THREE.Fog(0x8db8d8, 90, 320);
world.spawn("sun").mesh((() => {
  const g = new THREE.Group();
  const sun = new THREE.DirectionalLight(0xffe0b8, 2.2);
  sun.position.set(60, 80, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const s = 130;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, far: 400 });
  g.add(sun, new THREE.AmbientLight(0x9fb4d8, 0.75));
  return g;
})());

// ---- generate the city -----------------------------------------------------
const city = generateCity(world, seed);

// ---- AI traffic ------------------------------------------------------------
const CAR_COLORS = [0xc23b3b, 0x3b62c2, 0xd8d8d8, 0x2f2f34, 0xd8a13b, 0x3bc27a];
class CarAI {
  constructor(r) {
    this.r = r;
    this.axis = r() < 0.5 ? "x" : "z";
    this.dir = r() < 0.5 ? 1 : -1;
    this.speed = 9 + r() * 4;
    this._nextCross = null;
  }
  init(entity) { this._align(entity); }
  _align(entity) {
    // snap to the correct lane (right-hand traffic) and face travel direction
    const lane = city.laneOffset * this.dir;
    if (this.axis === "x") entity.position.z = this._road + lane;
    else entity.position.x = this._road - lane;
    entity.rotation.y = this.axis === "x"
      ? (this.dir > 0 ? Math.PI / 2 : -Math.PI / 2)
      : (this.dir > 0 ? 0 : Math.PI);
  }
  get _road() { // nearest road line to current cross-axis position
    const p = this.axis === "x" ? this._z ?? 0 : this._x ?? 0;
    return city.lines.reduce((a, b) => Math.abs(b - p) < Math.abs(a - p) ? b : a);
  }
  fixedUpdate(dt, { entity }) {
    const p = entity.position;
    this._x = p.x; this._z = p.z;
    const move = this.speed * dt * this.dir;
    if (this.axis === "x") p.x += move; else p.z += move;

    // choose a turn at the next intersection line
    const along = this.axis === "x" ? p.x : p.z;
    if (this._nextCross === null) {
      const ahead = city.lines.filter((c) => this.dir > 0 ? c > along + 1 : c < along - 1);
      this._nextCross = ahead.length
        ? (this.dir > 0 ? Math.min(...ahead) : Math.max(...ahead))
        : null;
      if (this._nextCross === null) { this.dir *= -1; this._align(entity); return; }
    }
    const passed = this.dir > 0 ? along >= this._nextCross : along <= this._nextCross;
    if (passed) {
      const roll = this.r();
      if (roll < 0.35) {                    // turn
        if (this.axis === "x") { p.x = this._nextCross; this.axis = "z"; }
        else { p.z = this._nextCross; this.axis = "x"; }
        this.dir = roll < 0.175 ? 1 : -1;
        this._align(entity);
      }
      this._nextCross = null;
    }
    // edge of the map: u-turn
    if (Math.abs(p.x) > city.half + 2 || Math.abs(p.z) > city.half + 2) {
      this.dir *= -1; this._align(entity);
    }
  }
}

function makeCar(color) {
  const g = new THREE.Group();
  const bodyM = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 3.2), bodyM);
  body.position.y = 0.55; body.castShadow = true;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.45, 1.6),
    new THREE.MeshStandardMaterial({ color: 0x202830, roughness: 0.2 }));
  cabin.position.set(0, 1.0, -0.1);
  const wheelM = new THREE.MeshStandardMaterial({ color: 0x14161a });
  for (const [wx, wz] of [[-0.7, 1.05], [0.7, 1.05], [-0.7, -1.05], [0.7, -1.05]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.25, 10), wheelM);
    w.rotation.z = Math.PI / 2;
    w.position.set(wx, 0.32, wz);
    g.add(w);
  }
  g.add(body, cabin);
  return g;
}

const carR = rng(seed ^ 0xBEEF);
for (let i = 0; i < 34; i++) {
  const line = city.lines[Math.floor(carR() * city.lines.length)];
  const along = -city.half + carR() * city.half * 2;
  const ai = new CarAI(carR);
  const e = world.spawn("car")
    .mesh(makeCar(CAR_COLORS[i % CAR_COLORS.length]))
    .at(ai.axis === "x" ? along : line, 0, ai.axis === "x" ? line : along)
    .add(ai);
}

// ---- player on foot --------------------------------------------------------
class PlayerMove {
  fixedUpdate(dt, { input, world, entity }) {
    const body = entity.get(Body);
    const cam = world.camera;
    const f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
    const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    const stick = input.stick("left");
    const ix = input.axis("KeyA", "KeyD") + stick.x;
    const iz = input.axis("KeyS", "KeyW") - stick.y;
    const run = input.down("ShiftLeft") ? 11 : 6.5;
    const wish = f.multiplyScalar(iz).addScaledVector(r, ix);
    if (wish.lengthSq() > 1) wish.normalize();
    body.velocity.x = wish.x * run;
    body.velocity.z = wish.z * run;
    if (input.pressed("Space") && body.onGround) { body.velocity.y = 9; audio.play("jump"); }
    if (wish.lengthSq() > 0.01)
      entity.rotation.y = Math.atan2(body.velocity.x, body.velocity.z);
  }
}

const player = world.spawn("player")
  .mesh((() => {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x4d8dff }));
    b.position.y = 0.45; b.castShadow = true;
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xf2c9a0 }));
    h.position.y = 1.15; h.castShadow = true;
    g.add(b, h);
    return g;
  })())
  .at(...city.spawn)
  .add(new Body({ size: [0.6, 1.35, 0.6], offset: [0, 0.55, 0] }))
  .add(new PlayerMove());

// camera: follow loosely, orbit around the player
const rig = new OrbitRig({ target: city.spawn, distance: 14, pitch: 0.42, maxDist: 400 });
world.spawn("camera").add(rig).add({
  update(dt) { rig.target.lerp(player.position.clone().add(new THREE.Vector3(0, 1.4, 0)), dt * 3); },
});

// R = new city
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyR") location.search = "?seed=" + Math.floor(Math.random() * 100000);
});

engine.start();
window.__pf = { engine, world, audio, player, city };
