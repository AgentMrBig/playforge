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
      `W/S drive · A/D skid-steer (hold both tracks to pivot) · R reset\n` +
      `build ${typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev"}`;
  };

  addEventListener("keydown", (e) => { keys[e.code] = true; if (e.code === "KeyR") tank.reset(); });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  window.__tank = {
    world, tank, scene, camera, RAPIER, renderer,
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
    // chase cam BEHIND the tank (−Z local), level
    const bp = tank.mesh.position, bq = tank.mesh.quaternion;
    const back = new THREE.Vector3(0, 4.5, -11).applyQuaternion(bq);
    const des = bp.clone().add(new THREE.Vector3(back.x, Math.max(2.5, back.y), back.z));
    camera.position.lerp(des, 1 - Math.exp(-6 * dt));
    camera.lookAt(bp.x, bp.y + 1.2, bp.z);
    updateHUD();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
}

main();
