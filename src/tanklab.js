import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { Tank } from "./tankphysics.js";

// TANK LAB — standalone sandbox for the specialized tracked-vehicle controller.
// Same fixed-step + render-interp discipline as the other labs.

const FIXED = 1 / 60;
let world, tank, scene, camera, renderer;
let acc = 0, last = performance.now();
const keys = {};

async function main() {
  await RAPIER.init();
  world = new RAPIER.World({ x: 0, y: -18, z: 0 });

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11151b);
  scene.fog = new THREE.Fog(0x11151b, 160, 460);
  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 700);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  document.getElementById("app").appendChild(renderer.domElement);
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.7);
  sun.position.set(70, 100, 40); sun.castShadow = true;
  sun.shadow.camera.left = -90; sun.shadow.camera.right = 90;
  sun.shadow.camera.top = 90; sun.shadow.camera.bottom = -90;
  scene.add(sun, new THREE.AmbientLight(0x8899bb, 0.55));

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700),
    new THREE.MeshStandardMaterial({ color: 0x3a4030, roughness: 0.98 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const grid = new THREE.GridHelper(700, 140, 0x3c463a, 0x262d24); grid.position.y = 0.01; scene.add(grid);
  world.createCollider(RAPIER.ColliderDesc.cuboid(350, 1, 350).setTranslation(0, -1, 0).setFriction(1));

  // some obstacles a tank should shrug off / climb
  const rampMat = new THREE.MeshStandardMaterial({ color: 0x6b5638, roughness: 0.9 });
  const addWedge = (x, z, wdt, len, hgt, yaw = 0) => {
    const geo = new THREE.BufferGeometry(); const hw = wdt / 2, hl = len / 2;
    const v = new Float32Array([-hw,0,-hl, hw,0,-hl, -hw,0,hl, hw,0,hl, -hw,hgt,hl, hw,hgt,hl]);
    geo.setAttribute("position", new THREE.BufferAttribute(v, 3));
    geo.setIndex([0,1,2, 1,3,2, 2,3,4, 3,5,4, 0,2,4, 1,5,3, 0,4,1, 1,4,5]);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, rampMat); m.position.set(x, 0, z); m.rotation.y = yaw;
    m.castShadow = m.receiveShadow = true; scene.add(m);
    const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    world.createCollider(RAPIER.ColliderDesc.convexHull(v).setTranslation(x, 0, z).setRotation(q).setFriction(1));
  };
  addWedge(0, 40, 14, 20, 3);
  addWedge(30, 70, 12, 16, 5, 0.5);
  // a few crates to crush
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x8a6b3a, roughness: 0.85 });
  for (let i = 0; i < 8; i++) {
    const s = 1 + Math.random();
    const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat);
    const x = -30 + i * 5, z = 25; m.position.set(x, s / 2, z); m.castShadow = true; scene.add(m);
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, s / 2, z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(s/2, s/2, s/2).setDensity(60), b);
    m.userData.body = b;
  }

  tank = new Tank(world, RAPIER, { pos: [0, 2, 0] });
  scene.add(tank.mesh);
  await tank.load().catch((e) => console.warn("tank load failed:", e.message));

  const hud = document.createElement("div");
  hud.style.cssText = "position:fixed;left:12px;top:12px;color:#d6e4c8;font:12px ui-monospace,monospace;" +
    "background:rgba(10,14,10,.82);padding:10px 14px;border-radius:8px;line-height:1.7;white-space:pre";
  document.body.appendChild(hud);
  const updateHUD = () => {
    hud.textContent = `TANK LAB · stage 1 (physics)\n` +
      `speed   ${(Math.abs(tank.speedKmh) * 0.621371).toFixed(0)} mph\n` +
      `tracks  L ${tank.leftDrive.toFixed(2)}  R ${tank.rightDrive.toFixed(2)}\n` +
      `wheels  ${tank.grounded || 0}/${tank.wheels.length} grounded\n` +
      `W/S drive · A/D skid-steer (pivot in place) · R reset\n` +
      `drag to orbit · wheel to zoom · [C] free-orbit\n` +
      `build ${typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev"}`;
  };

  addEventListener("keydown", (e) => { keys[e.code] = true; if (e.code === "KeyR") tank.reset(); if (e.code === "KeyC") orbit.on = !orbit.on; });
  addEventListener("keyup", (e) => { keys[e.code] = false; });

  // ---- ORBIT CAMERA (Erik: "zero camera control") — drag to rotate, wheel to
  // zoom. Chase cam follows the tank; drag offsets the orbit around it. [C] can
  // detach into a free orbit that stays put.
  const orbit = { yaw: Math.PI, pitch: 0.42, dist: 14, on: false, drag: false, px: 0, py: 0 };
  const dom = renderer.domElement;
  dom.addEventListener("mousedown", (e) => { orbit.drag = true; orbit.px = e.clientX; orbit.py = e.clientY; });
  addEventListener("mouseup", () => { orbit.drag = false; });
  addEventListener("mousemove", (e) => {
    if (!orbit.drag) return;
    orbit.yaw -= (e.clientX - orbit.px) * 0.006;
    orbit.pitch = Math.max(-0.2, Math.min(1.35, orbit.pitch + (e.clientY - orbit.py) * 0.006));
    orbit.px = e.clientX; orbit.py = e.clientY;
  });
  dom.addEventListener("wheel", (e) => { e.preventDefault(); orbit.dist = Math.max(5, Math.min(60, orbit.dist + e.deltaY * 0.02)); }, { passive: false });
  // touch drag/pinch for mobile inspection
  let pinchD = 0;
  dom.addEventListener("touchstart", (e) => { if (e.touches.length === 1) { orbit.drag = true; orbit.px = e.touches[0].clientX; orbit.py = e.touches[0].clientY; } else if (e.touches.length === 2) { const dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY; pinchD = Math.hypot(dx, dy); } }, { passive: true });
  dom.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1 && orbit.drag) { orbit.yaw -= (e.touches[0].clientX - orbit.px) * 0.008; orbit.pitch = Math.max(-0.2, Math.min(1.35, orbit.pitch + (e.touches[0].clientY - orbit.py) * 0.008)); orbit.px = e.touches[0].clientX; orbit.py = e.touches[0].clientY; }
    else if (e.touches.length === 2) { const dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY; const d = Math.hypot(dx, dy); if (pinchD) orbit.dist = Math.max(5, Math.min(60, orbit.dist * (pinchD / d))); pinchD = d; }
  }, { passive: true });
  addEventListener("touchend", () => { orbit.drag = false; pinchD = 0; });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  window.__tank = {
    world, tank, scene, camera, RAPIER, renderer, orbit,
    step(n = 1) { for (let i = 0; i < n; i++) { tank.snapshotPrev(); tank.fixedUpdate(FIXED); world.step(); tank.snapshotCurr(); } return tank.height; },
    render() { tank.interpolate(1); renderer.render(scene, camera); },
    state() { const t = tank.body.translation(), v = tank.body.linvel(), a = tank.body.angvel();
      // heading from forward vector
      const r = tank.body.rotation(); const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      return { x: +t.x.toFixed(2), y: +t.y.toFixed(2), z: +t.z.toFixed(2), mph: +(tank.speedKmh * 0.621).toFixed(1),
        yawRate: +a.y.toFixed(2), heading: +Math.atan2(f.x, f.z).toFixed(2), upDot: +up.y.toFixed(2),
        grounded: tank.grounded, L: +tank.leftDrive.toFixed(2), R: +tank.rightDrive.toFixed(2) }; },
    snap(w = 480, h = 360) { renderer.render(scene, camera); const c = document.createElement("canvas");
      c.width = w; c.height = h; c.getContext("2d").drawImage(renderer.domElement, 0, 0, w, h); return c.toDataURL("image/jpeg", 0.7); },
  };

  requestAnimationFrame(frame);
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    acc += dt;
    const steer = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
    const thr = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    tank.setInput({ throttle: thr, steer, brake: keys.Space ? 1 : 0 });
    while (acc >= FIXED) { tank.snapshotPrev(); tank.fixedUpdate(FIXED); world.step(); tank.snapshotCurr(); acc -= FIXED; }
    tank.interpolate(Math.max(0, Math.min(1, acc / FIXED)));
    // crate visual sync
    scene.traverse((o) => { if (o.userData.body) { const t = o.userData.body.translation(), r = o.userData.body.rotation();
      o.position.set(t.x, t.y, t.z); o.quaternion.set(r.x, r.y, r.z, r.w); } });
    // orbit cam around the tank: yaw follows the tank's heading unless the user
    // is dragging or has toggled free-orbit [C]; drag/wheel always work
    const bp = tank.mesh.position, bq = tank.mesh.quaternion;
    if (!orbit.on && !orbit.drag) {
      // relax the orbit yaw toward "behind the tank" so it chases while driving
      const heading = Math.atan2(2 * (bq.w * bq.y + bq.x * bq.z), 1 - 2 * (bq.y * bq.y + bq.x * bq.x));
      let want = heading + Math.PI, d = (want - orbit.yaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
      orbit.yaw += d * (1 - Math.exp(-3 * dt));
    }
    const cp = Math.cos(orbit.pitch), des = new THREE.Vector3(
      bp.x + Math.sin(orbit.yaw) * orbit.dist * cp,
      bp.y + 1 + Math.sin(orbit.pitch) * orbit.dist,
      bp.z + Math.cos(orbit.yaw) * orbit.dist * cp);
    camera.position.lerp(des, orbit.drag ? 1 : 1 - Math.exp(-8 * dt));
    camera.lookAt(bp.x, bp.y + 1, bp.z);
    updateHUD();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
}

main();
