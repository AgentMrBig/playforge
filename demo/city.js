// PLAYFORGE CITY — GTA-style procedural city: seeded generator, AI traffic,
// on-foot player. R = new city, ?seed=N pins one.
import {
  Engine, World, ThirdPersonRig, Audio, Body, Collider,
  VehicleBody, PlayerVehicleControls, EngineSound, Animator, buildHumanoid,
  SkidMarks, THREE,
} from "../src/index.js";
import { CAR_MODELS } from "./carmodels.js";
import { loadCarModel } from "../src/assets.js";
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
  const chassis = new THREE.Group();          // leans with weight transfer
  const bodyM = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 3.2), bodyM);
  body.position.y = 0.55; body.castShadow = true;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.45, 1.6),
    new THREE.MeshStandardMaterial({ color: 0x202830, roughness: 0.2 }));
  cabin.position.set(0, 1.0, -0.1);
  chassis.add(body, cabin);
  const wheelM = new THREE.MeshStandardMaterial({ color: 0x14161a });
  const wheels = {};
  for (const [key, wx, wz] of [["fl", -0.7, 1.05], ["fr", 0.7, 1.05], ["rl", -0.7, -1.05], ["rr", 0.7, -1.05]]) {
    const pivot = new THREE.Group();          // steer yaw lives on the pivot
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.25, 10), wheelM);
    w.rotation.z = Math.PI / 2;
    pivot.add(w);
    pivot.position.set(wx, 0.32, wz);
    pivot.rotation.order = "YXZ";             // steer first, then spin
    g.add(pivot);
    wheels[key] = pivot;
  }
  g.add(chassis);
  return { visual: g, chassis, wheels };
}

const carR = rng(seed ^ 0xBEEF);
for (let i = 0; i < 34; i++) {
  const line = city.lines[Math.floor(carR() * city.lines.length)];
  const along = -city.half + carR() * city.half * 2;
  const ai = new CarAI(carR);
  world.spawn("car")
    .mesh(makeCar(CAR_COLORS[i % CAR_COLORS.length]).visual)
    .at(ai.axis === "x" ? along : line, 0, ai.axis === "x" ? line : along)
    .add(ai);
}

// ---- drivable cars: four hp tiers, each with its own simulated engine ------
let drivingCar = null; // entity while behind the wheel
// maxLatAccel = tire grade: how hard you can corner before traction breaks
const GARAGE = [
  { name: "Sedan",     hp: 120,   enginePower: 8,  topSpeed: 32, model: "sedan",    color: 0xd8d8d8, maxLatAccel: 8.5 },
  { name: "Muscle",    hp: 450,   enginePower: 12, topSpeed: 42, model: "muscle",   color: 0xc23b3b, maxLatAccel: 10 },
  { name: "Supercar",  hp: 800,   enginePower: 16, topSpeed: 52, model: "sports",   color: 0xd8a13b, maxLatAccel: 12.5 },
  { name: "TOP FUEL",  hp: 11000, enginePower: 34, topSpeed: 90, model: "dragster", color: 0x2f2f34, wheelbase: 4.6, grip: 9, maxLatAccel: 9 },
];
for (let i = 0; i < GARAGE.length; i++) {
  const spec = GARAGE[i];
  const { visual, chassis, wheels } = CAR_MODELS[spec.model](spec.color);
  const e = world.spawn("drivable")
    .mesh(visual)
    .at(city.spawn[0] + 6 + i * 6, 0, city.spawn[2] + 4)
    .add(new VehicleBody({
      chassis, wheels, enginePower: spec.enginePower, topSpeed: spec.topSpeed,
      wheelbase: spec.wheelbase ?? 2.9, grip: spec.grip ?? 7.5,
      maxLatAccel: spec.maxLatAccel ?? 8,
      wheelRadius: spec.model === "dragster" ? 0.55 : 0.34,
    }))
    .add(new PlayerVehicleControls({ enabled: () => drivingCar === e }))
    .add(new EngineSound(audio, { hp: spec.hp }))
    .add(new SkidMarks({ rearOffset: spec.model === "dragster" ? 2.2 : 1.35, track: spec.model === "dragster" ? 0.85 : 0.78 }));
  e.rotation.y = Math.PI / 2;
  e.specName = spec.name;
  e.specHp = spec.hp;
}

// ---- user-supplied model: the RX-7 (FBX) rolls into the garage async -------
loadCarModel("/models/LPRX7.fbx", { targetLength: 4.3 }).then(({ visual, chassis, wheels, wheelRadius }) => {
  const e = world.spawn("drivable")
    .mesh(visual)
    .at(city.spawn[0] + 6 + GARAGE.length * 6, 0, city.spawn[2] + 4)
    .add(new VehicleBody({
      chassis, wheels: wheels ?? undefined,
      enginePower: 13, topSpeed: 46, maxLatAccel: 10.5, wheelRadius: wheelRadius ?? 0.31,
    }))
    .add(new EngineSound(audio, { hp: 280, cylinders: 4 })) // rotary screamer-ish
    .add(new SkidMarks({ rearOffset: 1.25, track: 0.72 }));
  const e2 = e; // closure for controls
  e.add(new PlayerVehicleControls({ enabled: () => drivingCar === e2 }));
  e.rotation.y = Math.PI / 2;
  e.specName = "RX-7"; e.specHp = 280;
  console.log("RX-7 loaded, wheels:", wheels ? Object.keys(wheels).join(",") : "none detected");
}).catch((err) => console.warn("RX-7 load failed:", err.message));

world.spawn("hud").add({
  update() {
    const hudSpeed = document.getElementById("speed");
    if (hudSpeed) hudSpeed.textContent = drivingCar
      ? drivingCar.specName + " (" + drivingCar.specHp + " hp) — " +
        Math.round(drivingCar.get(VehicleBody).kmh) + " km/h"
      : "";
  },
});

// ---- player on foot --------------------------------------------------------
class PlayerMove {
  fixedUpdate(dt, { input, world, entity }) {
    const body = entity.get(Body);
    if (drivingCar) { body.velocity.x = 0; body.velocity.z = 0; return; }
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

    // drive the animation state machine off physics state
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

const rigHuman = buildHumanoid({ shirt: 0x4d8dff });
const player = world.spawn("player")
  .mesh(rigHuman.root)
  .at(...city.spawn)
  .add(new Body({ size: [0.6, 1.55, 0.6], offset: [0, 0.78, 0] }))
  .add(new Animator(rigHuman.root, rigHuman.clips))
  .add(new PlayerMove());
player.get(Animator).play("idle");

// camera: the GTA rig — click once to lock the mouse, Esc to release
engine.input.enablePointerLock();
const rig = new ThirdPersonRig(player, {
  distance: 6.5,
  isSprinting: () => engine.input.down("ShiftLeft") &&
    Math.hypot(player.get(Body).velocity.x, player.get(Body).velocity.z) > 8,
});
world.spawn("camera").add(rig);

// R = new city · E = enter/exit the nearest car
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyR") location.search = "?seed=" + Math.floor(Math.random() * 100000);
  if (e.code === "KeyE") {
    if (drivingCar) {                       // step out
      const car = drivingCar;
      drivingCar = null;
      car.components.find((c) => c.rpm !== undefined)?.stop();
      const yaw = car.rotation.y;
      player.at(car.position.x + Math.cos(yaw) * 2.4, car.position.y + 0.3,
                car.position.z - Math.sin(yaw) * 2.4);
      player.object3d.visible = true;
      rig.target = player;
      rig.distance = 6.5;
    } else {                                // hop in, if one's close
      let best = null, bestD = 3.8;
      for (const c of world.findAll("drivable")) {
        const d = c.position.distanceTo(player.position);
        if (d < bestD) { best = c; bestD = d; }
      }
      if (best) {
        drivingCar = best;
        player.object3d.visible = false;
        audio.play("click");
        best.components.find((c) => c.rpm !== undefined)?.start();
        rig.target = best;
        rig.distance = 9.5;
      }
    }
  }
});

engine.start();
window.__pf = { engine, world, audio, player, city };
