import * as THREE from "three";

/**
 * Animation system: named-bone rigs + procedural clips + crossfading Animator.
 *
 * Bones here are named Object3D nodes (no skin weights needed for our blocky
 * style — meshes parent to bones directly). THREE.AnimationMixer resolves
 * tracks by node name, so clips are portable across any rig with matching
 * bone names.
 *
 *   const rig = buildHumanoid({ shirt: 0x4d8dff });
 *   world.spawn("player").mesh(rig.root)
 *     .add(new Animator(rig.root, rig.clips))
 *   ...
 *   entity.get(Animator).play("run", { fade: 0.15 });
 */
export class Animator {
  constructor(root, clips = {}) {
    this.root = root;
    this.clips = clips;
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = {};
    for (const [name, clip] of Object.entries(clips))
      this.actions[name] = this.mixer.clipAction(clip);
    this.current = null;
  }

  /** crossfade to a clip; no-op if it's already playing */
  play(name, { fade = 0.22, speed = 1, loop = true, once = false } = {}) {
    if (this.current === name) { this.actions[name].timeScale = speed; return; }
    const next = this.actions[name];
    if (!next) return;
    next.reset();
    next.timeScale = speed;
    next.setLoop(once ? THREE.LoopOnce : loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = once;
    next.enabled = true;
    if (this.current && this.actions[this.current])
      next.crossFadeFrom(this.actions[this.current], fade, true);
    next.play();
    this.current = name;
  }

  setSpeed(speed) { if (this.current) this.actions[this.current].timeScale = speed; }
  update(dt) { this.mixer.update(dt); }
  dispose() { this.mixer.stopAllAction(); }
}

// ---------------------------------------------------------------------------
// procedural clip building: euler-keyframed bone rotations
function rotTrack(bone, times, eulers) {
  const values = [];
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  for (const [x, y, z] of eulers) {
    q.setFromEuler(e.set(x, y, z));
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(bone + ".quaternion", times, values);
}
function posTrack(bone, times, positions) {
  return new THREE.VectorKeyframeTrack(bone + ".position", times, positions.flat());
}

/**
 * buildHumanoid — blocky character with named bones and generated clips.
 * Bones: hips, spine, head, arm_l, arm_r, leg_l, leg_r (pivots at joints).
 * Clips: idle, walk, run, jump.
 */
export function buildHumanoid({
  shirt = 0x4d8dff, pants = 0x2c3444, skin = 0xf2c9a0, hair = 0x3a2c1e,
  scale = 1,
} = {}) {
  const M = (c) => new THREE.MeshStandardMaterial({ color: c });
  const box = (w, h, d, mat, y = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.y = y;
    m.castShadow = true;
    return m;
  };

  const root = new THREE.Group();
  root.name = "humanoid";

  const hips = new THREE.Group(); hips.name = "hips";
  hips.position.y = 0.78 * scale;
  root.add(hips);

  const spine = new THREE.Group(); spine.name = "spine";
  spine.add(box(0.5 * scale, 0.55 * scale, 0.28 * scale, M(shirt), 0.28 * scale));
  hips.add(spine);

  const head = new THREE.Group(); head.name = "head";
  head.position.y = 0.58 * scale;
  head.add(box(0.34 * scale, 0.34 * scale, 0.34 * scale, M(skin), 0.17 * scale));
  const hairM = box(0.36 * scale, 0.1 * scale, 0.36 * scale, M(hair), 0.36 * scale);
  head.add(hairM);
  spine.add(head);

  const mkArm = (side) => {
    const a = new THREE.Group(); a.name = "arm_" + side;
    a.position.set(0.33 * scale * (side === "l" ? -1 : 1), 0.52 * scale, 0);
    a.add(box(0.14 * scale, 0.52 * scale, 0.16 * scale, M(shirt), -0.26 * scale));
    return a;
  };
  const armL = mkArm("l"), armR = mkArm("r");
  spine.add(armL, armR);

  const mkLeg = (side) => {
    const l = new THREE.Group(); l.name = "leg_" + side;
    l.position.set(0.13 * scale * (side === "l" ? -1 : 1), 0, 0);
    l.add(box(0.18 * scale, 0.78 * scale, 0.2 * scale, M(pants), -0.39 * scale));
    return l;
  };
  const legL = mkLeg("l"), legR = mkLeg("r");
  hips.add(legL, legR);

  // ---- clips ---------------------------------------------------------------
  const clips = {};
  const S = (deg) => THREE.MathUtils.degToRad(deg);

  { // idle: slow breath — spine sway + tiny arm drift (3s)
    const t = [0, 1.5, 3];
    clips.idle = new THREE.AnimationClip("idle", 3, [
      rotTrack("spine", t, [[0, 0, 0], [S(1.5), 0, S(1)], [0, 0, 0]]),
      rotTrack("arm_l", t, [[0, 0, S(3)], [0, 0, S(6)], [0, 0, S(3)]]),
      rotTrack("arm_r", t, [[0, 0, S(-3)], [0, 0, S(-6)], [0, 0, S(-3)]]),
      posTrack("hips", t, [[0, 0.78, 0], [0, 0.765, 0], [0, 0.78, 0]]),
    ]);
  }
  { // walk: opposed leg swing ±38°, counter arms, gentle bob (0.8s)
    const t = [0, 0.2, 0.4, 0.6, 0.8];
    const swing = (a) => [[S(a), 0, 0], [0, 0, 0], [S(-a), 0, 0], [0, 0, 0], [S(a), 0, 0]];
    clips.walk = new THREE.AnimationClip("walk", 0.8, [
      rotTrack("leg_l", t, swing(38)),
      rotTrack("leg_r", t, swing(-38)),
      rotTrack("arm_l", t, swing(-26)),
      rotTrack("arm_r", t, swing(26)),
      posTrack("hips", t, [[0, 0.78, 0], [0, 0.81, 0], [0, 0.78, 0], [0, 0.81, 0], [0, 0.78, 0]]),
      rotTrack("spine", t, [[S(3), 0, 0], [S(3), 0, 0], [S(3), 0, 0], [S(3), 0, 0], [S(3), 0, 0]]),
    ]);
  }
  { // run: bigger swing ±62°, forward lean, punchy bob (0.5s)
    const t = [0, 0.125, 0.25, 0.375, 0.5];
    const swing = (a) => [[S(a), 0, 0], [0, 0, 0], [S(-a), 0, 0], [0, 0, 0], [S(a), 0, 0]];
    clips.run = new THREE.AnimationClip("run", 0.5, [
      rotTrack("leg_l", t, swing(62)),
      rotTrack("leg_r", t, swing(-62)),
      rotTrack("arm_l", t, swing(-48)),
      rotTrack("arm_r", t, swing(48)),
      posTrack("hips", t, [[0, 0.78, 0], [0, 0.85, 0], [0, 0.78, 0], [0, 0.85, 0], [0, 0.78, 0]]),
      rotTrack("spine", t, [[S(12), 0, 0], [S(12), 0, 0], [S(12), 0, 0], [S(12), 0, 0], [S(12), 0, 0]]),
    ]);
  }
  { // jump: arms up, legs tucked (0.35s, clamps at the end)
    const t = [0, 0.35];
    clips.jump = new THREE.AnimationClip("jump", 0.35, [
      rotTrack("arm_l", t, [[0, 0, S(4)], [S(-160), 0, S(15)]]),
      rotTrack("arm_r", t, [[0, 0, S(-4)], [S(-160), 0, S(-15)]]),
      rotTrack("leg_l", t, [[0, 0, 0], [S(28), 0, 0]]),
      rotTrack("leg_r", t, [[0, 0, 0], [S(45), 0, 0]]),
    ]);
  }

  return { root, clips, bones: { hips, spine, head, armL, armR, legL, legR } };
}
