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
  animations = null,   // [{name, url}] external Mixamo FBX clips (one anim each)
} = {}) {
  const ext = url.split(".").pop().toLowerCase();
  const loaded = await LOADERS[ext]().loadAsync(url);
  const root = loaded.scene ?? loaded;
  let embeddedClips = (loaded.animations && loaded.animations.length ? loaded.animations : root.animations) || [];

  // ---- external animation clips (Mixamo exports one FBX per animation) -----
  // Bind by bone name: strip Mixamo's "mixamorig:" prefix so tracks target
  // this skeleton's plain bone names (Hips, Spine, LeftArm, …).
  if (animations) {
    for (const a of animations) {
      try {
        const ax = a.url.split(".").pop().toLowerCase();
        const anim = await LOADERS[ax]().loadAsync(a.url);
        const clips = (anim.animations && anim.animations.length ? anim.animations : (anim.scene ?? anim).animations) || [];
        // a file may hold ONE clip (individual export) or MANY (motion pack)
        clips.forEach((clip, i) => {
          if (a.name) clip.name = clips.length > 1 ? `${a.name}_${i}` : a.name;
          for (const tr of clip.tracks) tr.name = tr.name.replace(/mixamorig:?/i, "");
          // strip root-motion position tracks: Mixamo bakes them in CENTIMETER
          // scale (teleports a meter-scale rig into the void), and our
          // controller drives locomotion anyway — clips must play in place
          clip.tracks = clip.tracks.filter((tr) => !tr.name.endsWith(".position"));
          embeddedClips = embeddedClips.concat(clip);
        });
      } catch (e) { console.warn("anim", a.name, "failed:", e.message); }
    }
  }

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
    // UE exports carry an all-zeros vertex-paint channel; FBXLoader enables
    // vertexColors for it and multiplies the whole model to black
    if (o.geometry?.attributes?.color) o.geometry.deleteAttribute("color");
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      if (!m) return;
      if (tex) { m.map = tex; m.color.setHex(0xffffff); }
      m.vertexColors = false;
      m.side = THREE.FrontSide; m.needsUpdate = true;
    });
  });

  // ---- UE-skeleton support (Assetsville etc.): rename bones to the Mixamo
  // names every downstream system speaks (clips, ragdoll, controllers) ------
  const UE_ALIAS = {
    pelvis: "Hips", spine_01: "Spine", spine_02: "Spine1", spine_03: "Spine2",
    neck_01: "Neck", head: "Head",
    clavicle_l: "LeftShoulder", upperarm_l: "LeftArm", lowerarm_l: "LeftForeArm", hand_l: "LeftHand",
    clavicle_r: "RightShoulder", upperarm_r: "RightArm", lowerarm_r: "RightForeArm", hand_r: "RightHand",
    thigh_l: "LeftUpLeg", calf_l: "LeftLeg", foot_l: "LeftFoot",
    thigh_r: "RightUpLeg", calf_r: "RightLeg", foot_r: "RightFoot",
  };
  let isUE = false;
  root.traverse((o) => {
    if (o.isBone && UE_ALIAS[o.name.toLowerCase()]) { o.name = UE_ALIAS[o.name.toLowerCase()]; isUE = true; }
  });

  // ---- normalize. UE exports lie through node transforms (Z-up, cm bones,
  // unposed geometry bounds) — measure by SKINNED VERTICES when skinned: the
  // same ground truth the renderer uses.
  const skinnedBounds = () => {
    root.updateWorldMatrix(true, true);
    const bb = new THREE.Box3();
    let found = false;
    const v = new THREE.Vector3();
    root.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      found = true;
      // CPU sampling must mimic the renderer: 'attached' bindMatrixInverse
      // and boneMatrices only refresh on the RENDER path — sampling through
      // stale ones after transforming the root gives garbage bounds (that
      // mis-scaled the UE citizen into invisibility)
      o.bindMatrixInverse.copy(o.matrixWorld).invert();
      o.skeleton.update();
      const pos = o.geometry.attributes.position;
      const stride = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += stride) {
        v.fromBufferAttribute(pos, i);
        o.applyBoneTransform(i, v);
        v.applyMatrix4(o.matrixWorld);
        bb.expandByPoint(v);
      }
    });
    return found ? bb : new THREE.Box3().setFromObject(root);
  };
  let box = skinnedBounds();
  let size = box.getSize(new THREE.Vector3());
  if (size.z > size.y * 1.4) {                     // Z-up export: height along Z
    root.rotation.x = -Math.PI / 2;
    box = skinnedBounds();
    size = box.getSize(new THREE.Vector3());
  }
  const scale = targetHeight / (size.y || 1.8);
  root.scale.multiplyScalar(scale);
  box = skinnedBounds();
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


function buildHumanoidClips(bones) {
  const has = (n) => !!bones[n];
  const clips = {};
  // Bind-relative track: euler values are DELTAS applied on top of each bone's
  // rest pose (rest * delta). Setting absolute quaternions wiped the Mixamo
  // bind pose and splayed the limbs — this composes instead.
  const rest = {};
  const track = (bone, times, eulers) => {
    if (!rest[bone]) rest[bone] = bones[bone].quaternion.clone();
    const r = rest[bone], tmp = new THREE.Quaternion(), e = new THREE.Euler();
    const vals = [];
    for (const [x, y, z] of eulers) {
      tmp.setFromEuler(e.set(x, y, z));
      const out = r.clone().multiply(tmp);
      vals.push(out.x, out.y, out.z, out.w);
    }
    return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, vals);
  };

  // IDLE: arms lowered from T-pose + gentle breathing (3s loop)
  {
    const t = [0, 1.5, 3];
    const tracks = [];
    if (has("LeftArm")) tracks.push(track("LeftArm", t, [ARM_L, ARM_L, ARM_L]));
    if (has("RightArm")) tracks.push(track("RightArm", t, [ARM_R, ARM_R, ARM_R]));
    if (has("Spine")) tracks.push(track("Spine", t, [[0, 0, 0], [D(1.5), 0, 0], [0, 0, 0]]));
    clips.idle = new THREE.AnimationClip("idle", 3, tracks);
  }
  clips.walk = locomotion("walk", 0.9, D(26), D(22), D(16));
  clips.run = locomotion("run", 0.6, D(42), D(40), D(28), D(10));
  // JUMP: legs tuck forward, arms raise (0.4s, clamps)
  {
    const t = [0, 0.4];
    const tracks = [];
    if (has("LeftArm")) tracks.push(track("LeftArm", t, [ARM_L, addX(ARM_L, D(40))]));
    if (has("RightArm")) tracks.push(track("RightArm", t, [ARM_R, addX(ARM_R, D(40))]));
    if (has("LeftUpLeg")) tracks.push(track("LeftUpLeg", t, [[0, 0, 0], [D(38), 0, 0]]));
    if (has("RightUpLeg")) tracks.push(track("RightUpLeg", t, [[0, 0, 0], [D(38), 0, 0]]));
    clips.jump = new THREE.AnimationClip("jump", 0.4, tracks);
  }
  return clips;

  function locomotion(name, dur, legAmp, kneeAmp, armAmp, lean = 0) {
    const t = [0, dur * 0.25, dur * 0.5, dur * 0.75, dur];
    const sw = (a) => [[a, 0, 0], [0, 0, 0], [-a, 0, 0], [0, 0, 0], [a, 0, 0]];
    // arm swing = the arms-down delta plus a forward/back X wobble around it
    const armsw = (base, a) => [addX(base, a), base, addX(base, -a), base, addX(base, a)];
    const tracks = [];
    if (has("LeftUpLeg")) tracks.push(track("LeftUpLeg", t, sw(legAmp)));
    if (has("RightUpLeg")) tracks.push(track("RightUpLeg", t, sw(-legAmp)));
    if (has("LeftLeg")) tracks.push(track("LeftLeg", t, [[0, 0, 0], [kneeAmp, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]));
    if (has("RightLeg")) tracks.push(track("RightLeg", t, [[0, 0, 0], [0, 0, 0], [0, 0, 0], [kneeAmp, 0, 0], [0, 0, 0]]));
    if (has("LeftArm")) tracks.push(track("LeftArm", t, armsw(ARM_L, -armAmp)));
    if (has("RightArm")) tracks.push(track("RightArm", t, armsw(ARM_R, armAmp)));
    if (lean && has("Spine")) tracks.push(track("Spine", t, [[lean, 0, 0], [lean, 0, 0], [lean, 0, 0], [lean, 0, 0], [lean, 0, 0]]));
    return new THREE.AnimationClip(name, dur, tracks);
  }
}
// arms-down DELTA from the T-pose bind, about the bone LOCAL X (calibrated
// live: rest*Xdelta hangs BOTH arms symmetrically; Z lowered one and raised
// the other). addX layers the forward/back walk swing on the same axis.
const ARM_L = [D(80), 0, 0];
const ARM_R = [D(80), 0, 0];
const addX = (e, dx) => [e[0] + dx, e[1], e[2]];

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
