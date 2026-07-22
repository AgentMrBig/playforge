import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { Car } from "./carphysics.js";

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

let world, car, scene, camera, renderer;
let last = performance.now() / 1000;
let acc = 0;

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

  // ---- the car --------------------------------------------------------
  car = new Car(world, RAPIER, { pos: [0, 3, 0] });
  scene.add(car.mesh);

  buildHUD();

  // debug/verification handle — the agent Browser pane throttles rAF to ~0fps,
  // so headless checks drive the fixed step manually instead of trusting the loop.
  window.__garage = {
    world, car, RAPIER, scene, camera, renderer, frames: 0,
    render() { car.interpolate(1); updateCamera(0.016); renderer.render(scene, camera); },
    step(n = 1) { for (let i = 0; i < n; i++) { car.snapshotPrev(); car.fixedUpdate(FIXED); world.step(); car.snapshotCurr(); } return car.height; },
    wheels() { return car.wheels.map((w) => ({ n: w.name, grounded: w.grounded, comp: +w.comp.toFixed(3), dist: +w.dist.toFixed(3) })); },
    state() { const t = car.body.translation(), v = car.body.linvel();
      return { y: t.y, x: t.x, z: t.z, speed: Math.hypot(v.x, v.y, v.z) * 3.6, frames: window.__garage.frames }; },
  };

  addEventListener("resize", onResize);
  addEventListener("keydown", (e) => {
    if (e.code === "KeyR") car.reset();
    if (e.code === "KeyT") car.reset(12);   // big drop — hard-landing settle test
  });

  requestAnimationFrame(frame);
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

  let steps = 0;
  while (acc >= FIXED && steps < MAX_SUBSTEPS) {
    car.snapshotPrev();
    car.fixedUpdate(FIXED);     // suspension forces BEFORE the solve
    world.step();
    car.snapshotCurr();
    acc -= FIXED;
    steps++;
  }
  if (steps === MAX_SUBSTEPS) acc = 0;  // shed backlog rather than lurch
  ft.sub = steps;

  const alpha = acc / FIXED;            // leftover fraction → smooth interpolation
  car.interpolate(alpha);

  updateCamera(dt);
  updateHUD();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

const _camTarget = new THREE.Vector3();
const _camDesired = new THREE.Vector3();
function updateCamera(dt) {
  // chase from behind (-Z) and above, looking at the car
  _camTarget.copy(car.mesh.position);
  _camDesired.set(_camTarget.x, _camTarget.y + 5, _camTarget.z - 11);
  camera.position.lerp(_camDesired, 1 - Math.pow(0.0001, dt));
  camera.lookAt(_camTarget.x, _camTarget.y + 0.6, _camTarget.z);
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
    <h1>THE GARAGE · STAGE 1</h1>
    <div class="row"><span>fps</span><b id="h-fps">–</b></div>
    <div class="row"><span>frame ms</span><b id="h-ms">–</b></div>
    <div class="row"><span>2s peak ms</span><b id="h-peak">–</b></div>
    <div class="row"><span>substeps/frame</span><b id="h-sub">–</b></div>
    <div class="row"><span>car height</span><b id="h-y">–</b></div>
    <div class="row"><span>speed</span><b id="h-kmh">–</b></div>
    <div class="row"><span>wheels grounded</span><b id="h-wg">–</b></div>
    <label>spring stiffness <span class="val" id="v-k">30000</span></label>
    <input id="s-k" type="range" min="5000" max="80000" step="500" value="30000">
    <label>spring damping <span class="val" id="v-d">4000</span></label>
    <input id="s-d" type="range" min="0" max="12000" step="100" value="4000">
    <label>rest length <span class="val" id="v-rest">0.50</span></label>
    <input id="s-rest" type="range" min="0.2" max="0.9" step="0.01" value="0.50">
    <label>angular damping <span class="val" id="v-ang">0.40</span></label>
    <input id="s-ang" type="range" min="0" max="4" step="0.01" value="0.40">
    <canvas id="ftg" width="216" height="46"></canvas>
    <div class="hint">[R] drop &nbsp; [T] hard drop (12m)</div>
    <div class="stamp">build ${typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev"}</div>`;
  document.body.appendChild(hud);

  bindSlider("s-k", "v-k", (v) => { car.suspStiff = v; }, 0);
  bindSlider("s-d", "v-d", (v) => { car.suspDamp = v; }, 0);
  bindSlider("s-rest", "v-rest", (v) => { car.suspRest = v; });
  bindSlider("s-ang", "v-ang", (v) => car.setAngularDamping(v));

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
