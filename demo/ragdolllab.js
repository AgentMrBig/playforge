// PLAYFORGE — Ragdoll Lab (proving ground)
//
// The ragdoll equivalent of the car Garage: a stripped scene so the ACTIVE
// RAGDOLL is measurable and tunable in isolation — now with the reusable MAIN
// CHARACTER CONTROLLER dropped in, so you WALK the guy around (WASD, Shift run,
// Space jump, third-person camera) and trigger the ragdoll while moving, the same
// controller the game uses. Build it here, prove it, merge it into the game.
//
//   • WALK around (WASD / Shift run / Space jump), third-person orbit camera
//   • trigger the ragdoll every way it happens in-game (drop, punch, launch,
//     trip, clothesline) + muscle mode + a braced STAGGER (light hit → tries to
//     stay up) — the seam the gradient blend rig grows from
//   • RIGHT-CLICK to punch, right-drag to grab
//   • SEE it: camera follows the body · slow-mo + pause + single-step
//   • MEASURE it: live readouts (state, settle time, max limb speed, ROM, overlaps)
//   • TUNE it live: muscle tone + gravity-assist sliders
//
// Own fixed-timestep loop (like garage.js) so slow-mo/pause/step are trivial.
import {
  Engine, World, Physics, initRapier, createCharacterController, THREE,
} from "../src/index.js";
import { attachRagdollMouse } from "./ragdollmouse.js";

const FIXED = 1 / 60;
const MAX_SUBSTEPS = 5;

const engine = new Engine(document.getElementById("game"), { clearColor: 0x1a2029 });
const world = new World();
engine.world = world;
const scene = world.scene;

// ---- lights + a readable ground grid ----------------------------------------
scene.add(new THREE.HemisphereLight(0x9db4c8, 0x2a2620, 0.85));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.5);
sun.position.set(8, 16, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, far: 50 });
scene.add(sun);
engine.renderer.shadowMap.enabled = true;
engine.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 80),
  new THREE.MeshStandardMaterial({ color: 0x333a42, roughness: 0.96 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(80, 80, 0x556070, 0x2c333b);
grid.position.y = 0.01;
scene.add(grid);

// ---- physics + the reusable character controller (walk + ragdoll) -----------
const phys = new Physics({ gravity: -20 });
const TONE0 = 1.9;
let ch = null;                    // the character controller handle
const state = () => (ch ? ch.state : "anim");
const getRag = () => (ch ? ch.rag : null);

// ---- Phase 2b obstacle course: uneven geometry to test weight-bearing foot IK ---
// steps (climb), a platform (step up onto), a shallow stair "ramp" (walk up a slope),
// and low trip-boxes (feet conform / stumble over). Each = a static box collider + mesh.
function buildObstacles() {
  const matStep = new THREE.MeshStandardMaterial({ color: 0x4a5560, roughness: 0.9 });
  const matTrip = new THREE.MeshStandardMaterial({ color: 0x6a5540, roughness: 0.95 });
  const box = (w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; scene.add(m);
    phys.addBox([w / 2, h / 2, d / 2], [x, y, z], { friction: 1.0 });
  };
  // staircase (climb) — 4 steps, +X
  for (let i = 0; i < 4; i++) box(3, 0.22 * (i + 1), 0.6, 7, 0.11 * (i + 1), -3 + i * 0.6, matStep);
  // a low platform to step onto, -X
  box(3, 0.5, 3, -7, 0.25, 0, matStep);
  // shallow "ramp" made of thin rising steps (walk up a slope), +Z
  for (let i = 0; i < 8; i++) box(3, 0.09 * (i + 1), 0.7, 0, 0.045 * (i + 1), 7 + i * 0.7, matStep);
  // scattered low trip-boxes near spawn (feet conform / stumble)
  const trips = [[2.5, 0.15, 2], [-2, 0.12, 3], [3, 0.18, -1.5], [-3, 0.15, -3], [1.5, 0.1, 4.5]];
  for (const [x, h, z] of trips) box(0.9, h, 0.9, x, h / 2, z, matTrip);
}

initRapier().then(() => {
  world.spawn("physics").add(phys);
  phys.addGroundPlane(0);         // the Rapier floor the capsule + ragdoll land on
  buildObstacles();
  ch = createCharacterController(world, {
    scene, phys, camera: true, dragOrbit: true, spawn: [0, 0, 0], tone: TONE0, fly: false,
  });
  ch.ready.then(() => {
    // ---- direct mouse interaction: right-click punch / right-drag grab -------
    attachRagdollMouse({
      canvas: engine.renderer.domElement,
      getCamera: () => world.camera || engine.camera,
      getRag: () => ch.rag,
      getPhys: () => phys,
      ensureActive: () => {                              // grab needs a live free ragdoll
        if (!ch.rag) return null;
        if (ch.rag.muscle) ch.rag.exitMuscle();
        if (ch.state !== "ragdoll") ch.goRagdoll();
        return ch.rag;
      },
      onPunch: (segName, point, impulse, power) => ch.hit(point, impulse, power),
    });
    setStatus("WALK: WASD · Shift run · Space jump — trigger buttons/keys, or RIGHT-CLICK to punch · SHIFT+right-click = hard · drag to grab");
  }).catch((e) => setStatus("LOAD FAILED: " + e.message));
});

// ---- triggers → the controller ----------------------------------------------
const fire = (name) => { if (ch && ch.triggers[name]) ch.triggers[name](); };

// ---- input: keys + on-screen buttons ----------------------------------------
const KEYMAP = {
  KeyH: "punch", KeyL: "launch", KeyT: "trip",
  KeyM: "muscle", KeyG: "getup", KeyR: "reset",
};
// NB: WASD/Shift/Space are consumed by the walk controller; Q triggers "drop"
// (D/C are walk keys now — was Drop/Clothesline). Buttons still cover everything.
const KEYMAP2 = { KeyQ: "drop", KeyX: "clothesline" };
addEventListener("keydown", (e) => {
  if (KEYMAP[e.code]) { fire(KEYMAP[e.code]); e.preventDefault(); return; }
  if (KEYMAP2[e.code]) { fire(KEYMAP2[e.code]); e.preventDefault(); return; }
  if (e.code === "KeyP") togglePause();
  else if (e.code === "Period") stepOnce();
  else if (e.code === "Comma") cycleSlowmo();
});

// ---- slow-mo / pause / single-step -----------------------------------------
let timeScale = 1, paused = false;
const SLOWMO = [1, 0.35, 0.12];
let slowIdx = 0;
function cycleSlowmo() { slowIdx = (slowIdx + 1) % SLOWMO.length; timeScale = SLOWMO[slowIdx]; }
function togglePause() { paused = !paused; }
function stepOnce() { stepPhysics(FIXED); renderFrame(1); }

// ---- fixed-timestep loop (own loop → slow-mo/pause are trivial) --------------
let last = performance.now() / 1000, acc = 0, fps = 60, fpsT = 0, fpsN = 0;
function stepPhysics(dt) { world._fixedUpdate(dt, engine); }
function renderFrame(alpha) {
  world._update(1 / Math.max(1, fps), engine);
  engine.renderer.render(scene, world.camera || engine.camera);
}
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000;
  let dt = now - last; last = now;
  if (dt > 0.1) dt = 0.1;
  fpsT += dt; fpsN++;
  if (fpsT > 0.5) { fps = fpsN / fpsT; fpsT = 0; fpsN = 0; }
  if (!paused) {
    acc += dt * timeScale;
    let steps = 0;
    while (acc >= FIXED && steps < MAX_SUBSTEPS) { stepPhysics(FIXED); acc -= FIXED; steps++; }
    if (steps === MAX_SUBSTEPS) acc = 0;
  }
  renderFrame(acc / FIXED);
  updateHUD();
  engine.input.endFrame();   // zero pointer dx/dy/wheel + per-frame pressed — our own
                             // loop doesn't get the Engine's end-of-frame reset
}
requestAnimationFrame(frame);
function fitViewport() {
  engine.renderer.setSize(innerWidth, innerHeight, false);
  world.camera.aspect = innerWidth / innerHeight;
  world.camera.updateProjectionMatrix();
}
fitViewport();
addEventListener("resize", fitViewport);

// ---- HUD: live readouts + tuning sliders + trigger buttons ------------------
function setStatus(t) { const el = document.getElementById("status"); if (el) el.textContent = t; }
function metrics() {
  const rag = getRag();
  if (!rag || !rag.active) return null;
  let maxV = 0;
  for (const s of rag.segments) {
    const v = s.body.linvel(), w = s.body.angvel();
    maxV = Math.max(maxV, Math.hypot(v.x, v.y, v.z), Math.hypot(w.x, w.y, w.z));
  }
  let over = 0;
  for (const L of rag._joints) {
    if (L.type === "revolute" && !L.softHinge) continue;
    const qp = L.p.body.rotation(), qc = L.c.body.rotation();
    const pQ = new THREE.Quaternion(qp.x, qp.y, qp.z, qp.w);
    const rel = pQ.clone().invert().multiply(new THREE.Quaternion(qc.x, qc.y, qc.z, qc.w));
    const err = new THREE.Quaternion().copy(L.rel0).invert().multiply(rel);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(err.w)));
    if (ang > (L.limit ?? 1.2) + 0.05) over++;
  }
  const adj = new Set();
  for (const L of rag._joints) { adj.add(L.p.name + "|" + L.c.name); adj.add(L.c.name + "|" + L.p.name); }
  let overlaps = 0;
  const S = rag.segments;
  for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
    if (adj.has(S[i].name + "|" + S[j].name)) continue;
    const a = S[i].body.translation(), b = S[j].body.translation();
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < (S[i].radius + S[j].radius) * 0.5) overlaps++;
  }
  return { maxV, over, overlaps, settleT: rag._settleT || 0 };
}
function updateHUD() {
  const rag = getRag();
  const m = metrics();
  const st = document.getElementById("readouts");
  if (!st) return;
  const smLabel = timeScale === 1 ? "1×" : timeScale + "×";
  const line = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  st.innerHTML =
    line("state", rag && rag.muscle ? "MUSCLE" : state()) +
    line("tone", (rag ? rag.tone : TONE0).toFixed(2)) +
    line("time", (paused ? "PAUSED" : smLabel)) +
    line("fps", fps.toFixed(0)) +
    (m ? (
      line("settle", m.settleT.toFixed(2) + "s") +
      line("max limb v", m.maxV.toFixed(1)) +
      line("joints past ROM", m.over) +
      line("self-overlaps", m.overlaps)
    ) : line("settle", "—"));
}

// build the control panel + sliders once
(function buildUI() {
  const css = document.createElement("style");
  css.textContent = `
    #panel{position:fixed;right:12px;top:10px;z-index:20;display:flex;flex-direction:column;gap:8px;
      font:12px/1.4 ui-monospace,monospace;color:#cfe;user-select:none;width:190px}
    #readouts{background:rgba(12,16,20,.82);border:1px solid #2c3a48;border-radius:8px;padding:8px 10px}
    #readouts div{display:flex;justify-content:space-between}
    #readouts b{color:#ffd479}
    .grp{background:rgba(12,16,20,.82);border:1px solid #2c3a48;border-radius:8px;padding:8px 10px;display:flex;flex-wrap:wrap;gap:6px}
    .btn{flex:1 1 46%;padding:7px 4px;border-radius:6px;border:1px solid #3a4a5a;background:#1c2833;color:#cfe;
      cursor:pointer;text-align:center;font:600 12px ui-monospace,monospace}
    .btn:hover{background:#26414f}
    .sld label{display:flex;justify-content:space-between;color:#9fb4c4}
    .sld input{width:100%}`;
  document.head.appendChild(css);
  const panel = document.createElement("div"); panel.id = "panel";
  panel.innerHTML = `<div id="readouts"></div>`;
  const grp = document.createElement("div"); grp.className = "grp";
  const btns = [
    ["Drop (Q)", "drop"], ["Punch (H)", "punch"], ["Launch (L)", "launch"], ["Trip (T)", "trip"],
    ["Clothesline (X)", "clothesline"], ["Muscle (M)", "muscle"], ["Get up (G)", "getup"], ["Reset (R)", "reset"],
  ];
  for (const [label, fn] of btns) {
    const b = document.createElement("div"); b.className = "btn"; b.textContent = label;
    b.onclick = () => fire(fn);
    grp.appendChild(b);
  }
  const timeRow = document.createElement("div"); timeRow.className = "grp";
  const pauseB = document.createElement("div"); pauseB.className = "btn"; pauseB.textContent = "Pause (P)"; pauseB.onclick = togglePause;
  const stepB = document.createElement("div"); stepB.className = "btn"; stepB.textContent = "Step (.)"; stepB.onclick = stepOnce;
  const slowB = document.createElement("div"); slowB.className = "btn"; slowB.textContent = "Slow-mo (,)"; slowB.onclick = cycleSlowmo;
  timeRow.append(pauseB, stepB, slowB);
  const sld = document.createElement("div"); sld.className = "grp sld";
  const mkSlider = (name, min, max, val, step, oninput) => {
    const wrap = document.createElement("div"); wrap.style.width = "100%";
    const lab = document.createElement("label");
    const span = document.createElement("span"); span.textContent = name;
    const out = document.createElement("b"); out.textContent = (+val).toFixed(2); out.style.color = "#ffd479";
    lab.append(span, out);
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
    inp.oninput = () => { out.textContent = (+inp.value).toFixed(2); oninput(+inp.value); };
    wrap.append(lab, inp); sld.appendChild(wrap);
  };
  mkSlider("tone", 0, 4, TONE0, 0.05, (v) => { const r = getRag(); if (r) r.tone = v; });
  mkSlider("assist", 0, 1, 0.85, 0.05, (v) => { const r = getRag(); if (r) r.assist = v; });
  panel.append(grp, timeRow, sld);
  document.body.appendChild(panel);
})();

// ---- headless verification handle ------------------------------------------
window.__lab = {
  engine, world, phys, get ch() { return ch; }, get rag() { return ch && ch.rag; }, get state() { return state(); },
  fire, metrics, stepPhysics, setTimeScale: (v) => { timeScale = v; },
};
