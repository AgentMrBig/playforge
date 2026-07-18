// PLAYFORGE GARAGE — the textured vehicle framework showcase.
// Walk up, press E to drive, O to pop every door/hood/trunk open.
import {
  Engine, World, ThirdPersonRig, Audio, Body, Heightfield,
  VehicleBody, PlayerVehicleControls, EngineSound, SkidMarks,
  Animator, buildHumanoid, loadVehicle, VehicleRig, THREE,
} from "../src/index.js";

const engine = new Engine(document.getElementById("game"), { clearColor: 0x9ec4e4 });
const world = new World();
const audio = new Audio();
engine.world = world;
world.scene.fog = new THREE.Fog(0x9ec4e4, 120, 400);

// lights
world.spawn("sun").mesh((() => {
  const g = new THREE.Group();
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.3);
  sun.position.set(40, 60, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const s = 60;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, far: 200 });
  g.add(sun, new THREE.AmbientLight(0x9fb4d0, 0.85));
  return g;
})());

// flat lot (Heightfield so Bodies + vehicles stand on it)
const hf = new Heightfield({ size: 400, res: 8, heightAt: () => 0 });
world.spawn("ground").mesh((() => {
  const m = hf.buildMesh((x, z, h, s, out) => {
    const tile = (Math.floor(x / 6) + Math.floor(z / 6)) & 1;
    out.setHex(tile ? 0x3a3f45 : 0x33383d);
  });
  return m;
})()).add(hf);
// parking lines
const lineMat = new THREE.MeshStandardMaterial({ color: 0xd8d3c3 });
for (let i = -3; i <= 3; i++) {
  const l = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.02, 5), lineMat);
  l.position.set(i * 6, 0.02, 6); world.scene.add(l);
}

// ---- the fleet -------------------------------------------------------------
let drivingCar = null;
const FLEET = [
  { name: "Sedan",  file: "/models/sedanpack/Assets/Car.fbx",    x: -12, hp: 260, ep: 12, top: 44, grip: 10.5, siren: 0 },
  { name: "Police", file: "/models/sedanpack/Assets/Police.fbx", x: 0,   hp: 340, ep: 13, top: 48, grip: 11.5, siren: 6 },
  { name: "Taxi",   file: "/models/sedanpack/Assets/Taxi.fbx",   x: 12,  hp: 240, ep: 11, top: 42, grip: 10,   siren: 0 },
];
const cars = [];
for (const spec of FLEET) {
  loadVehicle(spec.file, { targetLength: 4.7, textureDir: "/models/sedanpack/Texture" }).then((rig) => {
    const e = world.spawn("drivable")
      .mesh(rig.visual)
      .at(spec.x, 0, -4)
      .add(new VehicleBody({
        chassis: rig.chassis, wheels: rig.wheels ?? undefined, wheelRadius: rig.wheelRadius,
        suspension: rig.suspension,
        enginePower: spec.ep, topSpeed: spec.top, maxLatAccel: spec.grip,
      }))
      .add(new VehicleRig(rig, { sirenHz: spec.siren }))
      .add(new EngineSound(audio, { hp: spec.hp }))
      .add(new SkidMarks({ rearOffset: 1.35, track: 0.78 }));
    const self = e;
    e.add(new PlayerVehicleControls({ enabled: () => drivingCar === self }));
    e.specName = spec.name; e.specHp = spec.hp; e.rig = rig;
    cars.push(e);
  }).catch((err) => console.warn(spec.name, "failed:", err.message));
}

// ---- player ----------------------------------------------------------------
class PlayerMove {
  fixedUpdate(dt, { input, world, entity }) {
    const body = entity.get(Body);
    if (drivingCar) { body.velocity.x = 0; body.velocity.z = 0; return; }
    const cam = world.camera;
    const f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
    const rt = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    const st = input.stick("left");
    const wish = f.multiplyScalar(input.axis("KeyS", "KeyW") - st.y)
                  .addScaledVector(rt, input.axis("KeyA", "KeyD") + st.x);
    if (wish.lengthSq() > 1) wish.normalize();
    const spd = input.down("ShiftLeft") ? 10 : 6;
    body.velocity.x = wish.x * spd; body.velocity.z = wish.z * spd;
    if (input.pressed("Space") && body.onGround) { body.velocity.y = 9; audio.play("jump"); }
    if (wish.lengthSq() > 0.01) entity.rotation.y = Math.atan2(body.velocity.x, body.velocity.z);
    const anim = entity.get(Animator);
    if (anim) {
      const p = Math.hypot(body.velocity.x, body.velocity.z);
      anim.play(!body.onGround ? "jump" : p > 7.5 ? "run" : p > 0.5 ? "walk" : "idle",
                { fade: 0.18, speed: p > 0.5 && p <= 7.5 ? p / 4.4 : 1, once: !body.onGround });
    }
  }
}
const rigHuman = buildHumanoid({ shirt: 0x2a6cc0 });
const player = world.spawn("player")
  .mesh(rigHuman.root).at(0, 0, 8)
  .add(new Body({ size: [0.6, 1.55, 0.6], offset: [0, 0.78, 0] }))
  .add(new Animator(rigHuman.root, rigHuman.clips))
  .add(new PlayerMove());
player.get(Animator).play("idle");

engine.input.enablePointerLock();
const rig = new ThirdPersonRig(player, { distance: 6.5, isSprinting: () => engine.input.down("ShiftLeft") });
world.spawn("camera").add(rig);

// ---- controls: enter/exit + open panels ------------------------------------
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyE") {
    if (drivingCar) {
      drivingCar.components.find((c) => c.rpm !== undefined)?.stop();
      const yaw = drivingCar.rotation.y;
      player.at(drivingCar.position.x + Math.cos(yaw) * 2.6, 0.2, drivingCar.position.z - Math.sin(yaw) * 2.6);
      player.object3d.visible = true;
      rig.target = player; rig.distance = 6.5; drivingCar = null;
    } else {
      let best = null, d = 4.5;
      for (const c of cars) { const dd = c.position.distanceTo(player.position); if (dd < d) { best = c; d = dd; } }
      if (best) {
        drivingCar = best; player.object3d.visible = false; audio.play("click");
        best.components.find((c) => c.rpm !== undefined)?.start();
        rig.target = best; rig.distance = 9.5;
      }
    }
  }
  // open panels — nearest car (or the one you're driving)
  const target = drivingCar ?? (() => { let b = null, d = 5; for (const c of cars) { const dd = c.position.distanceTo(player.position); if (dd < d) { b = c; d = dd; } } return b; })();
  const vr = target?.components.find((c) => c.openAll);
  if (!vr) return;
  if (e.code === "KeyO") vr.rig.openParts.some((p) => p.target > 0.5) ? vr.closeAll() : vr.openAll();
  const map = { Digit1: "door_fl", Digit2: "door_fr", Digit3: "door_bl", Digit4: "door_br", Digit5: "hood", Digit6: "trunk" };
  if (map[e.code]) vr.toggle(map[e.code]);
  if (e.code === "KeyC") {                             // C = cycle paint color
    const palette = [0xd21f1f, 0x1f5fd2, 0x111418, 0xe0e0e0, 0x1f9d55, 0xe0a020, 0x8a2be2];
    vr._paintI = ((vr._paintI ?? -1) + 1) % palette.length;
    vr.rig.setPaint(palette[vr._paintI]);
  }
  if (e.code === "KeyL") vr.headlights = !vr.headlights; // L = headlights
});

world.spawn("hud").add({ update() {
  const el = document.getElementById("stats");
  if (el) el.textContent = drivingCar
    ? `${drivingCar.specName} · ${Math.round(drivingCar.get(VehicleBody).kmh)} km/h · [O] doors [1-6] panels`
    : `${cars.length}/3 loaded · walk up + [E] to drive`;
} });

engine.start();
window.__pf = { engine, world, audio, player, cars, get drivingCar() { return drivingCar; } };
