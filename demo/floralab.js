// PLAYFORGE — Flora Lab (procedural flora proving ground)
//
// Phase 1: instanced procedural grass whose motion is DATA-DRIVEN. Drive the car
// through the field (or fly the free cam) and the grass bends away + lays along
// your path, then springs back — all in the vertex shader, fed each frame via
// field.setDisturbers([...]). Density + wind sliders. See FLORA_PLAN.md.
//
// Same lab methodology as garage / ragdoll / map. Own fixed-step loop.
import {
  Engine, World, Physics, initRapier, Car, FloraField, makeGrassSprig, loadVehicle, THREE,
} from "../src/index.js";
import RAPIER from "@dimforge/rapier3d-compat";

const FIXED = 1 / 60, MAX_SUBSTEPS = 5;
const qs = new URLSearchParams(location.search);

const engine = new Engine(document.getElementById("game"), { clearColor: 0x8fb9dc });
const world = new World(); engine.world = world;
const scene = world.scene;
scene.fog = new THREE.FogExp2(0xbcd6ea, 0.0016);

scene.add(new THREE.HemisphereLight(0xcfe0f0, 0x40402e, 0.95));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.5);
sun.position.set(30, 50, 20); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, far: 140 });
scene.add(sun);
engine.renderer.shadowMap.enabled = true; engine.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// ---- gently rolling ground (visual + flat physics floor) --------------------
const FIELD = 140;                       // grass field half-extent... (full = 2*FIELD)
function groundH(x, z) { return Math.sin(x * 0.03) * 1.2 + Math.cos(z * 0.035) * 1.5 + Math.sin((x + z) * 0.012) * 2.0; }
const gGeo = new THREE.PlaneGeometry(FIELD * 2, FIELD * 2, 120, 120);
gGeo.rotateX(-Math.PI / 2);
{ const p = gGeo.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, groundH(p.getX(i), p.getZ(i))); gGeo.computeVertexNormals(); }
const ground = new THREE.Mesh(gGeo, new THREE.MeshStandardMaterial({ color: 0x3f6b39, roughness: 0.97 }));
ground.receiveShadow = true; scene.add(ground);

const phys = new Physics({ gravity: -20 });

// ---- flora field ------------------------------------------------------------
const MAX_GRASS = +(qs.get("max") || 60000);
const field = new FloraField(scene, { geometry: makeGrassSprig({ blades: 5, height: 0.55 }), max: MAX_GRASS });
// scatter in RANDOM order across the field so the density slider thins uniformly
field.scatter(MAX_GRASS, () => {
  const x = (Math.random() * 2 - 1) * FIELD, z = (Math.random() * 2 - 1) * FIELD;
  return { x, y: groundH(x, z), z, scale: 0.7 + Math.random() * 0.7, yaw: Math.random() * 6.28, tint: Math.random() };
});
field.setDensity(0.6);
field.setWind({ dir: [1, 0.4], strength: 0.25, gust: 0.6 });

// ---- car (drive through the grass) + a WASD/auto driver ---------------------
let car = null;
const keys = {};
const auto = { on: true, t: 0 };
const freeCam = { on: false, pos: new THREE.Vector3(), yaw: 0, pitch: -0.2, speed: 45 };
addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (e.code === "KeyR") resetCar();
  if (e.code === "KeyF") toggleFreeCam();
  if (["Space", "KeyW", "KeyS", "KeyA", "KeyD"].includes(e.code) && freeCam.on) e.preventDefault();
});
addEventListener("keyup", (e) => { keys[e.code] = false; });
function carInput() {
  if (freeCam.on) { auto.t += FIXED; return { throttle: 1, steer: 0.3 * Math.sin(auto.t * 0.3), brake: 0 }; }
  const up = keys.KeyW || keys.ArrowUp, dn = keys.KeyS || keys.ArrowDown, l = keys.KeyA || keys.ArrowLeft, r = keys.KeyD || keys.ArrowRight;
  if (up || dn || l || r) auto.on = false;
  if (auto.on) { auto.t += FIXED; return { throttle: 1, steer: 0.35 * Math.sin(auto.t * 0.3), brake: 0 }; }
  return { throttle: (up ? 1 : 0) - (dn ? 1 : 0), steer: (l ? 1 : 0) - (r ? 1 : 0), brake: 0, handbrake: !!keys.Space };
}
function resetCar() {
  if (!car) return;
  car.body.setTranslation({ x: 0, y: groundH(0, 0) + 2, z: 0 }, true);
  car.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  car.body.setLinvel({ x: 0, y: 0, z: 0 }, true); car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  car._read(car.currPos, car.currQuat); car.prevPos.copy(car.currPos); car.prevQuat.copy(car.currQuat);
  auto.t = 0;
}
function toggleFreeCam() {
  freeCam.on = !freeCam.on;
  if (freeCam.on) { freeCam.pos.copy(world.camera.position); const d = new THREE.Vector3(); world.camera.getWorldDirection(d); freeCam.yaw = Math.atan2(d.x, d.z); freeCam.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)); engine.renderer.domElement.requestPointerLock?.(); }
  else document.exitPointerLock?.();
}
engine.renderer.domElement.addEventListener("click", () => { if (freeCam.on && !document.pointerLockElement) engine.renderer.domElement.requestPointerLock?.(); });
addEventListener("mousemove", (e) => { if (!freeCam.on || !document.pointerLockElement) return; freeCam.yaw -= e.movementX * 0.0022; freeCam.pitch = THREE.MathUtils.clamp(freeCam.pitch - e.movementY * 0.0022, -1.5, 1.5); });

initRapier().then(() => {
  world.spawn("physics").add(phys);
  // flat-ish physics floor sampled from groundH (heightfield collider — cheap)
  phys.addHeightfield(-FIELD, -FIELD, FIELD * 2, groundH, { n: 96, friction: 1.0 });
  car = new Car(phys.world, RAPIER, { pos: [0, groundH(0, 0) + 2, 0] });
  scene.add(car.mesh);
  // Synty muscle car instead of the placeholder box (non-blocking)
  loadVehicle("models/fabpack/SK_veh_Muscle_01.fbx", {
    targetLength: 4.6, textureDir: "models/fabpack", textureFlipY: true,
    textureMap: { palette: "T_colorPalette2048.PNG", veh: "T_colorPalette2048.PNG" },
  }).then((rig) => car.attachModel(rig)).catch((e) => console.warn("muscle load failed:", e.message));
  phys._pre.push(() => { car.snapshotPrev(); car.setInput(carInput()); car.fixedUpdate(FIXED); });
  phys._post.push(() => car.snapshotCurr());
  setStatus("drive (WASD / autopilot) or fly (F) through the grass — it bends + springs back");
});

// ---- camera (chase / free-fly) ----------------------------------------------
const _f = new THREE.Vector3(), _g = new THREE.Vector3(), _t = new THREE.Vector3();
function updateCamera(dt) {
  const cam = world.camera;
  if (freeCam.on) {
    const cy = Math.cos(freeCam.yaw), sy = Math.sin(freeCam.yaw), cp = Math.cos(freeCam.pitch), sp = Math.sin(freeCam.pitch);
    _f.set(sy * cp, sp, cy * cp);
    const spd = freeCam.speed * (keys.ShiftLeft ? 3 : 1) * dt;
    if (keys.KeyW) freeCam.pos.addScaledVector(_f, spd);
    if (keys.KeyS) freeCam.pos.addScaledVector(_f, -spd);
    if (keys.KeyD) { freeCam.pos.x += cy * spd; freeCam.pos.z -= sy * spd; }
    if (keys.KeyA) { freeCam.pos.x -= cy * spd; freeCam.pos.z += sy * spd; }
    if (keys.Space) freeCam.pos.y += spd;
    if (keys.ControlLeft || keys.KeyC) freeCam.pos.y -= spd;
    cam.position.copy(freeCam.pos); cam.lookAt(freeCam.pos.x + _f.x, freeCam.pos.y + _f.y, freeCam.pos.z + _f.z);
    return;
  }
  if (!car) return;
  const p = car.mesh.position;
  _f.set(0, 0, 1).applyQuaternion(car.mesh.quaternion);
  _g.set(p.x - _f.x * 9, p.y + 4.5, p.z - _f.z * 9);
  cam.position.lerp(_g, 0.12);
  _t.set(p.x + _f.x * 5, p.y + 1, p.z + _f.z * 5); cam.lookAt(_t);
}

// ---- feed disturbers (car + free cam when low) → grass reacts ----------------
const _lv = new THREE.Vector3();
function feedDisturbers() {
  const d = [];
  if (car) {
    const t = car.body.translation(), v = car.body.linvel();
    d.push({ x: t.x, y: t.y, z: t.z, radius: 4.5, strength: 0.9, vx: v.x * 0.05, vz: v.z * 0.05 });
  }
  if (freeCam.on) d.push({ x: freeCam.pos.x, y: freeCam.pos.y, z: freeCam.pos.z, radius: 4, strength: 0.7, vx: 0, vz: 0 });
  field.setDisturbers(d);
}

// ---- loop -------------------------------------------------------------------
let last = performance.now() / 1000, acc = 0, fps = 60;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000; let dt = now - last; last = now; if (dt > 0.25) dt = FIXED;
  fps += ((1 / Math.max(1e-3, dt)) - fps) * 0.1;
  acc += dt; let steps = 0;
  while (acc >= FIXED && steps < MAX_SUBSTEPS) { world._fixedUpdate(FIXED, engine); acc -= FIXED; steps++; }
  if (car) car.interpolate(Math.min(1, acc / FIXED));
  feedDisturbers();
  field.update(dt);
  updateCamera(dt);
  world._update(dt, engine);
  updateHUD();
  engine.renderer.render(scene, world.camera);
}
requestAnimationFrame(frame);
function fit() { engine.renderer.setSize(innerWidth, innerHeight, false); world.camera.far = 2000; world.camera.aspect = innerWidth / innerHeight; world.camera.updateProjectionMatrix(); }
fit(); addEventListener("resize", fit);

// ---- HUD + sliders ----------------------------------------------------------
function setStatus(t) { const el = document.getElementById("status"); if (el) el.textContent = t; }
function updateHUD() {
  const el = document.getElementById("readouts"); if (!el) return;
  const spd = car ? Math.hypot(car.body.linvel().x, car.body.linvel().z) * 3.6 : 0;
  const line = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  el.innerHTML = line("mode", freeCam.on ? "FREE-FLY" : "drive") + line("fps", fps.toFixed(0))
    + line("grass rendered", field.mesh.count) + line("of max", field.count) + line("car", spd.toFixed(0) + " km/h");
}
(function ui() {
  const css = document.createElement("style");
  css.textContent = `#panel{position:fixed;right:12px;top:10px;z-index:20;width:190px;font:12px/1.4 ui-monospace,monospace;color:#cfe;user-select:none}
    #readouts{background:rgba(10,14,18,.82);border:1px solid #2c3a48;border-radius:8px;padding:8px 10px;margin-bottom:8px}
    #readouts div{display:flex;justify-content:space-between}#readouts b{color:#ffd479}
    .sld{background:rgba(10,14,18,.82);border:1px solid #2c3a48;border-radius:8px;padding:8px 10px}
    .sld label{display:flex;justify-content:space-between;color:#9fb4c4}.sld input{width:100%}`;
  document.head.appendChild(css);
  const panel = document.createElement("div"); panel.id = "panel";
  panel.innerHTML = `<div id="readouts"></div>`;
  const sld = document.createElement("div"); sld.className = "sld";
  const mk = (name, min, max, val, step, on) => {
    const wrap = document.createElement("div"); const lab = document.createElement("label");
    const s = document.createElement("span"); s.textContent = name; const b = document.createElement("b"); b.textContent = (+val).toFixed(2); b.style.color = "#ffd479";
    lab.append(s, b); const inp = document.createElement("input"); inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
    inp.oninput = () => { b.textContent = (+inp.value).toFixed(2); on(+inp.value); }; wrap.append(lab, inp); sld.append(wrap);
  };
  mk("density", 0, 1, 0.6, 0.02, (v) => field.setDensity(v));
  mk("wind", 0, 1.2, 0.25, 0.02, (v) => field.setWind({ strength: v }));
  panel.append(sld); document.body.append(panel);
})();

window.__flora = { engine, world, field, get car() { return car; }, feedDisturbers };
