// PLAYFORGE — the one map. Island proving ground: drive the textured pack
// cars (real force physics + 4-corner suspension) around a classic automobile
// test course — straightaway, skidpad, slalom, and a jump ramp.
import {
  Engine, World, ThirdPersonRig, Audio, Body, Heightfield,
  VehicleBody, PlayerVehicleControls, EngineSound, SkidMarks,
  Animator, buildHumanoid, loadVehicle, VehicleRig, RoadNetwork, CarCollisions,
  initRapier, Physics, RapierVehicle,
  fbm, mulberry, THREE,
} from "../src/index.js";

const engine = new Engine(document.getElementById("game"), { clearColor: 0x93bfe0 });
const world = new World();
const audio = new Audio();
engine.world = world;
world.scene.fog = new THREE.Fog(0x93bfe0, 260, 720);
world.camera.far = 2000;
world.camera.updateProjectionMatrix();

// sun
world.spawn("sun").mesh((() => {
  const g = new THREE.Group();
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.3);
  sun.position.set(90, 120, 50);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const s = 130;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, far: 400 });
  g.add(sun, new THREE.AmbientLight(0xa8c0e0, 0.85));
  return g;
})());

// ============================================================================
// ISLAND — flat proving-ground plain, hills toward the rim, water beyond
// ============================================================================
const SEA = -0.5, ISLE = 900;
function islandHeight(x, z) {
  const r = Math.hypot(x, z);
  if (r < 240) return 0;                              // flat course plain
  if (r < 430) {                                      // rolling hills ring
    const t = (r - 240) / 190;
    return Math.sin(t * Math.PI) * (5 + (fbm(x * 0.012, z * 0.012, { seed: 7 }) * 0.5 + 0.5) * 9);
  }
  const d = Math.min((r - 430) / 70, 1);              // slope down to the sea
  return -7 * d;
}
const hf = new Heightfield({ size: ISLE, res: 200, heightAt: islandHeight });
const SAND = new THREE.Color(0xd9c58a), GRASS = new THREE.Color(0x4c8a45);
const ROCK = new THREE.Color(0x7b7671), TARMAC = new THREE.Color(0x33373d);
const islandMesh = hf.buildMesh((x, z, h, slope, out) => {
  const r = Math.hypot(x, z);
  if (r < 235) out.copy(TARMAC).lerp(GRASS, THREE.MathUtils.clamp((r - 150) / 85, 0, 1)); // course tarmac fading to grass
  else if (h < SEA + 1.2) out.copy(SAND);
  else if (slope > 0.7 || h > 11) out.copy(ROCK);
  else out.copy(GRASS);
});
world.spawn("island").mesh(islandMesh).add(hf);

// sea
const sea = world.spawn("sea").mesh(new THREE.Mesh(
  new THREE.PlaneGeometry(ISLE * 2.4, ISLE * 2.4).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x2e6d9e, transparent: true, opacity: 0.82, roughness: 0.3 }),
)).at(0, SEA, 0);
sea.add({ update(dt, { engine }) { sea.position.y = SEA + Math.sin(engine.time * 0.6) * 0.1; } });

// ============================================================================
// TEST COURSE
// ============================================================================
const paint = (w, d, x, z, color = 0xd8d3c3, rot = 0) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color, roughness: 1 }));
  m.rotation.y = rot; m.position.set(x, 0.02, z); m.receiveShadow = true;
  world.scene.add(m);
};

// straightaway: dashed lines + start line
for (let x = -120; x < 126; x += 8) { paint(4, 0.3, x, -4.5); paint(4, 0.3, x, 4.5); }
paint(0.5, 12, -120, 0);                              // start line
paint(0.5, 12, 120, 0, 0xd84040);                    // finish line (red)

// skidpad: painted ring
(() => {
  const ring = new THREE.Mesh(new THREE.RingGeometry(21.5, 22.5, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xe0d040, roughness: 1, side: THREE.DoubleSide }));
  ring.position.set(-70, 0.02, 95); world.scene.add(ring);
})();

// slalom cones — real dynamic bodies once physics is up (plow through them!)
const coneGeo = new THREE.ConeGeometry(0.35, 0.9, 10);
const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1a });
const bandMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0 });
const cones = [];
for (let i = 0; i < 9; i++) {
  const g = new THREE.Group();
  const c = new THREE.Mesh(coneGeo, coneMat); c.position.y = 0.45; c.castShadow = true;
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.31, 0.16, 10), bandMat); b.position.y = 0.5;
  g.add(c, b);
  cones.push(world.spawn("cone").mesh(g).at(-40 + i * 14, 0, -80));
}

// jump ramp — a wedge with a matching ground provider so the car climbs + flies
function makeRamp(x0, length, height, width) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(length, 0); shape.lineTo(length, height); shape.lineTo(0, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geo.rotateY(0);                                     // shape in XY, extruded +Z
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9a5a2e, roughness: 1 }));
  mesh.position.set(x0, 0, -width / 2); mesh.castShadow = true; mesh.receiveShadow = true;
  world.scene.add(mesh);
  // ground provider covering the ramp footprint (the walking player still
  // uses heightAt; the CARS collide with the actual mesh via Rapier now)
  const provider = {
    heightAt(x, z) {
      const lx = x - x0;
      if (lx < 0 || lx > length || Math.abs(z) > width / 2) return -Infinity;
      return (lx / length) * height;
    },
    slopeAt() { return height / length; },
  };
  return { mesh, provider };
}
const ramp = makeRamp(150, 16, 4.2, 12);              // climb 16m to 4.2m, launch
world.spawn("ramp").add(ramp.provider);

// ============================================================================
// REAL PHYSICS — Rapier. Terrain/ramp colliders ARE the render meshes:
// the car collides with everything that has a shape, from any angle.
// ============================================================================
const phys = new Physics({ gravity: -20 });
const physReady = initRapier().then(() => {
  world.spawn("physics").add(phys);
  phys.addMeshCollider(islandMesh);                   // the island, exactly as drawn
  phys.addMeshCollider(ramp.mesh);                    // the ramp, exactly as drawn
  phys.addGroundPlane(SEA - 4);                       // nothing falls forever
  for (const c of cones) phys.addDynamicProp(c, { half: [0.28, 0.42, 0.28], mass: 3.5, restitution: 0.35 });
});

// circuit road looping the proving ground (shows the road system in context)
const roads = new RoadNetwork({ ground: (x, z) => islandHeight(x, z) });
world.spawn("roads").add(roads);
{
  const loop = [], R = 195;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    loop.push([Math.cos(a) * R * (0.9 + 0.15 * Math.sin(a * 2)), Math.sin(a) * R]);
  }
  roads.addRoad(loop, { width: 10, closed: true });
}

// ============================================================================
// CARS — the textured pack, fully rigged
// ============================================================================
let drivingCar = null;
world.spawn("carCollisions").add(new CarCollisions({ audio }));   // car-vs-car contact + sparks
const FLEET = [
  { name: "Classic", file: "models/sedanpack/Assets/Car.fbx",    z: -6, hp: 300, ep: 13, top: 52, grip: 11, siren: 0, paint: 0xcc2222 },
  { name: "Police",  file: "models/sedanpack/Assets/Police.fbx", z: 0,  hp: 360, ep: 14, top: 55, grip: 12, siren: 6 },
  { name: "Taxi",    file: "models/sedanpack/Assets/Taxi.fbx",   z: 6,  hp: 260, ep: 12, top: 48, grip: 10.5, siren: 0 },
];
const cars = [];
for (const spec of FLEET) {
  Promise.all([physReady, loadVehicle(spec.file, { targetLength: 4.7, textureDir: "models/sedanpack/Texture" })])
    .then(([, rig]) => {
      if (spec.paint) rig.setPaint(spec.paint);
      const e = world.spawn("drivable").mesh(rig.visual).at(-115, 0, spec.z);
      e.rotation.y = Math.PI / 2;                      // face down the straight (+X) — BEFORE the body spawns
      e.add(new RapierVehicle({
        suspension: rig.suspension, wheelRadius: rig.wheelRadius,
        enginePower: spec.ep, topSpeed: spec.top,
      }))
        .add(new VehicleRig(rig, { sirenHz: spec.siren }))
        .add(new EngineSound(audio, { hp: spec.hp }))
        .add(new SkidMarks());
      const self = e;
      e.add(new PlayerVehicleControls({ enabled: () => drivingCar === self }));
      e.specName = spec.name; e.rig = rig;
      cars.push(e);
    }).catch((err) => console.warn(spec.name, err.message));
}

// ============================================================================
// PLAYER
// ============================================================================
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
  .mesh(rigHuman.root).at(-122, 0, 0)
  .add(new Body({ size: [0.6, 1.55, 0.6], offset: [0, 0.78, 0] }))
  .add(new Animator(rigHuman.root, rigHuman.clips))
  .add(new PlayerMove());
player.get(Animator).play("idle");

engine.input.enablePointerLock();
const rig = new ThirdPersonRig(player, { distance: 6.5, isSprinting: () => engine.input.down("ShiftLeft") });
world.spawn("camera").add(rig);

// ============================================================================
// controls: enter/exit + open panels + paint + lights
// ============================================================================
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyE") {
    if (drivingCar) {
      drivingCar.components.find((c) => c.rpm !== undefined)?.stop();
      const yaw = drivingCar.rotation.y;
      player.at(drivingCar.position.x + Math.cos(yaw) * 2.6, drivingCar.position.y + 0.4, drivingCar.position.z - Math.sin(yaw) * 2.6);
      player.object3d.visible = true; rig.target = player; rig.distance = 6.5; drivingCar = null;
    } else {
      let best = null, d = 4.5;
      for (const c of cars) { const dd = c.position.distanceTo(player.position); if (dd < d) { best = c; d = dd; } }
      if (best) { drivingCar = best; player.object3d.visible = false; audio.play("click");
        best.components.find((c) => c.rpm !== undefined)?.start(); rig.target = best; rig.distance = 9.5; }
    }
  }
  const target = drivingCar ?? (() => { let b=null,d=5; for(const c of cars){const dd=c.position.distanceTo(player.position); if(dd<d){b=c;d=dd;}} return b; })();
  if (e.code === "KeyF" && target) target.get(VehicleBody)?.recover(target, world); // BeamNG-style recover
  const vr = target?.components.find((c) => c.openAll);
  if (!vr) return;
  if (e.code === "KeyO") vr.rig.openParts.some((p) => p.target > 0.5) ? vr.closeAll() : vr.openAll();
  if (e.code === "KeyL") vr.headlights = !vr.headlights;
  if (e.code === "KeyC") { const pal=[0xcc2222,0x2255cc,0x111418,0xe0e0e0,0x1f9d55,0xe0a020];
    vr._pi=((vr._pi??-1)+1)%pal.length; vr.rig.setPaint(pal[vr._pi]); }
  const map = { Digit1:"door_fl", Digit2:"door_fr", Digit3:"door_bl", Digit4:"door_br", Digit5:"hood", Digit6:"trunk" };
  if (map[e.code]) vr.toggle(map[e.code]);
});

world.spawn("hud").add({ update() {
  const el = document.getElementById("stats"); if (!el) return;
  el.textContent = drivingCar
    ? `${drivingCar.specName} · ${Math.round(drivingCar.get(VehicleBody).kmh)} km/h · [O]panels [C]paint [L]lights`
    : `${cars.length}/3 cars ready · walk to the start line + [E] to drive · straight → skidpad → slalom → ramp`;
} });

engine.start();
window.__pf = { engine, world, audio, player, cars, hf, phys, physReady, cones, get drivingCar() { return drivingCar; } };
