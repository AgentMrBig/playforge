import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { Car } from "./carphysics.js";
import { loadVehicle } from "./vehicledef.js";
import { VehicleAudio } from "./vehicleaudio.js";
import { SkidTrails } from "./skidtrails.js";
import { Cluster } from "./cluster.js";
import { VehicleFX } from "./vehiclefx.js";

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

let world, car, scene, camera, renderer, eventQueue, skid, fx;
let last = performance.now() / 1000;
let acc = 0;
const keys = {};
const audio = new VehicleAudio({ hp: 450 });
const cluster = new Cluster();

/** one physics step + drain hard-impact events into the car's deform system */
function physicsStep() {
  world.step(eventQueue);
  eventQueue.drainContactForceEvents((e) => {
    const ch = car.collider.handle;
    const c1 = e.collider1(), c2 = e.collider2();
    if (c1 !== ch && c2 !== ch) return;
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
    car.impact(point, mag, dir);
    if (fx) fx.onImpact(point, mag);      // spark burst on hard hits
  });
}

/** map current key state → car input */
function readInput() {
  if (cam.mode === "free") return { throttle: 0, steer: 0, brake: 0, handbrake: false };  // WASD flies the cam
  const up = keys.KeyW || keys.ArrowUp, down = keys.KeyS || keys.ArrowDown;
  const left = keys.KeyA || keys.ArrowLeft, right = keys.KeyD || keys.ArrowRight;
  return {
    throttle: (up ? 1 : 0) - (down ? 1 : 0),   // W/↑ forward, S/↓ reverse
    steer: (left ? 1 : 0) - (right ? 1 : 0),    // A/D
    brake: 0,
    handbrake: !!keys.Space,
  };
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
  scene.fog = new THREE.Fog(0x151a20, 60, 180);

  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 500);
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
  const groundSize = 200;
  const groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    new THREE.MeshStandardMaterial({ color: 0x33383f, roughness: 0.95 })
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);
  const grid = new THREE.GridHelper(groundSize, 100, 0x556070, 0x2c333b);
  grid.position.y = 0.01;
  scene.add(grid);

  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(groundSize / 2, 0.5, groundSize / 2).setTranslation(0, -0.5, 0),
    groundBody
  );

  // ---- a couple of ramps / kerbs to load the suspension (Stage 2+) ----
  addRamp([0, 0, 22], 8, 1.6, 6, -0.28);     // gentle launch ramp ahead
  addRamp([-14, 0, 6], 5, 1.0, 5, 0.35);     // side kicker
  addKerb([10, 0, 4], 12, 0.18, 0.8);        // low kerb strip to test small bumps
  addWall([9, 0, 34], 12, 3, 1);             // crash walls (drive into these to dent)
  addWall([-16, 0, -2], 1, 3, 16);
  addWall([0, 0, -20], 8, 3, 1);

  // ---- the car --------------------------------------------------------
  car = new Car(world, RAPIER, { pos: [0, 3, 0] });
  scene.add(car.mesh);
  skid = new SkidTrails(scene);
  fx = new VehicleFX(scene);

  buildHUD();

  // debug/verification handle — the agent Browser pane throttles rAF to ~0fps,
  // so headless checks drive the fixed step manually instead of trusting the loop.
  window.__garage = {
    world, car, RAPIER, scene, camera, renderer, audio, skid, fx, cluster, frames: 0,
    render() { car.interpolate(1); updateCamera(0.016); renderer.render(scene, camera); },
    step(n = 1) { for (let i = 0; i < n; i++) { car.snapshotPrev(); car.fixedUpdate(FIXED); physicsStep(); car.snapshotCurr(); } return car.height; },
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
    if (e.code === "KeyR") car.reset();
    if (e.code === "KeyT") car.reset(12);   // big drop — hard-landing settle test
    if (e.code === "KeyP") car.repair();    // un-dent the body
    if (e.code === "KeyC") toggleFreeCam(); // chase ⇄ free cam
    if (e.code === "KeyK") skid.clear();    // wipe skid marks
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
  });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  setupCameraInput(renderer.domElement);

  // audio needs a user gesture to start (browser autoplay policy)
  const startAudio = () => { audio.start(); removeEventListener("keydown", startAudio); removeEventListener("mousedown", startAudio); };
  addEventListener("keydown", startAudio);
  addEventListener("mousedown", startAudio);

  requestAnimationFrame(frame);

  // swap the placeholder box for a real Synty car (non-blocking; box works until then)
  const pick = new URLSearchParams(location.search).get("car") || "lowcar";
  const spec = CARS[pick] || CARS.lowcar;
  loadVehicle(spec.file, { targetLength: spec.len, ...spec.opts })
    .then((rig) => { rig.name = pick; car.attachModel(rig); window.__garage.modelLoaded = pick; })
    .catch((e) => console.warn("[garage] model load failed, keeping box:", e));
}

/** angled ramp box: pos = base center [x,0,z], rotX in radians (tilt) */
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

  if (dt > 0.25) dt = 0.25;             // clamp after a stall so we don't spiral
  acc += dt;

  car.setInput(readInput());

  let steps = 0;
  while (acc >= FIXED && steps < MAX_SUBSTEPS) {
    car.snapshotPrev();
    car.fixedUpdate(FIXED);     // suspension + tire forces BEFORE the solve
    physicsStep();
    car.snapshotCurr();
    acc -= FIXED;
    steps++;
  }
  if (steps === MAX_SUBSTEPS) acc = 0;  // shed backlog rather than lurch
  ft.sub = steps;

  const alpha = acc / FIXED;            // leftover fraction → smooth interpolation
  car.interpolate(alpha);
  car.updateDebris(dt);                 // tumble loose wheels/chunks (plain JS)
  skid.update(car);                     // lay tyre skid marks where wheels slide/spin
  fx.update(dt, car);                   // tyre smoke + sparks
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
  if (cam.mode === "chase") {
    cam.mode = "free";
    cam.freePos.copy(camera.position);
    // aim the free cam where the chase cam was looking
    _cfwd.copy(cam.look).sub(camera.position).normalize();
    cam.freeYaw = Math.atan2(_cfwd.x, _cfwd.z);
    cam.freePitch = Math.asin(Math.max(-1, Math.min(1, _cfwd.y)));
  } else {
    cam.mode = "chase";
  }
}

function updateCamera(dt) {
  if (cam.mode === "free") return updateFreeCam(dt);
  const p = car.mesh.position;
  const v = car.body.linvel();
  const speed = Math.hypot(v.x, v.z);
  // auto-swing behind the direction of travel when moving & not dragging (GTA feel)
  if (!cam.drag && speed > 3) {
    const behind = Math.atan2(v.x, v.z) + Math.PI;
    cam.yaw = lerpAngle(cam.yaw, behind, Math.min(1, 2.2 * dt));
  }
  const ch = Math.cos(cam.pitch) * cam.dist;
  _clook.set(p.x, p.y + 1.1, p.z);
  _cdes.set(p.x + Math.sin(cam.yaw) * ch, p.y + 2.0 + Math.sin(cam.pitch) * cam.dist, p.z + Math.cos(cam.yaw) * ch);
  // obstacle pull-in: don't let the camera clip through walls behind the car
  _cfwd.copy(_cdes).sub(_clook);
  const len = _cfwd.length(); _cfwd.normalize();
  const hit = world.castRay(new RAPIER.Ray(_clook, _cfwd), len, true, undefined, undefined, undefined, car.body);
  if (hit) {
    const toi = (hit.timeOfImpact ?? hit.toi) * 0.85;
    _cdes.copy(_clook).addScaledVector(_cfwd, Math.min(len, toi));
  }
  camera.position.lerp(_cdes, 1 - Math.pow(0.0016, dt));
  cam.look.lerp(_clook, 1 - Math.pow(0.0022, dt));
  camera.lookAt(cam.look);
}

function updateFreeCam(dt) {
  _cfwd.set(Math.sin(cam.freeYaw) * Math.cos(cam.freePitch), Math.sin(cam.freePitch), Math.cos(cam.freeYaw) * Math.cos(cam.freePitch));
  const spd = cam.freeSpeed * dt * (keys.ShiftLeft ? 3 : 1);
  const rx = Math.cos(cam.freeYaw), rz = -Math.sin(cam.freeYaw);   // horizontal right
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
    #hud .stamp{color:#5a6b7a;font-size:10px;margin-top:6px}`;
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
    <label>spring stiffness <span class="val" id="v-k">30000</span></label>
    <input id="s-k" type="range" min="5000" max="80000" step="500" value="30000">
    <label>spring damping <span class="val" id="v-d">1500</span></label>
    <input id="s-d" type="range" min="0" max="12000" step="100" value="1500">
    <label>rest length <span class="val" id="v-rest">0.50</span></label>
    <input id="s-rest" type="range" min="0.2" max="0.9" step="0.01" value="0.50">
    <label>engine force <span class="val" id="v-eng">8000</span></label>
    <input id="s-eng" type="range" min="2000" max="20000" step="500" value="8000">
    <label>tire grip <span class="val" id="v-grip">1.70</span></label>
    <input id="s-grip" type="range" min="0.5" max="3" step="0.05" value="1.70">
    <label>rear grip mul <span class="val" id="v-rg">1.00</span></label>
    <input id="s-rg" type="range" min="0.3" max="1.2" step="0.02" value="1.00">
    <label>CoG height (low↔bus) <span class="val" id="v-cog">-0.45</span></label>
    <input id="s-cog" type="range" min="-0.5" max="0.5" step="0.02" value="-0.45">
    <label>anti-roll bar <span class="val" id="v-arb">29000</span></label>
    <input id="s-arb" type="range" min="0" max="60000" step="1000" value="29000">
    <canvas id="ftg" width="216" height="46"></canvas>
    <div class="hint">WASD drive · Space handbrake/burnout · drag=orbit · scroll=zoom · [C] free-cam · [R] drop · [P] repair · [K] clear skids</div>
    <div class="stamp">build ${typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev"}</div>`;
  document.body.appendChild(hud);

  bindSlider("s-k", "v-k", (v) => { car.suspStiff = v; }, 0);
  bindSlider("s-d", "v-d", (v) => { car.suspDamp = v; }, 0);
  bindSlider("s-rest", "v-rest", (v) => { car.suspRest = v; });
  bindSlider("s-eng", "v-eng", (v) => { car.engineForce = v; }, 0);
  bindSlider("s-grip", "v-grip", (v) => { car.tireGrip = v; });
  bindSlider("s-rg", "v-rg", (v) => { car.rearGripMul = v; });
  bindSlider("s-cog", "v-cog", (v) => car.setCoM(v));
  bindSlider("s-arb", "v-arb", (v) => { car.antiRoll = v; }, 0);

  ftCanvas = document.getElementById("ftg");
  ftCtx = ftCanvas.getContext("2d");
}

function bindSlider(id, valId, apply, digits = 2) {
  const el = document.getElementById(id);
  const label = document.getElementById(valId);
  el.addEventListener("input", () => {
    const v = parseFloat(el.value);
    label.textContent = v.toFixed(digits);
    apply(v);
  });
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
  set("h-kmh", car.speedKmh.toFixed(0) + " km/h");
  set("h-wg", car.wheels.filter((w) => w.grounded).length + " / 4");
  set("h-dent", String(car.dents));
  set("h-dmg", car.wheelsOff + " / " + car.debris.length);
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
