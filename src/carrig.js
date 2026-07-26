import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";   // deduped singleton
import { Car } from "./carphysics.js";
import { VehicleFX } from "./vehiclefx.js";
import { VehicleAudio } from "./vehicleaudio.js";
import { SkidTrails } from "./skidtrails.js";
import { Cluster } from "./cluster.js";
import { loadVehicle } from "./vehicledef.js";

/**
 * createCarRig — the COMPLETE proving-ground car as one drop-in component.
 *
 * The reusable-component principle (Erik): any scene that wants "the car" gets
 * the exact thing built + tuned in the Garage — physics, the Synty model, the FX
 * (tyre/burnout smoke, sparks, EXHAUST BACKFIRE FLAME), procedural audio (engine +
 * pops + crash), skid trails, the chase/cockpit/free CAMERA (G-force sway, speed
 * vibration, crash shake, glance-into-turns, obstacle pull-in), and full input
 * (keyboard + gamepad + touch). No scene ever re-rolls a stripped-down car again.
 *
 *   const rig = createCarRig({ scene, phys, camera, dom: renderer.domElement });
 *   // per render frame (after the physics has stepped):
 *   rig.update(dt, alpha);      // alpha = physics interpolation factor (0..1)
 *
 * It registers its own phys._pre/_post hooks (suspension before world.step,
 * snapshot after), so the host just steps the Physics world and calls update().
 *
 * @param opts.scene   THREE.Scene
 * @param opts.phys    Physics component (has .world + _pre/_post)
 * @param opts.camera  THREE.PerspectiveCamera the rig drives
 * @param opts.dom     canvas element for mouse/wheel camera input
 * @param opts.model   vehicle key ("muscle" default) or a {file,len,opts} spec
 * @param opts.pos     spawn position
 */
const MODELS = {
  muscle: { file: "models/fabpack/SK_veh_Muscle_01.fbx", len: 4.6 },
  sedan:  { file: "models/fabpack/SK_veh_Sedan_01.fbx",  len: 4.5 },
  suv:    { file: "models/fabpack/SK_veh_SUV_01.fbx",    len: 4.7 },
};
const AV = { textureDir: "models/fabpack", textureFlipY: true,
  textureMap: { palette: "T_colorPalette2048.PNG", veh: "T_colorPalette2048.PNG" } };

export function createCarRig({ scene, phys, camera, dom, model = "muscle", hp = 450, pos = [0, 3, 0], carOpts = {}, gauges = true } = {}) {
  const world = phys.world;
  const FIXED = 1 / 60;

  // ── car + FX + audio + skids + gauge cluster (identical stack to garage.js) ──
  const car = new Car(world, RAPIER, { pos, ...carOpts });
  scene.add(car.mesh);
  const fx = new VehicleFX(scene);
  const audio = new VehicleAudio({ hp });
  const skid = new SkidTrails(scene);
  const cluster = gauges ? new Cluster() : null;   // analog tach + speedo overlay
  audio.onPop = (d) => fx.exhaustFlame(car, d);   // fire out the pipes on every backfire

  const spec = typeof model === "string" ? (MODELS[model] || MODELS.muscle) : model;
  loadVehicle(spec.file, { targetLength: spec.len, ...(spec.opts || AV) })
    .then((rig) => { rig.name = typeof model === "string" ? model : "car"; car.attachModel(rig); })
    .catch((e) => console.warn("[carrig] model load failed, keeping box:", e.message));

  // ── input: keyboard + gamepad + touch (ported from garage) ──
  const keys = {};
  const touch = { left: false, right: false, gas: false, rev: false, hb: false };
  const pad = { prev: {} };
  const pollPad = () => { const gps = navigator.getGamepads ? navigator.getGamepads() : []; for (const gp of gps) if (gp && gp.connected) return gp; return null; };
  const padDown = (gp, i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
  const padJust = (gp, i) => { const now = padDown(gp, i), was = pad.prev[i]; pad.prev[i] = now; return now && !was; };
  const dz = (v, d = 0.14) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
  let enabled = true;

  function readInput() {
    if (!enabled || cam.mode === "free") return { throttle: 0, steer: 0, brake: 0, handbrake: false };
    const up = keys.KeyW || keys.ArrowUp, down = keys.KeyS || keys.ArrowDown;
    const left = keys.KeyA || keys.ArrowLeft, right = keys.KeyD || keys.ArrowRight;
    let throttle = (up ? 1 : 0) - (down ? 1 : 0), steer = (left ? 1 : 0) - (right ? 1 : 0);
    let handbrake = !!keys.Space, brake = 0;
    if (up && down) { throttle = 1; brake = 1; }                    // brake-stand burnout
    const gp = pollPad();
    if (gp) {
      const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
      if (rt > 0.3 && lt > 0.3) { throttle = rt; brake = lt; }
      else if (Math.abs(rt - lt) > 0.02) throttle = rt - lt;
      const gpSteer = -dz(gp.axes[0] || 0);
      if (Math.abs(gpSteer) > 0.02) steer = gpSteer;
      handbrake = handbrake || padDown(gp, 0);
    }
    if (touch.gas || touch.rev) throttle = (touch.gas ? 1 : 0) - (touch.rev ? 1 : 0);
    if (touch.gas && touch.rev) { throttle = 1; brake = 1; }
    if (touch.left || touch.right) steer = (touch.left ? 1 : 0) - (touch.right ? 1 : 0);
    handbrake = handbrake || touch.hb;
    return { throttle, steer, brake, handbrake };
  }
  function handlePadExtras(dt) {
    const gp = pollPad(); cam.stick = false;
    if (!gp) return;
    if (padJust(gp, 3)) car.reset();
    if (padJust(gp, 1)) car.repair();
    if (padJust(gp, 2)) skid.clear();
    const rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
    if (cam.mode === "chase" && (rx || ry)) { cam.stick = true; cam.yaw -= rx * 2.6 * dt; cam.pitch = Math.max(-0.25, Math.min(1.25, cam.pitch + ry * 1.7 * dt)); }
  }
  const onKeyDown = (e) => {
    keys[e.code] = true;
    if (e.code === "KeyR") { car.reset(); }
    if (e.code === "KeyP") { car.repair(); }
    if (e.code === "KeyK") skid.clear();
    if (e.code === "KeyC") toggleCam();
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code) && cam.mode !== "free") e.preventDefault();
  };
  const onKeyUp = (e) => { keys[e.code] = false; };
  addEventListener("keydown", onKeyDown);
  addEventListener("keyup", onKeyUp);
  buildTouch();

  // audio needs a user gesture (autoplay policy)
  const startAudio = () => { audio.start(); removeEventListener("keydown", startAudio); removeEventListener("mousedown", startAudio); removeEventListener("touchstart", startAudio); };
  addEventListener("keydown", startAudio); addEventListener("mousedown", startAudio); addEventListener("touchstart", startAudio);

  // ── camera: chase / cockpit / free (ported from garage) ──
  const cam = { mode: "chase", yaw: Math.PI, pitch: 0.34, dist: 9, drag: false, px: 0, py: 0, look: new THREE.Vector3(), cockYaw: 0, cockPitch: 0, freePos: new THREE.Vector3(0, 6, -14), freeYaw: 0, freePitch: -0.15, freeSpeed: 24, shakeAmt: 0, stick: false, sway: new THREE.Vector3(), pv: new THREE.Vector3() };
  const _cdes = new THREE.Vector3(), _clook = new THREE.Vector3(), _cfwd = new THREE.Vector3(), _hq = new THREE.Quaternion(), _hup = new THREE.Vector3(), _hoff = new THREE.Vector3();
  const lerpAngle = (a, b, t) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2; return a + d * t; };
  if (dom) {
    dom.addEventListener("mousedown", (e) => { cam.drag = true; cam.px = e.clientX; cam.py = e.clientY; e.preventDefault(); });
    addEventListener("mouseup", () => { cam.drag = false; });
    addEventListener("mousemove", (e) => {
      if (!cam.drag) return;
      const dx = e.clientX - cam.px, dy = e.clientY - cam.py; cam.px = e.clientX; cam.py = e.clientY;
      if (cam.mode === "chase") { cam.yaw -= dx * 0.005; cam.pitch = Math.max(-0.25, Math.min(1.25, cam.pitch + dy * 0.005)); }
      else if (cam.mode === "cockpit") { cam.cockYaw -= dx * 0.004; cam.cockPitch = Math.max(-0.8, Math.min(0.8, cam.cockPitch - dy * 0.004)); }
      else { cam.freeYaw -= dx * 0.004; cam.freePitch = Math.max(-1.45, Math.min(1.45, cam.freePitch - dy * 0.004)); }
    });
    dom.addEventListener("wheel", (e) => { e.preventDefault(); if (cam.mode === "chase") cam.dist = Math.max(4, Math.min(32, cam.dist + e.deltaY * 0.01)); else cam.freeSpeed = Math.max(4, Math.min(140, cam.freeSpeed - e.deltaY * 0.05)); }, { passive: false });
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  function toggleCam() {
    if (cam.mode === "chase") { cam.mode = "cockpit"; cam.cockYaw = 0; cam.cockPitch = 0; cam._baseFov = camera.fov; camera.fov = 74; camera.updateProjectionMatrix(); }
    else if (cam.mode === "cockpit") { cam.mode = "free"; camera.up.set(0, 1, 0); if (cam._baseFov) { camera.fov = cam._baseFov; camera.updateProjectionMatrix(); } cam.freePos.copy(camera.position); _cfwd.copy(cam.look).sub(camera.position).normalize(); cam.freeYaw = Math.atan2(_cfwd.x, _cfwd.z); cam.freePitch = Math.asin(Math.max(-1, Math.min(1, _cfwd.y))); }
    else { cam.mode = "chase"; if (cam._baseFov) { camera.fov = cam._baseFov; camera.updateProjectionMatrix(); } }
  }
  function updateCockpitCam(dt) {
    const m = car.mesh, v = car.body.linvel();
    _hoff.set((v.x - cam.pv.x) / Math.max(dt, 1e-3), 0, (v.z - cam.pv.z) / Math.max(dt, 1e-3));
    cam.pv.set(v.x, v.y, v.z);
    _hq.copy(m.quaternion).invert(); _hoff.applyQuaternion(_hq);
    _hoff.x = THREE.MathUtils.clamp(-_hoff.x * 0.006, -0.09, 0.09); _hoff.z = THREE.MathUtils.clamp(-_hoff.z * 0.006, -0.11, 0.07); _hoff.y = 0;
    cam.sway.lerp(_hoff, Math.min(1, 7 * dt));
    const spd = Math.abs(car.speedKmh), vib = spd > 25 ? spd / 900 : 0;
    _cdes.set(0.37 + cam.sway.x, 0.3, 0.12 + cam.sway.z);
    _cdes.x += (Math.random() - 0.5) * vib; _cdes.y += (Math.random() - 0.5) * vib * 0.7 + ((car.bumpPulse || 0) > 0 ? (Math.random() - 0.5) * 0.04 : 0);
    m.localToWorld(_cdes);
    if (cam.shakeAmt > 0.01) { _cdes.x += (Math.random() - 0.5) * cam.shakeAmt * 0.2; _cdes.y += (Math.random() - 0.5) * cam.shakeAmt * 0.15; cam.shakeAmt *= Math.pow(0.02, dt); }
    camera.position.copy(_cdes);
    if (!cam.drag) cam.cockYaw = lerpAngle(cam.cockYaw, 0, Math.min(1, 3 * dt));
    const turnGlance = THREE.MathUtils.clamp(car.body.angvel().y * 0.14, -0.3, 0.3);
    _hq.copy(m.quaternion); _hup.set(0, 1, 0).applyQuaternion(_hq);
    _hq.premultiply(new THREE.Quaternion().setFromAxisAngle(_hup, cam.cockYaw + turnGlance));
    _cfwd.set(0, 0, 1).applyQuaternion(_hq); _cfwd.y += cam.cockPitch;
    _clook.copy(camera.position).add(_cfwd);
    camera.up.copy(_hup).lerp(new THREE.Vector3(0, 1, 0), 0.35).normalize();
    camera.lookAt(_clook);
  }
  function updateFreeCam(dt) {
    _cfwd.set(Math.sin(cam.freeYaw) * Math.cos(cam.freePitch), Math.sin(cam.freePitch), Math.cos(cam.freeYaw) * Math.cos(cam.freePitch));
    const spd = cam.freeSpeed * dt * (keys.ShiftLeft ? 3 : 1);
    const rx = -Math.cos(cam.freeYaw), rz = Math.sin(cam.freeYaw);
    if (keys.KeyW) cam.freePos.addScaledVector(_cfwd, spd);
    if (keys.KeyS) cam.freePos.addScaledVector(_cfwd, -spd);
    if (keys.KeyD) { cam.freePos.x += rx * spd; cam.freePos.z += rz * spd; }
    if (keys.KeyA) { cam.freePos.x -= rx * spd; cam.freePos.z -= rz * spd; }
    if (keys.KeyE || keys.Space) cam.freePos.y += spd;
    if (keys.KeyQ) cam.freePos.y -= spd;
    camera.position.copy(cam.freePos);
    camera.lookAt(cam.freePos.x + _cfwd.x, cam.freePos.y + _cfwd.y, cam.freePos.z + _cfwd.z);
  }
  function updateCamera(dt) {
    if (cam.mode === "free") return updateFreeCam(dt);
    if (cam.mode === "cockpit") return updateCockpitCam(dt);
    camera.up.set(0, 1, 0);
    const p = car.mesh.position, v = car.body.linvel(), speed = Math.hypot(v.x, v.z);
    if (!cam.drag && !cam.stick && speed > 3) { const behind = Math.atan2(v.x, v.z) + Math.PI; cam.yaw = lerpAngle(cam.yaw, behind, Math.min(1, 2.2 * dt)); }
    const ch = Math.cos(cam.pitch) * cam.dist;
    _clook.set(p.x, p.y + 1.1, p.z);
    _cdes.set(p.x + Math.sin(cam.yaw) * ch, p.y + 2.0 + Math.sin(cam.pitch) * cam.dist, p.z + Math.cos(cam.yaw) * ch);
    _cfwd.copy(_cdes).sub(_clook); const len = _cfwd.length(); _cfwd.normalize();
    const hit = world.castRay(new RAPIER.Ray(_clook, _cfwd), len, true, undefined, undefined, undefined, car.body);
    if (hit) { const toi = (hit.timeOfImpact ?? hit.toi) * 0.85; _cdes.copy(_clook).addScaledVector(_cfwd, Math.min(len, toi)); }
    camera.position.lerp(_cdes, 1 - Math.pow(0.0016, dt));
    cam.look.lerp(_clook, 1 - Math.pow(0.0022, dt));
    camera.lookAt(cam.look);
    if (cam.shakeAmt > 0.01) { camera.position.x += (Math.random() - 0.5) * cam.shakeAmt * 0.55; camera.position.y += (Math.random() - 0.5) * cam.shakeAmt * 0.4; camera.position.z += (Math.random() - 0.5) * cam.shakeAmt * 0.55; cam.shakeAmt *= Math.pow(0.02, dt); }
  }
  function buildTouch() {
    if (!("ontouchstart" in window) && !(navigator.maxTouchPoints > 0)) return;
    const mk = (txt, key, css) => { const b = document.createElement("div"); b.textContent = txt; b.style.cssText = "position:fixed;z-index:35;width:76px;height:76px;border-radius:50%;background:rgba(28,38,48,.55);border:2px solid rgba(127,215,255,.45);color:#cfe;font:700 28px ui-monospace,monospace;display:flex;align-items:center;justify-content:center;user-select:none;touch-action:none;" + css; document.body.appendChild(b); const on = (e) => { e.preventDefault(); touch[key] = true; }; const off = (e) => { if (e) e.preventDefault(); touch[key] = false; }; b.addEventListener("touchstart", on, { passive: false }); b.addEventListener("touchend", off); b.addEventListener("touchcancel", off); };
    mk("◀", "left", "left:14px;bottom:92px"); mk("▶", "right", "left:106px;bottom:92px");
    mk("▲", "gas", "right:14px;bottom:160px"); mk("▼", "rev", "right:14px;bottom:64px"); mk("✋", "hb", "right:108px;bottom:112px");
  }

  // drive the car inside the physics step (suspension before world.step, snapshot after)
  const preHook = () => { car.snapshotPrev(); car.setInput(readInput()); car.fixedUpdate(FIXED); };
  const postHook = () => car.snapshotCurr();
  phys._pre.push(preHook);
  phys._post.push(postHook);

  return {
    car, fx, audio, skid, cam, cluster,
    /** call once per RENDER frame, after the physics world has stepped */
    update(dt, alpha = 1) {
      handlePadExtras(dt);
      fx.update(dt, car);
      skid.update(car);
      audio.update(dt, car);
      car.interpolate(Math.min(1, Math.max(0, alpha)));
      updateCamera(dt);
      if (cluster) cluster.update(audio.rpm || 0, car.speedKmh);   // tach + speedo
    },
    toggleCam,
    shake(a) { cam.shakeAmt = Math.max(cam.shakeAmt, a); },
    setEnabled(v) { enabled = v; },
    get cameraMode() { return cam.mode; },
    dispose() {
      phys._pre = phys._pre.filter((h) => h !== preHook);
      phys._post = phys._post.filter((h) => h !== postHook);
      removeEventListener("keydown", onKeyDown); removeEventListener("keyup", onKeyUp);
      cluster?.canvas?.remove();
      car.mesh.parent?.remove(car.mesh);
    },
  };
}
