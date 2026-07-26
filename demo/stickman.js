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
for (const [a, b] of BONES) v.addStick(J[a], J[b], 1);

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

// ── render meshes: a sphere per joint + a cylinder per bone (shared geo) ──
const skin = new THREE.MeshStandardMaterial({ color: 0xdfe8f0, roughness: 0.6, metalness: 0.05 });
const jointMesh = {};
for (const k in J) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(J[k].r, 12, 10), skin);
  m.castShadow = true; scene.add(m); jointMesh[k] = m;
}
const boneGeo = new THREE.CylinderGeometry(0.045, 0.045, 1, 8);
boneGeo.translate(0, 0.5, 0);   // origin at base so we scale y = length
const boneMesh = BONES.map(() => { const m = new THREE.Mesh(boneGeo, skin); m.castShadow = true; scene.add(m); return m; });
const _up = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3(), _q = new THREE.Quaternion();
function render() {
  for (const k in J) jointMesh[k].position.copy(J[k].p);
  for (let i = 0; i < BONES.length; i++) {
    const a = J[BONES[i][0]].p, b = J[BONES[i][1]].p, m = boneMesh[i];
    _d.subVectors(b, a); const len = _d.length() || 1e-4;
    m.position.copy(a); m.quaternion.setFromUnitVectors(_up, _d.divideScalar(len));
    m.scale.set(1, len, 1);
  }
  renderer.render(scene, camera);
}

// ── state: drive strength (1 = crisp, 0 = flop/KO) + balance assist ──
let drive = 1, flopped = false, facing = 1;
function balanceAssist() {
  if (drive <= 0) return;
  // keep the hips over the mid-foot base (invisible upright cheat), scaled by drive
  const midX = (J.footL.p.x + J.footR.p.x) * 0.5;
  J.pelvis.p.x += (midX - J.pelvis.p.x) * 0.10 * drive;
  // gentle stand height so he doesn't sag
  const standY = 0.98, sag = standY - J.pelvis.p.y;
  if (sag > 0) J.pelvis.p.y += sag * 0.08 * drive;
}

// ── input: mouse drag a limb (grab nearest point, throw punches) + keys ──
const _ray = new THREE.Raycaster(), _pt = new THREE.Vector2(), _plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), _hit = new THREE.Vector3();
let grabbed = null;
function pointerXY(e) {
  const r = canvas.getBoundingClientRect();
  _pt.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  _ray.setFromCamera(_pt, camera); _ray.ray.intersectPlane(_plane, _hit);
  return _hit;
}
canvas.addEventListener("pointerdown", (e) => {
  const w = pointerXY(e); let best = null, bd = 0.45;
  for (const k in J) { const d = J[k].p.distanceTo(w); if (d < bd) { bd = d; best = J[k]; } }
  grabbed = best; canvas.setPointerCapture?.(e.pointerId);
});
addEventListener("pointermove", (e) => { if (grabbed) { const w = pointerXY(e); grabbed.p.copy(w); grabbed.p.z = 0; } });
addEventListener("pointerup", () => { grabbed = null; });
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
  drive += ((flopped ? 0 : 1) - drive) * Math.min(1, 6 * dt);   // smooth flop/recover
  balanceAssist();
  v.step(dt, { driveStrength: drive, facing });
  if (grabbed) { grabbed.o.copy(grabbed.p); }             // held point has no inertia while dragged
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
