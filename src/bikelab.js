import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { Bike } from "./bikephysics.js";
import { loadCharacter } from "./character.js";
import { Ragdoll } from "./ragdoll.js";
import { initRapier } from "./phys.js";
import { solveTwoBone } from "./ik.js";
import { VehicleAudio } from "./vehicleaudio.js";

// BIKE LAB — lean, minimal sandbox for the motorcycle controller. Same fixed-
// step + render-interpolation discipline as the proving ground, none of the
// car-specific systems. Grows stage by stage (rider ragdoll, audio, damage).

const FIXED = 1 / 60;
let world, bike, scene, camera, renderer;
let acc = 0, last = performance.now();
const keys = {};

async function main() {
  await RAPIER.init();
  world = new RAPIER.World({ x: 0, y: -14, z: 0 });

  // ---- scene ------------------------------------------------------------
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10141a);
  scene.fog = new THREE.Fog(0x10141a, 140, 420);
  camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 600);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  document.getElementById("app").appendChild(renderer.domElement);
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
  sun.position.set(60, 90, 40); sun.castShadow = true;
  sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
  sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
  scene.add(sun, new THREE.AmbientLight(0x8899bb, 0.55));

  // ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(600, 120, 0x39424d, 0x232a32);
  grid.position.y = 0.01; scene.add(grid);
  world.createCollider(RAPIER.ColliderDesc.cuboid(300, 1, 300).setTranslation(0, -1, 0).setFriction(1));

  // a few flush wedge ramps (same convex-prism trick as the proving ground)
  const rampMat = new THREE.MeshStandardMaterial({ color: 0x7a4a2b, roughness: 0.85 });
  const addWedge = (x, z, wdt, len, hgt, yaw = 0) => {
    const geo = new THREE.BufferGeometry();
    const hw = wdt / 2, hl = len / 2;
    const v = new Float32Array([
      -hw, 0, -hl, hw, 0, -hl, -hw, 0, hl, hw, 0, hl,     // base
      -hw, hgt, hl, hw, hgt, hl,                           // top edge (far end)
    ]);
    geo.setAttribute("position", new THREE.BufferAttribute(v, 3));
    geo.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 0, 2, 4, 1, 5, 3, 0, 4, 1, 1, 4, 5]);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, rampMat);
    m.position.set(x, 0, z); m.rotation.y = yaw; m.castShadow = m.receiveShadow = true;
    scene.add(m);
    const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    world.createCollider(RAPIER.ColliderDesc.convexHull(v)
      .setTranslation(x, 0, z).setRotation(q).setFriction(1));
  };
  addWedge(0, 60, 10, 16, 3);
  addWedge(24, 100, 8, 20, 5);
  addWedge(-26, 90, 12, 14, 2, 0.4);

  // perimeter walls
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x5c4433, roughness: 0.9 });
  const addWall = (px, pz, sx, sz) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx * 2, 5, sz * 2), wallMat);
    m.position.set(px, 2.5, pz); m.castShadow = true; scene.add(m);
    world.createCollider(RAPIER.ColliderDesc.cuboid(sx, 2.5, sz).setTranslation(px, 2.5, pz));
  };
  addWall(0, 298, 300, 2); addWall(0, -298, 300, 2);
  addWall(298, 0, 2, 300); addWall(-298, 0, 2, 300);

  // ---- the bike ---------------------------------------------------------
  bike = new Bike(world, RAPIER, { pos: [0, 1.2, 0] });
  scene.add(bike.mesh);

  // engine audio — same procedural engine as the car, smaller lung (screamier
  // rev range comes from the lower hp + the bike's own speed profile)
  const audio = new VehicleAudio({ hp: 180 });
  const startAudio = () => { audio.start?.(); removeEventListener("pointerdown", startAudio); removeEventListener("touchstart", startAudio); removeEventListener("keydown", startAudio); };
  addEventListener("pointerdown", startAudio);
  addEventListener("touchstart", startAudio);
  addEventListener("keydown", startAudio);

  // ---- the rider: the main character, seated — ragdolls off on a crash ----
  let rider = null;
  loadCharacter("models/character/humanoid_male.fbx", {
    textureDir: "models/character", texture: "base_texture.png", targetHeight: 1.8,
  }).then(async (ch) => {
    await initRapier();                     // ragdoll.js reads phys.js's R handle
    // seat him on the bike, inside the lean group so he leans with it.
    // origin is at his FEET — drop it so his butt lands ON the seat (hips y≈0.35
    // in lean-group space — verified by bone-position probe, not eyeball)
    ch.visual.position.set(0, -0.67, -0.30);
    bike.leanGroup.add(ch.visual);
    // riding pose: coarse FK for legs/torso (probed signs), then two-bone IK
    // reaches the hands to the bar grips — axis-agnostic, no more sign guessing
    const B = ch.bones;
    const rot = (n, x, y = 0, z = 0) => { if (B[n]) B[n].rotation.set(B[n].rotation.x + x, B[n].rotation.y + y, B[n].rotation.z + z); };
    rot("LeftUpLeg", -1.35, 0, 0.14); rot("RightUpLeg", -1.35, 0, -0.14);
    rot("LeftLeg", -1.35); rot("RightLeg", -1.35);
    rot("Spine", 0.35); rot("Spine1", 0.2); rot("Neck", -0.3);
    bike.mesh.updateWorldMatrix(true, true);
    const L = (x, y, z) => bike.leanGroup.localToWorld(new THREE.Vector3(x, y, z));
    for (const s of [1, -1]) {
      const pre = s > 0 ? "Left" : "Right";
      if (B[pre + "Arm"] && B[pre + "ForeArm"] && B[pre + "Hand"])
        solveTwoBone({ root: B[pre + "Arm"], mid: B[pre + "ForeArm"], eff: B[pre + "Hand"],
          target: L(s * 0.28, 0.52, 0.58), pole: L(s * 0.7, 0.3, 0.1), iterations: 8 });
    }
    // snapshot the riding pose — ragdoll exit() restores bone POSITIONS but the
    // quaternions keep the death pose; remount puts the whole pose back
    const poseSnap = [];
    ch.visual.traverse((o) => { if (o.isBone) poseSnap.push([o, o.quaternion.clone(), o.position.clone()]); });
    ch._poseSnap = poseSnap;
    // ragdoll ignores the chassis bit — he flies OFF the bike, not into it
    const rag = new Ragdoll(ch.bones, { world }, { collisionGroups: (0x0002 << 16) | (0xffff & ~0x0004) });
    rider = { ch, rag, mounted: true };
    window.__bike.rider = rider;
    window.__bike.updateRider = updateRider;    // headless: rAF ~0 in the agent pane
  }).catch((e) => console.warn("rider failed to load:", e.message));

  // crash transition → THROW the rider (called from the frame loop)
  function updateRider(dt) {
    if (!rider) return;
    if (rider.mounted && bike.crashed) {
      // dismount: hand the visual to the scene at its current world pose
      const v = rider.ch.visual;
      v.updateWorldMatrix(true, true);
      scene.attach(v);                       // keeps world transform
      const lv = bike.body.linvel();
      rider.rag.enter(
        new THREE.Vector3(lv.x * 1.05, 2.5 + Math.hypot(lv.x, lv.z) * 0.25, lv.z * 1.05),
        new THREE.Vector3(lv.x * 20, 300, lv.z * 20),
        v.position.clone().add(new THREE.Vector3(0, 0.8, 0)));
      rider.mounted = false;
    }
    if (!rider.mounted && rider.rag.active) rider.rag.update();
  }
  function updateRiderFixed() {
    if (rider && rider.rag.active) rider.rag.fixedUpdate(FIXED);
  }
  const remount = () => {
    if (!rider || rider.mounted) return;
    rider.rag.exit();
    const v = rider.ch.visual;
    bike.leanGroup.attach(v);
    v.position.set(0, -0.67, -0.30); v.rotation.set(0, 0, 0); v.scale.setScalar(v.scale.x);
    for (const [o, q, p] of rider.ch._poseSnap) { o.quaternion.copy(q); o.position.copy(p); }
    rider.mounted = true;
  };
  window.__bikeRemount = remount;

  // ---- HUD --------------------------------------------------------------
  const hud = document.createElement("div");
  hud.style.cssText = "position:fixed;left:12px;top:12px;color:#cfe3f5;font:12px ui-monospace,monospace;" +
    "background:rgba(10,14,18,.82);padding:10px 14px;border-radius:8px;line-height:1.7;white-space:pre";
  document.body.appendChild(hud);
  const updateHUD = () => {
    hud.textContent =
      `BIKE LAB · stage 1\n` +
      `speed   ${(Math.abs(bike.speedKmh) * 0.621371).toFixed(0)} mph\n` +
      `lean    ${(bike.lean * 57.3).toFixed(0)}°\n` +
      `steer   ${(bike.steer * 57.3).toFixed(1)}°\n` +
      `${bike.crashed ? "CRASHED — [R] reset" : "WASD ride · Space rear brake · R reset"}\n` +
      `build ${typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev"}`;
  };

  // ---- mobile touch controls (same pattern as the proving ground) ---------
  const touch = { left: false, right: false, gas: false, rev: false };
  if (("ontouchstart" in window) || navigator.maxTouchPoints > 0) {
    const css = document.createElement("style");
    css.textContent = `
      .tbtn{position:fixed;z-index:35;width:76px;height:76px;border-radius:50%;
        background:rgba(28,38,48,.55);border:2px solid rgba(127,215,255,.45);color:#cfe;
        font:700 28px ui-monospace,monospace;display:flex;align-items:center;justify-content:center;
        user-select:none;-webkit-user-select:none;touch-action:none}
      .tbtn.on{background:rgba(80,140,190,.8)}
      #tL{left:14px;bottom:92px} #tR{left:106px;bottom:92px}
      #tGas{right:14px;bottom:160px} #tRev{right:14px;bottom:64px} #tRst{right:108px;bottom:112px}`;
    document.head.appendChild(css);
    const mk = (id, txt, key, tap = null) => {
      const el = document.createElement("div");
      el.id = id; el.className = "tbtn"; el.textContent = txt;
      document.body.appendChild(el);
      el.addEventListener("touchstart", (e) => { e.preventDefault(); if (tap) return tap(); touch[key] = true; el.classList.add("on"); }, { passive: false });
      const off = (e) => { if (e) e.preventDefault(); touch[key] = false; el.classList.remove("on"); };
      el.addEventListener("touchend", off); el.addEventListener("touchcancel", off);
    };
    mk("tL", "◀", "left"); mk("tR", "▶", "right");
    mk("tGas", "▲", "gas"); mk("tRev", "▼", "rev");
    mk("tRst", "↺", null, () => { bike.reset(); remount(); });
    hud.style.display = "none";                 // phone: HUD hidden, ⚙ peeks
    const gear = document.createElement("div");
    gear.textContent = "⚙";
    gear.style.cssText = "position:fixed;top:10px;left:10px;z-index:36;width:40px;height:40px;" +
      "border-radius:50%;background:rgba(28,38,48,.5);color:#9fb4c4;display:flex;align-items:center;" +
      "justify-content:center;font-size:22px;user-select:none;-webkit-user-select:none;touch-action:none";
    gear.addEventListener("touchstart", (e) => {
      e.preventDefault();
      hud.style.display = hud.style.display === "none" ? "block" : "none";
    }, { passive: false });
    document.body.appendChild(gear);
  }

  addEventListener("keydown", (e) => { keys[e.code] = true; if (e.code === "KeyR") { bike.reset(); remount(); } });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // debug handle — same manual-step pattern as __garage (headless rAF ~0)
  window.__bike = {
    world, bike, scene, camera, RAPIER, renderer,
    snap(wpx = 480, hpx = 640) {          // headless visual proof (rAF ~0 in agent pane)
      renderer.render(scene, camera);
      const c2 = document.createElement("canvas");
      c2.width = wpx; c2.height = hpx;
      c2.getContext("2d").drawImage(renderer.domElement, 0, 0, wpx, hpx);
      return c2.toDataURL("image/jpeg", 0.72);
    },
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        bike.snapshotPrev(); bike.fixedUpdate(FIXED); world.step(); bike.snapshotCurr();
      }
      return bike.height;
    },
    state() {
      const t = bike.body.translation(), v = bike.body.linvel();
      return { x: +t.x.toFixed(2), y: +t.y.toFixed(2), z: +t.z.toFixed(2),
        kmh: +bike.speedKmh.toFixed(1), lean: +(bike.lean * 57.3).toFixed(1),
        steer: +(bike.steer * 57.3).toFixed(2), crashed: bike.crashed };
    },
  };

  requestAnimationFrame(frame);

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    acc += dt;

    // input (keys + touch)
    let steer = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
    let thr = keys.KeyW ? 1 : 0;
    let brk = keys.KeyS ? 1 : 0;
    if (touch.left || touch.right) steer = (touch.left ? 1 : 0) - (touch.right ? 1 : 0);
    if (touch.gas) thr = 1;
    if (touch.rev) brk = 1;
    bike.setInput({ throttle: thr, steer, brake: brk, handbrake: !!keys.Space });

    while (acc >= FIXED) {
      bike.snapshotPrev();
      bike.fixedUpdate(FIXED);
      world.step();
      bike.snapshotCurr();
      updateRiderFixed();                 // ragdoll PD muscles at the fixed rate
      acc -= FIXED;
    }
    bike.interpolate(Math.max(0, Math.min(1, acc / FIXED)));
    updateRider(dt);                      // dismount detection + bones←physics
    audio.update(dt, bike);               // procedural engine + squeal

    // chase cam
    const bp = bike.mesh.position;
    const bq = bike.mesh.quaternion;
    const back = new THREE.Vector3(0, 2.2, -6.5).applyQuaternion(bq);
    // keep the camera from diving with the lean: flatten its up reference
    const des = bp.clone().add(new THREE.Vector3(back.x, Math.max(1.6, back.y), back.z));
    camera.position.lerp(des, 1 - Math.exp(-6 * dt));
    camera.lookAt(bp.x, bp.y + 0.8, bp.z);

    updateHUD();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
}

main();
