// PLAYFORGE — Flora Lab (procedural flora proving ground)
//
// Phase 1: instanced procedural grass whose motion is DATA-DRIVEN. Drive the car
// through the field (or fly the free cam) and the grass bends away + lays along
// your path, then springs back — all in the vertex shader, fed each frame via
// field.setDisturbers([...]). Density + wind sliders. See FLORA_PLAN.md.
//
// The car is the COMPLETE proving-ground car (createCarRig): physics + Synty
// muscle model + tyre/burnout smoke + sparks + EXHAUST BACKFIRE FLAME + procedural
// audio + skid trails + chase/cockpit/free camera + full input. One drop-in
// component — same car everywhere, no more stripped-down reinventions.
//
// Same lab methodology as garage / ragdoll / map. Own fixed-step loop.
import {
  Engine, World, Physics, initRapier, FloraField, THREE, createCarRig,
  makeGrassSprig, makeFlower, makeBush, makePineTree, makeOakTree,
} from "../src/index.js";

// ---- grass/dirt kickup: spin the driven wheels (or slide) on grass and they
// fling grass clippings + dirt clods backward — the peel-out effect for a grass
// world (the rig's tyre smoke reads as burning rubber; this adds the clippings). -
class GrassKickup {
  constructor(scene, groundAt = null) {
    this.scene = scene; this.groundAt = groundAt; this.parts = []; this.pool = []; this._cd = 0;
    this.grassGeo = new THREE.PlaneGeometry(0.06, 0.18);
    this.dirtGeo = new THREE.TetrahedronGeometry(0.05);
    this.grassMat = new THREE.MeshStandardMaterial({ color: 0x4d7a38, roughness: 1, side: THREE.DoubleSide });
    this.dirtMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 });
  }
  _spawn(x, y, z, vx, vy, vz, grass) {
    let m = this.pool.pop();
    if (!m) { m = new THREE.Mesh(); this.scene.add(m); }
    m.geometry = grass ? this.grassGeo : this.dirtGeo;
    m.material = grass ? this.grassMat : this.dirtMat;
    m.visible = true; m.scale.setScalar(0.6 + Math.random() * 0.9);
    m.position.set(x, y, z);
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    m.userData = { vx, vy, vz, spin: (Math.random() - 0.5) * 22, life: 0.45 + Math.random() * 0.5 };
    this.parts.push(m);
  }
  update(dt, car) {
    this._cd -= dt;
    const spin = car.driveSpin || 0, slide = car.screech || 0;
    const peeling = spin > 8 || (slide > 0.4 && Math.abs(car.speedKmh) > 6);
    if (peeling && this._cd <= 0) {
      this._cd = 0.02;
      const v = car.body.linvel(), intensity = Math.min(1, spin / 40 + slide);
      for (const w of car.wheels) {
        if (!w.driven || !w.grounded || w.detached || w.cx == null) continue;
        for (let i = 0, n = 1 + (intensity * 4 | 0); i < n; i++)
          // rooster tail: fling mostly BACKWARD (opposite travel) + low, so it
          // arcs behind the wheel and lands fast instead of hovering above it
          this._spawn(w.cx, (w.cy || 0) + 0.03, w.cz,
            -v.x * 0.4 + (Math.random() - 0.5) * 2.5, 0.8 + Math.random() * 1.8,
            -v.z * 0.4 + (Math.random() - 0.5) * 2.5, Math.random() < 0.7);
      }
    }
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const m = this.parts[i], u = m.userData;
      u.vy -= 24 * dt; m.position.x += u.vx * dt; m.position.y += u.vy * dt; m.position.z += u.vz * dt;
      m.rotation.x += u.spin * dt; m.rotation.z += u.spin * 0.7 * dt;
      const gy = (this.groundAt ? this.groundAt(m.position.x, m.position.z) : 0) + 0.02;
      if (m.position.y < gy) { m.position.y = gy; u.vy = 0; u.vx *= 0.6; u.vz *= 0.6; }   // rest on the terrain, not y=0
      if ((u.life -= dt) <= 0) { m.visible = false; this.parts.splice(i, 1); this.pool.push(m); }
    }
  }
}

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

// grass/dirt peel-out clippings (the rig owns engine audio + smoke + skids)
const kickup = new GrassKickup(scene, groundH);

// ---- flora ecosystem: grass · flowers · bushes · pines · oaks ---------------
const MAX_GRASS = +(qs.get("max") || 60000);
const rand = (a, b) => a + Math.random() * (b - a);
const spot = () => { const x = rand(-FIELD, FIELD), z = rand(-FIELD, FIELD); return { x, y: groundH(x, z), z, yaw: rand(0, 6.28) }; };

const grass = new FloraField(scene, { geometry: makeGrassSprig({ blades: 5, height: 0.55 }), max: MAX_GRASS });
grass.scatter(MAX_GRASS, () => ({ ...spot(), scale: rand(0.7, 1.4), tint: Math.random() }));
grass.setDensity(0.6);

const flowers = new FloraField(scene, {                               // palette-tinted blooms
  geometry: makeFlower(), max: 6000,
  palette: [0xe2524a, 0xf2c53d, 0x9b59b6, 0xffffff, 0xe98fb3, 0xf08a3c],
});
flowers.scatter(6000, () => ({ ...spot(), scale: rand(0.7, 1.3) }));

const bushes = new FloraField(scene, { geometry: makeBush({ size: 0.75 }), max: 1200, colorA: 0x3a6b31, colorB: 0x5f8f43, bendScale: 0.45, doubleSide: false });
bushes.scatter(1200, () => ({ ...spot(), scale: rand(0.7, 1.5) }));

const pines = new FloraField(scene, { geometry: makePineTree({ height: 7 }), max: 400, vertexColors: true, bendScale: 0.1, doubleSide: false });
pines.scatter(400, () => ({ ...spot(), scale: rand(0.7, 1.5) }));

const oaks = new FloraField(scene, { geometry: makeOakTree({ height: 5.5 }), max: 300, vertexColors: true, bendScale: 0.12, doubleSide: false });
oaks.scatter(300, () => ({ ...spot(), scale: rand(0.8, 1.4) }));

const fields = [grass, flowers, bushes, pines, oaks];
for (const f of fields) f.setWind({ dir: [1, 0.4], strength: 0.25, gust: 0.6 });

// ---- the car: the complete proving-ground rig (drive through the grass) ------
let rig = null;
initRapier().then(() => {
  world.spawn("physics").add(phys);
  // rolling physics floor sampled from groundH (heightfield collider — cheap)
  phys.addHeightfield(-FIELD, -FIELD, FIELD * 2, groundH, { n: 96, friction: 1.0 });
  rig = createCarRig({
    scene, phys, camera: world.camera, dom: engine.renderer.domElement,
    model: "muscle", hp: 450, pos: [0, groundH(0, 0) + 2, 0],
  });
  setStatus("drive (WASD, Space=handbrake) — [C] chase / cockpit / free-fly · [R] reset — grass bends + springs back");
});

// ---- feed disturbers (the car + the free-fly cam when low) → grass reacts -----
function feedDisturbers() {
  if (!rig) { for (const f of fields) f.setDisturbers([]); return; }
  const d = [];
  const t = rig.car.body.translation(), v = rig.car.body.linvel();
  d.push({ x: t.x, y: t.y, z: t.z, radius: 4.5, strength: 0.9, vx: v.x * 0.05, vz: v.z * 0.05 });
  if (rig.cameraMode === "free") { const c = world.camera.position; d.push({ x: c.x, y: c.y, z: c.z, radius: 4, strength: 0.7, vx: 0, vz: 0 }); }
  for (const f of fields) f.setDisturbers(d);
}

// ---- loop -------------------------------------------------------------------
let last = performance.now() / 1000, acc = 0, fps = 60;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000; let dt = now - last; last = now; if (dt > 0.25) dt = FIXED;
  fps += ((1 / Math.max(1e-3, dt)) - fps) * 0.1;
  acc += dt; let steps = 0;
  while (acc >= FIXED && steps < MAX_SUBSTEPS) { world._fixedUpdate(FIXED, engine); acc -= FIXED; steps++; }
  if (rig) {
    rig.update(dt, Math.min(1, acc / FIXED));   // FX + skids + audio + interpolate + camera
    kickup.update(dt, rig.car);                 // grass/dirt clippings flung by spinning/sliding wheels
  }
  feedDisturbers();
  for (const f of fields) f.update(dt);
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
  const spd = rig ? Math.hypot(rig.car.body.linvel().x, rig.car.body.linvel().z) * 3.6 : 0;
  const line = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  el.innerHTML = line("cam", rig ? rig.cameraMode : "—") + line("fps", fps.toFixed(0))
    + line("grass", grass.mesh.count) + line("flowers", flowers.count) + line("bushes", bushes.count)
    + line("trees", pines.count + oaks.count) + line("car", spd.toFixed(0) + " km/h");
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
  mk("grass density", 0, 1, 0.6, 0.02, (v) => { grass.setDensity(v); flowers.setDensity(v); });
  mk("wind", 0, 1.2, 0.25, 0.02, (v) => { for (const f of fields) f.setWind({ strength: v }); });
  panel.append(sld); document.body.append(panel);
})();

window.__flora = { engine, world, fields, grass, flowers, bushes, pines, oaks, get car() { return rig && rig.car; }, get rig() { return rig; }, feedDisturbers, kickup };
