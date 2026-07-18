// PLAYFORGE — Road Editor. Click the ground to lay road nodes; the road
// builds live and conforms to the terrain. Enter=new road, Backspace=undo,
// S=save JSON, T=test-drive a car on your roads.
import {
  Engine, World, OrbitRig, Audio, Body, Heightfield,
  VehicleBody, PlayerVehicleControls, EngineSound, SkidMarks,
  RoadNetwork, RoadEditor, loadVehicle, VehicleRig,
  fbm, THREE,
} from "../src/index.js";

const engine = new Engine(document.getElementById("game"), { clearColor: 0x9ec4e4 });
const world = new World();
const audio = new Audio();
engine.world = world;

world.spawn("sun").mesh((() => {
  const g = new THREE.Group();
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.2); sun.position.set(60, 90, 40);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  const s = 120; Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, far: 300 });
  g.add(sun, new THREE.AmbientLight(0x9fb4d0, 0.85)); return g;
})());

// gently rolling terrain so you can see roads conform to hills
const hf = new Heightfield({ size: 400, res: 128,
  heightAt: (x, z) => (fbm(x * 0.008, z * 0.008, { seed: 5 }) * 0.5 + 0.5) * 10 - 2 });
world.spawn("ground").mesh(hf.buildMesh((x, z, h, s, out) => {
  out.setHex(h > 4 ? 0x6b7a55 : 0x4c8a45);
})).add(hf);

// ---- road network + editor -------------------------------------------------
const roads = new RoadNetwork({ ground: (x, z) => hf.heightAt(x, z) });
world.spawn("roads").add(roads);
const editor = new RoadEditor(roads, { width: 8 });
world.spawn("roadedit").add(editor);

// seed one sample road so it's obvious what to do
roads.addRoad([[-80, -40], [-30, -20], [20, -30], [60, 10], [40, 60]], { width: 8 });

// orbit camera (unlocked cursor so you can click to place)
const rig = new OrbitRig({ target: [0, 0, 0], distance: 140, pitch: 0.9, maxDist: 400 });
world.spawn("camera").add(rig);

// ---- optional test car -----------------------------------------------------
let car = null, driving = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Enter") { editor.newRoad(); flash("new road started"); }
  if (e.code === "Backspace") { editor.undo(); }
  if (e.code === "KeyS") { editor.save(); flash("saved roads.json"); }
  if (e.code === "KeyT" && !car) spawnTestCar();
  if (e.code === "KeyC" && driving) driving = false;
});
function spawnTestCar() {
  flash("loading test car…");
  loadVehicle("models/sedanpack/Assets/Car.fbx", { targetLength: 4.7, textureDir: "models/sedanpack/Texture" })
    .then((r) => {
      const start = roads.roads[0]?.nodes[0] ?? new THREE.Vector3(0, 0, 0);
      car = world.spawn("drivable").mesh(r.visual).at(start.x, hf.heightAt(start.x, start.z) + 1, start.z)
        .add(new VehicleBody({ chassis: r.chassis, wheels: r.wheels, wheelRadius: r.wheelRadius, suspension: r.suspension, enginePower: 13, topSpeed: 50, maxLatAccel: 11 }))
        .add(new VehicleRig(r)).add(new EngineSound(audio, { hp: 300 })).add(new SkidMarks())
        .add(new PlayerVehicleControls({ enabled: () => driving }));
      car.components.find((c) => c.rpm !== undefined)?.start();
      driving = true;
      rig.target = car.position; // orbit follows the car loosely
      world.spawn("follow").add({ update() { if (driving && car) rig.target.copy(car.position); } });
      flash("driving! WASD, C to release camera");
    }).catch((err) => flash("car failed: " + err.message));
}

let flashT = 0;
function flash(msg) { const el = document.getElementById("stats"); if (el) { el.textContent = msg; flashT = 2.5; } }
world.spawn("hud").add({ update(dt) {
  if (flashT > 0) { flashT -= dt; return; }
  const el = document.getElementById("stats");
  if (el) el.textContent = `${roads.roads.length} road(s) · click to add nodes · Enter=new road · Backspace=undo · S=save · T=test-drive`;
} });

engine.start();
window.__pf = { engine, world, roads, editor, hf };
