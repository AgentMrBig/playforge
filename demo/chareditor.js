// PLAYFORGE — Character / Ragdoll Editor
//
// The tuning bench for everything CHARACTER + RAGDOLL. Same philosophy as the
// Ragdoll Lab and the car Garage (isolated scene, ZERO game code, everything
// measurable + live-tunable) but built out into an actual editor:
//
//   • ANIMATION — browse every loaded clip, PLAY it, or SCRUB its timeline frame
//     by frame; speed + loop dials.
//   • BONES — inspect any bone's live local rotation; POSE mode freezes the
//     animator and lets you rotate the selected bone by hand (X/Y/Z sliders).
//   • RAGDOLL — trigger it every way it fires in-game (drop / punch / launch /
//     trip / clothesline) + muscle mode, and watch it settle + get up.
//   • TUNE — live sliders for every ragdoll dial (tone, assist, the ROM soft-limit
//     spring/damp/margin, limp ramp, settle thresholds) so the get-up + fall feel
//     can be dialled in with Erik watching, then baked as new defaults.
//   • MEASURE — live readouts: state, settle time, CORE vs whole-body max speed,
//     joints past ROM / hyperextended, self-collision overlaps.
//
// Own fixed-timestep loop (like garage.js) so slow-mo / pause / single-step are
// trivial and the ragdoll renders smooth between steps. Headless handle:
//   window.__ed = { rag, animator, bones, triggers, metrics(), stepPhysics(dt),
//                   scrubTo(clip,t), playClip(name), setPoseMode(b) }
// (a hidden browser pane throttles rAF → drive stepPhysics manually in tests.)
import {
  Engine, World, OrbitRig, Physics, initRapier, Ragdoll, loadCharacter, THREE,
} from "../src/index.js";
import { attachRagdollMouse } from "./ragdollmouse.js";

const FIXED = 1 / 60;
const MAX_SUBSTEPS = 5;

const engine = new Engine(document.getElementById("game"), { clearColor: 0x171c24 });
const world = new World();
engine.world = world;
const scene = world.scene;

// ---- lights + a readable ground grid ----------------------------------------
scene.add(new THREE.HemisphereLight(0x9db4c8, 0x2a2620, 0.9));
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
  new THREE.MeshStandardMaterial({ color: 0x2f363e, roughness: 0.96 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(80, 80, 0x556070, 0x2a3138);
grid.position.y = 0.01;
scene.add(grid);

// ---- camera: orbit that follows the body ------------------------------------
const cam = new OrbitRig({ target: [0, 1.0, 0], distance: 5.5, pitch: 0.25 });
world.spawn("camera").add(cam);

// ---- physics + character + ragdoll ------------------------------------------
const phys = new Physics({ gravity: -20 });
let rag = null, animator = null, bones = null, charVisual = null;
let state = "anim";               // anim | ragdoll | getup | pose | stagger
let getupTimer = 0;
let staggerTimer = 0;             // >0 while braced-staggering after a light hit
let poseMode = false;             // freeze the animator and hand-pose bones
const TONE0 = 1.9;

// every clip in the character anim pack — the editor browses ALL of them
const ANIMS = [
  ["idle", "idle.fbx"], ["walk", "walking.fbx"], ["run", "running.fbx"],
  ["jump", "jumping up.fbx"], ["fallIdle", "falling idle.fbx"], ["hardLanding", "hard landing.fbx"],
  ["getupBack", "getup_back.fbx"], ["getupFront", "getup_front.fbx"],
  ["crouchToStand", "crouch_to_stand.fbx"], ["standToCrouch", "stand_to_crouch.fbx"],
  ["crouchWalk", "crouch_walk.fbx"],
  ["pistolIdle", "pistol_idle.fbx"], ["rifleIdle", "rifle_idle.fbx"], ["firingRifle", "firing_rifle.fbx"],
  ["frontflip", "frontflip.fbx"], ["frontflipTwist", "frontflip_twist.fbx"],
];

const physReady = initRapier().then(() => {
  world.spawn("physics").add(phys);
  phys.addGroundPlane(0);
});

Promise.all([physReady, loadCharacter("models/character/humanoid_male.fbx", {
  textureDir: "models/character", texture: "base_texture.png", targetHeight: 1.8,
  animations: ANIMS.map(([name, file]) => ({ name, url: `models/character/anims/${file}` })),
})]).then(([, ch]) => {
  charVisual = ch.visual;
  animator = ch.animator;
  bones = ch.bones;
  scene.add(ch.visual);
  ch.visual.position.set(0, 0, 0);
  animator.play("idle");
  rag = new Ragdoll(bones, phys, { tone: TONE0 });
  rag.build();                      // pre-build capsules (disabled) so right-click can pick them

  // the driver: physics ragdoll ⇄ animation, with a natural get-up on settle.
  // (Do NOT assign to __ed.rag — it's a live getter; assigning throws in strict
  // ESM and would abort the rest of this callback. That exact bug had the Ragdoll
  // Lab spawning no driver → the ragdoll ran fully passive.)
  world.spawn("edctl").add({
    fixedUpdate(dt) {
      if (state === "getup") {
        getupTimer -= dt;
        if (getupTimer <= 0) { state = "anim"; animator.play("idle", { fade: 0.3 }); }
        return;
      }
      if (state === "stagger") {                       // braced hit — sways, stays up, recovers
        rag.fixedUpdate(dt);
        staggerTimer -= dt;
        if (staggerTimer <= 0) { rag.exitMuscle(); state = "anim"; charVisual.position.set(0, 0, 0); charVisual.rotation.set(0, 0, 0); animator.play("idle", { fade: 0.25 }); }
        return;
      }
      if (state === "ragdoll" && rag.active) {
        rag.fixedUpdate(dt);
        if (rag.muscle) return;
        if (autoGetup && rag.settled(1.3)) beginGetup();
      }
    },
    update(dt) {
      if (animator && !poseMode && (state === "anim" || state === "getup")) animator.update(dt);
      if (rag && rag.active) rag.update();
      const p = rag && rag.active ? rag.pelvisPos() : charVisual.position;
      cam.target.set(p.x, Math.max(0.6, p.y + (rag && rag.active ? 0.3 : 1.0)), p.z);
      updateHUD();
      updateScrubReadout();
    },
  });

  buildBoneUI();
  refreshClipButtons();

  // ---- direct mouse interaction: right-click punch / right-drag grab ---------
  attachRagdollMouse({
    canvas: engine.renderer.domElement,
    getCamera: () => world.camera || engine.camera,
    getRag: () => rag,
    getPhys: () => phys,
    ensureActive: () => {
      if (!rag) return null;
      poseMode = false;
      if (rag.muscle) rag.exitMuscle();
      if (state !== "ragdoll") { state = "ragdoll"; if (!rag.active) rag.enter(); }
      return rag;
    },
    onPunch: (segName, point, impulse, power) => {
      if (!rag) return;
      poseMode = false;
      if (power >= rag.knockdownImpulse) {
        if (rag.muscle) rag.exitMuscle();
        if (state !== "ragdoll") { state = "ragdoll"; if (!rag.active) rag.enter(); }
        staggerTimer = 0;
        rag.hit(point, impulse, { maxDeltaV: 16 });
      } else {
        if (state !== "stagger") {
          if (rag.active && !rag.muscle) rag.exit();
          state = "stagger"; rag.enterMuscle(rag.tone);
        }
        rag.hit(point, impulse, { maxDeltaV: 12 });
        staggerTimer = 1.0;
      }
    },
  });

  setStatus("ready — RIGHT-CLICK to punch · SHIFT+right = hard · drag to grab · or use the panels");
}).catch((e) => setStatus("LOAD FAILED: " + e.message));

// ---- get-up: settle → snap character to where it lies → play a getup clip ----
let autoGetup = true;
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

// ---- animation browse + scrub -----------------------------------------------
let activeClip = "idle";
function playClip(name) {
  if (!animator || !animator.clips[name]) return;
  poseMode = false; state = "anim"; getupTimer = 0;
  if (rag && rag.active) { if (rag.muscle) rag.exitMuscle(); else rag.exit(); }
  charVisual.position.set(0, 0, 0); charVisual.rotation.set(0, 0, 0);
  const a = animator.actions[name];
  a.paused = false;
  animator.play(name, { fade: 0.15, loop: !clipOnce });
  activeClip = name;
  highlightClip(name);
}
// scrub: freeze on one clip, drive its time from the slider (0..1 of duration)
function scrubTo(name, frac) {
  if (!animator || !animator.clips[name]) return;
  poseMode = false; state = "anim";
  if (rag && rag.active) { if (rag.muscle) rag.exitMuscle(); else rag.exit(); }
  for (const k in animator.actions) {
    const a = animator.actions[k];
    a.enabled = (k === name); a.weight = (k === name ? 1 : 0);
  }
  const a = animator.actions[name];
  a.reset(); a.play(); a.paused = true;
  a.time = frac * animator.clips[name].duration;
  animator.mixer.update(0);
  animator.current = name; activeClip = name;
  highlightClip(name);
}
let clipOnce = false;
let clipSpeed = 1;

// ---- triggers (mirror the ways the ragdoll fires in-game) -------------------
const V = (x, y, z) => new THREE.Vector3(x, y, z);
function ensureRag() {
  if (!rag) return false;
  poseMode = false;
  if (state !== "ragdoll") { state = "ragdoll"; rag.enter(); }
  return true;
}
const chestPoint = () => { const p = rag.segPos("chest") || rag.pelvisPos(); return { x: p.x, y: p.y, z: p.z }; };

const triggers = {
  drop() { if (!rag) return; poseMode = false; state = "ragdoll"; rag.enter(V(0, 0, 0)); rag.shove({ x: 0, y: 0.1, z: -1 }, 3, "chest"); },
  punch() { if (!ensureRag()) return; rag.hit(chestPoint(), V(6, 2, 0).multiplyScalar(60), { maxDeltaV: 14, soften: 0.4 }); },
  launch() { if (!rag) return; poseMode = false; state = "ragdoll"; rag.enter(V(0, 9, 0)); rag.shove({ x: 0.3, y: 1, z: 0.2 }, 10, "pelvis"); },
  trip() { if (!ensureRag()) return; rag.trip({ x: 1, y: 0, z: 0 }, 6, Math.random() < 0.5 ? "L" : "R"); },
  clothesline() { if (!ensureRag()) return; rag.clothesline({ x: 1, y: 0, z: 0 }, 9); },
  muscle() {
    if (!rag) return;
    poseMode = false;
    if (rag.muscle) { rag.exitMuscle(); state = "anim"; animator.play("idle", { fade: 0.3 }); }
    else { state = "ragdoll"; rag.enterMuscle(rag.tone); }
  },
  getup() { if (rag && rag.active && !rag.muscle) beginGetup(); },
  reset() {
    if (!rag) return;
    poseMode = false;
    if (rag.muscle) rag.exitMuscle();
    if (rag.active) rag.exit();
    state = "anim"; getupTimer = 0;
    charVisual.position.set(0, 0, 0); charVisual.rotation.set(0, 0, 0);
    animator.play("idle", { fade: 0.2 });
  },
};

// ---- input: keys ------------------------------------------------------------
const KEYMAP = {
  KeyD: "drop", KeyH: "punch", KeyL: "launch", KeyT: "trip",
  KeyC: "clothesline", KeyM: "muscle", KeyG: "getup", KeyR: "reset",
};
addEventListener("keydown", (e) => {
  if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
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

// ---- fixed-timestep loop ----------------------------------------------------
let last = performance.now() / 1000, acc = 0, fps = 60, fpsT = 0, fpsN = 0;
function stepPhysics(dt) { world._fixedUpdate(dt, engine); }
function renderFrame() {
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
  renderFrame();
  engine.input.endFrame();   // zero pointer deltas each frame (own loop, no engine reset)
                             // — without this OrbitRig re-applies stale mouse deltas (camera "on overdrive")
}
requestAnimationFrame(frame);
function fitViewport() {
  engine.renderer.setSize(innerWidth, innerHeight, false);
  world.camera.aspect = innerWidth / innerHeight;
  world.camera.updateProjectionMatrix();
}
fitViewport();
addEventListener("resize", fitViewport);

// ---- metrics ----------------------------------------------------------------
function setStatus(t) { const el = document.getElementById("status"); if (el) el.textContent = t; }
function metrics() {
  if (!rag || !rag.active) return null;
  let maxV = 0, coreV = 0;
  const CORE = new Set(["pelvis", "chest", "head", "thighL", "thighR"]);
  for (const s of rag.segments) {
    const v = s.body.linvel(), w = s.body.angvel();
    const m = Math.max(Math.hypot(v.x, v.y, v.z), Math.hypot(w.x, w.y, w.z));
    maxV = Math.max(maxV, m);
    if (CORE.has(s.name)) coreV = Math.max(coreV, m);
  }
  // joints past their ROM cone (soft-limited spherical / softHinge only)
  let over = 0, hyper = 0;
  for (const L of rag._joints) {
    if (L.type === "revolute" && !L.softHinge) continue;
    const qp = L.p.body.rotation(), qc = L.c.body.rotation();
    const pQ = new THREE.Quaternion(qp.x, qp.y, qp.z, qp.w);
    const rel = pQ.clone().invert().multiply(new THREE.Quaternion(qc.x, qc.y, qc.z, qc.w));
    const err = new THREE.Quaternion().copy(L.rel0).invert().multiply(rel);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(err.w)));
    const o = ang - (L.limit ?? 1.2);
    if (o > 0.05) over++;
    if (o > (rag.romHyper ?? 0.45)) hyper++;
  }
  // self-collision: non-adjacent segment pairs interpenetrating
  const adj = new Set();
  for (const L of rag._joints) { adj.add(L.p.name + "|" + L.c.name); adj.add(L.c.name + "|" + L.p.name); }
  let overlaps = 0;
  const S = rag.segments;
  for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
    if (adj.has(S[i].name + "|" + S[j].name)) continue;
    const a = S[i].body.translation(), b = S[j].body.translation();
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < (S[i].radius + S[j].radius) * 0.5) overlaps++;
  }
  return { maxV, coreV, over, hyper, overlaps, settleT: rag._settleT || 0 };
}
function updateHUD() {
  const m = metrics();
  const st = document.getElementById("readouts");
  if (!st) return;
  const smLabel = timeScale === 1 ? "1×" : timeScale + "×";
  const line = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  st.innerHTML =
    line("state", rag && rag.muscle ? "MUSCLE" : (poseMode ? "POSE" : state)) +
    line("clip", activeClip) +
    line("time", (paused ? "PAUSED" : smLabel)) +
    line("fps", fps.toFixed(0)) +
    (m ? (
      line("settle", m.settleT.toFixed(2) + "s") +
      line("core max v", m.coreV.toFixed(2)) +
      line("body max v", m.maxV.toFixed(1)) +
      line("joints &gt;ROM", m.over) +
      line("hyperextended", m.hyper) +
      line("self-overlaps", m.overlaps)
    ) : line("settle", "—"));
}

// ---- UI (readouts + clip browser + bones + triggers + tuning) ---------------
let clipBtns = {};
function refreshClipButtons() {
  const wrap = document.getElementById("clips");
  if (!wrap || !animator) return;
  wrap.innerHTML = ""; clipBtns = {};
  for (const name of Object.keys(animator.clips)) {
    const b = document.createElement("div"); b.className = "btn sm"; b.textContent = name;
    b.onclick = () => playClip(name);
    wrap.appendChild(b); clipBtns[name] = b;
  }
  highlightClip(activeClip);
}
function highlightClip(name) {
  for (const [k, b] of Object.entries(clipBtns)) b.classList.toggle("on", k === name);
}
function updateScrubReadout() {
  const el = document.getElementById("scrubval");
  if (!el || !animator) return;
  const a = animator.actions[activeClip];
  const dur = animator.clips[activeClip]?.duration ?? 1;
  if (a && !state.startsWith("rag") && state !== "getup") {
    const frac = dur ? (a.time % dur) / dur : 0;
    el.textContent = `${(a.time % dur).toFixed(2)} / ${dur.toFixed(2)}s`;
    const sc = document.getElementById("scrub");
    if (sc && document.activeElement !== sc && !a.paused) sc.value = frac;
  }
}

// ---- bone inspector + poser -------------------------------------------------
let selectedBone = null;
function buildBoneUI() {
  const sel = document.getElementById("boneSel");
  if (!sel || !bones) return;
  sel.innerHTML = "";
  for (const name of Object.keys(bones).sort()) {
    const o = document.createElement("option"); o.value = name; o.textContent = name; sel.appendChild(o);
  }
  selectedBone = sel.value = "Hips";
  sel.onchange = () => { selectedBone = sel.value; syncBoneSliders(); };
  syncBoneSliders();
}
function setPoseMode(on) {
  poseMode = on;
  if (on) {
    if (rag && rag.active) { if (rag.muscle) rag.exitMuscle(); else rag.exit(); }
    state = "pose";
    charVisual.position.set(0, 0, 0); charVisual.rotation.set(0, 0, 0);
    syncBoneSliders();
  } else { state = "anim"; animator.play(activeClip || "idle", { fade: 0.2 }); }
  const b = document.getElementById("poseToggle");
  if (b) { b.classList.toggle("on", on); b.textContent = on ? "Pose: ON" : "Pose: OFF"; }
}
const boneEuler = { x: 0, y: 0, z: 0 };
function syncBoneSliders() {
  if (!bones || !selectedBone || !bones[selectedBone]) return;
  const e = new THREE.Euler().setFromQuaternion(bones[selectedBone].quaternion, "XYZ");
  boneEuler.x = e.x; boneEuler.y = e.y; boneEuler.z = e.z;
  for (const ax of ["x", "y", "z"]) {
    const s = document.getElementById("bone_" + ax);
    if (s) { s.value = boneEuler[ax]; const o = document.getElementById("bonev_" + ax); if (o) o.textContent = boneEuler[ax].toFixed(2); }
  }
}
function applyBonePose() {
  if (!poseMode || !bones || !selectedBone) return;
  bones[selectedBone].quaternion.setFromEuler(new THREE.Euler(boneEuler.x, boneEuler.y, boneEuler.z, "XYZ"));
}

(function buildUI() {
  const css = document.createElement("style");
  css.textContent = `
    .panel{position:fixed;z-index:20;font:12px/1.4 ui-monospace,monospace;color:#cfe;user-select:none}
    #rightpanel{right:12px;top:10px;display:flex;flex-direction:column;gap:8px;width:200px;max-height:96vh;overflow:auto}
    #leftpanel{left:12px;bottom:34px;display:flex;flex-direction:column;gap:8px;width:236px;max-height:70vh;overflow:auto}
    .card{background:rgba(12,16,20,.86);border:1px solid #2c3a48;border-radius:8px;padding:8px 10px}
    .card h4{margin:0 0 6px;font:600 11px ui-monospace;color:#8fb0c8;letter-spacing:.04em;text-transform:uppercase}
    #readouts div{display:flex;justify-content:space-between}
    #readouts b{color:#ffd479}
    .grid{display:flex;flex-wrap:wrap;gap:6px}
    .btn{flex:1 1 46%;padding:7px 4px;border-radius:6px;border:1px solid #3a4a5a;background:#1c2833;color:#cfe;
      cursor:pointer;text-align:center;font:600 12px ui-monospace}
    .btn:hover{background:#26414f}
    .btn.sm{flex:1 1 46%;font:600 10px ui-monospace;padding:5px 3px}
    .btn.on{background:#2f6b48;border-color:#3f8a5f;color:#eaffef}
    .sld{display:flex;flex-direction:column;gap:5px}
    .sld label{display:flex;justify-content:space-between;color:#9fb4c4}
    .sld label b{color:#ffd479}
    .sld input[type=range]{width:100%}
    select{width:100%;background:#1c2833;color:#cfe;border:1px solid #3a4a5a;border-radius:5px;padding:4px}
    .row{display:flex;gap:6px;align-items:center}
  `;
  document.head.appendChild(css);

  // ---- RIGHT: readouts + triggers + time --------------------------------
  const right = document.createElement("div"); right.className = "panel"; right.id = "rightpanel";
  right.innerHTML = `<div class="card" id="readouts"></div>`;

  const trig = document.createElement("div"); trig.className = "card";
  trig.innerHTML = `<h4>Ragdoll triggers</h4>`;
  const tg = document.createElement("div"); tg.className = "grid";
  for (const [label, fn] of [
    ["Drop (D)", "drop"], ["Punch (H)", "punch"], ["Launch (L)", "launch"], ["Trip (T)", "trip"],
    ["Clothesline (C)", "clothesline"], ["Muscle (M)", "muscle"], ["Get up (G)", "getup"], ["Reset (R)", "reset"],
  ]) {
    const b = document.createElement("div"); b.className = "btn"; b.textContent = label;
    b.onclick = () => triggers[fn]?.(); tg.appendChild(b);
  }
  trig.appendChild(tg);
  const autoRow = document.createElement("div"); autoRow.className = "grid"; autoRow.style.marginTop = "6px";
  const autoB = document.createElement("div"); autoB.className = "btn on"; autoB.textContent = "Auto get-up: ON";
  autoB.onclick = () => { autoGetup = !autoGetup; autoB.classList.toggle("on", autoGetup); autoB.textContent = "Auto get-up: " + (autoGetup ? "ON" : "OFF"); };
  autoRow.appendChild(autoB); trig.appendChild(autoRow);

  const time = document.createElement("div"); time.className = "card";
  time.innerHTML = `<h4>Time</h4>`;
  const tr = document.createElement("div"); tr.className = "grid";
  for (const [label, fn] of [["Pause (P)", togglePause], ["Step (.)", stepOnce], ["Slow-mo (,)", cycleSlowmo]]) {
    const b = document.createElement("div"); b.className = "btn"; b.textContent = label; b.onclick = fn; tr.appendChild(b);
  }
  time.appendChild(tr);
  right.append(trig, time);
  document.body.appendChild(right);

  // ---- LEFT: animation browser + bones + tuning -------------------------
  const left = document.createElement("div"); left.className = "panel"; left.id = "leftpanel";

  // animation card
  const anim = document.createElement("div"); anim.className = "card";
  anim.innerHTML = `<h4>Animation clips</h4><div class="grid" id="clips"></div>`;
  const scrubWrap = document.createElement("div"); scrubWrap.className = "sld"; scrubWrap.style.marginTop = "8px";
  scrubWrap.innerHTML = `<label>scrub <b id="scrubval">–</b></label>`;
  const scrub = document.createElement("input"); scrub.type = "range"; scrub.id = "scrub";
  scrub.min = 0; scrub.max = 1; scrub.step = 0.001; scrub.value = 0;
  scrub.oninput = () => scrubTo(activeClip, +scrub.value);
  scrubWrap.appendChild(scrub);
  const clipRow = document.createElement("div"); clipRow.className = "grid"; clipRow.style.marginTop = "6px";
  const playB = document.createElement("div"); playB.className = "btn"; playB.textContent = "Play"; playB.onclick = () => playClip(activeClip);
  const onceB = document.createElement("div"); onceB.className = "btn"; onceB.textContent = "Loop: ON";
  onceB.onclick = () => { clipOnce = !clipOnce; onceB.textContent = "Loop: " + (clipOnce ? "OFF" : "ON"); onceB.classList.toggle("on", clipOnce); };
  clipRow.append(playB, onceB);
  anim.append(scrubWrap, clipRow);
  // speed slider
  const spd = document.createElement("div"); spd.className = "sld"; spd.style.marginTop = "8px";
  spd.innerHTML = `<label>speed <b id="spdv">1.00</b></label>`;
  const spdI = document.createElement("input"); spdI.type = "range"; spdI.min = 0.1; spdI.max = 3; spdI.step = 0.05; spdI.value = 1;
  spdI.oninput = () => { clipSpeed = +spdI.value; document.getElementById("spdv").textContent = clipSpeed.toFixed(2); if (animator) animator.setSpeed(clipSpeed); };
  spd.appendChild(spdI); anim.appendChild(spd);
  left.appendChild(anim);

  // bones card
  const bone = document.createElement("div"); bone.className = "card";
  bone.innerHTML = `<h4>Bones</h4><select id="boneSel"></select>`;
  const poseRow = document.createElement("div"); poseRow.className = "grid"; poseRow.style.margin = "6px 0";
  const poseB = document.createElement("div"); poseB.className = "btn"; poseB.id = "poseToggle"; poseB.textContent = "Pose: OFF";
  poseB.onclick = () => setPoseMode(!poseMode);
  const resetB = document.createElement("div"); resetB.className = "btn"; resetB.textContent = "T-pose bone";
  resetB.onclick = () => { if (bones && selectedBone) { boneEuler.x = boneEuler.y = boneEuler.z = 0; applyBonePose(); syncBoneSliders(); } };
  poseRow.append(poseB, resetB); bone.appendChild(poseRow);
  for (const ax of ["x", "y", "z"]) {
    const w = document.createElement("div"); w.className = "sld";
    w.innerHTML = `<label>rot ${ax.toUpperCase()} <b id="bonev_${ax}">0.00</b></label>`;
    const i = document.createElement("input"); i.type = "range"; i.id = "bone_" + ax;
    i.min = -Math.PI; i.max = Math.PI; i.step = 0.01; i.value = 0;
    i.oninput = () => { boneEuler[ax] = +i.value; document.getElementById("bonev_" + ax).textContent = boneEuler[ax].toFixed(2); applyBonePose(); };
    w.appendChild(i); bone.appendChild(w);
  }
  left.appendChild(bone);

  // tuning card — live ragdoll dials
  const tune = document.createElement("div"); tune.className = "card";
  tune.innerHTML = `<h4>Ragdoll tuning</h4>`;
  const mkSlider = (name, min, max, step, get, set) => {
    const w = document.createElement("div"); w.className = "sld";
    const startV = get();
    w.innerHTML = `<label>${name} <b>${(+startV).toFixed(2)}</b></label>`;
    const out = w.querySelector("b");
    const i = document.createElement("input"); i.type = "range"; i.min = min; i.max = max; i.step = step; i.value = startV;
    i.oninput = () => { const v = +i.value; out.textContent = v.toFixed(2); set(v); };
    w.appendChild(i); tune.appendChild(w);
  };
  const R = () => rag;
  mkSlider("tone", 0, 4, 0.05, () => R() ? R().tone : TONE0, (v) => { if (R()) R().tone = v; });
  mkSlider("assist", 0, 1, 0.05, () => R() ? R().assist : 0.85, (v) => { if (R()) R().assist = v; });
  mkSlider("limpFloor", 0, 1, 0.02, () => R() ? R().limpFloor : 0, (v) => { if (R()) R().limpFloor = v; });
  mkSlider("limpTime", 0.05, 2, 0.05, () => R() ? R().limpTime : 0.55, (v) => { if (R()) R().limpTime = v; });
  mkSlider("romSpring", 0, 300, 5, () => R() ? R().romSpring : 45, (v) => { if (R()) R().romSpring = v; });
  mkSlider("romDamp", 0, 40, 1, () => R() ? R().romDamp : 8, (v) => { if (R()) R().romDamp = v; });
  mkSlider("romMargin", 0, 0.4, 0.01, () => R() ? R().romMargin : 0.12, (v) => { if (R()) R().romMargin = v; });
  mkSlider("romMaxTorque", 20, 400, 10, () => R() ? R().romMaxTorque : 140, (v) => { if (R()) R().romMaxTorque = v; });
  mkSlider("settleLinV", 0.1, 1.5, 0.05, () => R() ? R().settleLinV : 0.4, (v) => { if (R()) R().settleLinV = v; });
  mkSlider("settleAngV", 0.5, 5, 0.1, () => R() ? R().settleAngV : 1.6, (v) => { if (R()) R().settleAngV = v; });
  left.appendChild(tune);

  document.body.appendChild(left);
})();

// ---- headless verification handle ------------------------------------------
window.__ed = {
  engine, world, phys,
  get rag() { return rag; }, get animator() { return animator; }, get bones() { return bones; },
  get state() { return state; },
  triggers, metrics, stepPhysics, scrubTo, playClip,
  setPoseMode, setTimeScale: (v) => { timeScale = v; },
};
