// PLAYFORGE — STICKMAN (the stripped-down, shippable slice)
//
// A tiny active-ragdoll stickman on a custom Verlet solver — NO Rapier (saves ~2.5 MB).
// Procedural capsule/sphere body = zero art assets. This is the shippable-slice
// foundation for a stickman fighter (YouTube Playables / Poki / CrazyGames): <5 MB,
// interactive in <1 s. Stand via active ragdoll, drag a limb to swing/punch, F to flop.
import * as THREE from "three";
import { Verlet } from "../src/verlet.js";

const FIXED = 1 / 60, MAX_SUBSTEPS = 5;

// ── renderer / scene (side view of the XY plane) ──
const canvas = document.getElementById("game");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11151b);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 1.2, 5.2); camera.lookAt(0, 1.0, 0);

scene.add(new THREE.HemisphereLight(0xbcd6ea, 0x30302a, 1.0));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
sun.position.set(3, 8, 6); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 5, bottom: -1, near: 1, far: 20 });
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 12), new THREE.MeshStandardMaterial({ color: 0x2a3138, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const grid = new THREE.GridHelper(60, 60, 0x3a4652, 0x232a31); scene.add(grid);

// ── build the stickman on the Verlet solver ──
const v = new Verlet({ gravity: -24, iterations: 12, planar: true, groundFriction: 0.5 });
// joint table: [name, x, y, radius, mass]
const J = {
  head:      v.addPoint(0, 1.62, 0, { r: 0.13, mass: 1.2 }),
  chest:     v.addPoint(0, 1.32, 0, { r: 0.10, mass: 2.0 }),
  pelvis:    v.addPoint(0, 0.98, 0, { r: 0.10, mass: 2.2 }),
  shoulderL: v.addPoint(-0.17, 1.40, 0, { r: 0.05 }),
  shoulderR: v.addPoint(0.17, 1.40, 0, { r: 0.05 }),
  elbowL:    v.addPoint(-0.30, 1.14, 0, { r: 0.05, mass: 0.6 }),
  elbowR:    v.addPoint(0.30, 1.14, 0, { r: 0.05, mass: 0.6 }),
  handL:     v.addPoint(-0.33, 0.88, 0, { r: 0.06, mass: 0.5 }),
  handR:     v.addPoint(0.33, 0.88, 0, { r: 0.06, mass: 0.5 }),
  hipL:      v.addPoint(-0.11, 0.94, 0, { r: 0.05 }),
  hipR:      v.addPoint(0.11, 0.94, 0, { r: 0.05 }),
  kneeL:     v.addPoint(-0.12, 0.50, 0, { r: 0.05, mass: 0.9 }),
  kneeR:     v.addPoint(0.12, 0.50, 0, { r: 0.05, mass: 0.9 }),
  footL:     v.addPoint(-0.13, 0.06, 0, { r: 0.07, mass: 0.8 }),
  footR:     v.addPoint(0.13, 0.06, 0, { r: 0.07, mass: 0.8 }),
};
// bones (rigid distance constraints)
const BONES = [
  ["head", "chest"], ["chest", "pelvis"],
  ["chest", "shoulderL"], ["chest", "shoulderR"], ["shoulderL", "shoulderR"],
  ["shoulderL", "elbowL"], ["elbowL", "handL"], ["shoulderR", "elbowR"], ["elbowR", "handR"],
  ["pelvis", "hipL"], ["pelvis", "hipR"], ["hipL", "hipR"],
  ["hipL", "kneeL"], ["kneeL", "footL"], ["hipR", "kneeR"], ["kneeR", "footR"],
  // torso rigidity so the trunk holds shape
  ["pelvis", "shoulderL"], ["pelvis", "shoulderR"],
];
// cross-braces get lower stiffness so the torso loop isn't over-constrained (jitter)
const BRACE = new Set(["shoulderL>shoulderR", "hipL>hipR", "pelvis>shoulderL", "pelvis>shoulderR"]);
for (const [a, b] of BONES) v.addStick(J[a], J[b], BRACE.has(a + ">" + b) ? 0.6 : 1);

// active-ragdoll pose DRIVES (parent → child). dir = target unit direction in facing
// frame; the STAND pose = each bone's current rest direction. Poses just swap these dirs.
const dir = (a, b) => new THREE.Vector3(J[b].p.x - J[a].p.x, J[b].p.y - J[a].p.y, 0).normalize();
const DRIVEDEFS = [
  ["chest", "head"], ["pelvis", "chest"],
  ["shoulderL", "elbowL"], ["elbowL", "handL"], ["shoulderR", "elbowR"], ["elbowR", "handR"],
  ["hipL", "kneeL"], ["kneeL", "footL"], ["hipR", "kneeR"], ["kneeR", "footR"],
];
const DR = {};
for (const [a, b] of DRIVEDEFS) DR[a + ">" + b] = v.addDrive(J[a], J[b], dir(a, b));
const STAND = {};
for (const k in DR) STAND[k] = DR[k].dir.clone();   // remember the stand pose

// ── render: a chunky "Fall-Guys" body — fat rounded capsule limbs + a bean torso +
// big round head/hands/feet, driven by the Verlet joints. Bone lengths are fixed
// (distance constraints), so each capsule is built once at its length and just moved. ──
const skin = new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.55, metalness: 0.02 });
const dark = new THREE.MeshStandardMaterial({ color: 0x3a4a63, roughness: 0.7 });   // "shorts"/feet accent
// per-bone tube radius (null = internal brace, not drawn); torso is a fat bean
const TUBE = { "chest>pelvis": 0.20, "head>chest": 0.07, "shoulderL>elbowL": 0.085, "elbowL>handL": 0.075, "shoulderR>elbowR": 0.085, "elbowR>handR": 0.075, "hipL>kneeL": 0.14, "kneeL>footL": 0.115, "hipR>kneeR": 0.14, "kneeR>footR": 0.115 };
const _up = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3(), _mid = new THREE.Vector3();
const tubes = [];
for (const [a, b] of BONES) {
  const r = TUBE[a + ">" + b]; if (r == null) continue;    // skip braces
  const len = J[a].p.distanceTo(J[b].p);
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 5, 12), a === "kneeL" || a === "kneeR" ? dark : skin);
  m.castShadow = true; scene.add(m); tubes.push({ a, b, m, half: len / 2 });
}
// rounded blobs: head, hands, feet
const blobMesh = {};
const BLOB = { head: [0.17, skin], handL: [0.1, skin], handR: [0.1, skin], footL: [0.11, dark], footR: [0.11, dark] };
for (const k in BLOB) { const m = new THREE.Mesh(new THREE.SphereGeometry(BLOB[k][0], 16, 12), BLOB[k][1]); m.castShadow = true; scene.add(m); blobMesh[k] = m; }
function render() {
  for (const t of tubes) {
    const a = J[t.a].p, b = J[t.b].p;
    _d.subVectors(b, a); const len = _d.length() || 1e-4;
    _mid.addVectors(a, b).multiplyScalar(0.5); t.m.position.copy(_mid);
    t.m.quaternion.setFromUnitVectors(_up, _d.divideScalar(len));
    t.m.scale.set(1, len / (t.half * 2), 1);               // stretch cylinder part to live length
  }
  for (const k in blobMesh) blobMesh[k].position.copy(J[k].p);
  renderer.render(scene, camera);
}

// ── state: drive strength (1 = crisp, 0 = flop/KO) + balance assist ──
let drive = 1, flopped = false, facing = 1;
function balanceAssist() {
  if (drive <= 0) return;
  // keep the hips over the mid-foot base (invisible upright cheat), scaled by drive.
  // move prev too (half) so it doesn't inject a velocity spike = jitter.
  const midX = (J.footL.p.x + J.footR.p.x) * 0.5;
  const dx = (midX - J.pelvis.p.x) * 0.08 * drive;
  J.pelvis.p.x += dx; J.pelvis.o.x += dx * 0.5;
  // firm stand-height hold (the "cheat" balance) so the legs don't sag under gravity
  const sag = 0.98 - J.pelvis.p.y;
  if (sag > 0) { const dy = sag * 0.25 * drive; J.pelvis.p.y += dy; J.pelvis.o.y += dy * 0.5; }
}

// ── input: mouse drag a limb (grab nearest point, throw punches) + keys ──
const _ray = new THREE.Raycaster(), _pt = new THREE.Vector2(), _plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), _hit = new THREE.Vector3();
let grabbed = null, grabPrevX = 0, grabPrevY = 0, grabVX = 0, grabVY = 0;
function pointerXY(e) {
  const r = canvas.getBoundingClientRect();
  _pt.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  _ray.setFromCamera(_pt, camera); if (!_ray.ray.intersectPlane(_plane, _hit)) return null;
  return _hit;
}
canvas.addEventListener("pointerdown", (e) => {
  const w = pointerXY(e); if (!w) return;
  let best = null, bd = 0.5;
  for (const k in J) { const d = J[k].p.distanceTo(w); if (d < bd) { bd = d; best = J[k]; } }
  if (!best) return;
  grabbed = best; v.setPinned(best, true);                 // PIN at the cursor (no momentum injection)
  grabPrevX = best.p.x; grabPrevY = best.p.y; grabVX = grabVY = 0;
  canvas.setPointerCapture?.(e.pointerId);
});
addEventListener("pointermove", (e) => {
  if (!grabbed) return; const w = pointerXY(e); if (!w) return;
  grabbed.p.set(w.x, w.y, 0); grabbed.o.set(w.x, w.y, 0);   // held: sit at cursor, zero velocity
});
addEventListener("pointerup", () => {
  if (!grabbed) return;
  v.setPinned(grabbed, false);
  // THROW with the recent drag velocity, clamped so a flick can't launch it 1000x
  const M = 0.22, cx = Math.max(-M, Math.min(M, grabVX)), cy = Math.max(-M, Math.min(M, grabVY));
  grabbed.o.set(grabbed.p.x - cx, grabbed.p.y - cy, 0);
  grabbed = null;
});
addEventListener("keydown", (e) => {
  if (e.code === "KeyF") { flopped = !flopped; }
  if (e.code === "KeyR") reset();
  if (e.code === "KeyA") J.pelvis.o.x += 0.06;   // nudge left (lean/step)
  if (e.code === "KeyD") J.pelvis.o.x -= 0.06;   // nudge right
  if (e.code === "Space") { for (const k in J) J[k].o.y += 0.14; e.preventDefault(); }   // hop
  if (e.code === "KeyH") { v.impulse(J.handR, -0.25 * facing, 0.05); }   // throw a jab (fling the hand)
});
function reset() {
  const R = { head: [0, 1.62], chest: [0, 1.32], pelvis: [0, 0.98], shoulderL: [-0.17, 1.40], shoulderR: [0.17, 1.40], elbowL: [-0.30, 1.14], elbowR: [0.30, 1.14], handL: [-0.33, 0.88], handR: [0.33, 0.88], hipL: [-0.11, 0.94], hipR: [0.11, 0.94], kneeL: [-0.12, 0.50], kneeR: [0.12, 0.50], footL: [-0.13, 0.06], footR: [0.13, 0.06] };
  for (const k in J) { J[k].p.set(R[k][0], R[k][1], 0); J[k].o.copy(J[k].p); }
  flopped = false;
}

// ── fixed-timestep loop ──
function simStep(dt) {                                     // one fixed step (also driven headlessly)
  if (grabbed) {                                          // track drag velocity for a controlled throw on release
    grabVX = grabbed.p.x - grabPrevX; grabVY = grabbed.p.y - grabPrevY;
    grabPrevX = grabbed.p.x; grabPrevY = grabbed.p.y;
  }
  drive += ((flopped ? 0 : 1) - drive) * Math.min(1, 6 * dt);   // smooth flop/recover
  balanceAssist();
  v.step(dt, { driveStrength: drive, facing });           // grabbed point is pinned → not integrated/pushed
}
let last = performance.now() / 1000, acc = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000; let dt = now - last; last = now; if (dt > 0.1) dt = FIXED;
  acc += dt; let steps = 0;
  while (acc >= FIXED && steps < MAX_SUBSTEPS) { simStep(FIXED); acc -= FIXED; steps++; }
  render();
  updateHUD();
}
function fit() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
fit(); addEventListener("resize", fit); requestAnimationFrame(frame);

// ── minimal HUD ──
function setText(html) { const el = document.getElementById("status"); if (el) el.innerHTML = html; }
function updateHUD() {
  setText(`<b>STICKMAN</b> — drag a limb to swing · <b>H</b> jab · <b>Space</b> hop · <b>A/D</b> lean · <b>F</b> flop (${flopped ? "FLOP" : "stand"}) · <b>R</b> reset &nbsp;·&nbsp; drive ${drive.toFixed(2)}`);
}
window.__stick = { v, J, DR, STAND, reset, simStep, get drive() { return drive; }, set drive(x) { drive = x; }, get flopped() { return flopped; }, set flopped(x) { flopped = x; } };
