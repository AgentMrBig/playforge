// PLAYFORGE — Ragdoll Lab (proving ground)
//
// The ragdoll equivalent of the car Garage (proving.html/garage.js): a stripped
// scene — flat ground, one character, ZERO game code — so the ACTIVE RAGDOLL is
// measurable and tunable in isolation. Build it here, prove it, then merge into
// the game (same path the car system took).
//
// What it gives you:
//   • trigger the ragdoll every way it happens in-game (drop, punch, launch,
//     trip, clothesline) + muscle mode (tries to hold the mocap pose / stand)
//   • SEE it: orbit camera that follows the body, slow-mo + pause + single-step
//   • MEASURE it: live readouts (state, settle time, max limb speed, joints past
//     their ROM limit, self-collision overlaps)
//   • TUNE it live: muscle tone + gravity-assist sliders, natural get-up on settle
//
// Own fixed-timestep loop (like garage.js) so slow-mo/pause/step are trivial and
// the ragdoll renders smooth between steps.
import {
  Engine, World, OrbitRig, Physics, initRapier, Ragdoll, loadCharacter, THREE,
} from "../src/index.js";

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

// ---- camera: orbit that follows the body ------------------------------------
const cam = new OrbitRig({ target: [0, 1.0, 0], distance: 5.5, pitch: 0.25 });
world.spawn("camera").add(cam);

// ---- physics + character + ragdoll ------------------------------------------
const phys = new Physics({ gravity: -20 });
let rag = null, animator = null, bones = null, charVisual = null;
let state = "anim";               // anim | ragdoll | getup
let getupTimer = 0;
const TONE0 = 1.9;

const physReady = initRapier().then(() => {
  world.spawn("physics").add(phys);
  phys.addGroundPlane(0);         // the Rapier floor the ragdoll lands on
});

Promise.all([physReady, loadCharacter("models/character/humanoid_male.fbx", {
  textureDir: "models/character", texture: "base_texture.png", targetHeight: 1.8,
  animations: [
    { name: "idle", url: "models/character/anims/idle.fbx" },
    { name: "walk", url: "models/character/anims/walking.fbx" },
    { name: "getupBack", url: "models/character/anims/getup_back.fbx" },
    { name: "getupFront", url: "models/character/anims/getup_front.fbx" },
  ],
})]).then(([, ch]) => {
  charVisual = ch.visual;
  animator = ch.animator;
  bones = ch.bones;
  scene.add(ch.visual);
  ch.visual.position.set(0, 0, 0);
  animator.play("idle");
  rag = new Ragdoll(bones, phys, { tone: TONE0 });
  window.__lab.rag = rag;

  // the driver: physics ragdoll ⇄ animation, with a natural get-up on settle
  world.spawn("ragctl").add({
    fixedUpdate(dt) {
      if (state === "getup") {
        getupTimer -= dt;
        if (getupTimer <= 0) { state = "anim"; animator.play("idle", { fade: 0.3 }); }
        return;
      }
      if (state === "ragdoll" && rag.active) {
        rag.fixedUpdate(dt);
        if (rag.muscle) return;                       // muscle mode: no settle/get-up
        if (rag.settled(1.3)) beginGetup();
      }
    },
    update(dt) {
      if (animator && (state === "anim" || state === "getup")) animator.update(dt);
      if (rag && rag.active) rag.update();            // physics bodies → visual bones
      // camera follows the body (pelvis when down, character when up)
      const p = rag && rag.active ? rag.pelvisPos() : charVisual.position;
      cam.target.set(p.x, Math.max(0.6, p.y + (rag && rag.active ? 0.3 : 1.0)), p.z);
      updateHUD();
    },
  });

  setStatus("ready — press a trigger (or the buttons)");
}).catch((e) => setStatus("LOAD FAILED: " + e.message));

// ---- get-up: settle → snap character to where it lies → play a getup clip ----
function beginGetup() {
  const o = rag.groundOrientation();
  const p = rag.pelvisPos();
  rag.exit();
  charVisual.position.set(p.x, 0, p.z);
  charVisual.rotation.y = o.yaw;
  const clip = o.faceUp ? "getupBack" : "getupFront";
  const dur = animator.clips[clip]?.duration ?? 1.6;
  const speed = Math.min(2.4, Math.max(1, dur / 2.0));
  animator.play(clip, { fade: 0.1, once: true, speed });
  getupTimer = (dur / speed) * 0.95;
  state = "getup";
}

// ---- triggers (mirror the ways the ragdoll fires in-game) -------------------
const V = (x, y, z) => new THREE.Vector3(x, y, z);
function ensureRag() {
  if (!rag) return false;
  if (state !== "ragdoll") { state = "ragdoll"; rag.enter(); }
  return true;
}
const chestPoint = () => { const p = rag.segPos("chest") || rag.pelvisPos(); return { x: p.x, y: p.y, z: p.z }; };

const triggers = {
  drop() { if (!rag) return; state = "ragdoll"; rag.enter(V(0, 0, 0)); rag.shove({ x: 0, y: 0.1, z: -1 }, 3, "chest"); },
  punch() { if (!ensureRag()) return; rag.hit(chestPoint(), V(6, 2, 0).multiplyScalar(60), { maxDeltaV: 14, soften: 0.4 }); },
  launch() { if (!rag) return; state = "ragdoll"; rag.enter(V(0, 9, 0)); rag.shove({ x: 0.3, y: 1, z: 0.2 }, 10, "pelvis"); },
  trip() { if (!ensureRag()) return; rag.trip({ x: 1, y: 0, z: 0 }, 6, Math.random() < 0.5 ? "L" : "R"); },
  clothesline() { if (!ensureRag()) return; rag.clothesline({ x: 1, y: 0, z: 0 }, 9); },
  muscle() {
    if (!rag) return;
    if (rag.muscle) { rag.exitMuscle(); state = "anim"; animator.play("idle", { fade: 0.3 }); }
    else { state = "ragdoll"; rag.enterMuscle(rag.tone); }
  },
  getup() { if (rag && rag.active && !rag.muscle) beginGetup(); },
  reset() {
    if (!rag) return;
    if (rag.muscle) rag.exitMuscle();
    if (rag.active) rag.exit();
    state = "anim"; getupTimer = 0;
    charVisual.position.set(0, 0, 0); charVisual.rotation.set(0, 0, 0);
    animator.play("idle", { fade: 0.2 });
  },
};

// ---- input: keys + on-screen buttons ----------------------------------------
const KEYMAP = {
  KeyD: "drop", KeyH: "punch", KeyL: "launch", KeyT: "trip",
  KeyC: "clothesline", KeyM: "muscle", KeyG: "getup", KeyR: "reset",
};
addEventListener("keydown", (e) => {
  if (KEYMAP[e.code]) { triggers[KEYMAP[e.code]](); e.preventDefault(); return; }
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
  if (!rag || !rag.active) return null;
  let maxV = 0;
  for (const s of rag.segments) {
    const v = s.body.linvel(), w = s.body.angvel();
    maxV = Math.max(maxV, Math.hypot(v.x, v.y, v.z), Math.hypot(w.x, w.y, w.z));
  }
  // joints past their ROM limit (soft-limited spherical only — hinges are hard)
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
  // self-collision sanity: non-adjacent segment pairs interpenetrating
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
  const m = metrics();
  const st = document.getElementById("readouts");
  if (!st) return;
  const smLabel = timeScale === 1 ? "1×" : timeScale + "×";
  const line = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  st.innerHTML =
    line("state", rag && rag.muscle ? "MUSCLE" : state) +
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
    ["Drop (D)", "drop"], ["Punch (H)", "punch"], ["Launch (L)", "launch"], ["Trip (T)", "trip"],
    ["Clothesline (C)", "clothesline"], ["Muscle (M)", "muscle"], ["Get up (G)", "getup"], ["Reset (R)", "reset"],
  ];
  for (const [label, fn] of btns) {
    const b = document.createElement("div"); b.className = "btn"; b.textContent = label;
    b.onclick = () => triggers[fn]?.();
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
  mkSlider("tone", 0, 4, TONE0, 0.05, (v) => { if (rag) rag.tone = v; });
  mkSlider("assist", 0, 1, 0.85, 0.05, (v) => { if (rag) rag.assist = v; });
  panel.append(grp, timeRow, sld);
  document.body.appendChild(panel);
})();

// ---- headless verification handle ------------------------------------------
window.__lab = {
  engine, world, phys, get rag() { return rag; }, get state() { return state; },
  triggers, metrics, stepPhysics, setTimeScale: (v) => { timeScale = v; },
};
