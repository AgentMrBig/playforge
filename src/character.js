import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Animator } from "./animation.js";

/**
 * Character framework — load a rigged humanoid (FBX/GLB), texture it, and drive
 * it with animations. If the model ships its own clips we use them; if not
 * (like the free demo pack) we synthesize idle/walk/run/jump procedurally on
 * the model's actual bones (standard Mixamo naming).
 *
 *   const ch = await loadCharacter("models/character/humanoid_male.fbx",
 *                { textureDir: "models/character", texture: "base_texture.png" });
 *   world.spawn("guy").mesh(ch.visual)
 *     .add(ch.animator)             // Animator instance
 *     .add(new Body(...)).add(new CharacterController());
 *
 * Returns { visual, animator, bones, height }.
 */
const LOADERS = { fbx: () => new FBXLoader(), glb: () => new GLTFLoader(), gltf: () => new GLTFLoader() };

export async function loadCharacter(url, {
  targetHeight = 1.8, texture = null, textureDir = "", shadows = true, flipY = true,
} = {}) {
  const ext = url.split(".").pop().toLowerCase();
  const loaded = await LOADERS[ext]().loadAsync(url);
  const root = loaded.scene ?? loaded;
  const embeddedClips = (loaded.animations && loaded.animations.length ? loaded.animations : root.animations) || [];

  // ---- texture rebind (FBX refs often miss) + material cleanup ------------
  let tex = null;
  if (texture) {
    tex = new THREE.TextureLoader().setPath(textureDir.replace(/\/?$/, "/")).load(texture);
    // flipY true for this pack's UVs — false (the vehicle setting) sampled the
    // dark half of the palette atlas and made the skin come out near-black
    tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = flipY;
  }
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (shadows) o.castShadow = true;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      if (!m) return;
      if (tex) { m.map = tex; m.color.setHex(0xffffff); }
      m.side = THREE.FrontSide; m.needsUpdate = true;
    });
  });

  // ---- normalize: Y-up already, center X/Z, seat on ground, scale ---------
  let box = new THREE.Box3().setFromObject(root);
  let size = box.getSize(new THREE.Vector3());
  const scale = targetHeight / (size.y || 1.8);
  root.scale.setScalar(scale);
  box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  root.position.x -= c.x; root.position.z -= c.z; root.position.y -= box.min.y;

  const visual = new THREE.Group();
  visual.add(root);

  // ---- bone map ------------------------------------------------------------
  const bones = {};
  root.traverse((o) => { if (o.isBone && !bones[o.name]) bones[o.name] = o; });

  // ---- clips: embedded, else procedural -----------------------------------
  const clips = {};
  if (embeddedClips.length) {
    for (const c2 of embeddedClips) clips[classifyClip(c2.name)] = c2;
  } else {
    Object.assign(clips, buildHumanoidClips(bones));
  }
  const animator = new Animator(root, clips);

  return { visual, animator, bones, height: targetHeight, hadEmbedded: embeddedClips.length > 0 };
}

function classifyClip(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("run") || n.includes("sprint")) return "run";
  if (n.includes("walk")) return "walk";
  if (n.includes("jump")) return "jump";
  if (n.includes("idle")) return "idle";
  return n || "idle";
}

// ---------------------------------------------------------------------------
// procedural clips on a standard Mixamo skeleton. Arms rest DOWN from T-pose;
// legs/arms swing in the walk/run cycle. Rotation axes/signs are calibrated
// for the Mixamo bone frames (Y down the bone).
const D = (deg) => THREE.MathUtils.degToRad(deg);
function q(x, y, z) { return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)); }

function track(bone, times, eulers) {
  const vals = [];
  for (const [x, y, z] of eulers) { const qq = q(x, y, z); vals.push(qq.x, qq.y, qq.z, qq.w); }
  return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, vals);
}

// arms-down rest, about the bone's LOCAL X (calibrated on this rig: a positive
// X rotation on both upper arms swings them from T-pose down to the sides —
// Z arced them forward). Arm forward/back swing is also about X.
const ARM_DOWN = D(82);

function buildHumanoidClips(bones) {
  const has = (n) => !!bones[n];
  const clips = {};

  // IDLE: arms down + gentle breathing (3s loop)
  {
    const t = [0, 1.5, 3];
    const tracks = [];
    if (has("LeftArm")) tracks.push(track("LeftArm", t, [[ARM_DOWN, 0, 0], [ARM_DOWN + D(2), 0, 0], [ARM_DOWN, 0, 0]]));
    if (has("RightArm")) tracks.push(track("RightArm", t, [[ARM_DOWN, 0, 0], [ARM_DOWN + D(2), 0, 0], [ARM_DOWN, 0, 0]]));
    if (has("Spine")) tracks.push(track("Spine", t, [[0, 0, 0], [D(1.5), 0, 0], [0, 0, 0]]));
    clips.idle = new THREE.AnimationClip("idle", 3, tracks);
  }
  clips.walk = locomotion("walk", 0.9, D(26), D(22), D(16));
  clips.run = locomotion("run", 0.6, D(42), D(40), D(28), D(10));
  // JUMP: legs tuck, arms swing up (less X = arms rise) (0.4s, clamps)
  {
    const t = [0, 0.4];
    const tracks = [];
    if (has("LeftArm")) tracks.push(track("LeftArm", t, [[ARM_DOWN, 0, 0], [D(20), 0, 0]]));
    if (has("RightArm")) tracks.push(track("RightArm", t, [[ARM_DOWN, 0, 0], [D(20), 0, 0]]));
    if (has("LeftUpLeg")) tracks.push(track("LeftUpLeg", t, [[0, 0, 0], [D(35), 0, 0]]));
    if (has("RightUpLeg")) tracks.push(track("RightUpLeg", t, [[0, 0, 0], [D(35), 0, 0]]));
    clips.jump = new THREE.AnimationClip("jump", 0.4, tracks);
  }
  return clips;

  function locomotion(name, dur, legAmp, kneeAmp, armAmp, lean = 0) {
    const t = [0, dur * 0.25, dur * 0.5, dur * 0.75, dur];
    const sw = (a) => [[a, 0, 0], [0, 0, 0], [-a, 0, 0], [0, 0, 0], [a, 0, 0]];
    const armsw = (a) => [[ARM_DOWN + a, 0, 0], [ARM_DOWN, 0, 0], [ARM_DOWN - a, 0, 0], [ARM_DOWN, 0, 0], [ARM_DOWN + a, 0, 0]];
    const tracks = [];
    if (has("LeftUpLeg")) tracks.push(track("LeftUpLeg", t, sw(legAmp)));
    if (has("RightUpLeg")) tracks.push(track("RightUpLeg", t, sw(-legAmp)));
    if (has("LeftLeg")) tracks.push(track("LeftLeg", t, [[0, 0, 0], [kneeAmp, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]));
    if (has("RightLeg")) tracks.push(track("RightLeg", t, [[0, 0, 0], [0, 0, 0], [0, 0, 0], [kneeAmp, 0, 0], [0, 0, 0]]));
    // arms counter-swing to the legs (about X, around the arms-down rest)
    if (has("LeftArm")) tracks.push(track("LeftArm", t, armsw(-armAmp)));
    if (has("RightArm")) tracks.push(track("RightArm", t, armsw(armAmp)));
    if (lean && has("Spine")) tracks.push(track("Spine", t, [[lean, 0, 0], [lean, 0, 0], [lean, 0, 0], [lean, 0, 0], [lean, 0, 0]]));
    return new THREE.AnimationClip(name, dur, tracks);
  }
}

/**
 * CharacterController — WASD/stick locomotion for a loadCharacter rig with a
 * Body. Faces movement direction, picks idle/walk/run/jump by speed.
 */
export class CharacterController {
  constructor({ walk = 2.2, run = 5.5, jump = 8, turn = 12 } = {}) {
    Object.assign(this, { walk, run, jump, turn });
  }
  fixedUpdate(dt, { input, world, entity }) {
    const body = entity.components.find((c) => c.velocity && c.onGround !== undefined);
    if (!body) return;
    const cam = world.camera;
    const f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
    const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    const st = input.stick("left");
    const wish = f.multiplyScalar(input.axis("KeyS", "KeyW") - st.y)
                  .addScaledVector(r, input.axis("KeyA", "KeyD") + st.x);
    const moving = wish.lengthSq() > 0.01;
    if (wish.lengthSq() > 1) wish.normalize();
    const running = input.down("ShiftLeft");
    const spd = running ? this.run : this.walk;
    body.velocity.x = wish.x * spd; body.velocity.z = wish.z * spd;
    if (input.pressed("Space") && body.onGround) body.velocity.y = this.jump;
    if (moving) {
      const want = Math.atan2(wish.x, wish.z);
      let d = want - entity.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      entity.rotation.y += d * Math.min(1, dt * this.turn);
    }
    const anim = entity.components.find((c) => c.play && c.mixer);
    if (anim) {
      const planar = Math.hypot(body.velocity.x, body.velocity.z);
      if (!body.onGround) anim.play("jump", { fade: 0.12, once: true });
      else if (planar > this.walk + 0.5) anim.play("run", { fade: 0.15 });
      else if (planar > 0.2) anim.play("walk", { fade: 0.18 });
      else anim.play("idle", { fade: 0.25 });
    }
  }
}
