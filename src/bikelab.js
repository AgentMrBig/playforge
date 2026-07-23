import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { Bike } from "./bikephysics.js";

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

  addEventListener("keydown", (e) => { keys[e.code] = true; if (e.code === "KeyR") bike.reset(); });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // debug handle — same manual-step pattern as __garage (headless rAF ~0)
  window.__bike = {
    world, bike, scene, camera, RAPIER,
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

    // input
    const steer = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
    const thr = keys.KeyW ? 1 : 0;
    const brk = keys.KeyS ? 1 : 0;
    bike.setInput({ throttle: thr, steer, brake: brk, handbrake: !!keys.Space });

    while (acc >= FIXED) {
      bike.snapshotPrev();
      bike.fixedUpdate(FIXED);
      world.step();
      bike.snapshotCurr();
      acc -= FIXED;
    }
    bike.interpolate(Math.max(0, Math.min(1, acc / FIXED)));

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
