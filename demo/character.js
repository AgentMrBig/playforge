// PLAYFORGE — Character test. Loads the rigged humanoid, drives it with
// procedural animation (the demo pack ships no clips). WASD walk, Shift run,
// Space jump. Keys I/W/R/J force a clip for inspection.
import {
  Engine, World, ThirdPersonRig, Audio, Body,
  Heightfield, loadCharacter, CharacterController, THREE,
} from "../src/index.js";

const engine = new Engine(document.getElementById("game"), { clearColor: 0x9ec4e4 });
const world = new World();
engine.world = world;

world.spawn("sun").mesh((() => {
  const g = new THREE.Group();
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.3); sun.position.set(6, 12, 6);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  const s = 12; Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, far: 40 });
  g.add(sun, new THREE.AmbientLight(0x9fb4d0, 0.9)); return g;
})());

const hf = new Heightfield({ size: 120, res: 4, heightAt: () => 0 });
world.spawn("ground").mesh(hf.buildMesh((x, z, h, s, out) => {
  out.setHex((Math.floor(x / 2) + Math.floor(z / 2)) & 1 ? 0x4c8a45 : 0x458040);
})).add(hf);

let guy = null;
loadCharacter("models/character/humanoid_male.fbx", {
  textureDir: "models/character", texture: "base_texture.png", targetHeight: 1.8,
  animations: [                       // real Mixamo mocap (Erik's pack)
    { name: "idle", url: "models/character/anims/idle.fbx" },
    { name: "walk", url: "models/character/anims/walking.fbx" },
    { name: "run", url: "models/character/anims/running.fbx" },
    { name: "jump", url: "models/character/anims/jumping up.fbx" },
  ],
}).then((ch) => {
  guy = world.spawn("player").mesh(ch.visual).at(0, 0, 0)
    .add(new Body({ size: [0.5, 1.7, 0.5], offset: [0, 0.85, 0] }))
    .add(ch.animator)
    .add(new CharacterController());
  ch.animator.play("idle");
  window.__ch = ch;
  document.getElementById("stats").textContent =
    `loaded · ${Object.keys(ch.bones).length} bones · ${ch.hadEmbedded ? "embedded clips" : "procedural clips"} · WASD walk, Shift run, Space jump`;
}).catch((e) => { document.getElementById("stats").textContent = "FAILED: " + e.message; });

engine.input.enablePointerLock();
const rig = new ThirdPersonRig({ get position() { return guy?.position ?? new THREE.Vector3(); },
  get rotation() { return guy?.rotation ?? { y: 0 }; }, components: [] }, { distance: 4.5, height: 1.0 });
world.spawn("camera").add({ update(dt, ctx) { if (guy) rig.target = guy; rig.update(dt, ctx); } });

// force-clip keys for inspection
window.addEventListener("keydown", (e) => {
  const a = window.__ch?.animator; if (!a) return;
  if (e.code === "KeyI") a.play("idle");
  if (e.code === "KeyJ") a.play("jump", { once: true });
});

engine.start();
window.__pf = { engine, world, get guy() { return guy; } };
