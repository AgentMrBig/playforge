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
  targetHeight = 1.8, texture = null, textureDir = "", shadows = true,
} = {}) {
  const ext = url.split(".").pop().toLowerCase();
  const loaded = await LOADERS[ext]().loadAsync(url);
  const root = loaded.scene ?? loaded;
  const embeddedClips = (loaded.animations && loaded.animations.length ? loaded.animations : root.animations) || [];

  // ---- texture rebind (FBX refs often miss) + material cleanup ------------
  let tex = null;
  if (texture) {
    tex = new THREE.TextureLoader().setPath(textureDir.replace(/\/?$/, "/")).load(texture);
    tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false;
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

// arms rest rotation from T-pose. A single-axis sweep can't hang a Mixamo arm
// perfectly (it arcs inward as it drops), so this is a tuned relaxed pose;
// real Mixamo clips (auto-used when the model has them) look far better.
const ARM_DOWN_L = D(-80), ARM_DOWN_R = D(80);
const FORE_L = D(-18), FORE_R = D(18);           // slight elbow bend inward

function buildHumanoidClips(bones) {
  const has = (n) => !!bones[n];
  const clips = {};

  // IDLE: arms down + gentle breathing (3s loop)
  {
    const t = [0, 1.5, 3];
    const tracks = [];
    if (has("LeftArm")) tracks.push(track("LeftArm", t, [[0, 0, ARM_DOWN_L], [D(2), 0, ARM_DOWN_L], [0, 0, ARM_DOWN_L]]));
    if (has("RightArm")) tracks.push(track("RightArm", t, [[0, 0, ARM_DOWN_R], [D(2), 0, ARM_DOWN_R], [0, 0, ARM_DOWN_R]]));
    if (has("LeftForeArm")) tracks.push(track("LeftForeArm", t, [[0, 0, FORE_L], [0, 0, FORE_L], [0, 0, FORE_L]]));
    if (has("RightForeArm")) tracks.push(track("RightForeArm", t, [[0, 0, FORE_R], [0, 0, FORE_R], [0, 0, FORE_R]]));
    if (has("Spine")) tracks.push(track("Spine", t, [[0, 0, 0], [D(1.5), 0, 0], [0, 0, 0]]));
    clips.idle = new THREE.AnimationClip("idle", 3, tracks);
  }
  // WALK: leg swing ±26°, knee bend, counter arm swing (0.9s)
  clips.walk = locomotion("walk", 0.9, D(26), D(20), D(14));
  // RUN: bigger swing, forward lean (0.6s)
  clips.run = locomotion("run", 0.6, D(42), D(38), D(26), D(10));
  // JUMP: crouch → arms up (0.4s, clamps)
  {
    const t = [0, 0.4];
    const tracks = [];
    if (has("LeftArm")) tracks.push(track("LeftArm", t, [[0, 0, ARM_DOWN_L], [D(-150), 0, ARM_DOWN_L * 0.4]]));
    if (has("RightArm")) tracks.push(track("RightArm", t, [[0, 0, ARM_DOWN_R], [D(-150), 0, ARM_DOWN_R * 0.4]]));
    if (has("LeftUpLeg")) tracks.push(track("LeftUpLeg", t, [[0, 0, 0], [D(30), 0, 0]]));
    if (has("RightUpLeg")) tracks.push(track("RightUpLeg", t, [[0, 0, 0], [D(30), 0, 0]]));
    clips.jump = new THREE.AnimationClip("jump", 0.4, tracks);
  }
  return clips;

  function locomotion(name, dur, legAmp, kneeAmp, armAmp, lean = 0) {
    const t = [0, dur * 0.25, dur * 0.5, dur * 0.75, dur];
    const sw = (a) => [[a, 0, 0], [0, 0, 0], [-a, 0, 0], [0, 0, 0], [a, 0, 0]];
    const tracks = [];
    if (has("LeftUpLeg")) tracks.push(track("LeftUpLeg", t, sw(legAmp)));
    if (has("RightUpLeg")) tracks.push(track("RightUpLeg", t, sw(-legAmp)));
    // knees bend on the back-swing (simple: flex when leg is back)
    if (has("LeftLeg")) tracks.push(track("LeftLeg", t, [[0, 0, 0], [kneeAmp, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]));
    if (has("RightLeg")) tracks.push(track("RightLeg", t, [[0, 0, 0], [0, 0, 0], [0, 0, 0], [kneeAmp, 0, 0], [0, 0, 0]]));
    // arms: down base + counter-swing to the legs
    const arm = (base, a) => [[a, 0, base], [0, 0, base], [-a, 0, base], [0, 0, base], [a, 0, base]];
    if (has("LeftArm")) tracks.push(track("LeftArm", t, arm(ARM_DOWN_L, -armAmp)));
    if (has("RightArm")) tracks.push(track("RightArm", t, arm(ARM_DOWN_R, armAmp)));
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
