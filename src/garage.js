import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { Car } from "./carphysics.js";
import { loadVehicle } from "./vehicledef.js";
import { VehicleAudio } from "./vehicleaudio.js";
import { SkidTrails } from "./skidtrails.js";
import { Cluster } from "./cluster.js";
import { VehicleFX } from "./vehiclefx.js";
import { Trailer } from "./trailer.js";
import { loadCharacter } from "./character.js";
import { CarFire } from "./firesys.js";
import { Ragdoll } from "./ragdoll.js";
import { initRapier } from "./phys.js";

// a few real Synty cars to crumple — pick with ?car=<key>
const GWV = { textureDir: "models/gangwarfare", textureFlipY: true, textureMap: { material: "T_PolygonGangWarfare_Vehicle_01.PNG" } };
const AV = { textureDir: "models/fabpack", textureFlipY: true, textureMap: { palette: "T_colorPalette2048.PNG", veh: "T_colorPalette2048.PNG" } };
const CARS = {
  lowcar: { file: "models/gangwarfare/SK_Veh_LowCar_01.FBX", len: 4.4, opts: GWV },
  muscle: { file: "models/fabpack/SK_veh_Muscle_01.fbx", len: 4.6, opts: AV },
  sedan:  { file: "models/fabpack/SK_veh_Sedan_01.fbx", len: 4.5, opts: AV },
  suv:    { file: "models/fabpack/SK_veh_SUV_01.fbx", len: 4.7, opts: AV },
};

/**
 * The Garage — vehicle-physics proving ground. A stripped scene (flat ground +
 * ramps + one car + live readouts) with ZERO game code, so the physics is
 * measurable and can't be masked. See VEHICLE_REBUILD_PLAN.md.
 *
 * STAGE 0: scaffold + tuning HUD + frametime proof.
 * STAGE 1: fixed-timestep accumulator + render interpolation + rigid-body chassis.
 *   The frametime graph + smooth motion at any refresh rate = "no jerk" proof.
 */

const FIXED = 1 / 60;                 // fixed physics dt — deterministic, refresh-independent
const MAX_SUBSTEPS = 5;               // spiral-of-death guard

let world, car, scene, camera, renderer, eventQueue, skid, fx, trailer, fire;
let last = performance.now() / 1000;
let acc = 0;
const keys = {};
const audio = new VehicleAudio({ hp: 450 });
const cluster = new Cluster();
let lastInput = { throttle: 0, steer: 0, brake: 0, handbrake: false };

/** one physics step + drain hard-impact events into the car's deform system */
let crushCd = 0;          // D5: don't re-fire the crush while still sandwiched
function physicsStep() {
  world.step(eventQueue);
  crushCd = Math.max(0, crushCd - FIXED);
  const stepEvs = [];     // D5: this step's chassis impacts, for the opposing-pair test
  eventQueue.drainContactForceEvents((e) => {
    const c1 = e.collider1(), c2 = e.collider2();
    // D4: chassis = 5 sub-colliders; DERBY: AI cars deform too — a car-vs-car
    // hit crumples BOTH sides from the same event
    const carOf = (h) => car.colliderHandles.has(h) ? car
      : aiCars.find((a) => a.colliderHandles.has(h)) || null;
    const carA = carOf(c1), carB = carOf(c2);
    if (!carA && !carB) return;
    const isPlayer = carA === car || carB === car;
    const mag = e.totalForceMagnitude();
    const dir = e.maxForceDirection();
    let point = null;
    try {
      world.contactPair(world.getCollider(c1), world.getCollider(c2), (m) => {
        if (m && m.numSolverContacts && m.numSolverContacts() > 0) {
          const p = m.solverContactPoint(0);
          if (p) point = { x: p.x, y: p.y, z: p.z };
        }
      });
    } catch (err) { /* no manifold → deform falls back to the force direction */ }
    const glassWas = car.glassBroken;
    if (carA) carA.impact(point, mag, dir);
    if (carB && carB !== carA) carB.impact(point, mag, dir);
    if (fx) fx.onImpact(point, mag);      // spark burst on hard hits
    // AI fuel systems rupture too — hunted wrecks end up burning
    for (const K of [carA, carB])
      if (K && K !== car && K._fire && mag > 2000000 && Math.random() < 0.45)
        K._fire.ignite(Math.random() < 0.5 ? "front" : "rear", 0.35);
    if (!isPlayer) return;                // everything below is player feedback
    // log the damage event on the replay timeline (with the pose it happened at)
    if (point && mag >= car.dentThreshold) {
      const t = car.body.translation(), r = car.body.rotation();
      replay.events.push({
        f: replay.f, mag,
        point: { x: point.x, y: point.y, z: point.z },
        dir: { x: dir.x, y: dir.y, z: dir.z },
        pose: { px: t.x, py: t.y, pz: t.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w },
        glass: !glassWas && car.glassBroken,
      });
      if (replay.events.length > 60) replay.events.shift();
    }
    if (mag > 400000) cam.shakeAmt = Math.max(cam.shakeAmt || 0, Math.min(1, mag / 1800000));  // crash shake
    if (mag > 450000) audio.crash(mag / 2200000);   // VIOLENT crash sound on hard hits
    // FIRE: catastrophic hits can rupture the fuel system — chance scales with
    // violence; a cooked radiator (D3 overheat pegged) ignites on its own below
    if (fire && mag > 2400000 && Math.random() < 0.4)
      fire.ignite(point && point.z > car.body.translation().z ? "front" : "rear", 0.35);
    if (replay.auto && mag > 2200000 && !replay.active && replay.cooldown <= 0) {
      replay.pending = 1.3;               // monster crash → slow-mo crash cam (opt-in; [V] anytime)
      replay.cooldown = 25;
    }
    if (mag > 300000) stepEvs.push({ mag, point, dir: { x: dir.x, y: dir.y, z: dir.z } });
  });
  // ---- D5 CRUSH DETECTION: two hard impacts in the SAME step from OPPOSING
  // directions = the car is sandwiched (wall + anvil, wedged under the sweeper,
  // pinned by a trailer). Both sides take a severe boosted crumple — thresholds
  // don't matter when you're the meat in the press.
  if (stepEvs.length >= 2 && crushCd <= 0) {
    outer: for (let i = 0; i < stepEvs.length; i++) {
      for (let j = i + 1; j < stepEvs.length; j++) {
        const a = stepEvs[i], b2 = stepEvs[j];
        const dot = a.dir.x * b2.dir.x + a.dir.y * b2.dir.y + a.dir.z * b2.dir.z;
        if (dot < -0.8) {
          const crushMag = Math.max(1.8e6, (a.mag + b2.mag) * 0.9);
          car.impact(a.point, crushMag, a.dir);
          car.impact(b2.point, crushMag, b2.dir);
          cam.shakeAmt = 1;
          audio.crash(1);
          if (fx) { fx.onImpact(a.point, crushMag); fx.onImpact(b2.point, crushMag); }
          crushCd = 0.6;
          break outer;
        }
      }
    }
  }
}

// ---- Xbox / gamepad (standard mapping): LS steer, RT gas, LT reverse, A handbrake,
// Y reset, B repair, X clear skids, RS orbits the camera. Analog wins when used. ----
const pad = { prev: {} };
function pollPad() {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of gps) if (gp && gp.connected) return gp;
  return null;
}
const padDown = (gp, i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
function padJust(gp, i) { const now = padDown(gp, i), was = pad.prev[i]; pad.prev[i] = now; return now && !was; }
const dz = (v, d = 0.14) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));   // deadzone

// ---- mobile touch controls: big thumb buttons, multi-touch (gas+steer together) ----
const touch = { left: false, right: false, gas: false, rev: false, hb: false };
function buildTouchControls() {
  if (!("ontouchstart" in window) && !(navigator.maxTouchPoints > 0)) return;
  const css = document.createElement("style");
  css.textContent = `
    .tbtn{position:fixed;z-index:35;width:76px;height:76px;border-radius:50%;
      background:rgba(28,38,48,.55);border:2px solid rgba(127,215,255,.45);color:#cfe;
      font:700 28px ui-monospace,monospace;display:flex;align-items:center;justify-content:center;
      user-select:none;-webkit-user-select:none;touch-action:none}
    .tbtn.on{background:rgba(80,140,190,.8)}
    #tL{left:14px;bottom:92px} #tR{left:106px;bottom:92px}
    #tGas{right:14px;bottom:160px} #tRev{right:14px;bottom:64px} #tHb{right:108px;bottom:112px}`;
  document.head.appendChild(css);
  const mk = (id, txt, key) => {
    const b = document.createElement("div");
    b.id = id; b.className = "tbtn"; b.textContent = txt;
    document.body.appendChild(b);
    const on = (e) => { e.preventDefault(); touch[key] = true; b.classList.add("on"); };
    const off = (e) => { if (e) e.preventDefault(); touch[key] = false; b.classList.remove("on"); };
    b.addEventListener("touchstart", on, { passive: false });
    b.addEventListener("touchend", off);
    b.addEventListener("touchcancel", off);
  };
  mk("tL", "◀", "left"); mk("tR", "▶", "right");
  mk("tGas", "▲", "gas"); mk("tRev", "▼", "rev"); mk("tHb", "✋", "hb");
  // tiny ⚙ toggle: the debug panel is hidden on phones — tap to peek at it
  const gear = document.createElement("div");
  gear.textContent = "⚙";
  gear.style.cssText = "position:fixed;top:10px;left:10px;z-index:36;width:40px;height:40px;" +
    "border-radius:50%;background:rgba(28,38,48,.5);color:#9fb4c4;display:flex;align-items:center;" +
    "justify-content:center;font-size:22px;user-select:none;-webkit-user-select:none;touch-action:none";
  gear.addEventListener("touchstart", (e) => {
    e.preventDefault();
    const hud = document.getElementById("hud");
    if (hud) hud.style.display = hud.style.display === "block" ? "none" : "block";  // inline beats the media query
  }, { passive: false });
  document.body.appendChild(gear);
}

/** map current key + gamepad + touch state → car input */
function readInput() {
  if (cam.mode === "free") return { throttle: 0, steer: 0, brake: 0, handbrake: false };  // WASD flies the cam
  const up = keys.KeyW || keys.ArrowUp, down = keys.KeyS || keys.ArrowDown;
  const left = keys.KeyA || keys.ArrowLeft, right = keys.KeyD || keys.ArrowRight;
  let throttle = (up ? 1 : 0) - (down ? 1 : 0);   // W/↑ forward, S/↓ reverse
  let steer = (left ? 1 : 0) - (right ? 1 : 0);   // A/D
  let handbrake = !!keys.Space;
  let brake = 0;
  if (up && down) { throttle = 1; brake = 1; }    // BRAKE-STAND: gas + brake together = burnout
  const gp = pollPad();
  if (gp) {
    const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
    if (rt > 0.3 && lt > 0.3) { throttle = rt; brake = lt; }     // both pedals = brake-stand burnout
    else if (Math.abs(rt - lt) > 0.02) throttle = rt - lt;       // RT − LT
    const gpSteer = -dz(gp.axes[0] || 0);                        // stick left = steer left
    if (Math.abs(gpSteer) > 0.02) steer = gpSteer;
    handbrake = handbrake || padDown(gp, 0);                     // A = handbrake/burnout
  }
  // touch buttons take over when pressed (phone play)
  if (touch.gas || touch.rev) throttle = (touch.gas ? 1 : 0) - (touch.rev ? 1 : 0);
  if (touch.gas && touch.rev) { throttle = 1; brake = 1; }       // both thumbs = burnout too
  if (touch.left || touch.right) steer = (touch.left ? 1 : 0) - (touch.right ? 1 : 0);
  handbrake = handbrake || touch.hb;
  return { throttle, steer, brake, handbrake };
}

/** pad one-shots + right-stick camera orbit — call each frame */
function handlePadExtras(dt) {
  const gp = pollPad();
  cam.stick = false;
  if (!gp) return;
  if (padJust(gp, 3)) car.reset();     // Y
  if (padJust(gp, 1)) car.repair();    // B
  if (padJust(gp, 2)) skid.clear();    // X
  const rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
  if (cam.mode === "chase" && (rx || ry)) {
    cam.stick = true;                  // suppress auto-swing while aiming the stick
    cam.yaw -= rx * 2.6 * dt;
    cam.pitch = Math.max(-0.25, Math.min(1.25, cam.pitch + ry * 1.7 * dt));
  }
}

// frametime + substep telemetry (the measurable "no jerk" evidence)
const ft = { buf: new Float32Array(120), i: 0, sub: 0, max2s: 0, max2sT: 0 };

async function main() {
  await RAPIER.init();

  // ---- renderer / scene / camera --------------------------------------
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById("app").appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x151a20);
  scene.fog = new THREE.Fog(0x151a20, 120, 600);   // see across the bigger park

  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
  camera.position.set(0, 6, -12);

  scene.add(new THREE.HemisphereLight(0x9db4c8, 0x2a2620, 0.8));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
  sun.position.set(30, 50, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 40;
  sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
  sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
  sun.shadow.camera.far = 140;
  scene.add(sun);

  // ---- physics world --------------------------------------------------
  world = new RAPIER.World({ x: 0, y: -20, z: 0 });   // -20 matches the game
  world.integrationParameters.dt = FIXED;
  eventQueue = new RAPIER.EventQueue(true);

  // ---- ground: visual grid + Rapier fixed collider --------------------
  const groundSize = 600;   // 3× (Erik)
  const groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    new THREE.MeshStandardMaterial({ color: 0x33383f, roughness: 0.95 })
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);
  const grid = new THREE.GridHelper(groundSize, 150, 0x556070, 0x2c333b);
  grid.position.y = 0.01;
  scene.add(grid);

  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(groundSize / 2, 0.5, groundSize / 2).setTranslation(0, -0.5, 0),
    groundBody
  );

  // ---- PROVING GROUNDS (Erik: real car-testing facility, no giant cubes) ----
  // Modeled on real vehicle-dynamics facilities: drag strip w/ tree (built in
  // buildDragStrip), smooth flush-entry wedge ramps, jump + landing, skidpad
  // rings, slalom cones, one clean crash wall. Wedges are convex prisms whose
  // leading edge sits AT ground level — zero lip, smooth transition.
  // ramp park (+X): small → medium → LAUNCH with a landing wedge
  addWedge([40, 10], 7, 0.8, 9, 0);
  addWedge([60, 30], 9, 1.7, 13, 0);
  addWedge([85, 55], 11, 3.2, 19, 0);            // launch…
  addWedge([85, 110], 11, 2.4, 15, Math.PI);     // …landing wedge, facing back
  // skidpad (−X): painted concentric rings for steady-state cornering
  for (const rr of [14, 20, 26]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(rr - 0.25, rr + 0.25, 64),
      new THREE.MeshBasicMaterial({ color: 0xcfd8e0, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(-80, 0.015, 30);
    scene.add(ring);
  }
  // slalom line (−X south): proper cone-sized posts
  for (let i = 0; i < 8; i++) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 1.0, 10),
      new THREE.MeshStandardMaterial({ color: 0xe07a2a }));
    post.position.set(-40, 0.5, -30 + i * 14);
    post.castShadow = true;
    scene.add(post);
    const pb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-40, 0.5, -30 + i * 14));
    world.createCollider(RAPIER.ColliderDesc.cylinder(0.5, 0.35), pb);
  }
  // one clean reinforced crash wall (−Z), square-on to the spawn
  addWall([0, 0, -45], 16, 3.2, 1.6);
  // perimeter walls — no more driving off the edge of the world
  addWall([0, 0, 298], 600, 2.5, 2);
  addWall([0, 0, -298], 600, 2.5, 2);
  addWall([298, 0, 0], 2, 2.5, 600);
  addWall([-298, 0, 0], 2, 2.5, 600);
  buildSweeper();
  buildDummy();

  // ---- the car --------------------------------------------------------
  car = new Car(world, RAPIER, { pos: [0, 3, 0] });
  scene.add(car.mesh);
  skid = new SkidTrails(scene);
  fx = new VehicleFX(scene);
  fire = new CarFire(scene, car);          // Erik's fire system — stage 1: the car burns
  audio.onPop = (d) => fx.exhaustFlame(car, d);   // fire out the pipes on every backfire
  trailer = new Trailer(world, RAPIER, { pos: [5, 0.5, -5] });   // spawn at ride height, no drop
  scene.add(trailer.mesh);
  buildDragStrip();

  buildHUD();

  // debug/verification handle — the agent Browser pane throttles rAF to ~0fps,
  // so headless checks drive the fixed step manually instead of trusting the loop.
  window.__garage = {
    world, car, RAPIER, scene, camera, renderer, audio, skid, fx, cluster, frames: 0,
    replay, recordFrame, startReplay, stopReplay, updateReplay, trailer, toggleHitch, drag, updateDragTimer,
    fireBall, dropWeight, gadgets, updateGadgets,
    get dummy() { return dummy; }, updateDummy, updateDummyFixed,
    get fire() { return fire; },
    aiCars, updateAI,
    render() { car.interpolate(1); updateCamera(0.016); renderer.render(scene, camera); },
    step(n = 1) { for (let i = 0; i < n; i++) { car.snapshotPrev(); trailer.snapshotPrev(); car.fixedUpdate(FIXED); trailer.fixedUpdate(FIXED); physicsStep(); car.snapshotCurr(); trailer.snapshotCurr(); } return car.height; },
    wheels() { return car.wheels.map((w) => ({ n: w.name, grounded: w.grounded, comp: +w.comp.toFixed(3), dist: +w.dist.toFixed(3) })); },
    // headless deform metrics: how far the body mesh has moved from pristine
    dentStats() {
      const pos = car.bodyMesh.geometry.attributes.position, op = car.origPos;
      let moved = 0, maxD = 0;
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.array[i*3]-op[i*3], dy = pos.array[i*3+1]-op[i*3+1], dz = pos.array[i*3+2]-op[i*3+2];
        const d = Math.hypot(dx, dy, dz); if (d > 1e-4) moved++; if (d > maxD) maxD = d;
      }
      return { dents: car.dents, vertsMoved: moved, maxDisplacement: +maxD.toFixed(3), totalVerts: pos.count };
    },
    // headless driving: apply an input for n steps, report motion
    drive(input, n = 60) {
      car.setInput(input);
      for (let i = 0; i < n; i++) { car.fixedUpdate(FIXED); physicsStep(); }
      car.setInput({});
      const t = car.body.translation(), v = car.body.linvel(), a = car.body.angvel();
      return { x: +t.x.toFixed(2), y: +t.y.toFixed(2), z: +t.z.toFixed(2),
        speed: +car.speedKmh.toFixed(1), yawRate: +a.y.toFixed(3), heading: +Math.atan2(v.x, v.z).toFixed(2) };
    },
    state() { const t = car.body.translation(), v = car.body.linvel();
      return { y: t.y, x: t.x, z: t.z, speed: Math.hypot(v.x, v.y, v.z) * 3.6, frames: window.__garage.frames }; },
  };

  addEventListener("resize", onResize);
  addEventListener("keydown", (e) => {
    keys[e.code] = true;
    if (e.code === "KeyR") { car.reset(); fire?.douse(); }
    if (e.code === "KeyT") car.reset(12);   // big drop — hard-landing settle test
    if (e.code === "KeyP") { car.repair(); fire?.douse(); }   // un-dent + put out
    if (e.code === "Digit6") fire?.ignite("front", 0.5);      // torch it (test)
    if (e.code === "KeyC") toggleFreeCam(); // chase ⇄ free cam
    if (e.code === "KeyK") skid.clear();    // wipe skid marks
    if (e.code === "KeyV") replay.active ? stopReplay() : startReplay();   // slow-mo replay
    if (e.code === "KeyH") toggleHitch();   // hitch/unhitch the trailer
    if (e.code === "Digit1") fireBall(1);   // deformation gun: small / medium / heavy
    if (e.code === "Digit2") fireBall(2);
    if (e.code === "Digit3") fireBall(3);
    if (e.code === "Digit4") dropWeight(false);   // small weight drop
    if (e.code === "Digit5") dropWeight(true);    // THE ANVIL
    if (e.code === "KeyG") {                // teleport to the drag strip staging area
      const b = car.body;
      b.setTranslation({ x: drag.x, y: 0.97, z: drag.z0 - 12 }, true);
      b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      car.snapshotCurr(); car.snapshotPrev();
      drag.active = false;
      dragUI("staged — send it 🏁");
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
  });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  setupCameraInput(renderer.domElement);
  buildTouchControls();                     // on-screen buttons on touch devices

  // audio needs a user gesture to start (browser autoplay policy) — on phones the
  // only gestures are TOUCHES, so listen for those too or mobile stays silent
  const startAudio = () => {
    audio.start();
    removeEventListener("keydown", startAudio);
    removeEventListener("mousedown", startAudio);
    removeEventListener("touchstart", startAudio);
  };
  addEventListener("keydown", startAudio);
  addEventListener("mousedown", startAudio);
  addEventListener("touchstart", startAudio);

  requestAnimationFrame(frame);

  // swap the placeholder box for a real Synty car (non-blocking; box works until then)
  const pick = new URLSearchParams(location.search).get("car") || "lowcar";
  const spec = CARS[pick] || CARS.lowcar;
  loadVehicle(spec.file, { targetLength: spec.len, ...spec.opts })
    .then((rig) => { rig.name = pick; car.attachModel(rig); window.__garage.modelLoaded = pick; })
    .catch((e) => console.warn("[garage] model load failed, keeping box:", e));

  spawnDerby();                             // Erik #1: AI cars to hunt
}

// ------------------------------------------------------ AI TRAFFIC / DERBY ----
// A few full Car instances (same physics, same deform/zones/wheels-off — car-vs-
// car crashes crumple BOTH sides) with a dumb-but-fun driver: cruise waypoints,
// re-target when reached or stuck, brief reverse to unstick. Hunt them down.
const aiCars = [];
function spawnDerby() {
  const picks = [["sedan", [60, -60]], ["suv", [-70, 70]], ["lowcar", [-50, -90]]];
  for (const [key, [x, z]] of picks) {
    const spec2 = CARS[key];
    const ai = new Car(world, RAPIER, { pos: [x, 2, z] });
    scene.add(ai.mesh);
    ai._ai = { tgt: new THREE.Vector3(Math.random() * 300 - 150, 0, Math.random() * 300 - 150),
      stuckT: 0, revT: 0 };
    loadVehicle(spec2.file, { targetLength: spec2.len, ...spec2.opts })
      .then((rig) => { rig.name = key; ai.attachModel(rig); })
      .catch(() => {});
    ai._fire = new CarFire(scene, ai);      // their wrecks burn too
    aiCars.push(ai);
  }
}
const _aiTo = new THREE.Vector3();
function updateAI() {
  for (const ai of aiCars) {
    const A = ai._ai, t = ai.body.translation();
    _aiTo.set(A.tgt.x - t.x, 0, A.tgt.z - t.z);
    const dist = _aiTo.length();
    if (dist < 8) A.tgt.set(Math.random() * 400 - 200, 0, Math.random() * 400 - 200);
    // heading error → steer (P-control), speed capped for cruising
    const r = ai.body.rotation();
    _q2ai.set(r.x, r.y, r.z, r.w);
    _aiFwd.set(0, 0, 1).applyQuaternion(_q2ai);
    const want = Math.atan2(_aiTo.x, _aiTo.z);
    const have = Math.atan2(_aiFwd.x, _aiFwd.z);
    let err = want - have;
    if (err > Math.PI) err -= 2 * Math.PI; else if (err < -Math.PI) err += 2 * Math.PI;
    const spd = Math.abs(ai.speedKmh);
    // stuck? (pushed into a wall / wrecked into a corner) → back out for a bit
    if (spd < 2 && A.revT <= 0) A.stuckT += FIXED; else if (spd > 4) A.stuckT = 0;
    if (A.stuckT > 1.6) { A.revT = 1.2; A.stuckT = 0; }
    if (A.revT > 0) {
      A.revT -= FIXED;
      ai.setInput({ throttle: -0.6, steer: -Math.sign(err) });
    } else {
      ai.setInput({
        throttle: spd > 55 ? 0 : 0.55,
        steer: THREE.MathUtils.clamp(err * 1.4, -1, 1),
        brake: Math.abs(err) > 2 && spd > 25 ? 0.6 : 0,
      });
    }
    ai.fixedUpdate(FIXED);
  }
}
const _q2ai = new THREE.Quaternion();
const _aiFwd = new THREE.Vector3();

/** angled ramp box: pos = base center [x,0,z], rotX in radians (tilt) */
/** smooth ramp: right-triangular prism, thin edge FLUSH with the ground (no lip).
 *  Drive up from the -z side (local), rotated by yaw. Convex-hull collider. */
function addWedge([x, z], w, h, l, yaw = 0) {
  const hw = w / 2, hl = l / 2;
  // p0/p1 ground approach edge · p2/p3 ground far edge · p4/p5 top far edge
  const P = [[-hw, 0, -hl], [hw, 0, -hl], [-hw, 0, hl], [hw, 0, hl], [-hw, h, hl], [hw, h, hl]];
  const tri = (a, b2, c) => [...P[a], ...P[b2], ...P[c]];
  const verts = new Float32Array([
    ...tri(0, 5, 1), ...tri(0, 4, 5),     // slope face
    ...tri(2, 3, 5), ...tri(2, 5, 4),     // back face
    ...tri(0, 2, 4), ...tri(1, 5, 3),     // sides
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x565f68, roughness: 0.9, side: THREE.DoubleSide }));
  mesh.position.set(x, 0.005, z);
  mesh.rotation.y = yaw;
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0, z)
    .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
  world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(P.flat())), body);
}

function addRamp([x, , z], w, h, l, rotX) {
  const geo = new THREE.BoxGeometry(w, h, l);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x6b5b4a, roughness: 0.9 }));
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, 0, 0));
  const y = h / 2;
  mesh.position.set(x, y, z);
  mesh.quaternion.copy(q);
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(w / 2, h / 2, l / 2)
      .setTranslation(x, y, z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    body
  );
}

function addWall([x, , z], w, h, d) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color: 0x9a5040, roughness: 0.85 })
  );
  mesh.position.set(x, h / 2, z);
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setTranslation(x, h / 2, z), body);
}

function addKerb([x, , z], l, h, d) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(d, h, l),
    new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.9 })
  );
  mesh.position.set(x, h / 2, z);
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(d / 2, h / 2, l / 2).setTranslation(x, h / 2, z),
    body
  );
}

// ---- main loop: fixed-step accumulator + render interpolation ----------
// ---------------------------------------------------------- replay / crash cam ----
// Ring buffer records the car's pose + wheel state at 60Hz (last ~8s). A monster
// impact auto-triggers a slow-mo cinematic replay of the crash (orbiting camera,
// lerped playback so slow-mo stays butter smooth). [V] replays/skips manually.
const REPLAY_LEN = 8 * 60, RFLOATS = 16;
const replay = {
  data: new Float32Array(REPLAY_LEN * RFLOATS), n: 0, w: 0,
  active: false, ph: 0, startIdx: 0, len: 0, speed: 0.3,
  pending: 0, cooldown: 0, orbit: 0,
  f: 0,                        // monotonic frame counter (event timestamps)
  events: [],                  // damage events {f, point, mag, dir, pose, glass}
  evtQueue: [], evtIdx: 0, fStart: 0,
};
const _rp1 = new THREE.Vector3(), _rp2 = new THREE.Vector3();
const _rq1 = new THREE.Quaternion(), _rq2 = new THREE.Quaternion();

function recordFrame() {
  const i = replay.w * RFLOATS, d = replay.data;
  const p = car.currPos, q = car.currQuat;
  d[i] = p.x; d[i + 1] = p.y; d[i + 2] = p.z;
  d[i + 3] = q.x; d[i + 4] = q.y; d[i + 5] = q.z; d[i + 6] = q.w;
  for (let k = 0; k < 4; k++) { const w2 = car.wheels[k]; d[i + 7 + k] = w2.spin; d[i + 11 + k] = w2.dist; }
  d[i + 15] = car.steer;
  replay.w = (replay.w + 1) % REPLAY_LEN;
  if (replay.n < REPLAY_LEN) replay.n++;
  replay.f++;
}

/** visual-only glass toggle for the replay (physics/logic state untouched) */
function glassVisual(broken) {
  for (const m of car.glassMats || []) {
    m.opacity = broken ? 0 : (m.userData._op ?? 0.55);
    m.needsUpdate = true;
  }
}

function applyDamageEvent(ev, sparks) {
  car.deform(ev.point, ev.mag, ev.dir, ev.pose);
  if (ev.mag >= car.chunkForce) car.deform(ev.point, ev.mag * 1.6, ev.dir, ev.pose);  // chunk gouge too
  if (ev.glass) glassVisual(true);
  if (sparks && fx) fx.onImpact(ev.point, ev.mag);
}

function startReplay() {
  if (replay.active || replay.n < 90) return;
  replay.active = true;
  replay.len = Math.min(replay.n, 6 * 60);                       // last ~6 seconds
  replay.startIdx = (replay.w - replay.len + REPLAY_LEN) % REPLAY_LEN;
  replay.ph = 0;
  replay.orbit = cam.yaw;
  // rewind the DAMAGE too: start pristine, then re-enact each hit on cue.
  replay.fStart = replay.f - replay.len;
  car.repair();
  glassVisual(false);
  while (gadgets.length) expireGadget(gadgets[0]);   // anvils/balls don't haunt the replay
  // rewind the WHEELS + hide wreckage debris: the car replays WHOLE, not wrecked
  for (const m of car.debris) m.visible = false;
  for (const w of car.wheels) {
    if (w.detached && w.modelWheel) {
      const di = car.debris.indexOf(w.modelWheel);
      if (di >= 0) car.debris.splice(di, 1);
      car.mesh.add(w.modelWheel);
      w.modelWheel.visible = true;
      w.modelWheel.rotation.set(0, 0, 0);
      if (w._wheelScale) w.modelWheel.scale.copy(w._wheelScale);
      w._rfit = true;                       // placed from the recording during playback
    }
  }
  for (const ev of replay.events) if (ev.f < replay.fStart) applyDamageEvent(ev, false);  // pre-window damage stays
  replay.evtQueue = replay.events.filter((ev) => ev.f >= replay.fStart);
  replay.evtIdx = 0;
  showReplayUI(true);
}
function stopReplay() {
  replay.active = false;
  // fast-forward any un-played damage so the car leaves the replay in its true state
  while (replay.evtIdx < replay.evtQueue.length) applyDamageEvent(replay.evtQueue[replay.evtIdx++], false);
  glassVisual(!!car.glassBroken);
  for (const m of car.debris) m.visible = true;
  for (const w of car.wheels) if (w._rfit) {
    w._rfit = false;
    if (w.detached && w.modelWheel) w.modelWheel.visible = false;   // wheel's truly gone
  }
  showReplayUI(false);
}

function showReplayUI(on) {
  let el = document.getElementById("replayui");
  if (!el) {
    el = document.createElement("div");
    el.id = "replayui";
    el.style.cssText = "position:fixed;top:18px;left:50%;transform:translateX(-50%);color:#ff5533;" +
      "font:700 20px ui-monospace,monospace;letter-spacing:3px;z-index:40;pointer-events:none;" +
      "text-shadow:0 2px 8px rgba(0,0,0,.7);";
    el.textContent = "◉ REPLAY · SLOW-MO · [V] skip";
    document.body.appendChild(el);
  }
  el.style.display = on ? "block" : "none";
}

function readReplayFrame(f, pos, quat) {
  const idx = ((replay.startIdx + f) % REPLAY_LEN) * RFLOATS, d = replay.data;
  pos.set(d[idx], d[idx + 1], d[idx + 2]);
  quat.set(d[idx + 3], d[idx + 4], d[idx + 5], d[idx + 6]);
  return idx;
}

// ------------------------------------------------- mechanical obstacle + dummy ----
// THE SWEEPER: kinematic horizontal pole with a big ball on each end, spinning —
// time your pass or get swatted. Real colliders, real impacts.
let sweeper = null;
function buildSweeper() {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(-20, 1.1, 60));
  world.createCollider(RAPIER.ColliderDesc.cuboid(8, 0.18, 0.18), body);
  for (const s of [-8, 8]) world.createCollider(RAPIER.ColliderDesc.ball(1.25).setTranslation(s, 0, 0), body);
  const g2 = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.BoxGeometry(16, 0.36, 0.36),
    new THREE.MeshStandardMaterial({ color: 0x8a929c, metalness: 0.7, roughness: 0.4 }));
  pole.castShadow = true;
  g2.add(pole);
  for (const s of [-8, 8]) {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(1.25, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xb0413e, metalness: 0.5, roughness: 0.45 }));
    ball.position.x = s;
    ball.castShadow = true;
    g2.add(ball);
  }
  g2.position.set(-20, 1.1, 60);
  scene.add(g2);
  sweeper = { body, mesh: g2, ang: 0, speed: 0.9 };
}
function updateSweeper() {
  if (!sweeper) return;
  sweeper.ang += sweeper.speed * FIXED;
  const h = sweeper.ang / 2;
  sweeper.body.setNextKinematicRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) });
  sweeper.mesh.rotation.y = sweeper.ang;
}

// THE DUMMY: our little guy, wandering the pad — hit him and he flies (respawns)
let dummy = null;
function buildDummy() {
  // THE guy — the main game's skinned character, walking his loop until fate arrives
  loadCharacter("models/character/humanoid_male.fbx", {
    textureDir: "models/character", texture: "base_texture.png", targetHeight: 1.8,
    animations: [
      { name: "idle", url: "models/character/anims/idle.fbx" },
      { name: "walk", url: "models/character/anims/walking.fbx" },
    ],
  }).then(async (ch) => {
    await initRapier();                       // ragdoll.js reads phys.js's R handle
    scene.add(ch.visual);
    // the REAL ragdoll tech: jointed capsule skeleton + PD muscles + reflexes,
    // simulating in this world — same system as the main game's death ragdoll
    // ragdoll collides with ground/walls/sweeper but NOT the car (filter out its
    // 0x0004 bit) — the car plows through him like the main game's pedestrians;
    // his limbs were wedging in the bodywork and racking up dents (Erik lol)
    const rag = new Ragdoll(ch.bones, { world }, { collisionGroups: (0x0002 << 16) | (0xffff & ~0x0004) });
    dummy = { mesh: ch.visual, animator: ch.animator, rag,
      pos: new THREE.Vector3(12, 0, 18), tgt: new THREE.Vector3(12, 0, 18),
      flying: false, downT: 0 };
    dummy.mesh.position.copy(dummy.pos);
    ch.animator.play("walk");
  }).catch((e) => console.warn("dummy character failed to load:", e.message));
}
function updateDummy(dt) {
  if (!dummy) return;
  const d = dummy, ct = car.body.translation(), cv = car.body.linvel();
  if (!d.flying) {
    // wander near spawn
    if (d.pos.distanceTo(d.tgt) < 0.6) d.tgt.set(6 + Math.random() * 22, 0, 4 + Math.random() * 28);
    const dirx = d.tgt.x - d.pos.x, dirz = d.tgt.z - d.pos.z, L = Math.hypot(dirx, dirz) || 1;
    d.pos.x += (dirx / L) * 1.25 * dt; d.pos.z += (dirz / L) * 1.25 * dt;
    d.mesh.position.set(d.pos.x, 0, d.pos.z);
    d.mesh.rotation.y = Math.atan2(dirx, dirz);
    d.animator.update(dt);                                       // real walk cycle
    // car contact → RAGDOLL (the real tech: capsules + joints + muscles)
    const dx = ct.x - d.pos.x, dz = ct.z - d.pos.z;
    const spd = Math.hypot(cv.x, cv.z);
    if (Math.hypot(dx, dz) < 1.7 && spd > 2 && d.rag) {
      d.flying = true; d.downT = 0;
      _dv.set(cv.x * 1.1, 2 + spd * 0.3, cv.z * 1.1);           // inherit the car's momentum
      _di.set(cv.x * 25, spd * 10, cv.z * 25);                  // contact impulse → body spins off the hit
      _dp.set(ct.x, 0.8, ct.z);                                 // hit lands at bumper height
      d.rag.enter(_dv, _di, _dp);
      if (fx) fx.onImpact({ x: d.pos.x, y: 1, z: d.pos.z }, 600000);
      car.bumpPulse = Math.max(car.bumpPulse || 0, 0.7);         // thud
    }
  } else {
    d.animator.update(dt);                // clip keeps playing — it's the muscle PD target
    d.rag.update();                       // physics bodies → bones
    d.downT += dt;
    if (d.rag.settled(1.4) || d.downT > 10) {   // at rest → get up, walk it off
      const p = d.rag.pelvisPos();
      d.rag.exit();
      d.flying = false; d.downT = 0;
      d.pos.set(p.x, 0, p.z);
      d.mesh.position.set(p.x, 0, p.z);
      d.mesh.rotation.set(0, 0, 0);
      d.tgt.set(6 + Math.random() * 22, 0, 4 + Math.random() * 28);
      d.animator.play("walk");
    }
  }
}
const _dv = new THREE.Vector3(), _di = new THREE.Vector3(), _dp = new THREE.Vector3();
// ragdoll muscles run at the physics rate, inside the substep loop
function updateDummyFixed() {
  if (dummy?.rag?.active) dummy.rag.fixedUpdate(FIXED);
}

// ---------------------------------------------------------- test gadgets ----
// Deformation-testing arsenal (Erik): [1]/[2]/[3] fire a small/medium/heavy ball
// from the camera at the car; [4] drops a small weight on it, [5] drops the BIG
// anvil. All real dynamic Rapier bodies — they dent whatever they hit — auto-
// despawned after ~10 s, capped so the scene can't flood.
const gadgets = [];
const _gdir = new THREE.Vector3();
function _gadget(body, mesh, life = 10) {
  scene.add(mesh);
  gadgets.push({ body, mesh, t: life });
  if (gadgets.length > 10) expireGadget(gadgets[0]);
}
function expireGadget(g2) {
  const i = gadgets.indexOf(g2);
  if (i >= 0) gadgets.splice(i, 1);
  scene.remove(g2.mesh);
  world.removeRigidBody(g2.body);
}
function fireBall(size) {
  const [r, mass, sp] = { 1: [0.16, 25, 75], 2: [0.32, 110, 55], 3: [0.55, 400, 42] }[size];
  camera.getWorldDirection(_gdir);                 // fire wherever the camera POINTS
  const o = camera.position;
  const bd = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(o.x + _gdir.x * 2, o.y + _gdir.y * 2, o.z + _gdir.z * 2)
    .setLinvel(_gdir.x * sp, _gdir.y * sp, _gdir.z * sp).setCcdEnabled(true);
  const body = world.createRigidBody(bd);
  const density = mass / ((4 / 3) * Math.PI * r * r * r);
  world.createCollider(RAPIER.ColliderDesc.ball(r).setDensity(density).setFriction(0.6).setRestitution(0.3)
    .setCollisionGroups((0x0008 << 16) | 0xffff), body);   // tagged so the camera ray ignores gadgets
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0x8899a6, metalness: 0.85, roughness: 0.3 }));
  mesh.castShadow = true;
  _gadget(body, mesh);
}
function dropWeight(big) {
  const [w2, h2, d2, mass] = big ? [1.7, 1.0, 1.7, 2600] : [0.75, 0.55, 0.75, 300];
  const p = car.body.translation();                // over the BODY (mesh can be stale)
  const bd = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(p.x + (Math.random() - 0.5) * 0.6, p.y + 7, p.z + (Math.random() - 0.5) * 0.6);
  const body = world.createRigidBody(bd);
  const density = mass / (w2 * h2 * d2);
  world.createCollider(RAPIER.ColliderDesc.cuboid(w2 / 2, h2 / 2, d2 / 2).setDensity(density).setFriction(0.8).setRestitution(0.05)
    .setCollisionGroups((0x0008 << 16) | 0xffff), body);   // camera ray ignores gadgets
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d2),
    new THREE.MeshStandardMaterial({ color: big ? 0x5a4632 : 0x6b7480, metalness: 0.6, roughness: 0.5 }));
  mesh.castShadow = true;
  _gadget(body, mesh, big ? 14 : 10);
}
function updateGadgets(dt) {
  for (let i = gadgets.length - 1; i >= 0; i--) {
    const g2 = gadgets[i];
    const t = g2.body.translation(), r = g2.body.rotation();
    g2.mesh.position.set(t.x, t.y, t.z);
    g2.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    g2.t -= dt;
    if (g2.t <= 0 || t.y < -10) expireGadget(g2);
  }
}

// ---------------------------------------------------------------- drag strip ----
// A real quarter-mile at x=150: staging line, split markers (60ft/330/1-8/1000ft),
// gold finish line. Timer arms when you cross the start moving forward; fixed-step
// accurate; prints a time slip with splits + trap speed. [G] teleports to staging.
const DRAG_MARKS = [["60ft", 18.29], ["330ft", 100.58], ["1/8mi", 201.17], ["1000ft", 304.8], ["1/4mi", 402.34]];
const drag = { x: 150, z0: -280, active: false, t: 0, splits: [], best: null, prev: 1,
  tree: 0, treeT: 0, green: false, red: false };
replay.auto = false;   // auto crash-cam OFF by default (Erik) — [V] replays manually

function dragUI(html, show = true) {
  let el = document.getElementById("dragui");
  if (!el) {
    el = document.createElement("div");
    el.id = "dragui";
    el.style.cssText = "position:fixed;top:14px;right:14px;z-index:34;background:rgba(12,16,20,.85);" +
      "border:1px solid #2c3a48;border-radius:8px;padding:10px 14px;color:#eaf6ff;" +
      "font:12px ui-monospace,monospace;text-align:right;line-height:1.6;min-width:170px";
    document.body.appendChild(el);
  }
  el.style.display = show ? "block" : "none";
  if (html != null) el.innerHTML = html;
}

function updateDragTimer() {
  const p = car.currPos;
  const zRel = p.z - drag.z0;
  const inLane = Math.abs(p.x - drag.x) < 8;
  if (!drag.active) {
    // stage the TREE: sit still just behind the line → ambers count you down
    if (drag.tree === 0 && inLane && zRel > -8 && zRel <= 0 && Math.abs(car.speedKmh) < 2) {
      drag.tree = 1; drag.treeT = 0; drag.green = false; setTree(0);
    }
    if (drag.tree >= 1 && !drag.green) {
      drag.treeT += FIXED;
      const stage = Math.min(4, 1 + Math.floor(drag.treeT / 0.5));
      setTree(stage);
      if (stage >= 4) drag.green = true;
    }
    if (inLane && drag.prev <= 0 && zRel > 0 && car.body.linvel().z > 0.5) {
      drag.active = true; drag.t = 0; drag.splits = [];
      drag.red = drag.tree >= 1 && !drag.green;      // jumped the tree = RED LIGHT
      drag.tree = 0;
      if (!drag.red) setTree(4);
    }
    if (drag.tree >= 1 && (!inLane || zRel < -10)) { drag.tree = 0; drag.green = false; setTree(0); }  // rolled away
  } else {
    drag.t += FIXED;
    if (!inLane || zRel < -3 || drag.t > 90) { drag.active = false; dragUI("run cancelled"); }
    else {
      for (const [name, dz] of DRAG_MARKS) {
        if (zRel >= dz && !drag.splits.find((s) => s[0] === name)) {
          drag.splits.push([name, drag.t, car.speedKmh * 0.621371]);
          if (name === "1/4mi") {
            drag.active = false;
            const et = drag.t, trap = car.speedKmh * 0.621371;
            if (!drag.best || et < drag.best) drag.best = et;
            const rows = drag.splits.map(([n, t2, v]) => `${n}: ${t2.toFixed(2)}s @ ${v.toFixed(0)}`).join("<br>");
            dragUI((drag.red ? `<b style="color:#ff4444">🔴 RED LIGHT</b><br>` : "") +
              `<b style="color:#ffe066;font-size:14px">🏁 ${et.toFixed(2)}s @ ${trap.toFixed(0)} mph</b><br>` +
              rows + `<br><span style="color:#7fd7ff">session best ${drag.best.toFixed(2)}s</span>`);
            setTree(0);
          }
        }
      }
    }
  }
  drag.prev = zRel;
}

function buildDragStrip() {
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(16, 430),
    new THREE.MeshStandardMaterial({ color: 0x23272c, roughness: 0.95 }));
  strip.rotation.x = -Math.PI / 2;
  strip.position.set(drag.x, 0.012, drag.z0 + 205);
  strip.receiveShadow = true;
  scene.add(strip);
  const line = (dz, depth, col) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(16, depth), new THREE.MeshBasicMaterial({ color: col }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(drag.x, 0.02, drag.z0 + dz);
    scene.add(m);
  };
  line(0, 0.8, 0xdddddd);                                   // staging line
  for (const [, dz] of DRAG_MARKS) line(dz, 0.4, 0xbbbbbb); // splits
  line(402.34, 1.2, 0xffe066);                              // gold finish
  for (const dz of [0, 402.34]) for (const s of [-8.6, 8.6]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.7, 0.25),
      new THREE.MeshStandardMaterial({ color: 0xffe066, emissive: 0x554400 }));
    post.position.set(drag.x + s, 0.85, drag.z0 + dz);
    post.castShadow = true;
    scene.add(post);
  }
  // THE TREE: pole beside the staging line — 3 ambers + green (+ red-light shame)
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.15, 3.4, 0.15),
    new THREE.MeshStandardMaterial({ color: 0x333a42 }));
  pole.position.set(drag.x - 9.6, 1.7, drag.z0 - 1.5);
  scene.add(pole);
  drag.lights = [];
  const cols = [0xff9a00, 0xff9a00, 0xff9a00, 0x22dd55];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.MeshStandardMaterial({ color: 0x22262b, emissive: 0x000000 });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), m);
    bulb.position.set(drag.x - 9.6, 3.0 - i * 0.55, drag.z0 - 1.5);
    scene.add(bulb);
    drag.lights.push({ m, col: cols[i] });
  }
}

function setTree(stage) {   // 0=dark 1..3=ambers 4=GREEN
  if (!drag.lights) return;
  drag.lights.forEach((L, i) => {
    const on = stage >= 4 ? i === 3 : i < stage;
    L.m.emissive.setHex(on ? L.col : 0x000000);
    L.m.color.setHex(on ? L.col : 0x22262b);
  });
}

/** [H]: hitch when the car's rear is near the tongue; unhitch when connected */
const _hA = new THREE.Vector3(), _hB = new THREE.Vector3();
function toggleHitch() {
  if (trailer.joint) { trailer.unhitch(world, car); return; }
  const hl = { x: 0, y: -0.65, z: -(car.half.z + 0.15) };   // car hitch, local (bumper-low —
  // must match the trailer tongue's natural ride height or the trailer hangs and swings)
  const cr = car.body.rotation(), ct = car.body.translation();
  _rq1.set(cr.x, cr.y, cr.z, cr.w);
  _hA.set(hl.x, hl.y, hl.z).applyQuaternion(_rq1).add(_hB.set(ct.x, ct.y, ct.z));
  trailer.tongueWorld(_hB);
  if (_hA.distanceTo(_hB) < 4.5) trailer.hitchTo(car, RAPIER, world, hl);
}

function updateReplay(dt) {
  replay.ph += dt * replay.speed * 60;
  if (replay.ph >= replay.len - 1.01) { stopReplay(); return; }
  // re-enact damage exactly when it happened (dents, glass, sparks on cue)
  while (replay.evtIdx < replay.evtQueue.length && replay.evtQueue[replay.evtIdx].f - replay.fStart <= replay.ph)
    applyDamageEvent(replay.evtQueue[replay.evtIdx++], true);
  const f = Math.floor(replay.ph), frac = replay.ph - f;
  const idx = readReplayFrame(f, _rp1, _rq1);
  readReplayFrame(f + 1, _rp2, _rq2);
  car.mesh.position.lerpVectors(_rp1, _rp2, frac);               // lerped = smooth slow-mo
  car.mesh.quaternion.copy(_rq1).slerp(_rq2, frac);
  const d = replay.data;
  for (let k = 0; k < 4; k++) { const w2 = car.wheels[k]; if (w2.detached && !w2._rfit) continue; w2.spin = d[idx + 7 + k]; w2.dist = d[idx + 11 + k]; }
  car.steer = d[idx + 15];
  car._placeWheels();
  // cinematic slow orbit around the wreck
  replay.orbit += dt * 0.22;
  const p = car.mesh.position;
  _cdes.set(p.x + Math.sin(replay.orbit) * 8.5, p.y + 3.1, p.z + Math.cos(replay.orbit) * 8.5);
  camera.position.lerp(_cdes, 1 - Math.pow(0.002, dt));
  camera.lookAt(p.x, p.y + 0.7, p.z);
}

function frame() {
  if (window.__garage) window.__garage.frames++;
  const now = performance.now() / 1000;
  let dt = now - last;
  last = now;

  // frametime telemetry
  const ms = dt * 1000;
  ft.buf[ft.i = (ft.i + 1) % ft.buf.length] = ms;
  if (ms > ft.max2s) { ft.max2s = ms; ft.max2sT = now; }
  if (now - ft.max2sT > 2) { ft.max2s = ms; ft.max2sT = now; }   // decay the 2s peak

  replay.cooldown = Math.max(0, replay.cooldown - dt);
  if (replay.pending > 0) { replay.pending -= dt; if (replay.pending <= 0) startReplay(); }
  if (replay.active) {                    // physics + input freeze; pure playback
    updateReplay(dt);
    updateHUD();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
    return;
  }

  if (dt > 0.25) dt = 0.25;             // clamp after a stall so we don't spiral
  acc += dt;

  lastInput = readInput();
  car.setInput(lastInput);
  // gear-shift latency: torque cut exactly while the audio gearbox is mid-shift
  car.shiftCut = !!(audio.engine && audio.engine.running && audio.engine._shiftT > 0);

  let steps = 0;
  while (acc >= FIXED && steps < MAX_SUBSTEPS) {
    car.snapshotPrev();
    trailer.snapshotPrev();
    for (const ai of aiCars) ai.snapshotPrev();
    car.fixedUpdate(FIXED);     // suspension + tire forces BEFORE the solve
    trailer.fixedUpdate(FIXED);
    updateAI();                 // derby drivers (steer + their own fixedUpdate)
    physicsStep();
    car.snapshotCurr();
    trailer.snapshotCurr();
    for (const ai of aiCars) ai.snapshotCurr();
    recordFrame();              // 60Hz ring buffer for the replay / crash cam
    updateDragTimer();          // fixed-step-accurate quarter-mile timing
    updateSweeper();            // spin the ball-sweeper (kinematic)
    updateDummyFixed();         // ragdoll PD muscles (needs the fixed rate)
    acc -= FIXED;
    steps++;
  }
  if (steps === MAX_SUBSTEPS) acc = 0;  // shed backlog rather than lurch
  ft.sub = steps;

  const alpha = acc / FIXED;            // leftover fraction → smooth interpolation
  handlePadExtras(dt);                  // gamepad one-shots + right-stick camera
  car.interpolate(alpha);
  trailer.interpolate(alpha);
  for (const ai of aiCars) { ai.interpolate(alpha); ai.updateDebris(dt); ai._fire?.update(dt); }
  car.updateDebris(dt);                 // tumble loose wheels/chunks (plain JS)
  updateGadgets(dt);                    // sync + expire thrown/dropped test objects
  updateDummy(dt);                      // the little guy wanders… and flies
  skid.update(car);                     // lay tyre skid marks where wheels slide/spin
  fx.update(dt, car);                   // tyre smoke + sparks
  // engine cooked past the limp floor for a while → it catches
  if (fire) {
    if (car.overheat >= 1 && car.heatMul <= 0.41 && !fire.burning && Math.random() < 0.15 * dt)
      fire.ignite("front", 0.25);
    fire.update(dt);
  }
  audio.update(dt, car);                // procedural engine + tyre squeal
  cluster.update(audio.rpm, car.speedKmh);   // tach + speedo

  updateCamera(dt);
  updateHUD();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- camera ----
const cam = {
  mode: "chase",                       // "chase" | "free"
  yaw: Math.PI, pitch: 0.34, dist: 9,  // chase orbit
  drag: false, px: 0, py: 0,
  look: new THREE.Vector3(),
  freePos: new THREE.Vector3(0, 6, -14), freeYaw: 0, freePitch: -0.15, freeSpeed: 24,
};
const _cdes = new THREE.Vector3();
const _clook = new THREE.Vector3();
const _cfwd = new THREE.Vector3();

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function setupCameraInput(dom) {
  dom.addEventListener("mousedown", (e) => { cam.drag = true; cam.px = e.clientX; cam.py = e.clientY; e.preventDefault(); });
  addEventListener("mouseup", () => { cam.drag = false; });
  addEventListener("mousemove", (e) => {
    if (!cam.drag) return;
    const dx = e.clientX - cam.px, dy = e.clientY - cam.py;
    cam.px = e.clientX; cam.py = e.clientY;
    if (cam.mode === "chase") {
      cam.yaw -= dx * 0.005;
      cam.pitch = Math.max(-0.25, Math.min(1.25, cam.pitch + dy * 0.005));
    } else if (cam.mode === "cockpit") {
      cam.cockYaw -= dx * 0.004;
      cam.cockPitch = Math.max(-0.8, Math.min(0.8, cam.cockPitch - dy * 0.004));
    } else {
      cam.freeYaw -= dx * 0.004;
      cam.freePitch = Math.max(-1.45, Math.min(1.45, cam.freePitch - dy * 0.004));
    }
  });
  dom.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (cam.mode === "chase") cam.dist = Math.max(4, Math.min(32, cam.dist + e.deltaY * 0.01));
    else cam.freeSpeed = Math.max(4, Math.min(140, cam.freeSpeed - e.deltaY * 0.05));
  }, { passive: false });
  dom.addEventListener("contextmenu", (e) => e.preventDefault());
}

function toggleFreeCam() {
  // [C] cycles chase → COCKPIT → free → chase
  if (cam.mode === "chase") {
    cam.mode = "cockpit";
    cam.cockYaw = 0; cam.cockPitch = 0;
    cam._baseFov = camera.fov; camera.fov = 74; camera.updateProjectionMatrix();
  } else if (cam.mode === "cockpit") {
    cam.mode = "free";
    camera.up.set(0, 1, 0);
    if (cam._baseFov) { camera.fov = cam._baseFov; camera.updateProjectionMatrix(); }
    cam.freePos.copy(camera.position);
    _cfwd.copy(cam.look).sub(camera.position).normalize();
    cam.freeYaw = Math.atan2(_cfwd.x, _cfwd.z);
    cam.freePitch = Math.asin(Math.max(-1, Math.min(1, _cfwd.y)));
  } else {
    cam.mode = "chase";
    if (cam._baseFov) { camera.fov = cam._baseFov; camera.updateProjectionMatrix(); }
  }
}

// ---- COCKPIT CAM (Erik #3): sitting in the driver's seat, camera IS the
// driver's head — G-force sway (head lags acceleration on a spring), speed
// vibration, look-into-the-turn, mouse look-around, crash shake. ----------
const _hq = new THREE.Quaternion();
const _hup = new THREE.Vector3();
const _hoff = new THREE.Vector3();
function updateCockpitCam(dt) {
  const m = car.mesh;                       // interpolated pose (smooth at any fps)
  cam.sway = cam.sway || new THREE.Vector3();
  cam.pv = cam.pv || new THREE.Vector3();
  const v = car.body.linvel();
  // world acceleration → car-local (head lags it: brake = lean forward, corner = lean out)
  _hoff.set((v.x - cam.pv.x) / Math.max(dt, 1e-3), 0, (v.z - cam.pv.z) / Math.max(dt, 1e-3));
  cam.pv.set(v.x, v.y, v.z);
  _hq.copy(m.quaternion).invert();
  _hoff.applyQuaternion(_hq);
  _hoff.x = THREE.MathUtils.clamp(-_hoff.x * 0.006, -0.09, 0.09);
  _hoff.z = THREE.MathUtils.clamp(-_hoff.z * 0.006, -0.11, 0.07);
  _hoff.y = 0;
  cam.sway.lerp(_hoff, Math.min(1, 7 * dt));
  // head position: driver's seat + sway + speed vibration + crash shake
  const spd = Math.abs(car.speedKmh);
  const vib = spd > 25 ? (spd / 900) : 0;
  _cdes.set(0.37 + cam.sway.x, 0.3, 0.12 + cam.sway.z);   // seat height (origin = chassis CENTER)
  _cdes.x += (Math.random() - 0.5) * vib;
  _cdes.y += (Math.random() - 0.5) * vib * 0.7 + ((car.bumpPulse || 0) > 0 ? (Math.random() - 0.5) * 0.04 : 0);
  m.localToWorld(_cdes);
  if ((cam.shakeAmt || 0) > 0.01) {
    _cdes.x += (Math.random() - 0.5) * cam.shakeAmt * 0.2;
    _cdes.y += (Math.random() - 0.5) * cam.shakeAmt * 0.15;
    cam.shakeAmt *= Math.pow(0.02, dt);
  }
  camera.position.copy(_cdes);
  // look: car-forward + mouse offset + a natural glance INTO the turn
  if (!cam.drag) cam.cockYaw = lerpAngle(cam.cockYaw, 0, Math.min(1, 3 * dt));   // recenter
  const turnGlance = THREE.MathUtils.clamp(car.body.angvel().y * 0.14, -0.3, 0.3);
  _hq.copy(m.quaternion);
  _hup.set(0, 1, 0).applyQuaternion(_hq);
  _hq.premultiply(new THREE.Quaternion().setFromAxisAngle(_hup, cam.cockYaw + turnGlance));
  _cfwd.set(Math.sin(0), 0, 1).applyQuaternion(_hq);
  _cfwd.y += cam.cockPitch;
  _clook.copy(camera.position).add(_cfwd);
  // up vector: mostly the CAR's up (you roll with the crash) blended toward
  // world-up so normal driving doesn't feel seasick
  camera.up.copy(_hup).lerp(new THREE.Vector3(0, 1, 0), 0.35).normalize();
  camera.lookAt(_clook);
}

function updateCamera(dt) {
  if (cam.mode === "free") return updateFreeCam(dt);
  if (cam.mode === "cockpit") return updateCockpitCam(dt);
  camera.up.set(0, 1, 0);                  // leaving cockpit: level the horizon
  const p = car.mesh.position;
  const v = car.body.linvel();
  const speed = Math.hypot(v.x, v.z);
  // auto-swing behind the direction of travel when moving & not dragging (GTA feel)
  if (!cam.drag && !cam.stick && speed > 3) {
    const behind = Math.atan2(v.x, v.z) + Math.PI;
    cam.yaw = lerpAngle(cam.yaw, behind, Math.min(1, 2.2 * dt));
  }
  const ch = Math.cos(cam.pitch) * cam.dist;
  _clook.set(p.x, p.y + 1.1, p.z);
  _cdes.set(p.x + Math.sin(cam.yaw) * ch, p.y + 2.0 + Math.sin(cam.pitch) * cam.dist, p.z + Math.cos(cam.yaw) * ch);
  // obstacle pull-in: don't let the camera clip through walls behind the car
  _cfwd.copy(_cdes).sub(_clook);
  const len = _cfwd.length(); _cfwd.normalize();
  const hit = world.castRay(new RAPIER.Ray(_clook, _cfwd), len, true, undefined,
    (0xffff << 16) | (0xffff & ~0x0008), undefined, car.body);   // ignore gadget group
  if (hit) {
    const toi = (hit.timeOfImpact ?? hit.toi) * 0.85;
    _cdes.copy(_clook).addScaledVector(_cfwd, Math.min(len, toi));
  }
  camera.position.lerp(_cdes, 1 - Math.pow(0.0016, dt));
  cam.look.lerp(_clook, 1 - Math.pow(0.0022, dt));
  camera.lookAt(cam.look);
  // impact camera shake — decays fast (crashes feel like they HIT)
  if ((cam.shakeAmt || 0) > 0.01) {
    camera.position.x += (Math.random() - 0.5) * cam.shakeAmt * 0.55;
    camera.position.y += (Math.random() - 0.5) * cam.shakeAmt * 0.4;
    camera.position.z += (Math.random() - 0.5) * cam.shakeAmt * 0.55;
    cam.shakeAmt *= Math.pow(0.02, dt);
  }
}

function updateFreeCam(dt) {
  _cfwd.set(Math.sin(cam.freeYaw) * Math.cos(cam.freePitch), Math.sin(cam.freePitch), Math.cos(cam.freeYaw) * Math.cos(cam.freePitch));
  const spd = cam.freeSpeed * dt * (keys.ShiftLeft ? 3 : 1);
  const rx = -Math.cos(cam.freeYaw), rz = Math.sin(cam.freeYaw);   // horizontal right (was mirrored)
  if (keys.KeyW) cam.freePos.addScaledVector(_cfwd, spd);
  if (keys.KeyS) cam.freePos.addScaledVector(_cfwd, -spd);
  if (keys.KeyD) { cam.freePos.x += rx * spd; cam.freePos.z += rz * spd; }
  if (keys.KeyA) { cam.freePos.x -= rx * spd; cam.freePos.z -= rz * spd; }
  if (keys.KeyE || keys.Space) cam.freePos.y += spd;
  if (keys.KeyQ) cam.freePos.y -= spd;
  camera.position.copy(cam.freePos);
  camera.lookAt(cam.freePos.x + _cfwd.x, cam.freePos.y + _cfwd.y, cam.freePos.z + _cfwd.z);
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

// ---------------------------------------------------------------- HUD ----
let hud, ftCanvas, ftCtx, fpsEMA = 60;
function buildHUD() {
  const style = document.createElement("style");
  style.textContent = `
    #hud{position:fixed;top:10px;left:10px;color:#cfe;font:12px ui-monospace,monospace;
      background:rgba(12,16,20,.82);border:1px solid #2c3a48;border-radius:8px;padding:10px 12px;
      width:240px;user-select:none;line-height:1.5}
    #hud h1{font-size:12px;margin:0 0 6px;color:#7fd7ff;letter-spacing:.5px}
    #hud .row{display:flex;justify-content:space-between}
    #hud .row b{color:#fff;font-weight:600}
    #hud label{display:block;margin:7px 0 1px;color:#9fb4c4}
    #hud input[type=range]{width:100%}
    #hud .val{color:#ffd479}
    #hud canvas{margin-top:8px;border:1px solid #2c3a48;border-radius:4px;background:#0a0d10}
    #hud .hint{margin-top:8px;color:#6f8496;font-size:11px}
    #hud .stamp{color:#5a6b7a;font-size:10px;margin-top:6px}
    @media (max-width: 760px) {
      #hud{display:none}     /* phone: clear screen — ⚙ button brings it back */
    }`;
  document.head.appendChild(style);

  hud = document.createElement("div");
  hud.id = "hud";
  hud.innerHTML = `
    <h1>THE GARAGE · PROVING GROUND</h1>
    <div class="row"><span>fps</span><b id="h-fps">–</b></div>
    <div class="row"><span>frame ms</span><b id="h-ms">–</b></div>
    <div class="row"><span>2s peak ms</span><b id="h-peak">–</b></div>
    <div class="row"><span>substeps/frame</span><b id="h-sub">–</b></div>
    <div class="row"><span>car height</span><b id="h-y">–</b></div>
    <div class="row"><span>speed</span><b id="h-kmh">–</b></div>
    <div class="row"><span>rpm / squeal</span><b id="h-eng">–</b></div>
    <div class="row"><span>wheels grounded</span><b id="h-wg">–</b></div>
    <div class="row"><span>dents</span><b id="h-dent">0</b></div>
    <div class="row"><span>wheels off / debris</span><b id="h-dmg">0 / 0</b></div>
    <div class="row"><span>zones F/R/L/Ri/Ro</span><b id="h-zone">100 100 100 100 100</b></div>
    <div class="row"><span>input thr/brk/str</span><b id="h-inp">0 / 0 / 0</b></div>
    <label>spring stiffness <span class="val" id="v-k">30000</span></label>
    <input id="s-k" type="range" min="5000" max="80000" step="500" value="30000">
    <label>spring damping <span class="val" id="v-d">1500</span></label>
    <input id="s-d" type="range" min="0" max="12000" step="100" value="1500">
    <label>rest length <span class="val" id="v-rest">0.50</span></label>
    <input id="s-rest" type="range" min="0.2" max="0.9" step="0.01" value="0.50">
    <label>engine force <span class="val" id="v-eng">12000</span></label>
    <input id="s-eng" type="range" min="2000" max="24000" step="500" value="12000">
    <label>tire grip <span class="val" id="v-grip">1.70</span></label>
    <input id="s-grip" type="range" min="0.5" max="3" step="0.05" value="1.70">
    <label>rear grip mul <span class="val" id="v-rg">1.00</span></label>
    <input id="s-rg" type="range" min="0.3" max="1.2" step="0.02" value="1.00">
    <label>CoG height (low↔bus) <span class="val" id="v-cog">-0.45</span></label>
    <input id="s-cog" type="range" min="-0.5" max="0.5" step="0.02" value="-0.45">
    <label>anti-roll bar <span class="val" id="v-arb">29000</span></label>
    <input id="s-arb" type="range" min="0" max="60000" step="1000" value="29000">
    <canvas id="ftg" width="216" height="46"></canvas>
    <div class="hint">WASD drive · Space handbrake/burnout · [1-3] GUN s/m/heavy · [4] weight [5] ANVIL · [G] DRAG STRIP · [V] replay · [H] hitch · drag=orbit · scroll=zoom · [C] free-cam · [R] drop · [P] repair · [K] clear skids<br>
    🎮 LS steer · RT gas · LT reverse · A handbrake · RS camera · Y reset · B repair · X clear skids</div>
    <div class="stamp">build ${typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev"}</div>`;
  document.body.appendChild(hud);

  bindSlider("s-k", "v-k", (v) => {
    // stiffer springs compress less — compensate rest length so ride height stays put
    car.suspStiff = v;
    const rest = parseFloat(document.getElementById("s-rest").value);
    car.suspRest = rest + car.mass * 5 * (1 / v - 1 / 30000);
  }, 0);
  bindSlider("s-d", "v-d", (v) => { car.suspDamp = v; }, 0);
  bindSlider("s-rest", "v-rest", (v) => { car.suspRest = v + car.mass * 5 * (1 / car.suspStiff - 1 / 30000); });
  bindSlider("s-eng", "v-eng", (v) => { car.engineForce = v; }, 0);
  bindSlider("s-grip", "v-grip", (v) => { car.tireGrip = v; });
  bindSlider("s-rg", "v-rg", (v) => { car.rearGripMul = v; });
  bindSlider("s-cog", "v-cog", (v) => car.setCoM(v));
  bindSlider("s-arb", "v-arb", (v) => { car.antiRoll = v; }, 0);

  // save current sliders as defaults (localStorage) + restore them on load
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "💾 save as default";
  saveBtn.style.cssText = "margin-top:8px;width:100%;background:#1c2a38;color:#7fd7ff;border:1px solid #2c3a48;" +
    "border-radius:6px;padding:5px;font:11px ui-monospace,monospace;cursor:pointer";
  saveBtn.addEventListener("click", () => {
    const o = {};
    hud.querySelectorAll('input[type="range"]').forEach((el) => { o[el.id] = el.value; });
    localStorage.setItem("pg.defaults", JSON.stringify(o));
    saveBtn.textContent = "✔ saved";
    setTimeout(() => (saveBtn.textContent = "💾 save as default"), 1200);
  });
  hud.appendChild(saveBtn);
  try {
    const saved = JSON.parse(localStorage.getItem("pg.defaults") || "null");
    if (saved) for (const [id, v] of Object.entries(saved)) {
      const el = document.getElementById(id);
      if (el) { el.value = v; el.dispatchEvent(new Event("input")); }
    }
  } catch (e) { /* corrupt save — ignore */ }

  ftCanvas = document.getElementById("ftg");
  ftCtx = ftCanvas.getContext("2d");
}

function bindSlider(id, valId, apply, digits = 2) {
  const el = document.getElementById(id);
  const label = document.getElementById(valId);
  const commit = () => {
    const v = parseFloat(el.value);
    label.textContent = v.toFixed(digits);
    apply(v);
  };
  el.addEventListener("input", commit);
  // hover + mouse wheel nudges the slider (Erik). Shift = 5× coarse steps.
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const step = (parseFloat(el.step) || 1) * (e.shiftKey ? 5 : 1);
    const dir = e.deltaY < 0 ? 1 : -1;              // wheel up = increase
    const v = parseFloat(el.value) + dir * step;
    el.value = String(Math.min(parseFloat(el.max), Math.max(parseFloat(el.min), v)));
    commit();
  }, { passive: false });
}

let hudT = 0;
function updateHUD() {
  const ms = ft.buf[ft.i] || 16.6;
  fpsEMA += ((1000 / Math.max(ms, 0.1)) - fpsEMA) * 0.1;
  drawFrametime();
  if ((hudT = (hudT + 1) % 6) !== 0) return;   // text at 10Hz — cheap
  set("h-fps", fpsEMA.toFixed(0));
  set("h-ms", ms.toFixed(1));
  set("h-peak", ft.max2s.toFixed(1));
  set("h-sub", String(ft.sub));
  set("h-y", car.height.toFixed(2) + " m");
  set("h-kmh", (car.speedKmh * 0.621371).toFixed(0) + " mph");
  set("h-wg", car.wheels.filter((w) => w.grounded).length + " / 4");
  set("h-dent", String(car.dents));
  set("h-dmg", car.wheelsOff + " / " + car.debris.length);
  if (car.zoneHealth) {
    const z = car.zoneHealth;
    set("h-zone", [z.front, z.rear, z.left, z.right, z.roof].map((v) => Math.round(v * 100)).join(" "));
  }
  if (drag.active) dragUI(`⏱ ${drag.t.toFixed(2)}s · ${Math.round(car.speedKmh * 0.621371)} mph`);
  set("h-inp", Math.round(lastInput.throttle * 100) + " / " + Math.round(lastInput.brake * 100) + " / " + Math.round(lastInput.steer * 100));
  set("h-eng", Math.round(audio.rpm) + " / " + car.screech.toFixed(2));
}
function set(id, t) { const e = document.getElementById(id); if (e) e.textContent = t; }

function drawFrametime() {
  const w = ftCanvas.width, h = ftCanvas.height, n = ft.buf.length;
  ftCtx.clearRect(0, 0, w, h);
  // 16.6ms budget line
  const budgetY = h - (16.6 / 33.3) * h;
  ftCtx.strokeStyle = "#c65"; ftCtx.beginPath();
  ftCtx.moveTo(0, budgetY); ftCtx.lineTo(w, budgetY); ftCtx.stroke();
  // bars: green under budget, red over
  const bw = w / n;
  for (let k = 0; k < n; k++) {
    const idx = (ft.i + 1 + k) % n;
    const v = ft.buf[idx] || 0;
    const bh = Math.min(h, (v / 33.3) * h);
    ftCtx.fillStyle = v > 18 ? "#d9534f" : "#5fd08a";
    ftCtx.fillRect(k * bw, h - bh, Math.max(1, bw - 0.5), bh);
  }
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("beforeend",
    `<pre style="color:#f88;position:fixed;top:0;left:0;padding:12px;font:12px monospace">${e.stack || e}</pre>`);
});
